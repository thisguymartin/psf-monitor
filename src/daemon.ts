import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentNode, Harness } from "./domain.ts";
import { diskFileSystem } from "./fs.ts";
import { journalOn, pruneLanes } from "./journal.ts";
import { Monitor } from "./monitor.ts";
import { psTable } from "./probe.ts";
import { clearRecord, readRecord, serverUrl, writeRecord, type ServerRecord } from "./record.ts";
import { createHandler, type Assets } from "./server.ts";
import { adapters, type Homes } from "./sources.ts";
import { monitorVersion } from "./version.ts";
import type { Snapshot } from "./wire.ts";

// Process lifecycle for the monitor server: a detached
// daemon that outlives the session that started it, one per user.

export const DEFAULT_PORT = 47317;
const LAUNCHER = fileURLToPath(new URL("../bin/psf-monitor", import.meta.url));
const POLL_INTERVAL_MS = 100;

export interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface ServeOptions {
  readonly port: number;
  readonly windowHours: number;
  readonly assets: () => Promise<Assets>;
}

export type Scope = "pstack" | "all";

export interface StartOptions {
  readonly port: number;
  readonly windowHours: number;
  readonly harness: Harness | null;
  readonly focus: string | null;
  readonly scope: Scope;
}

interface Health {
  readonly app: string;
  readonly version: string;
  readonly instance: string;
  readonly pid: number;
}

async function health(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<Health>;
    return body.app === "psf-monitor" && typeof body.instance === "string" ? (body as Health) : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  while (processExists(pid)) await Bun.sleep(POLL_INTERVAL_MS);
}

export function launchUrl(record: ServerRecord, harness: Harness | null, focus: string | null, scope: Scope = "pstack"): string {
  const query = new URLSearchParams({ token: record.token });
  if (harness !== null) query.set("harness", harness);
  if (focus !== null) query.set("focus", focus);
  if (scope === "all") query.set("all", "1");
  return `${serverUrl(record)}/?${query.toString()}`;
}

function logTail(path: string): string {
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    return lines.slice(-8).join("\n");
  } catch {
    return "";
  }
}

/** Runs the server in the foreground until SIGINT or SIGTERM. */
export async function serve(where: Homes, options: ServeOptions, io: Io): Promise<number> {
  const pruned = pruneLanes(where.lanes, Date.now());
  if (pruned > 0) io.stdout(`removed ${pruned} lane ${pruned === 1 ? "journal" : "journals"} older than 7 days\n`);
  const version = monitorVersion();
  const instance = randomBytes(8).toString("hex");
  const token = randomBytes(24).toString("base64url");
  const monitor = new Monitor({
    adapters: adapters(where),
    fs: diskFileSystem,
    table: psTable,
    windowHours: options.windowHours,
    version,
    instance,
  });
  const handler = createHandler(monitor, { port: options.port, token, assets: await options.assets() });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: options.port, fetch: (request, bun) => handler(request, bun) });
  } catch (error) {
    io.stderr(`port ${options.port} is unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return 69;
  }
  writeRecord(where.state, {
    pid: process.pid,
    port: options.port,
    token,
    version,
    instance,
    startedAt: new Date().toISOString(),
  });
  io.stdout(`psf-monitor ${version} serving ${serverUrl({ port: options.port })}\n`);
  const stopped = new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
  await monitor.start();
  await stopped;
  monitor.stop();
  server.stop(true);
  clearRecord(where.state, instance);
  return 0;
}

/** Starts the daemon, or reuses one that runs this exact build, and prints its link. */
export async function start(where: Homes, options: StartOptions, io: Io): Promise<number> {
  // Watching agents means wanting external lanes too; say so the first time, since lane output is kept on disk.
  if (journalOn(where.lanes) === "enabled") {
    io.stderr(
      `lane journal on: external pstack lanes are recorded in ${where.lanes} and kept 7 days. ` +
        "`psf-monitor journal off` stops it and deletes them.\n",
    );
  }
  const version = monitorVersion();
  const existing = readRecord(where.state);
  if (existing !== null) {
    const running = await health(existing.port);
    if (running?.instance === existing.instance) {
      if (running.version === version) {
        io.stdout(`${launchUrl(existing, options.harness, options.focus, options.scope)}\n`);
        return 0;
      }
      io.stderr(`replacing psf-monitor ${running.version} with ${version}\n`);
      process.kill(running.pid, "SIGTERM");
      await waitForExit(running.pid);
    }
  }

  mkdirSync(where.state, { recursive: true, mode: 0o700 });
  const logPath = join(where.state, "server.log");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [LAUNCHER, "serve", "--port", String(options.port), "--hours", String(options.windowHours)],
    // Detached with its output in a file, so the caller's shell or tool call returns at once.
    { detached: true, stdio: ["ignore", log, log], env: process.env },
  );
  closeSync(log);
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });
  child.unref();

  // The server either becomes healthy or exits; there is no deadline to invent.
  for (;;) {
    if (exitCode !== null) {
      io.stderr(`psf-monitor exited before it was ready (status ${exitCode}). Log: ${logPath}\n${logTail(logPath)}\n`);
      return 69;
    }
    const record = readRecord(where.state);
    if (record !== null && record.pid === child.pid && (await health(record.port))?.instance === record.instance) {
      io.stdout(`${launchUrl(record, options.harness, options.focus, options.scope)}\n`);
      return 0;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

export async function stop(where: Homes, io: Io): Promise<number> {
  const record = readRecord(where.state);
  if (record === null) {
    io.stdout("psf-monitor is not running\n");
    return 0;
  }
  const running = await health(record.port);
  if (running?.instance !== record.instance) {
    clearRecord(where.state, record.instance);
    io.stdout("psf-monitor is not running (removed a stale record)\n");
    return 0;
  }
  process.kill(running.pid, "SIGTERM");
  await waitForExit(running.pid);
  io.stdout("psf-monitor stopped\n");
  return 0;
}

export function summarize(agents: readonly AgentNode[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.status.kind, (counts.get(agent.status.kind) ?? 0) + 1);
  const parts = [`${agents.length} agents`];
  for (const kind of ["running", "idle", "failed", "done", "cancelled", "ended", "unknown"]) {
    const count = counts.get(kind);
    if (count !== undefined) parts.push(`${count} ${kind}`);
  }
  return parts.join(" · ");
}

export async function status(where: Homes, io: Io, scope: Scope = "pstack"): Promise<number> {
  const record = readRecord(where.state);
  const running = record === null ? null : await health(record.port);
  if (record === null || running?.instance !== record.instance) {
    io.stdout("psf-monitor is not running\n");
    return 1;
  }
  try {
    const response = await fetch(`${serverUrl(record)}/api/snapshot`, {
      headers: { Authorization: `Bearer ${record.token}` },
    });
    const snapshot = (await response.json()) as Snapshot;
    const indexing = snapshot.server.indexing ? " · indexing" : "";
    const agents = snapshot.agents.filter((agent) => scope === "all" || agent.pstack);
    io.stdout(`psf-monitor ${running.version} · ${summarize(agents)}${indexing}\n${launchUrl(record, null, null, scope)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`psf-monitor did not answer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
