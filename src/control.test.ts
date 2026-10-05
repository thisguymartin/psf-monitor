import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cancelLane } from "./control.ts";
import type { AgentId } from "./domain.ts";
import { Store } from "./store.ts";

const id = "lane:l1" as AgentId;

function lane(pid: number, startedAtMs: number): Store {
  const store = new Store();
  store.apply({ kind: "agent", id, patch: { harness: "claude", source: "runner-lane", flavor: { kind: "lane", mode: "read-only", stream: "live", label: null, receipt: null } } });
  store.apply({ kind: "pstack", id });
  store.apply({ kind: "process", key: "lane-process", id, process: { pid, startedAtMs, state: "running" } });
  store.setAlive("lane-process", true);
  return store;
}

describe("cancel lane", () => {
  it("rejects hidden agents and finished lanes", async () => {
    let signalled = false;
    const store = lane(123, 1_000_000);
    store.apply({ kind: "outcome", id, outcome: "done", at: null, reason: null });
    expect(await cancelLane(store, async () => new Map([[123, 1_000_000]]), id, () => { signalled = true; })).toEqual({ kind: "not-cancellable", reason: "Lane is not running." });
    expect(await cancelLane(store, async () => new Map(), "lane:missing" as AgentId, () => { signalled = true; })).toEqual({ kind: "unknown-agent" });
    expect(signalled).toBe(false);
  });

  it("signals only when the runner start time matches", async () => {
    const sent: [number, string][] = [];
    const store = lane(123, 1_000_000);
    const table = async () => new Map([[123, 1_000_000]]);
    expect(await cancelLane(store, table, id, (pid, signal) => { sent.push([pid, signal]); })).toEqual({ kind: "sent" });
    expect(sent).toEqual([[123, "SIGTERM"]]);
  });

  it("does not signal a reused pid", async () => {
    let signalled = false;
    const store = lane(123, 1_000_000);
    expect(await cancelLane(store, async () => new Map([[123, 2_000_000]]), id, () => { signalled = true; })).toEqual({ kind: "process-gone" });
    expect(signalled).toBe(false);
  });

  it("signals a real child and observes its SIGTERM exit", async () => {
    const child = spawn("sleep", ["30"]);
    const exited = once(child, "exit");
    try {
      const pid = child.pid!;
      const startedAtMs = Date.now();
      expect(await cancelLane(lane(pid, startedAtMs), async () => new Map([[pid, startedAtMs]]), id)).toEqual({ kind: "sent" });
      const [code, signal] = await exited;
      expect(code).toBeNull();
      expect(signal).toBe("SIGTERM");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
