import type { ProbeTarget } from "./store.ts";

// Decides whether a recorded process is still the one
// that wrote the record: the pid must exist and must have started when the
// record says it did, so a reused pid is not mistaken for a live agent.

/** Live pids and their start times in epoch milliseconds. */
export type ProcessTable = (pids: readonly number[]) => Promise<ReadonlyMap<number, number>>;

// `ps -o lstart=` has one-second resolution, and a launcher records its start a moment after exec.
const START_TOLERANCE_MS = 10_000;

export function parseProcessTable(output: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const started = Date.parse(`${match[2]!.replace(/\s+/g, " ")} UTC`);
    if (Number.isFinite(started)) table.set(Number(match[1]), started);
  }
  return table;
}

export const psTable: ProcessTable = async (pids) => {
  if (pids.length === 0) return new Map();
  const child = Bun.spawn(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return parseProcessTable(output);
};

export function alive(target: ProbeTarget, table: ReadonlyMap<number, number>): boolean {
  const started = table.get(target.pid);
  if (started === undefined) return false;
  if (target.startedAtMs === null) return true;
  return Math.abs(started - target.startedAtMs) <= START_TOLERANCE_MS;
}
