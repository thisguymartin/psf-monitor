import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// The lane journal's on/off switch is the existence of
// its directory: the runner writes there only when it already exists.

export const LANE_RETENTION_MS = 7 * 24 * 3_600_000;

export type JournalChange = "enabled" | "already-on" | "disabled" | "already-off";

export function journalOn(root: string): JournalChange {
  if (existsSync(root)) return "already-on";
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return "enabled";
}

/** Turning the journal off deletes what it recorded; that is the point of the switch. */
export function journalOff(root: string): JournalChange {
  if (!existsSync(root)) return "already-off";
  rmSync(root, { recursive: true, force: true });
  return "disabled";
}

export function journalEnabled(root: string): boolean {
  return existsSync(root);
}

/** Removes lane directories older than the retention window. Returns how many went. */
export function pruneLanes(root: string, now: number, retentionMs: number = LANE_RETENTION_MS): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const path = join(root, name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs < retentionMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Another process removed it first.
    }
  }
  return removed;
}
