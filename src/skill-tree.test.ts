import { describe, expect, it } from "bun:test";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import type { AgentId } from "./domain.ts";
import { countsOf, treeOf } from "./graph.ts";
import { Store } from "./store.ts";

const root = "claude:s1" as AgentId;
const run = `skill:${root}/skill-1` as AgentId;
const at = "2026-10-01T10:00:00.000Z";

function claude() {
  return claudeAdapter("/tmp/claude").open("/tmp/claude/projects/-repo/s1.jsonl");
}
function assistant(content: unknown[], attributionSkill: string | null = null, stop_reason: string | null = null) {
  return JSON.stringify({ type: "assistant", timestamp: at, uuid: "record-1", attributionSkill, message: { model: "claude-opus-5-5", stop_reason, content } });
}
function tool(id: string, name: string, input: unknown) { return { type: "tool_use", id, name, input }; }

describe("skill runs", () => {
  it("records user, model, and skill triggers and nests the child under its caller", () => {
    const parser = claude();
    const user = parser.line(JSON.stringify({ type: "user", timestamp: at, message: { content: "<command-name>/pstack:poteto-mode</command-name>" } }), 0);
    expect(user.facts).toContainEqual(expect.objectContaining({ kind: "agent", patch: expect.objectContaining({ flavor: expect.objectContaining({ trigger: { kind: "user" } }) }) }));
    const parent = parser.line(assistant([tool("skill-1", "Skill", { skill: "pstack:deslop" })], "pstack:poteto-mode"), 1);
    expect(parent.facts).toContainEqual({ kind: "link", id: run, parent: "skill:claude:s1/0.0", via: "skill" } as never);
    expect(parent.facts).toContainEqual(expect.objectContaining({ kind: "agent", id: run, patch: expect.objectContaining({ flavor: expect.objectContaining({ trigger: { kind: "skill" } }) }) }));
    const nested = parser.line(assistant([tool("skill-2", "Skill", { skill: "pstack:no-comments" })], "pstack:deslop"), 2);
    expect(nested.facts).toContainEqual({ kind: "link", id: "skill:claude:s1/skill-2", parent: run, via: "skill" } as never);
    const model = claude().line(assistant([tool("m", "Skill", { skill: "pstack:interrogate" })]), 3);
    expect(model.facts).toContainEqual(expect.objectContaining({ kind: "agent", patch: expect.objectContaining({ flavor: expect.objectContaining({ trigger: { kind: "model" } }) }) }));
  });

  it("attributes subagent launches, runner calls, activity, and response to the current run", () => {
    const parser = claude();
    parser.line(assistant([tool("skill-1", "Skill", { skill: "pstack:no-comments" })]), 0);
    const parsed = parser.line(assistant([{ type: "text", text: "Final **review**" }, tool("agent-1", "Agent", { subagent_type: "pstack:comment-sicko" }), tool("lane-1", "Bash", { command: 'pstack-runner --receipt "$S/receipt.json"' })], "pstack:no-comments"), 1);
    expect(parsed.facts).toContainEqual({ kind: "spawn-call", by: run, callId: "agent-1" } as never);
    expect(parsed.facts).toContainEqual({ kind: "lane-call", by: run, callId: "lane-1", at, command: 'pstack-runner --receipt "$S/receipt.json"' } as never);
    expect(parsed.facts).toContainEqual({ kind: "result", id: run, result: { kind: "text", body: { text: "Final **review**", omitted: 0 } } } as never);
    const store = new Store();
    for (const fact of parsed.facts) store.apply(fact);
    store.apply({ kind: "link-by-call", id: "claude:s1:a1" as AgentId, callId: "agent-1", fallback: root });
    expect(store.node("claude:s1:a1" as AgentId)?.parent).toBe(run);
  });

  it("ignores other skills and creates a run for unseen attribution", () => {
    const parser = claude();
    expect(parser.line(assistant([tool("x", "Skill", { skill: "other:skill" })], "other:skill"), 0).facts.some((fact) => fact.kind === "agent" && fact.id.startsWith("skill:"))).toBe(false);
    const unseen = parser.line(assistant([{ type: "text", text: "done" }], "pstack:deslop"), 1);
    expect(unseen.facts).toContainEqual(expect.objectContaining({ kind: "agent", patch: expect.objectContaining({ flavor: expect.objectContaining({ trigger: { kind: "model" } }) }) }));
  });

  it("creates no run from the attribution a subagent inherits from its parent", () => {
    const parser = claudeAdapter("/tmp/claude").open("/tmp/claude/projects/-repo/s1/subagents/agent-a1.jsonl");
    const parsed = parser.line(assistant([{ type: "text", text: "reviewing" }], "pstack:no-comments"), 0);
    expect(parsed.facts.some((fact) => fact.kind === "agent" && fact.id.startsWith("skill:"))).toBe(false);
  });

  it("keeps the session's own activity while a run is current", () => {
    const parser = claude();
    parser.line(assistant([tool("skill-1", "Skill", { skill: "pstack:deslop" })]), 0);
    const parsed = parser.line(assistant([tool("t1", "Bash", { command: "ls" })], "pstack:deslop"), 1);
    expect(parsed.facts).toContainEqual(expect.objectContaining({ kind: "activity", id: root }));
    expect(parsed.facts).toContainEqual(expect.objectContaining({ kind: "activity", id: run }));
  });

  it("keeps the subagent's last assistant text as its response", () => {
    const parser = claudeAdapter("/tmp/claude").open("/tmp/claude/projects/-repo/s1/subagents/agent-a1.jsonl");
    const first = parser.line(assistant([{ type: "text", text: "draft" }]), 0);
    const last = parser.line(assistant([{ type: "text", text: "final review" }]), 1);
    const store = new Store();
    for (const fact of [...first.facts, ...last.facts]) store.apply(fact);
    expect(store.node("claude:s1:a1" as AgentId)?.result).toEqual({ kind: "text", body: { text: "final review", omitted: 0 } });
  });

  it("keeps a run live only while its runner works and counts skills separately", () => {
    const store = new Store();
    store.apply({ kind: "agent", id: root, patch: { harness: "claude", flavor: { kind: "session" } } });
    store.apply({ kind: "turn", id: root, turnId: "turn", at, event: { kind: "started" } });
    store.apply({ kind: "agent", id: run, patch: { harness: "claude", root, flavor: { kind: "skill", skill: "pstack:deslop", runner: root, trigger: { kind: "model" } }, seenAt: at } });
    store.apply({ kind: "link", id: run, parent: root, via: "skill" });
    store.apply({ kind: "current-skill", agent: root, run });
    expect(store.node(run)?.status.kind).toBe("running");
    store.apply({ kind: "current-skill", agent: root, run: null });
    expect(store.node(run)?.status.kind).toBe("done");
    const tree = treeOf(root, new Map(store.nodes().map((node) => [node.id, node])))!;
    expect(tree.step.get(run)).toBe(1);
    expect(countsOf(tree)).toMatchObject({ spawned: 0, skills: 1, running: 0 });
  });
});

describe("lane calls", () => {
  function fixture(command: string, when: string, label = "review") {
    const store = new Store();
    const lane = "lane:l1" as AgentId;
    store.apply({ kind: "agent", id: root, patch: { flavor: { kind: "session" } } });
    store.apply({ kind: "agent", id: run, patch: { root, flavor: { kind: "skill", skill: "pstack:deslop", runner: root, trigger: { kind: "model" } } } });
    store.apply({ kind: "link", id: run, parent: root, via: "skill" });
    store.apply({ kind: "agent", id: lane, patch: { root, flavor: { kind: "lane", mode: "read-only", stream: "live", label, receipt: null }, seenAt: "2026-10-01T10:00:30.000Z", receiptPath: "/tmp/receipt.json", resultPath: "/tmp/output.md" } });
    store.apply({ kind: "link", id: lane, parent: root, via: "runner" });
    store.apply({ kind: "lane-call", by: run, callId: "c1", at: when, command });
    return { store, lane };
  }
  it("matches literal receipt paths and labels", () => {
    for (const command of ["pstack-runner /tmp/receipt.json", "pstack-runner /tmp/output.md", "pstack-runner --label review"]) {
      const { store, lane } = fixture(command, "2026-10-01T09:00:00.000Z");
      expect(store.node(lane)?.parent).toBe(run);
      expect(store.node(lane)?.result).toEqual({ kind: "file", bytes: null });
    }
  });
  it("uses the 120 second window and otherwise leaves the session parent", () => {
    expect(fixture("pstack-runner --receipt $S/r", at).store.node("lane:l1" as AgentId)?.parent).toBe(run);
    expect(fixture("pstack-runner --receipt $S/r", "2026-10-01T09:57:00.000Z").store.node("lane:l1" as AgentId)?.parent).toBe(root);
  });
  it("shows a file result only after the lane records its output path", () => {
    const { store, lane } = fixture("pstack-runner", at);
    const without = new Store();
    without.apply({ kind: "agent", id: lane, patch: { flavor: { kind: "lane", mode: "read-only", stream: "live", label: null, receipt: null } } });
    expect(without.node(lane)?.result).toBeNull();
    expect(store.node(lane)?.result).toEqual({ kind: "file", bytes: null });
  });
});

describe("Codex skills", () => {
  it("starts a flat run from SKILL.md and attaches spawned threads to it", () => {
    const thread = "01a0aaaa-0000-7000-8000-000000000001";
    const parser = codexAdapter("/tmp/codex").open(`/tmp/codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${thread}.jsonl`);
    const line = (payload: unknown, offset: number) => parser.line(JSON.stringify({ type: "response_item", timestamp: at, payload }), offset);
    const skill = line({ type: "function_call", name: "exec_command", arguments: '{"cmd":"cat plugins/pstack/skills/deslop/SKILL.md"}', call_id: "s1" }, 1);
    expect(skill.facts).toContainEqual(expect.objectContaining({ kind: "agent", patch: expect.objectContaining({ flavor: expect.objectContaining({ skill: "pstack:deslop" }) }) }));
    const spawned = line({ type: "function_call", name: "spawn_agent", arguments: "{}", call_id: "a1" }, 2);
    expect(spawned.facts).toContainEqual({ kind: "spawn-call", by: `skill:codex:${thread}/s1`, callId: "a1" } as never);
    const child = line({ type: "function_call_output", call_id: "a1", output: 'agent_id: 01a0bbbb-0000-7000-8000-000000000002' }, 3);
    expect(child.facts).toContainEqual({ kind: "link", id: "codex:01a0bbbb-0000-7000-8000-000000000002", parent: `skill:codex:${thread}/s1`, via: "thread-spawn" } as never);
    const complete = parser.line(JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "task_complete", turn_id: "turn" } }), 4);
    expect(complete.facts).toContainEqual({ kind: "current-skill", agent: `codex:${thread}`, run: null } as never);
  });
});
