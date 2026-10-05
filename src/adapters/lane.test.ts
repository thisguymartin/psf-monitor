import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Fact } from "../adapter.ts";
import { laneAdapter } from "./lane.ts";

const root = "/home/u/.pstack-flex/lanes";
const adapter = laneAdapter(root);
const dir = join(root, "lane-1");
const id = "lane:lane-1";

const record = {
  schemaVersion: 1,
  laneId: "lane-1",
  runnerPid: 4242,
  startedAt: "2026-10-02T10:00:00.000Z",
  parent: "claude",
  parentSessionId: "s1",
  provider: "codex",
  model: "gpt-6-astra",
  effort: "high",
  mode: "read-only",
  label: "arena cross-judge",
  cwd: "/repo",
  promptPath: "/tmp/p.md",
  outputPath: "/tmp/o.md",
  receiptPath: "/tmp/r.json",
};

function kinds(facts: readonly Fact[]): string[] {
  return facts.map((fact) => fact.kind);
}

describe("claim", () => {
  it("recognizes the three journal files and nothing else", () => {
    expect(adapter.claim(join(dir, "lane.json"))).toEqual({ kind: "document", agent: id, always: true } as never);
    expect(adapter.claim(join(dir, "receipt.json"))).toEqual({ kind: "document", agent: id, always: true } as never);
    expect(adapter.claim(join(dir, "stream.jsonl"))).toEqual({ kind: "stream", agent: id, root: id, header: false } as never);
    expect(adapter.claim(join(dir, "lane.json.4242.tmp"))).toBeNull();
    expect(adapter.claim(join(root, "stray.json"))).toBeNull();
  });
});

describe("lane record", () => {
  it("names the lane, links it to the parent session, and records the runner process", () => {
    const parsed = adapter.document(join(dir, "lane.json"), JSON.stringify(record));
    expect(parsed.problem).toBeNull();
    expect(parsed.facts[0]).toMatchObject({
      kind: "agent",
      id,
      patch: {
        harness: "claude",
        source: "runner-lane",
        provider: "codex",
        requestedModel: "gpt-6-astra",
        effort: "high",
        title: "arena cross-judge",
        flavor: { kind: "lane", mode: "read-only", stream: "live", label: "arena cross-judge", receipt: null },
      },
    });
    expect(parsed.facts).toContainEqual({
      kind: "process",
      key: join(dir, "lane.json"),
      id,
      process: { pid: 4242, startedAtMs: Date.parse(record.startedAt), state: "running" },
    } as never);
    expect(parsed.facts).toContainEqual({ kind: "link", id, parent: "claude:s1", via: "runner" } as never);
  });

  it("marks lanes whose CLI prints only at exit", () => {
    const parsed = adapter.document(join(dir, "lane.json"), JSON.stringify({ ...record, provider: "deepseek" }));
    expect(parsed.facts[0]).toMatchObject({ patch: { flavor: { stream: "at-exit" } } });
  });

  it("leaves a lane without a parent session as its own root", () => {
    const parsed = adapter.document(join(dir, "lane.json"), JSON.stringify({ ...record, parentSessionId: null }));
    expect(kinds(parsed.facts)).not.toContain("link");
  });

  it("is always pstack work and carries what the lane was asked", () => {
    for (const provider of ["codex", "claude", "grok", "deepseek", "minimax"]) {
      const parsed = adapter.document(join(dir, "lane.json"), JSON.stringify({ ...record, provider, label: null, promptHead: "Judge the candidates." }));
      expect(parsed.facts).toContainEqual({ kind: "pstack", id } as never);
      expect(parsed.facts).toContainEqual({ kind: "prompt", id, text: "Judge the candidates.", at: record.startedAt } as never);
      expect(parsed.facts[0]).toMatchObject({ patch: { provider, titleHint: "Judge the candidates." } });
    }
    const older = adapter.document(join(dir, "lane.json"), JSON.stringify(record));
    expect(kinds(older.facts)).toContain("pstack");
    expect(kinds(older.facts)).not.toContain("prompt");
  });

  it("streams Codex and Grok lanes and waits for exit on Claude, DeepSeek, and MiniMax", () => {
    const stream = (provider: string) =>
      (adapter.document(join(dir, "lane.json"), JSON.stringify({ ...record, provider })).facts[0] as { patch: { flavor: { stream: string } } }).patch.flavor.stream;
    expect(["codex", "grok", "claude", "deepseek", "minimax"].map(stream)).toEqual(["live", "live", "at-exit", "at-exit", "at-exit"]);
  });

  it("rejects a record without the fields it needs", () => {
    expect(adapter.document(join(dir, "lane.json"), JSON.stringify({ provider: "codex" })).problem).toMatchObject({ kind: "shape" });
  });
});

describe("receipt", () => {
  const receipt = (status: string, extra: Record<string, unknown> = {}) =>
    adapter.document(join(dir, "receipt.json"), JSON.stringify({ status, provider: "codex", mode: "read-only", completedAt: "2026-10-02T10:05:00.000Z", ...extra }));

  it("maps every receipt status to an outcome", () => {
    const outcome = (status: string) => receipt(status).facts.find((fact) => fact.kind === "outcome");
    expect(outcome("complete")).toMatchObject({ outcome: "done", reason: null });
    expect(outcome("cancelled")).toMatchObject({ outcome: "cancelled" });
    for (const status of ["unavailable-cli", "unauthenticated", "unavailable-model", "timed-out", "child-failed", "malformed-output"]) {
      expect(outcome(status)).toMatchObject({ outcome: "failed" });
    }
    expect(receipt("exploded").problem).toMatchObject({ kind: "shape" });
  });

  it("explains a failure and carries usage and the reported model", () => {
    const parsed = receipt("child-failed", {
      error: { message: "exit 1", evidence: "" },
      usage: { inputTokens: 20, outputTokens: 3 },
      reportedModel: "gpt-6-astra-2026",
    });
    expect(parsed.facts).toContainEqual(expect.objectContaining({ kind: "outcome", reason: "child failed: exit 1" }));
    expect(parsed.facts).toContainEqual({ kind: "usage", id, key: null, usage: { inputTokens: 20, outputTokens: 3 } } as never);
    expect(parsed.facts[0]).toMatchObject({ patch: { reportedModel: "gpt-6-astra-2026", flavor: { receipt: "child-failed" } } });
  });

  it("retracts the runner process when the lane record disappears", () => {
    expect(adapter.removed(join(dir, "lane.json"))).toEqual([{ kind: "process-gone", key: join(dir, "lane.json") }]);
    expect(adapter.removed(join(dir, "receipt.json"))).toEqual([]);
  });
});

describe("stream", () => {
  it("reads Codex exec events, pairing a command with its output", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    expect(parser.line(JSON.stringify({ type: "thread.started", thread_id: "t" }), 0).items).toEqual([]);
    const started = parser.line(JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "git diff", status: "in_progress" } }), 10);
    expect(started.items[0]).toMatchObject({ kind: "tool-call", callId: "i1", name: "shell", input: { text: "git diff" } });
    const done = parser.line(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "git diff", aggregated_output: "+x", exit_code: 0 } }), 20);
    expect(done.items).toEqual([{ id: "20.1", at: null, kind: "tool-result", callId: "i1", ok: true, output: { text: "+x", omitted: 0 } }] as never);
    const message = parser.line(JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Candidate 2 wins." } }), 30);
    expect(message.items[0]).toMatchObject({ kind: "text", body: { text: "Candidate 2 wins." } });
    const usage = parser.line(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 2 } }), 40);
    expect(usage.facts[0]).toMatchObject({ kind: "usage", usage: { inputTokens: 9, outputTokens: 2 } });
    const failed = parser.line(JSON.stringify({ type: "turn.failed", error: { message: "quota" } }), 50);
    expect(failed.items[0]).toMatchObject({ kind: "notice", level: "error", text: "quota" });
  });

  it("emits a call for a command seen only on completion", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    const done = parser.line(JSON.stringify({ type: "item.completed", item: { id: "i9", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 2 } }), 0);
    expect(done.items.map((item) => item.kind)).toEqual(["tool-call", "tool-result"]);
    expect(done.items[1]).toMatchObject({ ok: false });
  });

  it("reads the single result a Claude-style CLI prints at exit", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    const parsed = parser.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "CLAUDE_OK", usage: { input_tokens: 10, output_tokens: 2 } }), 0);
    expect(parsed.items[0]).toMatchObject({ kind: "text", body: { text: "CLAUDE_OK" } });
    expect(parsed.facts).toContainEqual({ kind: "usage", id, key: null, usage: { inputTokens: 10, outputTokens: 2 } } as never);
  });

  it("reads Grok's streamed assistant messages", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    const parsed = parser.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "progress" }] } }), 0);
    expect(parsed.items[0]).toMatchObject({ kind: "text", body: { text: "progress" } });
  });

  it("tracks the call a Grok lane is waiting on", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    const call = parser.line(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "g1", name: "read_file", input: { path: "src/a.ts" } }] },
    }), 0);
    expect(call.facts).toContainEqual({ kind: "call", id, callId: "g1", at: null, event: { kind: "started", name: "read_file", snippet: "read_file · src/a.ts" } } as never);
    const result = parser.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "x" }] } }), 10);
    expect(result.facts).toEqual([{ kind: "call", id, callId: "g1", at: null, event: { kind: "ended" } }] as never);
  });

  it("tracks the item a Codex lane is waiting on", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    const started = parser.line(JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bun test" } }), 0);
    expect(started.facts).toContainEqual(expect.objectContaining({ kind: "call", callId: "i1", event: expect.objectContaining({ kind: "started" }) }));
    const done = parser.line(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bun test", exit_code: 0 } }), 10);
    expect(done.facts).toEqual([{ kind: "call", id, callId: "i1", at: null, event: { kind: "ended" } }] as never);
    const once = adapter.open(join(dir, "stream.jsonl")).line(JSON.stringify({ type: "item.completed", item: { id: "i2", type: "command_execution", command: "ls", exit_code: 0 } }), 0);
    expect(once.facts.filter((fact) => fact.kind === "call").map((fact) => (fact as { event: { kind: string } }).event.kind)).toEqual(["started", "ended"]);
  });

  it("reports events it does not recognize", () => {
    const parser = adapter.open(join(dir, "stream.jsonl"));
    expect(parser.line(JSON.stringify({ type: "hologram" }), 0).problem).toEqual({ kind: "unknown-type", recordType: "hologram" });
    expect(parser.line(JSON.stringify({ type: "item.completed", item: { id: "x", type: "hologram" } }), 0).problem).toEqual({ kind: "unknown-type", recordType: "item/hologram" });
  });
});
