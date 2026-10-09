import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Harness } from "./domain.ts";
import type { FileSystem } from "./fs.ts";
import type { ModelSheet, PstackSetup, ProviderSetup, SheetRole, SheetWriteRequest, SheetWriteResponse } from "./wire.ts";

// Model sheets the monitor may write: a project's private sheet, or a global
// sheet that setup-pstack already created. pstack's setup skill probes every
// model live before it writes; the monitor validates against the matrix instead
// and marks the sheet so the next setup run knows to probe it.

export const SHEET_NAME = "pstack-models.md";
export const SHEET_TITLE = "# pstack model configuration";
/** A comment line: pstack's parser keeps only `role: lanes` lines, so this never reads as a role. */
export const UNPROBED_MARK = "<!-- Written by psf-monitor without a live model probe. Run /pstack:setup-pstack to probe these models and rewrite the sheet. -->";
const SHEET_PROSE = "Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.";

const MAX_FILE = 256 * 1024;
const ROLE = /^[a-z][a-z ,_-]*$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Providers whose matrix row is open: any namespaced model id may be named. */
const OPEN_PROVIDERS = new Set(["openrouter", "opencode"]);
const PANEL_ROLES = ["arena runners", "interrogate reviewers"];
const ARCHITECT_ROLE = "architect runners";
const LAB_ALIASES: Readonly<Record<string, string>> = { anthropic: "claude", openai: "codex", "x-ai": "grok" };

// --- projects ---------------------------------------------------------------

/** The directory pstack's project sheets live under, per harness. */
export function projectSheetDir(harness: Harness): string {
  return harness === "claude" ? ".claude" : harness === "codex" ? ".codex" : ".opencode";
}

/**
 * The primary checkout a working directory belongs to, the way pstack finds it:
 * the parent of git's common directory. A linked worktree resolves to its main checkout.
 */
export function projectRoot(cwd: string, fs: FileSystem): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const git = join(dir, ".git");
    const stat = fs.stat(git);
    if (stat !== null) {
      if (stat.directory) return dir;
      const pointer = fs.readText(git, 4096) ?? "";
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (match === null) return null;
      const gitdir = isAbsolute(match[1]!.trim()) ? match[1]!.trim() : resolve(dir, match[1]!.trim());
      const common = (fs.readText(join(gitdir, "commondir"), 4096) ?? "").trim();
      return dirname(common.length === 0 ? gitdir : isAbsolute(common) ? common : resolve(gitdir, common));
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readSheetFile(fs: FileSystem, path: string, parse: (body: string) => SheetRole[], scope: ModelSheet["scope"], harness: Harness): ModelSheet {
  const body = fs.readText(path, MAX_FILE);
  return {
    harness,
    scope,
    path,
    present: body !== null,
    roles: body === null ? [] : parse(body),
    writable: scope === "project" || body !== null,
    unprobed: body !== null && body.includes(UNPROBED_MARK),
  };
}

/** One entry per project the given working directories belong to, with its Claude Code and Codex sheets. */
export function projectSetups(cwds: readonly string[], fs: FileSystem, parse: (body: string) => SheetRole[]): { root: string; name: string; sessions: number; sheets: ModelSheet[] }[] {
  const counts = new Map<string, number>();
  const rootOf = new Map<string, string | null>();
  for (const cwd of cwds) {
    let root = rootOf.get(cwd);
    if (root === undefined) {
      root = projectRoot(cwd, fs);
      rootOf.set(cwd, root);
    }
    if (root !== null) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([root, sessions]) => ({
      root,
      name: basename(root),
      sessions,
      sheets: (["claude", "codex"] as const).map((harness) => readSheetFile(fs, join(root, projectSheetDir(harness), SHEET_NAME), parse, "project", harness)),
    }));
}

export function globalSheet(fs: FileSystem, harness: Harness, home: string, parse: (body: string) => SheetRole[]): ModelSheet {
  return readSheetFile(fs, join(home, SHEET_NAME), parse, "global", harness);
}

// --- validation -------------------------------------------------------------

export interface LaneParts {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}

/** Splits `provider:model@effort` at the first colon and the last `@`, as pstack does. Null for an alias or a malformed lane. */
export function laneParts(lane: string): LaneParts | null {
  const colon = lane.indexOf(":");
  const at = lane.lastIndexOf("@");
  if (colon < 1 || at <= colon + 1) return null;
  const model = lane.slice(colon + 1, at);
  if (/[\s,]/.test(model)) return null;
  return { provider: lane.slice(0, colon), model, effort: lane.slice(at + 1) };
}

export function isAlias(lane: string): boolean {
  return lane === "inherit-parent" || lane === "auto";
}

/** The lab that made a lane's model, for the panel diversity rule; null for an alias. */
export function laneLab(lane: string): string | null {
  const parts = laneParts(lane);
  if (parts === null) return null;
  if (!OPEN_PROVIDERS.has(parts.provider)) return parts.provider;
  const segments = parts.model.split("/");
  const namespace = (parts.provider === "opencode" && segments[0] === "openrouter" ? segments[1] : segments[0])?.replace(/^~/, "") ?? "";
  if (parts.provider === "opencode" && segments[0] !== "openrouter" && !(namespace in LAB_ALIASES) && namespace !== "deepseek" && namespace !== "minimax") return null;
  return LAB_ALIASES[namespace] ?? namespace;
}

export interface Validation {
  readonly errors: string[];
  readonly warnings: string[];
}

function familyFor(providers: readonly ProviderSetup[], parts: LaneParts) {
  const provider = providers.find((entry) => entry.provider === parts.provider);
  if (provider === undefined) return { provider: undefined, family: undefined };
  const family = provider.families.find((entry) => entry.model === parts.model) ?? (OPEN_PROVIDERS.has(parts.provider) ? provider.families[0] : undefined);
  return { provider, family };
}

/** Everything pstack's setup would refuse without a probe, plus what it would ask the operator to confirm. */
export function validateRoles(roles: readonly SheetRole[], setup: Pick<PstackSetup, "providers" | "defaults">, confirmDiversity: boolean): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const required = setup.defaults.map((role) => role.role);
  for (const role of roles) {
    if (!ROLE.test(role.role)) { errors.push(`"${role.role}" is not a role name pstack can read.`); continue; }
    if (seen.has(role.role)) errors.push(`"${role.role}" is listed twice.`);
    seen.add(role.role);
    if (role.lanes.length === 0) errors.push(`"${role.role}" has no lane.`);
    for (const lane of role.lanes) {
      if (isAlias(lane)) continue;
      const parts = laneParts(lane);
      if (parts === null) { errors.push(`"${lane}" (${role.role}) is not provider:model@effort, inherit-parent, or auto.`); continue; }
      const { provider, family } = familyFor(setup.providers, parts);
      if (provider === undefined) { errors.push(`"${lane}" (${role.role}) names a provider the installed pstack does not list.`); continue; }
      if (OPEN_PROVIDERS.has(parts.provider)) {
        if (!parts.model.includes("/")) errors.push(`"${lane}" (${role.role}) needs a namespaced model id such as z-ai/glm-5.3.`);
        else if (parts.provider === "openrouter" && parts.model.startsWith("openrouter/")) errors.push(`"${lane}" (${role.role}) names an OpenRouter router; name the model it would pick instead.`);
      } else if (family === undefined) {
        errors.push(`"${lane}" (${role.role}): ${parts.provider} has no model "${parts.model}" in the installed matrix.`);
      }
      const efforts = family?.efforts.length ? family.efforts : (EFFORTS as readonly string[]);
      if (!efforts.includes(parts.effort)) errors.push(`"${lane}" (${role.role}): effort must be one of ${efforts.join(", ")}.`);
      if (provider.blocked !== null) warnings.push(`"${lane}" (${role.role}) would not start right now: ${provider.blocked}.`);
    }
  }
  for (const name of required) if (!seen.has(name)) errors.push(`The role "${name}" is missing; every documented role stays in the sheet.`);
  const architect = roles.find((role) => role.role === ARCHITECT_ROLE);
  if (architect !== undefined && architect.lanes.length < 2) errors.push(`"${ARCHITECT_ROLE}" keeps at least two lanes.`);
  if (!roles.some((role) => role.lanes.some((lane) => !isAlias(lane)))) errors.push("At least one role must name a model; a sheet of only inherit-parent and auto does nothing.");
  for (const name of PANEL_ROLES) {
    const panel = roles.find((role) => role.role === name);
    if (panel === undefined) continue;
    const labs = new Set(panel.lanes.map(laneLab).filter((lab): lab is string => lab !== null));
    if (labs.size >= 2) continue;
    const message = `"${name}" runs on ${labs.size === 1 ? `one provider (${[...labs][0]})` : "no external provider"}; pstack wants at least two for an adversarial panel.`;
    if (confirmDiversity) warnings.push(message);
    else errors.push(`${message} Tick "accept a single-provider panel" to write it anyway.`);
  }
  return { errors, warnings };
}

// --- rendering and writing --------------------------------------------------

export function renderSheet(roles: readonly SheetRole[]): string {
  return [SHEET_TITLE, "", SHEET_PROSE, "", UNPROBED_MARK, "", ...roles.map((role) => `${role.role}: ${role.lanes.join(", ")}`), ""].join("\n");
}

/** Writes through a sibling temp file, then reads back; a mismatch leaves no partial file behind. */
export function writeSheet(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  renameSync(temporary, path);
  if (readFileSync(path, "utf8") !== body) throw new Error(`the sheet at ${path} did not read back as written`);
}

/** Keeps a project sheet out of git the way setup-pstack does: the repository's own exclude file, never a tracked .gitignore. */
export function excludeFromGit(root: string, relativePath: string): void {
  const exclude = join(root, ".git", "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === relativePath)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${current.length === 0 || current.endsWith("\n") ? current : `${current}\n`}${relativePath}\n`);
}

function sheetTarget(request: SheetWriteRequest, setup: PstackSetup): { path: string; root: string | null } | string {
  if (request.harness !== "claude" && request.harness !== "codex") return "Sheets are kept for Claude Code and Codex.";
  if (request.scope === "global") {
    const sheet = setup.sheets.find((entry) => entry.harness === request.harness);
    if (sheet === undefined) return "No global sheet path is known.";
    if (!sheet.present) return "No global sheet exists yet. Run /pstack:setup-pstack to create one; it also wires the sheet into the harness.";
    return { path: sheet.path, root: null };
  }
  const project = request.root === null ? undefined : setup.projects.find((entry) => entry.root === request.root);
  if (project === undefined) return "That project is not one the monitor has seen a session in.";
  return { path: join(project.root, projectSheetDir(request.harness), SHEET_NAME), root: project.root };
}

/** Validates and writes (or deletes) the sheet a request names. Only paths the setup already lists can be touched. */
export function applySheetRequest(request: SheetWriteRequest, setup: PstackSetup): SheetWriteResponse {
  const target = sheetTarget(request, setup);
  if (typeof target === "string") return { ok: false, message: target, path: null, errors: [target], warnings: [] };
  if (request.roles === null) {
    if (target.root === null) return { ok: false, message: "The global sheet is not deleted from here; remove the file yourself if you mean it.", path: target.path, errors: [], warnings: [] };
    if (!existsSync(target.path)) return { ok: false, message: "This project has no sheet to delete.", path: target.path, errors: [], warnings: [] };
    rmSync(target.path, { force: true });
    return { ok: true, message: "Project sheet deleted; this project uses the global sheet again.", path: target.path, errors: [], warnings: [] };
  }
  const { errors, warnings } = validateRoles(request.roles, setup, request.confirmDiversity);
  if (errors.length > 0) return { ok: false, message: errors.length === 1 ? errors[0]! : `${errors.length} problems; nothing written.`, path: target.path, errors, warnings };
  try {
    writeSheet(target.path, renderSheet(request.roles));
    if (target.root !== null) excludeFromGit(target.root, `${projectSheetDir(request.harness)}/${SHEET_NAME}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not write the sheet.";
    return { ok: false, message, path: target.path, errors: [message], warnings };
  }
  return { ok: true, message: `Sheet written. Run /pstack:setup-pstack when you want these models probed.`, path: target.path, errors: [], warnings };
}
