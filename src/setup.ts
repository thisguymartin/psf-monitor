import { join } from "node:path";
import type { Harness } from "./domain.ts";
import type { FileSystem } from "./fs.ts";
import { array, object, oneLine, parseJson, text } from "./json.ts";
import { globalSheet, projectSetups, SHEET_TITLE } from "./sheets.ts";
import type { Homes } from "./sources.ts";
import type { GatewaySetup, ModelFamily, PstackInstall, PstackSetup, ProviderSetup, SetupSetting, SheetRole, SkillInfo } from "./wire.ts";

// How pstack is set up on this machine: the installed plugin's skills and
// model matrix, each provider's CLI and key, and the model sheets. Providers
// and roles come from the files pstack ships, so a new one needs no change
// here. Reports whether a key is set, never the key.

const MAX_FILE = 256 * 1024;
const SKILL_HEAD = 8 * 1024;
const PLUGIN = "pstack";

export interface SetupOptions {
  readonly where: Homes;
  readonly fs: FileSystem;
  readonly env: NodeJS.ProcessEnv;
  readonly which: (command: string) => string | null;
  /** Gateway config dirs default to `<home>/.pstack-flex/<provider>`. */
  readonly home: string;
  readonly platform: string;
  /** Working directories of indexed sessions; each git project among them gets a project entry. */
  readonly cwds?: readonly string[];
}

function configured(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value !== undefined && value.trim().length > 0 ? value : null;
}

// --- the installed plugin ---------------------------------------------------

function newer(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function hasSkills(fs: FileSystem, path: string): boolean {
  return fs.stat(join(path, "skills"))?.directory === true;
}

function cachedInstall(fs: FileSystem, home: string): Omit<PstackInstall, "harness"> | null {
  const cache = join(home, "plugins", "cache");
  let best: { version: string; path: string } | null = null;
  for (const marketplace of fs.list(cache) ?? []) {
    if (!marketplace.directory) continue;
    const versions = join(cache, marketplace.name, PLUGIN);
    for (const version of fs.list(versions) ?? []) {
      const path = join(versions, version.name);
      if (!version.directory || !hasSkills(fs, path)) continue;
      if (best === null || newer(version.name, best.version)) best = { version: version.name, path };
    }
  }
  return best;
}

// Claude Code records the active version; its cache can still hold older ones.
function recordedInstall(fs: FileSystem, home: string): Omit<PstackInstall, "harness"> | null {
  const plugins = object(object(parseJson(fs.readText(join(home, "plugins", "installed_plugins.json"), MAX_FILE) ?? ""))?.plugins);
  for (const [key, entries] of Object.entries(plugins ?? {})) {
    if (!key.startsWith(`${PLUGIN}@`)) continue;
    for (const entry of array(entries)) {
      const path = text(object(entry)?.installPath);
      if (path !== null && hasSkills(fs, path)) return { version: text(object(entry)?.version), path };
    }
  }
  return null;
}

function installs(fs: FileSystem, where: Homes): PstackInstall[] {
  const found: PstackInstall[] = [];
  const claude = recordedInstall(fs, where.claude) ?? cachedInstall(fs, where.claude);
  if (claude !== null) found.push({ harness: "claude", ...claude });
  const codex = cachedInstall(fs, where.codex);
  if (codex !== null) found.push({ harness: "codex", ...codex });
  return found;
}

// --- skills -----------------------------------------------------------------

function frontmatter(markdown: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return fields;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const colon = line.indexOf(":");
    if (colon <= 0 || line.startsWith(" ")) continue;
    const raw = line.slice(colon + 1).trim();
    const quoted = raw.startsWith('"') ? parseJson(raw) : undefined;
    fields.set(line.slice(0, colon).trim(), typeof quoted === "string" ? quoted : raw.replace(/^'(.*)'$/, "$1"));
  }
  return fields;
}

function skills(fs: FileSystem, install: string): SkillInfo[] {
  const found: SkillInfo[] = [];
  for (const entry of fs.list(join(install, "skills")) ?? []) {
    if (!entry.directory) continue;
    const head = fs.readText(join(install, "skills", entry.name, "SKILL.md"), SKILL_HEAD);
    if (head === null) continue;
    const fields = frontmatter(head);
    found.push({
      name: fields.get("name") ?? entry.name,
      description: fields.get("description") ?? "",
      invocable: fields.get("user-invocable") !== "false",
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// --- the model matrix -------------------------------------------------------

/** The rows of the first table under a heading, keyed by column title. */
export function tableUnder(markdown: string, heading: string): Record<string, string>[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("|")) rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
    else if (rows.length > 0 || line.startsWith("## ")) break;
  }
  const [header, , ...body] = rows;
  if (header === undefined) return [];
  return body.map((cells) => Object.fromEntries(header.map((title, index) => [title, cells[index] ?? ""])));
}

/** The binary the runner starts; a gateway provider runs `claude` against its own endpoint. */
function cliOf(provider: string, gateway: boolean): string {
  return gateway ? "claude" : provider;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "not a URL";
  }
}

// Mirrors the runner's guard: it refuses a gateway lane whose config dir holds a claude.ai login.
function loginIn(fs: FileSystem, configDir: string): GatewaySetup["login"] {
  const raw = fs.readText(join(configDir, ".credentials.json"), MAX_FILE);
  if (raw === null) return "none";
  const record = object(parseJson(raw));
  if (record === null) return "unreadable";
  return "claudeAiOauth" in record || "accessToken" in record ? "found" : "none";
}

function gateway(provider: string, row: Record<string, string>, options: SetupOptions): GatewaySetup {
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const baseUrlVar = `${prefix}_BASE_URL`;
  const configDirVar = `PSTACK_FLEX_${prefix}_CONFIG_DIR`;
  const maxContextVar = `${prefix}_MAX_CONTEXT_TOKENS`;
  const keyVar = row["API key variable"] ?? "";
  const baseUrl = configured(options.env, baseUrlVar);
  const configDir = configured(options.env, configDirVar);
  const resolvedDir = configDir ?? join(options.home, ".pstack-flex", provider);
  return {
    keyVar,
    keySet: configured(options.env, keyVar) !== null,
    baseUrlVar,
    baseUrl: safeUrl(baseUrl ?? row["Base URL default"] ?? ""),
    baseUrlOverridden: baseUrl !== null,
    configDirVar,
    configDir: resolvedDir,
    configDirOverridden: configDir !== null,
    maxContextVar,
    maxContext: configured(options.env, maxContextVar),
    login: loginIn(options.fs, resolvedDir),
  };
}

function blockedBy(cli: string, cliPath: string | null, setup: GatewaySetup | null): string | null {
  if (cliPath === null) return `\`${cli}\` is not on PATH`;
  if (setup === null) return null;
  if (!setup.keySet) return `${setup.keyVar} is not set`;
  if (setup.login === "found") return `a claude.ai login sits in ${setup.configDir}`;
  if (setup.login === "unreadable") return `unreadable credentials file in ${setup.configDir}`;
  return null;
}

function providers(matrix: string, options: SetupOptions): ProviderSetup[] {
  const rows = [...tableUnder(matrix, "## Model matrix"), ...tableUnder(matrix, "## Flex model matrix")];
  const byProvider = new Map<string, { families: ModelFamily[]; flex: Record<string, string> | null }>();
  for (const row of rows) {
    const provider = row.Provider;
    if (provider === undefined || provider.length === 0 || !row.Model) continue;
    const entry = byProvider.get(provider) ?? { families: [], flex: null };
    entry.families.push({
      family: row.Family ?? row.Model,
      model: row.Model,
      defaultEffort: row["Default effort"] ?? "",
      efforts: (row["Selectable efforts"] ?? "").split(/\s+/).filter((effort) => effort.length > 0),
    });
    if (row["API key variable"]) entry.flex = row;
    byProvider.set(provider, entry);
  }
  return [...byProvider].map(([provider, entry]) => {
    const setup = entry.flex === null ? null : gateway(provider, entry.flex, options);
    const cli = cliOf(provider, setup !== null);
    const cliPath = options.which(cli);
    return {
      provider,
      kind: setup === null ? "subscription" : "gateway",
      cli,
      cliPath,
      families: entry.families,
      gateway: setup,
      blocked: blockedBy(cli, cliPath, setup),
    };
  });
}

// --- model sheets -----------------------------------------------------------

const LANE = /^(?:inherit-parent|auto|[a-z0-9-]+:[A-Za-z0-9/._-]+@[a-z]+)$/;

/** The `role: lane, lane` rows of a model sheet; prose and headings fall away. */
export function parseSheet(sheet: string): SheetRole[] {
  const roles: SheetRole[] = [];
  for (const line of sheet.split("\n")) {
    const colon = line.indexOf(": ");
    if (colon <= 0) continue;
    const lanes = line.slice(colon + 2).split(",").map((lane) => lane.trim());
    if (lanes.every((lane) => LANE.test(lane))) roles.push({ role: line.slice(0, colon).trim(), lanes });
  }
  return roles;
}

// setup-pstack carries the first-run sheet as a fenced example; pstack uses those roles until a sheet exists.
function defaultRoles(fs: FileSystem, install: string): SheetRole[] {
  const skill = fs.readText(join(install, "skills", "setup-pstack", "SKILL.md"), MAX_FILE) ?? "";
  const start = skill.indexOf(SHEET_TITLE);
  if (start < 0) return [];
  const end = skill.indexOf("```", start);
  return parseSheet(skill.slice(start, end < 0 ? undefined : end));
}

// --- everything -------------------------------------------------------------

function settings(options: SetupOptions): SetupSetting[] {
  const row = (variable: string, value: string, meaning: string): SetupSetting => ({ variable, value, overridden: configured(options.env, variable) !== null, meaning });
  return [
    row("CLAUDE_CONFIG_DIR", options.where.claude, "Claude Code transcripts, plugins, and model sheet"),
    row("CODEX_HOME", options.where.codex, "Codex rollouts, plugins, and model sheet"),
    ...(options.where.opencode === undefined ? [] : [row("XDG_DATA_HOME", options.where.opencode, "OpenCode session database directory (under the XDG data home)")]),
    row("PSTACK_FLEX_LANES_DIR", options.where.lanes, "Lane journal the runner writes while it exists"),
    row("PSF_MONITOR_DIR", options.where.state, "This monitor's server record and log"),
  ];
}

export function readSetup(options: SetupOptions): PstackSetup {
  const { fs, where } = options;
  const found = installs(fs, where);
  const install = found[0]?.path ?? null;
  const matrix = install === null ? "" : fs.readText(join(install, "skills", "poteto-mode", "references", "provider-dispatch.md"), MAX_FILE) ?? "";
  return {
    installs: found,
    skills: install === null ? [] : skills(fs, install),
    providers: providers(matrix, options),
    sheets: [globalSheet(fs, "claude", where.claude, parseSheet), globalSheet(fs, "codex", where.codex, parseSheet)],
    projects: projectSetups(options.cwds ?? [], fs, parseSheet),
    defaults: install === null ? [] : defaultRoles(fs, install),
    settings: settings(options),
    platform: options.platform,
  };
}

const HARNESS_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

/** The setup as text, for `psf-monitor setup`. */
export function renderSetup(setup: PstackSetup): string {
  const lines: string[] = [];
  if (setup.installs.length === 0) {
    lines.push("pstack is not installed in Claude Code or Codex");
  } else {
    const runnable = setup.skills.filter((skill) => skill.invocable).length;
    lines.push(`pstack ${setup.installs.map((install) => `${install.version ?? "?"} in ${HARNESS_NAME[install.harness]}`).join(", ")} · ${setup.skills.length} skills, ${runnable} you can run`);
  }

  if (setup.providers.length > 0) {
    lines.push("", "Providers");
    const width = Math.max(...setup.providers.map((provider) => provider.provider.length));
    for (const provider of setup.providers) {
      const state = provider.blocked === null ? "ready" : `not ready: ${provider.blocked}`;
      const kind = provider.kind === "gateway" ? "API key     " : "subscription";
      lines.push(`  ${provider.provider.padEnd(width)}  ${kind}  ${state}`);
      lines.push(`  ${" ".repeat(width)}  models: ${provider.families.map((family) => family.model).join(", ")}`);
      if (provider.gateway !== null) {
        lines.push(`  ${" ".repeat(width)}  endpoint: ${provider.gateway.baseUrl}${provider.gateway.baseUrlOverridden ? ` (${provider.gateway.baseUrlVar})` : ""}`);
      }
    }
  }

  const written = setup.sheets.filter((entry) => entry.present);
  for (const entry of written) {
    lines.push("", `Model roles · ${HARNESS_NAME[entry.harness]} · ${entry.path}${entry.unprobed ? " · not probed" : ""}`);
    for (const role of entry.roles) lines.push(`  ${role.role}: ${role.lanes.join(", ")}`);
  }
  for (const project of setup.projects) {
    for (const entry of project.sheets) {
      if (!entry.present) continue;
      lines.push("", `Model roles · ${project.name} · ${HARNESS_NAME[entry.harness]} · ${entry.path}${entry.unprobed ? " · not probed" : ""} (replaces the global sheet in this project)`);
      for (const role of entry.roles) lines.push(`  ${role.role}: ${role.lanes.join(", ")}`);
    }
  }
  if (written.length === 0 && setup.defaults.length > 0) {
    lines.push("", "Model roles · first-run defaults; no model sheet is written yet");
    for (const role of setup.defaults) lines.push(`  ${role.role}: ${role.lanes.join(", ")}`);
  }

  const runnable = setup.skills.filter((skill) => skill.invocable);
  if (runnable.length > 0) {
    lines.push("", "Skills");
    const width = Math.max(...runnable.map((skill) => skill.name.length));
    for (const skill of runnable) lines.push(`  ${skill.name.padEnd(width)}  ${oneLine(skill.description, 96)}`);
    const leaves = setup.skills.length - runnable.length;
    if (leaves > 0) lines.push(`  plus ${leaves} principle ${leaves === 1 ? "leaf" : "leaves"} that skills read on their own`);
  }

  lines.push("", "Settings");
  for (const setting of setup.settings) {
    lines.push(`  ${setting.variable}=${setting.value}${setting.overridden ? "" : " (default)"}`);
  }
  return `${lines.join("\n")}\n`;
}
