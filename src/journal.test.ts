import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalEnabled, journalOff, journalOn, LANE_RETENTION_MS, pruneLanes } from "./journal.ts";

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
