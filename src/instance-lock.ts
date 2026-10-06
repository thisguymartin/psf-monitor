import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** SQLite's process lock is released even after SIGKILL; no stale PID lock to reclaim. */
export function lockInstance(dir: string): (() => void) | null {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "instance.sqlite");
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.run("PRAGMA busy_timeout = 0");
    db.run("BEGIN IMMEDIATE");
    return () => db.close();
  } catch (error) {
    db.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") return null;
    throw error;
  }
}
