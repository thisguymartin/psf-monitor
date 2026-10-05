import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The running server's address and access token, kept
// where only this user can read it.

export interface ServerRecord {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly version: string;
  readonly instance: string;
  readonly startedAt: string;
}

const FILE = "server.json";

export function readRecord(dir: string): ServerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as Partial<ServerRecord>;
    if (
      typeof parsed.pid !== "number"
      || typeof parsed.port !== "number"
      || typeof parsed.token !== "string"
      || typeof parsed.version !== "string"
      || typeof parsed.instance !== "string"
      || typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed as ServerRecord;
  } catch {
    return null;
  }
}

export function writeRecord(dir: string, record: ServerRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `${FILE}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, join(dir, FILE));
}

/** Removes the record only if it still describes `instance`. */
export function clearRecord(dir: string, instance: string): void {
  if (readRecord(dir)?.instance !== instance) return;
  try {
    unlinkSync(join(dir, FILE));
  } catch {
    // Already gone.
  }
}

export function serverUrl(record: Pick<ServerRecord, "port">): string {
  return `http://127.0.0.1:${record.port}`;
}
