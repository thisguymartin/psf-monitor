import { describe, expect, it } from "bun:test";
import type { AgentId, AgentNode } from "./domain.ts";
import { filterTree, matchesAgent, type AgentFilter } from "./explorer.ts";
import { treeOf, withoutSkills } from "./graph.ts";

const now = Date.parse("2026-10-05T12:00:00Z");
const all: AgentFilter = { query: "", status: "all", kind: "all" };
function node(id: string, parent: string | null, status: AgentNode["status"] = { kind: "done", at: null }): AgentNode {
  return {
    id: id as AgentId, parent: parent as AgentId | null, title: id, status,
    via: null, spawnCall: null, harness: "codex", source: "codex-rollout",
    flavor: { kind: "subagent", agentType: null }, cwd: null,
    model: { provider: "codex", requested: "gpt-6", reported: null, effort: null },
    startedAt: null, lastActivityAt: "2026-10-05T11:00:00Z", activity: null,
    prompt: null, result: null, pending: null, usage: null, health: "ok",
  };
}
const root = node("root", null);
const parent = node("finished parent", root.id);
const child = node("running child", parent.id, { kind: "running", evidence: "pid" });
const sibling = node("other work", root.id);
const tree = treeOf(root.id, new Map([root, parent, child, sibling].map((entry) => [entry.id, entry])))!;

describe("agent explorer filters", () => {
  it("keeps the path to running descendants without counting ancestors as matches", () => {
    const filtered = filterTree(tree, { ...all, status: "running" }, now);
    expect(filtered.tree.nodes.map((entry) => entry.id)).toEqual([root.id, parent.id, child.id]);
    expect([...filtered.matches]).toEqual([child.id]);
  });

  it("combines search terms with status and type", () => {
    expect(matchesAgent(child, { query: "CHILD gpt-6", status: "running", kind: "subagent" }, now)).toBe(true);
    expect(matchesAgent(child, { query: "child", status: "done", kind: "all" }, now)).toBe(false);
    expect(matchesAgent(child, { query: "child", status: "all", kind: "lane" }, now)).toBe(false);
  });

  it("does not misrepresent stale lifecycle evidence as running", () => {
    const stale = { ...child, status: { kind: "running", evidence: "lifecycle" } as const };
    expect(matchesAgent(stale, { ...all, status: "running" }, now)).toBe(false);
    expect(matchesAgent(stale, { ...all, status: "stalled" }, now)).toBe(true);
    expect(matchesAgent(child, { ...all, status: "running" }, now)).toBe(true);
  });

  it("reports zero matches while retaining the root for graph structure", () => {
    const filtered = filterTree(tree, { ...all, query: "absent" }, now);
    expect(filtered.matches.size).toBe(0);
    expect(filtered.tree.nodes).toEqual([root]);
  });

  it("finds agents behind hidden skills", () => {
    const skill: AgentNode = { ...parent, flavor: { kind: "skill", skill: "review", trigger: { kind: "user" }, runner: root.id } };
    const shown = withoutSkills(new Map([root, skill, child].map((entry) => [entry.id, entry])));
    const filtered = filterTree(treeOf(root.id, shown)!, { ...all, status: "running" }, now);
    expect(filtered.tree.nodes.map((entry) => entry.id)).toEqual([root.id, child.id]);
    expect(filtered.tree.children.get(root.id)?.[0]?.id).toBe(child.id);
  });

  it("searches current activity and includes idle agents in Waiting", () => {
    const idle: AgentNode = { ...child, pending: { name: "Bash", snippet: "bun test src", since: null }, status: { kind: "idle", evidence: "pid", detail: null } };
    expect(matchesAgent(idle, { ...all, query: "bun test", status: "waiting" }, now)).toBe(true);
  });
});
