import { describe, expect, it } from "bun:test";
import type { AgentNode, AgentStatus, Flavor } from "./domain.ts";
import { activityLine, ago, compactNumber, duration, prettyModel, shortPath, statusLine, summarizeInput } from "./format.ts";

const now = Date.parse("2026-10-01T12:00:00Z");
const node = (status: AgentStatus, flavor: Flavor = { kind: "session" }, extra: Partial<AgentNode> = {}): AgentNode => ({
  status,
  flavor,
  startedAt: "2026-10-01T11:57:46Z",
  lastActivityAt: "2026-10-01T11:57:00Z",
  activity: null,
  pending: null,
  ...extra,
}) as AgentNode;

describe("format", () => {
  it("compacts token counts", () => {
    expect([999, 1_000, 1_250, 12_400, 412_000, 1_200_000].map(compactNumber)).toEqual(["999", "1k", "1.3k", "12k", "412k", "1.2M"]);
  });

  it("formats durations and ages", () => {
    expect(duration(8_000)).toBe("8s");
    expect(duration(134_000)).toBe("2m 14s");
    expect(duration(3 * 3_600_000 + 5 * 60_000)).toBe("3h 05m");
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(ago("2026-10-01T11:59:55Z", now)).toBe("just now");
    expect(ago("2026-10-01T11:56:00Z", now)).toBe("4m ago");
    expect(ago(null, now)).toBe("");
  });

  it("shortens Claude model slugs and leaves others alone", () => {
    expect(prettyModel(["claude", "opus", "5", "5"].join("-"))).toBe("opus 5.5");
    expect(prettyModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(prettyModel(null)).toBeNull();
  });

  it("summarizes tool input by its most telling field", () => {
    expect(summarizeInput('{\n  "command": "git status --short",\n  "description": "x"\n}')).toBe("git status --short");
    expect(summarizeInput('{"file_path": "/repo/a.ts"')).toBe('{"file_path": "/repo/a.ts"');
    expect(summarizeInput("ls -la\nmore")).toBe("ls -la");
  });

  it("keeps the last two path segments", () => {
    expect(shortPath("/Users/me/workspace/pstack-flex")).toBe("…/workspace/pstack-flex");
    expect(shortPath("/repo")).toBe("/repo");
  });

  it("says whether an agent works, waits for input, or is gone", () => {
    const subagent: Flavor = { kind: "subagent", agentType: null };
    const fresh = { activity: { what: "tool", snippet: "Bash · ls", at: "2026-10-01T11:59:50Z" }, lastActivityAt: "2026-10-01T11:59:50Z" } as const;
    expect(statusLine(node({ kind: "running", evidence: "pid" }, { kind: "session" }, fresh), now)).toBe("working · 2m 14s");
    expect(statusLine(node({ kind: "running", evidence: "lifecycle" }, subagent, fresh), now)).toBe("in turn · 2m 14s");
    expect(statusLine(node({ kind: "running", evidence: "parent" }, subagent, fresh), now)).toBe("running · 2m 14s");
    expect(statusLine(node({ kind: "idle", evidence: "pid", detail: null }), now)).toBe("waiting for input · 3m ago");
    expect(statusLine(node({ kind: "idle", evidence: "lifecycle", detail: null }), now)).toBe("between turns · 3m ago");
    expect(statusLine(node({ kind: "ended", at: null }), now)).toBe("ended · process gone");
    expect(statusLine(node({ kind: "ended", at: null }, subagent), now)).toBe("ended · 3m ago");
  });

  it("flags a running agent as quiet only when its source stamps activity", () => {
    const stale = { activity: { what: "text", snippet: "x", at: "2026-10-01T11:57:00Z" } } as const;
    expect(statusLine(node({ kind: "running", evidence: "lifecycle" }, { kind: "session" }, stale), now)).toBe("in turn · 2m 14s · quiet 3m 00s");
    const lane: Flavor = { kind: "lane", mode: "read-only", stream: "at-exit", label: null, receipt: null };
    expect(statusLine(node({ kind: "running", evidence: "pid" }, lane), now)).toBe("working · 2m 14s");
  });

  it("calls a turn stalled once it has been silent for 15 minutes, but never a live process", () => {
    const old = { lastActivityAt: "2026-10-01T11:40:00Z" } as const;
    expect(statusLine(node({ kind: "running", evidence: "lifecycle" }, { kind: "session" }, old), now)).toBe("stalled · 20m ago");
    expect(statusLine(node({ kind: "running", evidence: "pid" }, { kind: "session" }, old), now)).toBe("working · 2m 14s");
  });

  it("names the call an agent waits on before its latest step", () => {
    const lane: Flavor = { kind: "lane", mode: "read-only", stream: "at-exit", label: null, receipt: null };
    const pending = { name: "Bash", snippet: "Bash · bun test", since: null };
    const activity = { what: "text", snippet: "Looking", at: null } as const;
    expect(activityLine(node({ kind: "running", evidence: "pid" }, { kind: "session" }, { pending, activity }))).toBe("Bash · bun test");
    expect(activityLine(node({ kind: "running", evidence: "pid" }, { kind: "session" }, { activity }))).toBe("Looking");
    expect(activityLine(node({ kind: "running", evidence: "pid" }, lane))).toBe("reply arrives at exit");
    expect(activityLine(node({ kind: "done", at: null }, lane))).toBeNull();
  });
});
