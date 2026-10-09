import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { object, parseJson, text } from "./json.ts";
import type { LaneRecord, RunnerReceipt } from "./pstack.ts";
import type { LaneSummary } from "./wire.ts";

// The lane journal's on/off switch is the existence of
// its directory: the runner writes there only when it already exists.

export const LANE_RETENTION_MS = 7 * 24 * 3_600_000;

/** The runner names a lane `<start base36>-<pid base36>-<6 hex>`; nothing else is a lane, so nothing else can be deleted. */
const LANE_ID = /^[0-9a-z]{1,16}-[0-9a-z]{1,16}-[0-9a-f]{6}$/;

export function isLaneId(value: string): boolean {
  return LANE_ID.test(value);
}

export type JournalChange = "enabled" | "already-on" | "disabled" | "already-off";
export type LaneDeletion = "deleted" | "missing" | "invalid";

function readJson(path: string): Record<string, unknown> | null {
  try {
    return object(parseJson(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const RECEIPT_STATUSES = new Set<string>(["complete", "cancelled", "unavailable-cli", "unauthenticated", "unavailable-model", "timed-out", "child-failed", "malformed-output"]);

/**
 * Every lane the journal holds, newest first. `running` names the lanes whose runner the
 * monitor still sees alive; without that, a lane with no receipt is `unknown`.
 */
export function listLanes(root: string, running: (laneId: string) => boolean = () => false): LaneSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const lanes: LaneSummary[] = [];
  for (const laneId of entries) {
    if (!isLaneId(laneId)) continue;
    const dir = join(root, laneId);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const record = readJson(join(dir, "lane.json")) as Partial<LaneRecord> | null;
    const receipt = readJson(join(dir, "receipt.json")) as Partial<RunnerReceipt> | null;
    const receiptStatus = text(receipt?.status);
    lanes.push({
      laneId,
      label: text(record?.label),
      provider: text(record?.provider) ?? text(receipt?.provider),
      model: text(record?.model),
      effort: text(record?.effort),
      parent: text(record?.parent),
      startedAt: text(record?.startedAt),
      status: receiptStatus !== null && RECEIPT_STATUSES.has(receiptStatus) ? (receiptStatus as LaneSummary["status"]) : running(laneId) ? "running" : "unknown",
      bytes: sizeOf(join(dir, "lane.json")) + sizeOf(join(dir, "stream.jsonl")) + sizeOf(join(dir, "receipt.json")),
    });
  }
  return lanes.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.laneId.localeCompare(a.laneId));
}

/** Removes one lane's records. The id is checked against the runner's naming, so no path escapes the journal. */
export function deleteLane(root: string, laneId: string): LaneDeletion {
  if (!isLaneId(laneId)) return "invalid";
  const dir = join(root, laneId);
  if (!existsSync(dir)) return "missing";
  rmSync(dir, { recursive: true, force: true });
  return "deleted";
}

/** Removes every lane the `keep` predicate does not claim; the journal itself stays on. */
export function clearLanes(root: string, keep: (laneId: string) => boolean = () => false): { deleted: string[]; kept: string[] } {
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const lane of listLanes(root)) {
    if (keep(lane.laneId)) {
      kept.push(lane.laneId);
      continue;
    }
    if (deleteLane(root, lane.laneId) === "deleted") deleted.push(lane.laneId);
  }
  return { deleted, kept };
}

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
