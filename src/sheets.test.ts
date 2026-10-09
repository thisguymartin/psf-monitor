import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskFileSystem } from "./fs.ts";
import { parseSheet } from "./setup.ts";
import { applySheetRequest, excludeFromGit, laneLab, laneParts, projectRoot, projectSetups, renderSheet, UNPROBED_MARK, validateRoles, writeSheet } from "./sheets.ts";
import type { PstackSetup, ProviderSetup, SheetRole } from "./wire.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "psf-monitor-sheets-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function provider(name: string, models: [string, string, string[]][], blocked: string | null = null): ProviderSetup {
  return {
    provider: name, kind: "subscription", cli: name, cliPath: `/bin/${name}`, gateway: null, blocked,
    families: models.map(([family, model, efforts]) => ({ family, model, defaultEffort: efforts[0]!, efforts })),
  };
}

const PROVIDERS: ProviderSetup[] = [
  provider("claude", [["fable", "fable", ["low", "high", "max"]], ["opus", "opus", ["low", "high", "max"]]]),
  provider("codex", [["sol-6.1", "gpt-6.1-sol", ["low", "high"]], ["astra", "gpt-6-astra", ["high"]]]),
  provider("grok", [["grok", "grok-4.7", ["xhigh"]]], "`grok` is not on PATH"),
  provider("openrouter", [["openrouter", "<any OpenRouter model ID>", ["high"]]]),
  provider("opencode", [["opencode", "<any OpenCode model ID>", ["high"]]]),
];

const DEFAULTS: SheetRole[] = [
  { role: "bug-fix", lanes: ["codex:gpt-6.1-sol@high"] },
  { role: "why investigators, synthesizer", lanes: ["inherit-parent"] },
  { role: "arena runners", lanes: ["claude:fable@max", "codex:gpt-6-astra@high"] },
  { role: "architect runners", lanes: ["codex:gpt-6-astra@high", "claude:fable@max"] },
];

function setup(projects: PstackSetup["projects"] = [], sheets: PstackSetup["sheets"] = []): PstackSetup {
  return { installs: [], skills: [], providers: PROVIDERS, sheets, projects, defaults: DEFAULTS, settings: [], platform: "darwin" };
}

describe("lane descriptors", () => {
  it("splits at the first colon and the last @, so model ids may carry both", () => {
    expect(laneParts("codex:gpt-6.1-sol@high")).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(laneParts("openrouter:z-ai/glm-5.3:free@high")).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3:free", effort: "high" });
    expect(laneParts("inherit-parent")).toBeNull();
    expect(laneParts("codex:@high")).toBeNull();
    expect(laneParts("codex:a b@high")).toBeNull();
  });

  it("maps a lane to the lab that made its model", () => {
    expect(laneLab("claude:fable@max")).toBe("claude");
    expect(laneLab("openrouter:anthropic/claude-x@high")).toBe("claude");
    expect(laneLab("openrouter:z-ai/glm-5.3@high")).toBe("z-ai");
    expect(laneLab("opencode:openrouter/openai/gpt-x@high")).toBe("codex");
    expect(laneLab("opencode:deepseek/deepseek-flash@high")).toBe("deepseek");
    expect(laneLab("opencode:opencode/glm-5.3@high")).toBeNull();
    expect(laneLab("auto")).toBeNull();
  });
});

describe("validateRoles", () => {
  it("accepts a sheet that keeps every documented role on matrix models", () => {
    expect(validateRoles(DEFAULTS, setup(), false)).toEqual({ errors: [], warnings: [] });
  });

  it("refuses unknown providers, models, efforts, and malformed lanes", () => {
    const roles: SheetRole[] = [
      { role: "bug-fix", lanes: ["cursor:fast@high", "codex:gpt-9@high", "codex:gpt-6.1-sol@ultra", "codex:gpt-6.1-sol"] },
      ...DEFAULTS.slice(1),
    ];
    const { errors } = validateRoles(roles, setup(), false);
    expect(errors).toEqual([
      '"cursor:fast@high" (bug-fix) names a provider the installed pstack does not list.',
      '"codex:gpt-9@high" (bug-fix): codex has no model "gpt-9" in the installed matrix.',
      '"codex:gpt-6.1-sol@ultra" (bug-fix): effort must be one of low, high.',
      '"codex:gpt-6.1-sol" (bug-fix) is not provider:model@effort, inherit-parent, or auto.',
    ]);
  });

  it("requires every documented role, two architect lanes, and at least one model", () => {
    const { errors } = validateRoles([{ role: "architect runners", lanes: ["auto"] }, { role: "bug-fix", lanes: [] }, { role: "bug-fix", lanes: ["auto"] }], setup(), false);
    expect(errors).toContain('"bug-fix" is listed twice.');
    expect(errors).toContain('"bug-fix" has no lane.');
    expect(errors).toContain('The role "why investigators, synthesizer" is missing; every documented role stays in the sheet.');
    expect(errors).toContain('The role "arena runners" is missing; every documented role stays in the sheet.');
    expect(errors).toContain('"architect runners" keeps at least two lanes.');
    expect(errors).toContain("At least one role must name a model; a sheet of only inherit-parent and auto does nothing.");
  });

  it("treats a single-provider panel as an error until the operator accepts it", () => {
    const roles: SheetRole[] = DEFAULTS.map((role) => (role.role === "arena runners" ? { role: role.role, lanes: ["codex:gpt-6.1-sol@high", "codex:gpt-6-astra@high"] } : role));
    const refused = validateRoles(roles, setup(), false);
    expect(refused.errors).toEqual(['"arena runners" runs on one provider (codex); pstack wants at least two for an adversarial panel. Tick "accept a single-provider panel" to write it anyway.']);
    const accepted = validateRoles(roles, setup(), true);
    expect(accepted.errors).toEqual([]);
    expect(accepted.warnings).toEqual(['"arena runners" runs on one provider (codex); pstack wants at least two for an adversarial panel.']);
  });

  it("allows namespaced open-row models and warns about a provider that cannot start", () => {
    const roles: SheetRole[] = DEFAULTS.map((role) => (role.role === "bug-fix" ? { role: role.role, lanes: ["openrouter:z-ai/glm-5.3@high", "grok:grok-4.7@xhigh"] } : role));
    const ok = validateRoles(roles, setup(), false);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual(['"grok:grok-4.7@xhigh" (bug-fix) would not start right now: `grok` is not on PATH.']);
    const bad = validateRoles(DEFAULTS.map((role) => (role.role === "bug-fix" ? { role: role.role, lanes: ["openrouter:glm@high", "openrouter:openrouter/auto@high"] } : role)), setup(), false);
    expect(bad.errors).toEqual([
      '"openrouter:glm@high" (bug-fix) needs a namespaced model id such as z-ai/glm-5.3.',
      '"openrouter:openrouter/auto@high" (bug-fix) names an OpenRouter router; name the model it would pick instead.',
    ]);
  });
});

describe("project roots", () => {
  it("finds the main checkout from a working directory and from a linked worktree", () => {
    const main = join(scratch, "repo");
    mkdirSync(join(main, ".git", "worktrees", "feature"), { recursive: true });
    mkdirSync(join(main, "src", "deep"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
    const linked = join(scratch, "repo-feature");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
    expect(projectRoot(join(main, "src", "deep"), diskFileSystem)).toBe(main);
    expect(projectRoot(linked, diskFileSystem)).toBe(main);
    expect(projectRoot(scratch, diskFileSystem)).toBeNull();
  });

  it("lists each project once with its session count and both sheets", () => {
    const main = join(scratch, "repo");
    mkdirSync(join(main, ".git"), { recursive: true });
    mkdirSync(join(main, ".codex"), { recursive: true });
    writeFileSync(join(main, ".codex", "pstack-models.md"), `${renderSheet(DEFAULTS)}`);
    const projects = projectSetups([join(main, "src"), main, scratch], diskFileSystem, parseSheet);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ root: main, name: "repo", sessions: 2 });
    expect(projects[0]!.sheets.map((sheet) => [sheet.harness, sheet.present, sheet.writable, sheet.unprobed])).toEqual([["claude", false, true, false], ["codex", true, true, true]]);
    expect(projects[0]!.sheets[1]!.roles).toEqual(DEFAULTS);
  });
});

describe("writing sheets", () => {
  it("renders a sheet pstack can parse, with the unprobed mark as a comment", () => {
    const body = renderSheet(DEFAULTS);
    expect(body.startsWith("# pstack model configuration\n")).toBe(true);
    expect(body).toContain(UNPROBED_MARK);
    expect(parseSheet(body)).toEqual(DEFAULTS);
  });

  it("writes atomically and keeps the project sheet out of git", () => {
    const root = join(scratch, "repo");
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "node_modules\n");
    writeSheet(join(root, ".claude", "pstack-models.md"), "# x\n");
    expect(readFileSync(join(root, ".claude", "pstack-models.md"), "utf8")).toBe("# x\n");
    expect(existsSync(join(root, ".claude", `pstack-models.md.${process.pid}.tmp`))).toBe(false);
    excludeFromGit(root, ".claude/pstack-models.md");
    excludeFromGit(root, ".claude/pstack-models.md");
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe("node_modules\n.claude/pstack-models.md\n");
  });

  it("applies a request only to a project the setup lists, and only to an existing global sheet", () => {
    const root = join(scratch, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    const projects = projectSetups([root], diskFileSystem, parseSheet);
    const globalPath = join(scratch, "home", "pstack-models.md");
    const current = setup(projects, [{ harness: "claude", scope: "global", path: globalPath, present: false, roles: [], writable: false, unprobed: false }]);
    const written = applySheetRequest({ harness: "claude", scope: "project", root, roles: DEFAULTS, confirmDiversity: false }, current);
    expect(written).toMatchObject({ ok: true, path: join(root, ".claude", "pstack-models.md"), errors: [] });
    expect(parseSheet(readFileSync(written.path!, "utf8"))).toEqual(DEFAULTS);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain(".claude/pstack-models.md");

    expect(applySheetRequest({ harness: "claude", scope: "project", root: join(scratch, "elsewhere"), roles: DEFAULTS, confirmDiversity: false }, current).ok).toBe(false);
    expect(applySheetRequest({ harness: "claude", scope: "global", root: null, roles: DEFAULTS, confirmDiversity: false }, current).message).toContain("No global sheet exists yet");
    expect(applySheetRequest({ harness: "opencode", scope: "project", root, roles: DEFAULTS, confirmDiversity: false }, current).ok).toBe(false);

    const invalid = applySheetRequest({ harness: "claude", scope: "project", root, roles: DEFAULTS.slice(1), confirmDiversity: false }, current);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual(['The role "bug-fix" is missing; every documented role stays in the sheet.']);
    expect(parseSheet(readFileSync(written.path!, "utf8"))).toEqual(DEFAULTS);

    expect(applySheetRequest({ harness: "claude", scope: "global", root: null, roles: null, confirmDiversity: false }, current).ok).toBe(false);
    expect(applySheetRequest({ harness: "claude", scope: "project", root, roles: null, confirmDiversity: false }, current)).toMatchObject({ ok: true });
    expect(existsSync(written.path!)).toBe(false);
    expect(applySheetRequest({ harness: "claude", scope: "project", root, roles: null, confirmDiversity: false }, current).ok).toBe(false);

    mkdirSync(join(scratch, "home"), { recursive: true });
    writeFileSync(globalPath, renderSheet(DEFAULTS));
    const withGlobal = setup(projects, [{ ...current.sheets[0]!, present: true, writable: true }]);
    const changed = DEFAULTS.map((role) => (role.role === "bug-fix" ? { role: role.role, lanes: ["claude:opus@high"] } : role));
    expect(applySheetRequest({ harness: "claude", scope: "global", root: null, roles: changed, confirmDiversity: false }, withGlobal).ok).toBe(true);
    expect(parseSheet(readFileSync(globalPath, "utf8"))[0]).toEqual({ role: "bug-fix", lanes: ["claude:opus@high"] });
  });
});
