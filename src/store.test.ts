import { describe, expect, it } from "bun:test";
import type { Fact } from "./adapter.ts";
import type { AgentId } from "./domain.ts";
import { Store } from "./store.ts";

const root = "claude:s1" as AgentId;
const child = "claude:s1:a1" as AgentId;
const grandchild = "claude:s1:a2" as AgentId;

function store(...facts: Fact[]): Store {
  const result = new Store();
  for (const fact of facts) result.apply(fact);
  return result;
}

const session: Fact = {
  kind: "agent",
  id: root,
  patch: { harness: "claude", source: "claude-session", flavor: { kind: "session" }, entrypoint: "cli" },
};
const subagent: Fact = {
  kind: "agent",
  id: child,
  patch: { harness: "claude", source: "claude-session", flavor: { kind: "subagent", agentType: "Explore" }, root },
};
const pidFile = (state: string, pid = 10): Fact => ({
  kind: "process",
  key: "/sessions/10.json",
  id: root,
  process: { pid, startedAtMs: null, state },
});

const started = (id: AgentId, at: string): Fact => ({ kind: "turn", id, turnId: "turn", at, event: { kind: "started" } });
const finished = (id: AgentId, at: string, outcome: "done" | "cancelled" = "done"): Fact => ({
  kind: "turn",
  id,
  turnId: "turn",
  at,
  event: { kind: "ended", outcome, reason: null },
});

describe("Claude session status", () => {
  it("follows the live process record", () => {
    const busy = store(session, pidFile("busy"));
    busy.setAlive("/sessions/10.json", true);
    expect(busy.node(root)!.status).toEqual({ kind: "running", evidence: "pid" });

    const waiting = store(session, pidFile("waiting"));
    waiting.setAlive("/sessions/10.json", true);
    expect(waiting.node(root)!.status).toEqual({ kind: "idle", evidence: "pid", detail: "waiting" });
  });

  it("ends when the process is gone or its record is removed", () => {
    const dead = store(session, pidFile("busy"));
    dead.setAlive("/sessions/10.json", false);
    expect(dead.node(root)!.status.kind).toBe("ended");

    const removed = store(session, pidFile("busy"), { kind: "process-gone", key: "/sessions/10.json" });
    removed.noteProcessRecords("claude");
    expect(removed.node(root)!.status.kind).toBe("ended");
  });

  it("does not guess without process records", () => {
    expect(store(session).node(root)!.status.kind).toBe("unknown");
  });

  it("follows its turns when it keeps no process record", () => {
    const desktop = store(session, started(root, "t0"));
    expect(desktop.node(root)!.status).toEqual({ kind: "running", evidence: "lifecycle" });
    desktop.apply(finished(root, "t1"));
    expect(desktop.node(root)!.status).toEqual({ kind: "idle", evidence: "lifecycle", detail: null });
    desktop.apply(finished(root, "t2", "cancelled"));
    expect(desktop.node(root)!.status).toEqual({ kind: "idle", evidence: "lifecycle", detail: "interrupted" });
  });

  it("stays ended inside a turn once its terminal process record is gone", () => {
    const gone = store(session, started(root, "t0"));
    gone.noteProcessRecords("claude");
    expect(gone.node(root)!.status.kind).toBe("ended");
  });

  it("keeps the probe result when the record is rewritten for the same process", () => {
    const result = store(session, pidFile("busy"));
    result.setAlive("/sessions/10.json", true);
    result.apply(pidFile("idle"));
    expect(result.node(root)!.status).toEqual({ kind: "idle", evidence: "pid", detail: null });
    result.apply(pidFile("idle", 11));
    expect(result.node(root)!.status.kind).toBe("unknown");
  });
});

describe("Claude subagent status", () => {
  const live = (...facts: Fact[]): Store => {
    const result = store(session, pidFile("busy"), subagent, ...facts);
    result.setAlive("/sessions/10.json", true);
    return result;
  };

  it("runs while its session lives and finishes on the parent's tool result", () => {
    const spawned = live({ kind: "link-by-call", id: child, callId: "call-1", fallback: root });
    expect(spawned.node(child)!.status).toEqual({ kind: "running", evidence: "parent" });
    spawned.apply({ kind: "child-outcome", callId: "call-1", outcome: "done", at: "t", reason: null });
    expect(spawned.node(child)!.status).toEqual({ kind: "done", at: "t" });
  });

  it("keeps running after an async launch until the notification arrives", () => {
    const spawned = live(
      { kind: "link-by-call", id: child, callId: "call-1", fallback: root },
      { kind: "child-outcome", callId: "call-1", outcome: "launched", at: "t0", reason: null },
    );
    expect(spawned.node(child)!.status.kind).toBe("running");
    spawned.apply({ kind: "child-outcome", callId: "call-1", outcome: "cancelled", at: "t1", reason: null });
    expect(spawned.node(child)!.status).toEqual({ kind: "cancelled", at: "t1" });
  });

  it("treats a user stop as cancelled", () => {
    const stopped = live(
      { kind: "link-by-call", id: child, callId: "call-1", fallback: root },
      { kind: "outcome", id: child, outcome: "cancelled", at: null, reason: "stopped by the user" },
    );
    expect(stopped.node(child)!.status.kind).toBe("cancelled");
  });

  it("ends with its session when no outcome was recorded", () => {
    const orphan = live({ kind: "link-by-call", id: child, callId: "call-1", fallback: root });
    orphan.setAlive("/sessions/10.json", false);
    expect(orphan.node(child)!.status.kind).toBe("ended");
  });

  it("finishes on its own end of turn before the parent records a result", () => {
    const spawned = live(
      { kind: "link-by-call", id: child, callId: "call-1", fallback: root },
      started(child, "t0"),
    );
    expect(spawned.node(child)!.status).toEqual({ kind: "running", evidence: "lifecycle" });
    spawned.apply(finished(child, "t1"));
    expect(spawned.node(child)!.status).toEqual({ kind: "done", at: "t1" });
    spawned.apply({ kind: "child-outcome", callId: "call-1", outcome: "launched", at: "t2", reason: null });
    expect(spawned.node(child)!.status).toEqual({ kind: "done", at: "t1" });
    spawned.apply({ kind: "child-outcome", callId: "call-1", outcome: "cancelled", at: "t3", reason: null });
    expect(spawned.node(child)!.status).toEqual({ kind: "cancelled", at: "t3" });
  });

  it("runs mid-turn while its session lives and ends with it", () => {
    const spawned = live({ kind: "link-by-call", id: child, callId: "call-1", fallback: root }, started(child, "t0"));
    expect(spawned.node(child)!.status.kind).toBe("running");
    spawned.setAlive("/sessions/10.json", false);
    expect(spawned.node(child)!.status.kind).toBe("ended");
  });

  it("revives when a message resumes it", () => {
    const resumed = live({ kind: "link-by-call", id: child, callId: "call-1", fallback: root }, started(child, "t0"), finished(child, "t1"));
    resumed.apply(started(child, "t2"));
    expect(resumed.node(child)!.status).toEqual({ kind: "running", evidence: "lifecycle" });
  });

  it("attaches to whichever agent made the spawning call", () => {
    const nested = live(
      { kind: "link-by-call", id: child, callId: "call-1", fallback: root },
      { kind: "agent", id: grandchild, patch: { harness: "claude", flavor: { kind: "subagent", agentType: null }, root } },
      { kind: "link-by-call", id: grandchild, callId: "call-2", fallback: root },
    );
    expect(nested.node(grandchild)!.parent).toBe(root);
    nested.apply({ kind: "spawn-call", by: child, callId: "call-2" });
    expect(nested.node(grandchild)!.parent).toBe(child);
    expect(nested.node(child)!.parent).toBe(root);
  });
});

describe("Codex thread status", () => {
  const thread = "codex:t1" as AgentId;
  const childThread = "codex:t2" as AgentId;
  const facts = (id: AgentId, flavor: "session" | "subagent"): Fact => ({
    kind: "agent",
    id,
    patch: {
      harness: "codex",
      source: "codex-rollout",
      flavor: flavor === "session" ? { kind: "session" } : { kind: "subagent", agentType: "reviewer" },
    },
  });

  it("runs inside a turn and idles between turns at the root", () => {
    const result = store(facts(thread, "session"), { kind: "turn", id: thread, turnId: "u1", at: "t0", event: { kind: "started" } });
    expect(result.node(thread)!.status).toEqual({ kind: "running", evidence: "lifecycle" });
    result.apply({ kind: "turn", id: thread, turnId: "u1", at: "t1", event: { kind: "ended", outcome: "done", reason: null } });
    expect(result.node(thread)!.status).toEqual({ kind: "idle", evidence: "lifecycle", detail: null });
  });

  it("finishes a child with its last turn and revives it on a new one", () => {
    const result = store(
      facts(childThread, "subagent"),
      { kind: "link", id: childThread, parent: thread, via: "thread-spawn" },
      { kind: "turn", id: childThread, turnId: "u1", at: "t0", event: { kind: "started" } },
      { kind: "turn", id: childThread, turnId: "u1", at: "t1", event: { kind: "ended", outcome: "failed", reason: "boom" } },
    );
    expect(result.node(childThread)!.status).toEqual({ kind: "failed", at: "t1", reason: "boom" });
    expect(result.node(childThread)!.parent).toBe(thread);
    result.apply({ kind: "turn", id: childThread, turnId: "u2", at: "t2", event: { kind: "started" } });
    expect(result.node(childThread)!.status.kind).toBe("running");
  });
});

describe("activity", () => {
  const call = (callId: string, at: string, name = "Bash"): Fact => ({
    kind: "call",
    id: root,
    callId,
    at,
    event: { kind: "started", name, snippet: `${name} · ${callId}` },
  });
  const done = (callId: string): Fact => ({ kind: "call", id: root, callId, at: "t9", event: { kind: "ended" } });

  it("keeps the latest call still awaiting its result", () => {
    const result = store(session, started(root, "t0"), call("c1", "t1"));
    expect(result.node(root)!.pending).toEqual({ name: "Bash", snippet: "Bash · c1", since: "t1" });
    result.apply(call("c2", "t2", "Read"));
    expect(result.node(root)!.pending?.snippet).toBe("Read · c2");
    result.apply(done("c1"));
    expect(result.node(root)!.pending?.snippet).toBe("Read · c2");
    result.apply(done("c2"));
    expect(result.node(root)!.pending).toBeNull();
    result.apply(call("c3", "t3"));
    result.apply(finished(root, "t4"));
    expect(result.node(root)!.pending).toBeNull();
  });

  it("keeps the latest prompt", () => {
    const result = store(
      session,
      { kind: "prompt", id: root, text: "first", at: "t0" },
      { kind: "prompt", id: root, text: "second", at: "t1" },
    );
    expect(result.node(root)!.prompt).toEqual({ text: "second", at: "t1" });
    expect(result.node(root)!.lastActivityAt).toBe("t1");
  });
});

describe("pstack scope", () => {
  const other = "claude:s2" as AgentId;
  const otherSession: Fact = { ...session, id: other } as Fact;

  it("marks the whole spawn tree when any member is pstack work", () => {
    const result = store(
      session,
      subagent,
      { kind: "link-by-call", id: child, callId: "call-1", fallback: root },
      otherSession,
    );
    expect(result.node(root)!.pstack).toBe(false);
    result.apply({ kind: "pstack", id: child });
    expect(result.node(root)!.pstack).toBe(true);
    expect(result.node(child)!.pstack).toBe(true);
    expect(result.node(other)!.pstack).toBe(false);
  });

  it("sends the newly marked tree in the next flush", () => {
    const result = store(session, subagent, otherSession);
    result.flush();
    result.apply({ kind: "pstack", id: root });
    const upserts = result.flush()!.upserts.map((node) => node.id).sort();
    expect(upserts).toEqual([root, child].sort());
  });
});

describe("usage", () => {
  it("counts a message split across records once", () => {
    const usage = { inputTokens: 10, outputTokens: 5 };
    const result = store(
      session,
      { kind: "usage", id: root, key: "msg-1", usage },
      { kind: "usage", id: root, key: "msg-1", usage },
      { kind: "usage", id: root, key: "msg-2", usage },
    );
    expect(result.node(root)!.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("lets a cumulative total replace keyed usage", () => {
    const result = store(
      session,
      { kind: "usage", id: root, key: "msg-1", usage: { outputTokens: 5 } },
      { kind: "usage", id: root, key: null, usage: { outputTokens: 42 } },
    );
    expect(result.node(root)!.usage).toEqual({ outputTokens: 42 });
  });
});

describe("message links", () => {
  const codexRoot = "codex:t-root" as AgentId;
  const judge = "codex:t-judge" as AgentId;
  const otherRoot = "codex:t-other" as AgentId;
  const otherJudge = "codex:t-other-judge" as AgentId;
  const codexAgent = (id: AgentId, path: string, parent: AgentId | null): Fact[] => [
    {
      kind: "agent",
      id,
      patch: {
        harness: "codex",
        source: "codex-rollout",
        flavor: parent === null ? { kind: "session" } : { kind: "subagent", agentType: null },
        agentPath: path,
      },
    },
    ...(parent === null ? [] : [{ kind: "link", id, parent, via: "thread-spawn" } as Fact]),
  ];
  const codexMessage = (key: string, near: AgentId, from: string, to: string): Fact => ({
    kind: "message",
    key,
    from: { kind: "codex-path", near, path: from },
    to: { kind: "codex-path", near, path: to },
    at: `2026-10-02T10:00:0${key.length % 10}Z`,
  });

  it("resolves Codex paths within each tree and counts each message once", () => {
    const result = store(
      ...codexAgent(codexRoot, "/root", null),
      ...codexAgent(judge, "/root/judge", codexRoot),
      ...codexAgent(otherRoot, "/root", null),
      ...codexAgent(otherJudge, "/root/judge", otherRoot),
      codexMessage("m1", judge, "/root", "/root/judge"),
      codexMessage("m1", judge, "/root", "/root/judge"),
      codexMessage("m2", judge, "/root", "/root/judge"),
      codexMessage("m3", codexRoot, "/root/judge", "/root"),
      codexMessage("m4", otherJudge, "/root/judge", "/root"),
    );
    const links = result.links().map(({ from, to, count }) => `${from} > ${to} × ${count}`);
    expect(links.sort()).toEqual([
      `${codexRoot} > ${judge} × 2`,
      `${judge} > ${codexRoot} × 1`,
      `${otherJudge} > ${otherRoot} × 1`,
    ].sort());
  });

  it("resolves Claude targets by agent id, name, or main, and drops what it cannot place", () => {
    const named: Fact = { kind: "agent", id: grandchild, patch: { harness: "claude", flavor: { kind: "subagent", agentType: null }, root, agentName: "researcher" } };
    const send = (key: string, from: AgentId, target: string): Fact => ({
      kind: "message",
      key,
      from: { kind: "agent", id: from },
      to: { kind: "claude-target", session: root, target },
      at: null,
    });
    const result = store(session, subagent, named, send("s1", root, "a1"), send("s2", root, "researcher"), send("s3", child, "main"), send("s4", root, "nobody"));
    expect(result.links().map(({ from, to }) => `${from} > ${to}`).sort()).toEqual([
      `${root} > ${child}`,
      `${root} > ${grandchild}`,
      `${child} > ${root}`,
    ].sort());
  });

  it("sends links with a flush only when they change", () => {
    const result = store(...codexAgent(codexRoot, "/root", null), ...codexAgent(judge, "/root/judge", codexRoot));
    // No links yet; the snapshot already says so.
    expect(result.flush()!.links).toBeNull();
    result.apply({ kind: "activity", id: judge, activity: { what: "text", snippet: "x", at: null } });
    expect(result.flush()!.links).toBeNull();
    result.apply(codexMessage("m1", judge, "/root", "/root/judge"));
    expect(result.flush()!.links).toHaveLength(1);
  });
});

describe("flush", () => {
  it("sends only nodes that changed", () => {
    const result = store(session, subagent);
    const first = result.flush()!;
    expect(first.upserts.map((node) => node.id).sort()).toEqual([root, child]);
    expect(result.flush()).toBeNull();
    result.apply({ kind: "activity", id: child, activity: { what: "text", snippet: "hi", at: "t" } });
    expect(result.flush()!.upserts.map((node) => node.id)).toEqual([child]);
  });
});
