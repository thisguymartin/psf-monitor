import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "./domain.ts";

// The sessions the user hid from the page, kept across monitor restarts.
// A row names a tree root and when it was hidden; the store drops the
// row's effect once the tree is active after that time.

export class HiddenSessions {
  private readonly db: Database;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "hidden.sqlite");
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS hidden (root TEXT PRIMARY KEY, hiddenAt INTEGER NOT NULL);`);
  }

  close(): void {
    this.db.close();
  }

  all(): Map<AgentId, number> {
    const rows = this.db.query("SELECT root, hiddenAt FROM hidden").all() as { root: string; hiddenAt: number }[];
    return new Map(rows.map((row) => [row.root as AgentId, row.hiddenAt]));
  }

  hide(root: AgentId, at: number): void {
    this.db.query("INSERT INTO hidden VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET hiddenAt=excluded.hiddenAt").run(root, at);
  }

  unhide(root: AgentId): void {
    this.db.query("DELETE FROM hidden WHERE root=?").run(root);
  }

  clear(): number {
    return this.db.query("DELETE FROM hidden").run().changes;
  }
}
