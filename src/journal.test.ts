import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { clearLanes, deleteLane, isLaneId, journalEnabled, journalOff, journalOn, LANE_RETENTION_MS, listLanes, pruneLanes } from "./journal.ts";

const LANE_A = "mg1abc-1f4-0a1b2c";
const LANE_B = "mg1abd-1f5-ffeedd";

function writeLane(root: string, laneId: string, options: { receipt?: boolean; startedAt?: string } = {}): void {
  const dir = join(root, laneId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lane.json"), JSON.stringify({ schemaVersion: 1, laneId, runnerPid: 4242, startedAt: options.startedAt ?? "2026-10-09T10:00:00.000Z", parent: "claude", parentSessionId: "s1", provider: "codex", model: "gpt-6", effort: "high", mode: "read-only", label: "review", cwd: "/repo", promptPath: "/p", promptHead: "Review", outputPath: "/o", receiptPath: "/r" }));
  writeFileSync(join(dir, "stream.jsonl"), "{\"type\":\"text\"}\n");
  if (options.receipt === true) writeFileSync(join(dir, "receipt.json"), JSON.stringify({ schemaVersion: 1, status: "complete", provider: "codex", mode: "read-only", completedAt: "2026-10-09T10:05:00.000Z", reportedModel: null, usage: null, error: null }));
}

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-journal-switch-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("journal switch", () => {
  it("turns on by creating a private directory and off by deleting it", () => {
    const root = join(scratch, "lanes");
    expect(journalEnabled(root)).toBe(false);
    expect(journalOn(root)).toBe("enabled");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(journalOn(root)).toBe("already-on");
    mkdirSync(join(root, "lane-1"));
    expect(journalOff(root)).toBe("disabled");
    expect(existsSync(root)).toBe(false);
    expect(journalOff(root)).toBe("already-off");
  });

  it("prunes lanes older than the retention window", () => {
    const root = join(scratch, "lanes");
    mkdirSync(join(root, "old"), { recursive: true });
    mkdirSync(join(root, "new"));
    const now = Date.now();
    const old = (now - LANE_RETENTION_MS - 60_000) / 1000;
    utimesSync(join(root, "old"), old, old);
    expect(pruneLanes(root, now)).toBe(1);
    expect(readdirSync(root)).toEqual(["new"]);
    expect(pruneLanes(join(scratch, "missing"), now)).toBe(0);
  });
});

describe("recorded lanes", () => {
  it("accepts only the runner's lane names", () => {
    expect(isLaneId(LANE_A)).toBe(true);
    expect(isLaneId("../etc")).toBe(false);
    expect(isLaneId("lane-1")).toBe(false);
    expect(isLaneId("")).toBe(false);
  });

  it("lists lanes newest first with their receipt or running state", () => {
    const root = join(scratch, "lanes");
    writeLane(root, LANE_A, { receipt: true });
    writeLane(root, LANE_B, { startedAt: "2026-10-09T11:00:00.000Z" });
    mkdirSync(join(root, "not-a-lane"));
    writeFileSync(join(root, `${LANE_A}.tmp`), "");
    const lanes = listLanes(root, (lane) => lane === LANE_B);
    expect(lanes.map((lane) => lane.laneId)).toEqual([LANE_B, LANE_A]);
    expect(lanes[1]).toMatchObject({ label: "review", provider: "codex", model: "gpt-6", effort: "high", parent: "claude", startedAt: "2026-10-09T10:00:00.000Z", status: "complete" });
    expect(lanes[1]!.bytes).toBeGreaterThan(0);
    expect(lanes[0]!.status).toBe("running");
    expect(listLanes(root)[0]!.status).toBe("unknown");
    expect(listLanes(join(scratch, "missing"))).toEqual([]);
  });

  it("deletes one lane by id and refuses anything else", () => {
    const root = join(scratch, "lanes");
    writeLane(root, LANE_A);
    expect(deleteLane(root, "../lanes")).toBe("invalid");
    expect(deleteLane(root, LANE_B)).toBe("missing");
    expect(deleteLane(root, LANE_A)).toBe("deleted");
    expect(existsSync(join(root, LANE_A))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("clears every lane except the ones to keep, and keeps the journal on", () => {
    const root = join(scratch, "lanes");
    writeLane(root, LANE_A);
    writeLane(root, LANE_B);
    expect(clearLanes(root, (lane) => lane === LANE_B)).toEqual({ deleted: [LANE_A], kept: [LANE_B] });
    expect(readdirSync(root)).toEqual([LANE_B]);
    expect(journalEnabled(root)).toBe(true);
  });
});
