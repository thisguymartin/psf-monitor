import { describe, expect, it } from "bun:test";
import type { AgentId, AgentNode } from "./domain.ts";
import { summarizeOverview } from "./overview.ts";
import type { ModelSheet, PstackSetup, ProviderSetup } from "./wire.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
function node(id: string, changes: Partial<AgentNode> = {}): AgentNode {
  return {
    id: id as AgentId, parent: null, via: null, spawnCall: null, harness: "codex", source: "codex-rollout", flavor: { kind: "session" },
    pstack: true, title: id, cwd: "/work/project", model: { provider: "codex", requested: "gpt-6", reported: null, effort: null },
    status: { kind: "running", evidence: "pid" }, startedAt: null, lastActivityAt: "2026-10-09T11:00:00Z", activity: null,
    prompt: null, result: null, pending: null, usage: null, health: "ok", ...changes,
  };
}
function nodes(...entries: AgentNode[]) { return new Map(entries.map((entry) => [entry.id, entry])); }
function provider(name: string): ProviderSetup { return { provider: name, kind: "subscription", cli: name, cliPath: null, families: [], gateway: null, blocked: "CLI missing" }; }
function sheet(scope: "global" | "project", provider: string): ModelSheet {
  return { harness: "codex", scope, path: "/sheet", present: true, writable: true, unprobed: false, roles: [{ role: "review", lanes: [`${provider}:model@high`] }] };
}
function setup(changes: Partial<PstackSetup> = {}): PstackSetup {
  return { installs: [], skills: [], providers: [], sheets: [], projects: [], defaults: [], settings: [], platform: "darwin", ...changes };
}

describe("work overview", () => {
  it("keeps running and attention work scoped and counts a session once", () => {
    const root = node("root");
    const child = node("child", { parent: root.id, flavor: { kind: "subagent", agentType: null } });
    const failed = node("failed", { parent: root.id, status: { kind: "failed", at: null, reason: "Test failed" } });
    const stale = node("stale", { parent: root.id, status: { kind: "running", evidence: "lifecycle" } });
    const other = node("other", { pstack: false });
    const summary = summarizeOverview(nodes(root, child, failed, stale, other), "pstack", now, null);
    expect(summary.running.map((entry) => entry.id)).toEqual([root.id, child.id]);
    expect(summary.runningSessions).toBe(1);
    expect(summary.attention.map((entry) => entry.id)).toEqual([failed.id, stale.id]);
    expect(summary.entries).toBe(4);
    expect(summarizeOverview(nodes(root, other), "normal", now, null).running).toEqual([other]);
    expect(summarizeOverview(nodes(root, other), "all", now, null).runningSessions).toBe(2);
    expect(summarizeOverview(nodes(stale, failed), "all", now, null).attention.map((entry) => entry.id)).toEqual([failed.id, stale.id]);
  });

  it("excludes skill wrappers and distinguishes unknown, partial, and reported zero usage", () => {
    const root = node("root", { usage: { inputTokens: 100, outputTokens: 20 } });
    const wrapper = node("skill", { parent: root.id, usage: root.usage, flavor: { kind: "skill", skill: "review", trigger: { kind: "user" }, runner: root.id } });
    const unknown = node("unknown");
    const partial = node("partial", { usage: { outputTokens: 7 } });
    const summary = summarizeOverview(nodes(root, wrapper, unknown, partial), "all", now, null);
    expect(summary.entries).toBe(3);
    expect(summary.models).toEqual([{ provider: "codex", model: "gpt-6", entries: 3, running: 3, tokens: 127, reporting: 2, partial: true }]);
    expect(summarizeOverview(nodes(unknown), "all", now, null).models[0]?.tokens).toBeNull();
    expect(summarizeOverview(nodes(node("zero", { usage: { totalTokens: 0 } })), "all", now, null).models[0]).toMatchObject({ tokens: 0, reporting: 1, partial: false });
    expect(summarizeOverview(nodes(node("total", { usage: { totalTokens: 200, inputTokens: 100, outputTokens: 20 } })), "all", now, null).models[0]?.tokens).toBe(200);
  });

  it("uses the effective project sheet and ignores unused unconfigured providers", () => {
    const config = setup({ providers: [provider("codex"), provider("project"), provider("global"), provider("unused")], sheets: [sheet("global", "global")],
      projects: [{ root: "/work/project", name: "project", sessions: 1, sheets: [sheet("project", "project")] }] });
    const summary = summarizeOverview(nodes(node("current")), "pstack", now, config);
    expect(summary.blockers.map((entry) => entry.provider.provider)).toEqual(["codex", "project"]);
    expect(summary.blockers[0]).toMatchObject({ activity: true, assignments: false });
    expect(summary.blockers[1]).toMatchObject({ activity: false, assignments: true });
    expect(summarizeOverview(nodes(node("done", { status: { kind: "done", at: null } })), "pstack", now, config).blockers).toEqual([]);
  });

  it("falls back to global assignments without matching a sibling path or another harness", () => {
    const config = setup({ providers: [provider("global"), provider("project"), provider("claude")], sheets: [sheet("global", "global")],
      projects: [{ root: "/work/project", name: "project", sessions: 1, sheets: [sheet("project", "project"), { ...sheet("project", "claude"), harness: "claude" }] }] });
    expect(summarizeOverview(nodes(node("sibling", { cwd: "/work/project-other" })), "all", now, config).blockers.map((entry) => entry.provider.provider)).toEqual(["global"]);
    expect(summarizeOverview(nodes(node("nested", { cwd: "/work/project/subdir" })), "all", now, config).blockers.map((entry) => entry.provider.provider)).toEqual(["project"]);
  });

  it("keeps an empty project override empty and resolves auto without inventing a provider", () => {
    const config = setup({ providers: [provider("global"), provider("default")], defaults: [{ role: "review", lanes: ["default:model", "auto", "inherit-parent"] }],
      sheets: [sheet("global", "global")], projects: [{ root: "/work/project", name: "project", sessions: 1, sheets: [{ ...sheet("project", "project"), roles: [] }] }] });
    expect(summarizeOverview(nodes(node("current")), "all", now, config).blockers).toEqual([]);
    expect(summarizeOverview(nodes(node("current")), "all", now, { ...config, sheets: [], projects: [] }).blockers.map((entry) => entry.provider.provider)).toEqual(["default"]);
  });
});
