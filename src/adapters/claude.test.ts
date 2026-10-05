import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Fact } from "../adapter.ts";
import { claudeAdapter, procStartMs } from "./claude.ts";

const home = "/home/u/.claude";
const adapter = claudeAdapter(home);
const sessionPath = join(home, "projects", "-repo", "s1.jsonl");
const subagentPath = join(home, "projects", "-repo", "s1", "subagents", "agent-a1.jsonl");
const metaPath = join(home, "projects", "-repo", "s1", "subagents", "agent-a1.meta.json");

const base = { sessionId: "s1", cwd: "/repo", version: "2.1.287", entrypoint: "cli", gitBranch: "main", uuid: "u", parentUuid: null };
const line = (record: Record<string, unknown>): string => JSON.stringify({ ...base, timestamp: "2026-10-01T10:00:00.000Z", ...record });

function kinds(facts: readonly Fact[]): string[] {
  return facts.map((fact) => fact.kind);
}

describe("claim", () => {
  it("recognizes sessions, subagents, sidecars, and process records", () => {
    expect(adapter.claim(sessionPath)).toEqual({ kind: "stream", agent: "claude:s1", root: "claude:s1", header: false } as never);
    expect(adapter.claim(subagentPath)).toEqual({ kind: "stream", agent: "claude:s1:a1", root: "claude:s1", header: false } as never);
    expect(adapter.claim(metaPath)).toEqual({ kind: "document", agent: "claude:s1:a1", always: false } as never);
    expect(adapter.claim(join(home, "sessions", "123.json"))).toEqual({ kind: "document", agent: null, always: true });
    expect(adapter.claim(join(home, "sessions", "123.key"))).toBeNull();
    expect(adapter.claim(join(home, "history.jsonl"))).toBeNull();
  });
});

describe("session transcript", () => {
  const parser = () => adapter.open(sessionPath);

  it("reads assistant text, usage keyed by message, and spawn calls", () => {
    const parsed = parser().line(line({
      type: "assistant",
      effort: "high",
      message: {
        id: "msg-1",
        model: "claude-test-model",
        usage: { input_tokens: 3, output_tokens: 7 },
        content: [
          { type: "text", text: "Looking now." },
          { type: "tool_use", id: "call-1", name: "Agent", input: { description: "Map the repo", subagent_type: "Explore" } },
        ],
      },
    }), 120);
    expect(parsed.problem).toBeNull();
    expect(parsed.cliVersion).toBe("2.1.287");
    expect(kinds(parsed.facts)).toContain("spawn-call");
    expect(parsed.facts).toContainEqual({ kind: "usage", id: "claude:s1", key: "msg-1", usage: { inputTokens: 3, outputTokens: 7 } } as never);
    expect(parsed.facts).toContainEqual({ kind: "agent", id: "claude:s1", patch: { reportedModel: "claude-test-model", effort: "high" } } as never);
    expect(parsed.items.map((item) => `${item.id} ${item.kind}`)).toEqual(["120.0 text", "120.1 tool-call"]);
    const activity = parsed.facts.filter((fact) => fact.kind === "activity").at(-1);
    expect(activity).toMatchObject({ activity: { what: "tool", snippet: "Agent · Map the repo" } });
  });

  it("records sync and async Agent results as child outcomes", () => {
    const result = (status: string) => parser().line(line({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "ok" }] }] },
      toolUseResult: { agentId: "a1", status },
    }), 0);
    expect(result("completed").facts).toContainEqual({ kind: "child-outcome", callId: "call-1", outcome: "done", at: "2026-10-01T10:00:00.000Z", reason: null } as never);
    expect(result("async_launched").facts).toContainEqual(expect.objectContaining({ kind: "child-outcome", outcome: "launched" }));
    expect(result("completed").items[0]).toMatchObject({ kind: "tool-result", callId: "call-1", ok: true });
  });

  it("reads background task notifications", () => {
    const parsed = parser().line(line({
      type: "user",
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content: "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>call-1</tool-use-id>\n<status>killed</status>\n<summary>Agent stopped</summary>\n</task-notification>",
      },
    }), 0);
    expect(parsed.facts).toContainEqual(expect.objectContaining({ kind: "child-outcome", callId: "call-1", outcome: "cancelled" }));
    expect(parsed.items[0]).toMatchObject({ kind: "notice", text: "Agent stopped" });
  });

  it("turns human prompts into prompt items and title hints, but not injected context", () => {
    const prompt = parser().line(line({ type: "user", message: { role: "user", content: "Build the monitor" } }), 0);
    expect(prompt.items[0]).toMatchObject({ kind: "prompt", body: { text: "Build the monitor", omitted: 0 } });
    expect(prompt.facts).toContainEqual({ kind: "agent", id: "claude:s1", patch: { titleHint: "Build the monitor" } } as never);
    const meta = parser().line(line({ type: "user", isMeta: true, message: { role: "user", content: "caveat" } }), 0);
    expect(meta.items).toEqual([]);
    const command = parser().line(line({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } }), 0);
    expect(command.items[0]).toMatchObject({ kind: "notice", text: "ran /model" });
  });

  it("opens a turn on a human prompt and closes it only at the end of the reply", () => {
    const turns = (record: Record<string, unknown>) => parser().line(line(record), 0).facts.filter((fact) => fact.kind === "turn");
    const reply = (stop_reason: string | null) => turns({ type: "assistant", message: { id: "m1", stop_reason, content: [{ type: "text", text: "ok" }] } });
    expect(turns({ type: "user", message: { role: "user", content: "Build the monitor" } })).toEqual([
      { kind: "turn", id: "claude:s1", turnId: "turn", at: "2026-10-01T10:00:00.000Z", event: { kind: "started" } },
    ] as never);
    expect(reply("tool_use")).toEqual([]);
    expect(reply(null)).toEqual([]);
    expect(reply("end_turn")).toMatchObject([{ event: { kind: "ended", outcome: "done" } }]);
    expect(reply("stop_sequence")).toMatchObject([{ event: { kind: "ended", outcome: "done" } }]);
    expect(turns({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }))
      .toMatchObject([{ event: { kind: "ended", outcome: "cancelled" } }]);
    expect(turns({ type: "user", isMeta: true, message: { role: "user", content: "caveat" } })).toEqual([]);
    expect(turns({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } })).toEqual([]);
  });

  it("records the prompt an agent is working on", () => {
    const prompt = parser().line(line({ type: "user", message: { role: "user", content: "Build the\nmonitor" } }), 0);
    expect(prompt.facts).toContainEqual({ kind: "prompt", id: "claude:s1", text: "Build the monitor", at: "2026-10-01T10:00:00.000Z" } as never);
    const reminder = parser().line(line({ type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>" } }), 0);
    expect(kinds(reminder.facts)).not.toContain("prompt");
  });

  it("reports the tool call awaiting its result", () => {
    const call = parser().line(line({
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "bun test" } }] },
    }), 0);
    expect(call.facts).toContainEqual({
      kind: "call",
      id: "claude:s1",
      callId: "call-1",
      at: "2026-10-01T10:00:00.000Z",
      event: { kind: "started", name: "Bash", snippet: "Bash · bun test" },
    } as never);
    const result = (extra: Record<string, unknown>) => parser().line(line({
      type: "user",
      ...extra,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    }), 0);
    const ended = { kind: "call", id: "claude:s1", callId: "call-1", at: "2026-10-01T10:00:00.000Z", event: { kind: "ended" } };
    expect(result({}).facts).toContainEqual(ended as never);
    expect(result({ isMeta: true }).facts).toContainEqual(ended as never);
  });

  it("flags pstack work from attribution, skills, agents, and commands", () => {
    const flagged = (record: Record<string, unknown>) => kinds(parser().line(line(record), 0).facts).includes("pstack");
    const assistant = (extra: Record<string, unknown>, content: unknown[] = [{ type: "text", text: "ok" }]) =>
      ({ type: "assistant", ...extra, message: { id: "m1", content } });
    const tool = (name: string, input: Record<string, unknown>) => assistant({}, [{ type: "tool_use", id: "c1", name, input }]);
    expect(flagged(assistant({ attributionPlugin: "pstack" }))).toBe(true);
    expect(flagged(assistant({ attributionSkill: "pstack:poteto-mode" }))).toBe(true);
    expect(flagged(assistant({ attributionAgent: "pstack:pstack-opus-high" }))).toBe(true);
    expect(flagged(assistant({ attributionPlugin: "caveman" }))).toBe(false);
    expect(flagged(tool("Skill", { skill: "pstack:arena" }))).toBe(true);
    expect(flagged(tool("Skill", { skill: "impeccable" }))).toBe(false);
    expect(flagged(tool("Agent", { subagent_type: "pstack:pstack-fable-high", prompt: "x" }))).toBe(true);
    expect(flagged(tool("Agent", { subagent_type: "Explore", prompt: "x" }))).toBe(false);
    expect(flagged({ type: "user", message: { role: "user", content: "<command-name>/pstack:monitor</command-name>" } })).toBe(true);
    expect(flagged({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } })).toBe(false);
  });

  it("turns SendMessage calls into messages, leaving other sessions' sockets out", () => {
    const send = (to: string) => parser().line(line({
      type: "assistant",
      message: { id: "m9", content: [{ type: "tool_use", id: `call-${to.length}`, name: "SendMessage", input: { to, message: "status?" } }] },
    }), 0);
    expect(send("a1").facts).toContainEqual({
      kind: "message",
      key: "claude:call-2",
      from: { kind: "agent", id: "claude:s1" },
      to: { kind: "claude-target", session: "claude:s1", target: "a1" },
      at: "2026-10-01T10:00:00.000Z",
    } as never);
    expect(send("uds:/tmp/cc-socks/1.sock").facts.some((fact) => fact.kind === "message")).toBe(false);
  });

  it("takes the AI title as the session title", () => {
    const parsed = parser().line(JSON.stringify({ type: "ai-title", aiTitle: "Agent monitor", sessionId: "s1" }), 0);
    expect(parsed.facts).toEqual([{ kind: "agent", id: "claude:s1", patch: { title: "Agent monitor" } }] as never);
  });

  it("degrades visibly on unknown or malformed records", () => {
    const unknown = parser().line(line({ type: "brand-new-record" }), 40);
    expect(unknown.problem).toEqual({ kind: "unknown-type", recordType: "brand-new-record" });
    expect(unknown.items[0]).toMatchObject({ kind: "unparsed", recordType: "brand-new-record" });
    expect(parser().line(line({ type: "assistant" }), 0).problem).toMatchObject({ kind: "shape", recordType: "assistant" });
    expect(parser().line("{not json", 0).problem).toEqual({ kind: "not-json" });
    expect(parser().line(line({ type: "attachment", attachment: {} }), 0).problem).toBeNull();
  });
});

describe("subagent transcript", () => {
  it("reports itself as a subagent of its session", () => {
    const parsed = adapter.open(subagentPath).line(line({ type: "user", isSidechain: true, agentId: "a1", message: { role: "user", content: "Task brief" } }), 0);
    expect(parsed.facts[0]).toMatchObject({
      kind: "agent",
      id: "claude:s1:a1",
      patch: { flavor: { kind: "subagent", agentType: null }, root: "claude:s1" },
    });
  });
});

describe("documents", () => {
  it("links a subagent to the call that spawned it", () => {
    const parsed = adapter.document(metaPath, JSON.stringify({ agentType: "Explore", description: "Map the repo", toolUseId: "call-1", spawnDepth: 1 }));
    expect(parsed.facts).toEqual([
      {
        kind: "agent",
        id: "claude:s1:a1",
        patch: {
          harness: "claude",
          source: "claude-session",
          flavor: { kind: "subagent", agentType: "Explore" },
          root: "claude:s1",
          title: "Map the repo",
        },
      },
      { kind: "link-by-call", id: "claude:s1:a1", callId: "call-1", fallback: "claude:s1" },
    ] as never);
    const stopped = adapter.document(metaPath, JSON.stringify({ agentType: "Explore", toolUseId: "call-1", stoppedByUser: true }));
    expect(kinds(stopped.facts)).toContain("outcome");
    const lane = adapter.document(metaPath, JSON.stringify({ agentType: "pstack:pstack-opus-high", toolUseId: "call-1" }));
    expect(lane.facts).toContainEqual({ kind: "pstack", id: "claude:s1:a1" } as never);
  });

  it("turns a process record into a probe-able process", () => {
    const path = join(home, "sessions", "29441.json");
    const parsed = adapter.document(path, JSON.stringify({
      pid: 29441,
      sessionId: "s1",
      cwd: "/repo",
      procStart: "Fri Oct  2 04:15:58 2026",
      status: "busy",
      kind: "interactive",
      entrypoint: "cli",
    }));
    expect(parsed.facts[1]).toEqual({
      kind: "process",
      key: path,
      id: "claude:s1",
      process: { pid: 29441, startedAtMs: Date.UTC(2026, 9, 2, 4, 15, 58), state: "busy" },
    } as never);
    expect(adapter.removed(path)).toEqual([{ kind: "process-gone", key: path }]);
    expect(adapter.document(path, "{}").problem).toMatchObject({ kind: "shape" });
  });

  it("parses ps-style start times as UTC", () => {
    expect(procStartMs("Thu Oct  1 23:59:59 2026")).toBe(Date.UTC(2026, 9, 1, 23, 59, 59));
    expect(procStartMs("garbage")).toBeNull();
  });
});
