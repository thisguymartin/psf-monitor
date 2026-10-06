import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, AgentNode } from "./domain.ts";
import type { Store } from "./store.ts";
import type { PromptMessage, PromptMode } from "./wire.ts";

export function messageTarget(store: Store, id: AgentId): AgentNode | null {
  if (!store.isPstack(id)) return null;
  let node = store.node(id);
  const seen = new Set<AgentId>();
  while (node !== null && !seen.has(node.id)) {
    seen.add(node.id);
    if ((node.flavor.kind === "session" || node.flavor.kind === "subagent") && (node.harness === "claude" || node.harness === "codex")) return node;
    const parent = node.flavor.kind === "skill" ? node.flavor.runner : node.parent;
    node = parent === null ? null : store.node(parent);
  }
  return null;
}

const TTL = 24 * 60 * 60 * 1000;
export class MessageInbox {
  private readonly db: Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "messages.sqlite");
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS receivers (target TEXT PRIMARY KEY, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, target TEXT NOT NULL, source TEXT NOT NULL, mode TEXT NOT NULL, text TEXT NOT NULL, queuedAt INTEGER NOT NULL, deliveredAt INTEGER);
      CREATE INDEX IF NOT EXISTS message_target ON messages(target, queuedAt);`);
  }
  close(): void { this.db.close(); }
  list(target: string): PromptMessage[] {
    this.prune();
    return this.db.query("SELECT id, source, mode, text, queuedAt, deliveredAt FROM messages WHERE target=? ORDER BY queuedAt DESC LIMIT 20").all(target) as PromptMessage[];
  }
  connected(target: string): boolean {
    const row = this.db.query("SELECT seen FROM receivers WHERE target=?").get(target) as { seen: number } | null;
    return row !== null && Date.now() - row.seen < TTL;
  }
  enqueue(target: string, source: string, mode: PromptMode, text: string): void {
    this.prune();
    this.db.transaction(() => {
      const row = this.db.query("SELECT COUNT(*) AS n FROM messages WHERE target=? AND deliveredAt IS NULL").get(target) as { n: number };
      if (row.n >= 20) throw new Error("This agent already has 20 queued messages.");
      this.db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, NULL)").run(crypto.randomUUID(), target, source, mode, text, Date.now());
    }).immediate();
  }
  cancel(target: string, id: string): boolean {
    return this.db.query("DELETE FROM messages WHERE target=? AND id=? AND deliveredAt IS NULL").run(target, id).changes > 0;
  }
  receive(target: string, finishing: boolean): PromptMessage[] {
    this.prune();
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.query("INSERT INTO receivers VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET seen=excluded.seen").run(target, now);
      const rows = this.db.query(`SELECT id, source, mode, text, queuedAt, deliveredAt FROM messages WHERE target=? AND deliveredAt IS NULL ${finishing ? "" : "AND mode='steer'"} ORDER BY queuedAt, rowid`).all(target) as PromptMessage[];
      for (const row of rows) this.db.query("UPDATE messages SET deliveredAt=? WHERE id=?").run(now, row.id);
      return rows;
    }).immediate();
  }
  private prune(): void {
    this.db.query("DELETE FROM messages WHERE queuedAt<?").run(Date.now() - TTL);
    this.db.query("DELETE FROM receivers WHERE seen<?").run(Date.now() - TTL);
  }
}
