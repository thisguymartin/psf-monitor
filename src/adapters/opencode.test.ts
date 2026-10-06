import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../domain.ts";
import { diskFileSystem } from "../fs.ts";
import { Index } from "../index.ts";
import { Store } from "../store.ts";
import type { TimelinePage } from "../wire.ts";
import { laneAdapter } from "./lane.ts";
import { openCodeAdapter } from "./opencode.ts";

let dir: string;
let db: Database;
const root = "opencode:ses_root" as AgentId;
const now = Date.parse("2026-10-05T10:00:00Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psf-opencode-"));
  db = new Database(join(dir, "opencode.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function session(id = "ses_root", parent: string | null = null, updated = now) {
  db.query("INSERT INTO session VALUES (?, ?, '/repo', 'OpenCode work', '1.18.34', ?, ?)").run(id, parent, now - 100, updated);
}
function message(id: string, role: string, extra = {}, time = now, sessionId = "ses_root") {
  db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, sessionId, JSON.stringify({ role, ...extra }), time, time);
}
function part(id: string, messageId: string, data: unknown, time = now) {
  db.query("INSERT INTO part VALUES (?, ?, 'ses_root', ?, ?, ?)").run(id, messageId, JSON.stringify(data), time, time);
}
function setup() {
  const adapter = openCodeAdapter(dir);
  const store = new Store();
  const appended: unknown[] = [];
  const index = new Index([adapter], store, diskFileSystem, { sinceMs: now - 1000, watched: () => true, onItems: (_, items) => appended.push(...items) });
  return { adapter, store, index, appended };
}

describe("OpenCode native database", () => {
  it("indexes the pstack tree, completed tools and message usage without double counting steps", async () => {
    session(); session("ses_child", "ses_root"); session("ses_grandchild", "ses_child"); session("ses_other");
    message("u1", "user"); part("p1", "u1", { type: "text", text: "/pstack:poteto-mode inspect" });
    message("a1", "assistant", { providerID: "openai", modelID: "gpt-6", variant: "high", finish: "stop", time: { completed: now + 10 }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } }, now + 1);
    part("p2", "a1", { type: "reasoning", text: "Check the code" });
    part("p3", "a1", { type: "tool", tool: "task", callID: "task1", state: { status: "completed", input: { description: "Explore" }, output: "Done", metadata: { sessionId: "ses_child" } } });
    part("p4", "a1", { type: "step-finish", tokens: { input: 100, output: 20 } });
    part("p5", "a1", { type: "text", text: "All done" });
    const { index, store } = setup();
    await index.refresh(true);
    expect(store.nodes().map((node) => String(node.id)).sort()).toEqual([root, "opencode:ses_child", "opencode:ses_grandchild"].sort());
    expect(store.node(root)).toMatchObject({ harness: "opencode", source: "opencode-session", model: { provider: "openai", reported: "gpt-6", effort: "high" }, status: { kind: "idle" }, usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cachedInputTokens: 10 }, result: { body: { text: "All done" } }, pending: null });
    expect(store.node("opencode:ses_child" as AgentId)).toMatchObject({ parent: root, spawnCall: "task1" });
    expect(store.node("opencode:ses_grandchild" as AgentId)?.parent).toBe("opencode:ses_child" as AgentId);
    expect(index.health()[0]).toMatchObject({ state: "ok", files: 4, unchecked: [] });
    const kinds: string[] = [];
    let before: number | null = null;
    do {
      const page: TimelinePage = index.timeline(root, before, 1)!;
      kinds.unshift(...page.items.map((item) => item.kind));
      before = page.older;
    } while (before !== null);
    expect(kinds).toEqual(["prompt", "thinking", "tool-call", "tool-result", "text"]);
  });

  it("refreshes in-place WAL updates and preserves active tools across snapshot replay", async () => {
    session(); message("u1", "user"); part("p1", "u1", { type: "text", text: "/pstack:swarm review" });
    message("a1", "assistant", { finish: "tool-calls" }, now + 1);
    part("p2", "a1", { type: "tool", tool: "bash", callID: "bash1", state: { status: "running", input: { command: "ls" } } });
    const { index, store, appended } = setup();
    await index.refresh(true);
    expect(store.node(root)).toMatchObject({ status: { kind: "running" }, pending: { name: "bash" } });
    appended.length = 0;
    await index.refresh(false);
    expect(appended).toEqual([]);
    db.query("UPDATE part SET data=?, time_updated=? WHERE id='p2'").run(JSON.stringify({ type: "tool", tool: "bash", callID: "bash1", state: { status: "error", input: { command: "ls" }, error: "command failed" } }), now + 5);
    await index.refresh(false);
    expect(store.node(root)?.pending).toBeNull();
    expect(appended).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tool-result", ok: false, output: expect.objectContaining({ text: "command failed" }) })]));
    db.query("UPDATE message SET data=?, time_updated=? WHERE id='a1'").run(JSON.stringify({ role: "assistant", finish: "stop" }), now + 6);
    part("p3", "a1", { type: "text", text: "Finished" });
    await index.refresh(false);
    expect(store.node(root)?.result).not.toBeNull();
    message("u2", "user", {}, now + 10); part("p4", "u2", { type: "text", text: "Continue" }, now + 10);
    await index.refresh(false);
    expect(store.node(root)).toMatchObject({ status: { kind: "running" }, result: null });
  });

  it("keeps an old ancestor of a recent child but excludes unrelated old sessions", () => {
    session("ses_root", null, now - 10000); session("ses_child", "ses_root"); session("ses_old", null, now - 10000);
    const { adapter } = setup();
    expect(adapter.snapshot!(now - 1000).documents.map((doc) => String(doc.agent))).toEqual([root, "opencode:ses_child"]);
  });

  it("does not create a missing database and isolates an incompatible schema", async () => {
    const missing = join(dir, "missing");
    expect(openCodeAdapter(missing).snapshot!(0)).toEqual({ present: false, documents: [] });
    expect(existsSync(join(missing, "opencode.db"))).toBe(false);
    db.exec("DROP TABLE part");
    session();
    const { index } = setup();
    await index.refresh(true);
    expect(index.health()[0]).toMatchObject({ state: "degraded", shape: 1 });
  });

  it("links a parentless OpenCode lane only by an exact path in the same directory", async () => {
    session(); message("u1", "user"); message("a1", "assistant", { finish: "tool-calls" }, now + 1);
    part("p1", "a1", { type: "tool", tool: "bash", callID: "lane1", state: { status: "running", input: { command: "pstack-runner --receipt /tmp/run-1.receipt.json" } } });
    const lane = { schemaVersion: 1, laneId: "l1", runnerPid: 4242, startedAt: new Date(now).toISOString(), parent: "opencode", parentSessionId: null, provider: "opencode", model: "openai/gpt-6", effort: "high", mode: "read-only", label: "Review", cwd: "/repo", promptPath: "/tmp/p", outputPath: "/tmp/o", receiptPath: "/tmp/run-1.receipt.json" };
    const adapter = laneAdapter(dir);
    const { index, store } = setup();
    await index.refresh(true);
    for (const fact of adapter.document(join(dir, "l1", "lane.json"), JSON.stringify(lane)).facts) store.apply(fact);
    expect(store.node("lane:l1" as AgentId)?.parent).toBe(root);
    expect(store.nodes().map((node) => node.id)).toContain(root);
    for (const fact of adapter.document(join(dir, "l2", "lane.json"), JSON.stringify({ ...lane, laneId: "l2", receiptPath: "/tmp/other", outputPath: "/tmp/other-out" })).facts) store.apply(fact);
    expect(store.node("lane:l2" as AgentId)?.parent).toBeNull();
  });
});
