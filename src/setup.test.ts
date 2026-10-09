import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diskFileSystem } from "./fs.ts";
import { parseSheet, readSetup, renderSetup, tableUnder, type SetupOptions } from "./setup.ts";

const MATRIX = `# Provider dispatch

## Model matrix

| Family | Provider | Model | Default effort | Selectable efforts | Claude-native agent stem |
|---|---|---|---|---|---|
| fable | claude | fable | max | low medium high xhigh max | fable |
| sol-6 | codex | gpt-6-sol | high | low medium high | - |

Prose between the tables.

## Flex model matrix

| Family | Provider | Model | Default effort | Selectable efforts | API key variable | Base URL default |
|---|---|---|---|---|---|---|
| deepseek | deepseek | deepseek-flash | high | low high | DEEPSEEK_API_KEY | https://api.deepseek.com/anthropic |
| deepseek-pro | deepseek | deepseek-v4-pro | high | low high | DEEPSEEK_API_KEY | https://api.deepseek.com/anthropic |
| minimax | minimax | MiniMax-M3 | high | low high | MINIMAX_API_KEY | https://api.minimax.io/anthropic |
`;

const SETUP_SKILL = `---
name: setup-pstack
description: Configure pstack's models. Use for /setup-pstack.
---

\`\`\`markdown
# pstack model configuration

Provider-qualified per-role choices. \`inherit-parent\` and \`auto\` use the parent model.

bug-fix: codex:gpt-6-sol@high
why investigators, synthesizer: inherit-parent
arena runners: claude:fable@max, deepseek:deepseek-flash@high
\`\`\`

After the block: not a role
`;

let scratch: string;

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function options(env: NodeJS.ProcessEnv = {}, found: readonly string[] = ["claude", "codex"]): SetupOptions {
  return {
    where: { claude: join(scratch, "claude"), codex: join(scratch, "codex"), lanes: join(scratch, "flex", "lanes"), state: join(scratch, "state") },
    fs: diskFileSystem,
    env,
    which: (command) => (found.includes(command) ? `/bin/${command}` : null),
    home: scratch,
    platform: "darwin",
  };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "psf-monitor-setup-"));
  const old = join(scratch, "claude", "plugins", "cache", "open-pstack", "pstack", "1.10.0");
  const install = join(scratch, "claude", "plugins", "cache", "open-pstack", "pstack", "1.9.0");
  write(join(old, "skills", "stale", "SKILL.md"), "---\nname: stale\n---\n");
  write(join(scratch, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "pstack@open-pstack": [{ installPath: install, version: "1.9.0" }] } }));
  write(join(install, "skills", "arena", "SKILL.md"), '---\nname: arena\ndescription: "Spawn N candidates: pick a \\"base\\"."\n---\n# Arena\n');
  write(join(install, "skills", "principle-prove-it-works", "SKILL.md"), "---\nname: principle-prove-it-works\ndescription: Apply before declaring done.\nuser-invocable: false\n---\n");
  write(join(install, "skills", "setup-pstack", "SKILL.md"), SETUP_SKILL);
  write(join(install, "skills", "poteto-mode", "references", "provider-dispatch.md"), MATRIX);
  write(join(scratch, "codex", "plugins", "cache", "open-pstack", "pstack", "1.8.0", "skills", "arena", "SKILL.md"), "---\nname: arena\n---\n");
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("tableUnder", () => {
  it("reads the first table under a heading by column title", () => {
    expect(tableUnder(MATRIX, "## Model matrix").map((row) => row.Model)).toEqual(["fable", "gpt-6-sol"]);
    expect(tableUnder(MATRIX, "## Flex model matrix")[2]?.["API key variable"]).toBe("MINIMAX_API_KEY");
    expect(tableUnder(MATRIX, "## Missing")).toEqual([]);
  });
});

describe("parseSheet", () => {
  it("keeps role rows and drops headings and prose", () => {
    expect(parseSheet("# pstack model configuration\n\nNote: read the reference first.\n\nbug-fix: codex:gpt-6-sol@high\narena runners: claude:fable@max, minimax:MiniMax-M3.1-Flash-Preview@high\nwhy investigators, synthesizer: inherit-parent\n")).toEqual([
      { role: "bug-fix", lanes: ["codex:gpt-6-sol@high"] },
      { role: "arena runners", lanes: ["claude:fable@max", "minimax:MiniMax-M3.1-Flash-Preview@high"] },
      { role: "why investigators, synthesizer", lanes: ["inherit-parent"] },
    ]);
  });
});

describe("readSetup", () => {
  it("finds the install Claude Code recorded, not the newest cached one", () => {
    const setup = readSetup(options());
    expect(setup.installs.map((install) => [install.harness, install.version])).toEqual([["claude", "1.9.0"], ["codex", "1.8.0"]]);
    expect(setup.skills).toEqual([
      { name: "arena", description: 'Spawn N candidates: pick a "base".', invocable: true },
      { name: "principle-prove-it-works", description: "Apply before declaring done.", invocable: false },
      { name: "setup-pstack", description: "Configure pstack's models. Use for /setup-pstack.", invocable: true },
    ]);
  });

  it("groups model families by provider and tells gateways from subscriptions", () => {
    const setup = readSetup(options());
    expect(setup.providers.map((provider) => [provider.provider, provider.kind, provider.cli, provider.families.map((family) => family.model)])).toEqual([
      ["claude", "subscription", "claude", ["fable"]],
      ["codex", "subscription", "codex", ["gpt-6-sol"]],
      ["deepseek", "gateway", "claude", ["deepseek-flash", "deepseek-v4-pro"]],
      ["minimax", "gateway", "claude", ["MiniMax-M3"]],
    ]);
    expect(setup.providers[1]?.families[0]).toEqual({ family: "sol-6", model: "gpt-6-sol", defaultEffort: "high", efforts: ["low", "medium", "high"] });
  });

  it("says what stops a provider and never returns a key", () => {
    const setup = readSetup(options({ DEEPSEEK_API_KEY: "sk-secret-value", MINIMAX_API_KEY: "  " }, ["claude"]));
    const blocked = Object.fromEntries(setup.providers.map((provider) => [provider.provider, provider.blocked]));
    expect(blocked).toEqual({ claude: null, codex: "`codex` is not on PATH", deepseek: null, minimax: "MINIMAX_API_KEY is not set" });
    expect(setup.providers[2]?.gateway).toMatchObject({ keyVar: "DEEPSEEK_API_KEY", keySet: true, baseUrl: "https://api.deepseek.com/anthropic", baseUrlOverridden: false, configDir: join(scratch, ".pstack-flex", "deepseek"), login: "none" });
    expect(JSON.stringify(setup)).not.toContain("sk-secret-value");
  });

  it("applies the gateway overrides and hides credentials in an endpoint", () => {
    const dir = join(scratch, "elsewhere");
    const setup = readSetup(options({ DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://user:pass@proxy.test/v1?token=abc", PSTACK_FLEX_DEEPSEEK_CONFIG_DIR: dir, DEEPSEEK_MAX_CONTEXT_TOKENS: "64000" }));
    expect(setup.providers[2]?.gateway).toMatchObject({ baseUrl: "https://proxy.test/v1", baseUrlOverridden: true, configDir: dir, configDirOverridden: true, maxContext: "64000" });
  });

  it("flags a claude.ai login in a gateway config dir", () => {
    write(join(scratch, ".pstack-flex", "minimax", ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    const minimax = readSetup(options({ MINIMAX_API_KEY: "k" })).providers[3];
    expect(minimax?.gateway?.login).toBe("found");
    expect(minimax?.blocked).toContain("claude.ai login");
  });

  it("reads written sheets and falls back to the first-run roles", () => {
    const before = readSetup(options());
    expect(before.sheets.map((sheet) => sheet.present)).toEqual([false, false]);
    expect(before.defaults.map((role) => role.role)).toEqual(["bug-fix", "why investigators, synthesizer", "arena runners"]);
    write(join(scratch, "codex", "pstack-models.md"), "# pstack model configuration\n\nbug-fix: deepseek:deepseek-v4-pro@high\n");
    const codex = readSetup(options()).sheets[1];
    expect(codex).toMatchObject({ harness: "codex", present: true, roles: [{ role: "bug-fix", lanes: ["deepseek:deepseek-v4-pro@high"] }] });
  });

  it("lists the git projects the sessions ran in, with their sheets", () => {
    const repo = join(scratch, "projects", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    write(join(repo, ".claude", "pstack-models.md"), "# pstack model configuration\n\nbug-fix: codex:gpt-6-sol@low\n");
    const setup = readSetup({ ...options(), cwds: [join(repo, "src"), repo, join(scratch, "loose")] });
    expect(setup.projects).toHaveLength(1);
    expect(setup.projects[0]).toMatchObject({ root: repo, name: "app", sessions: 2 });
    expect(setup.projects[0]!.sheets.map((sheet) => [sheet.harness, sheet.scope, sheet.present, sheet.writable])).toEqual([["claude", "project", true, true], ["codex", "project", false, true]]);
    expect(setup.projects[0]!.sheets[0]!.roles).toEqual([{ role: "bug-fix", lanes: ["codex:gpt-6-sol@low"] }]);
    expect(setup.sheets[0]).toMatchObject({ scope: "global", writable: false });
    expect(renderSetup(setup)).toContain("Model roles · app · Claude Code");
  });

  it("reports nothing installed without failing", () => {
    const empty = join(scratch, "empty");
    const setup = readSetup({ ...options(), where: { claude: empty, codex: empty, lanes: empty, state: empty } });
    expect(setup).toMatchObject({ installs: [], skills: [], providers: [], defaults: [] });
    expect(renderSetup(setup)).toContain("pstack is not installed");
  });

  it("renders the setup as text", () => {
    const report = renderSetup(readSetup(options({ CODEX_HOME: join(scratch, "codex") })));
    expect(report).toContain("pstack 1.9.0 in Claude Code, 1.8.0 in Codex · 3 skills, 2 you can run");
    expect(report).toContain("deepseek  API key       not ready: DEEPSEEK_API_KEY is not set");
    expect(report).toContain("plus 1 principle leaf that skills read on their own");
    expect(report).toContain(`CODEX_HOME=${join(scratch, "codex")}\n`);
    expect(report).toContain("(default)");
  });
});
