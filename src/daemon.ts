import { MessageInbox } from "./messages.ts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentNode, Harness } from "./domain.ts";
import { cancelLane } from "./control.ts";
import { diskFileSystem } from "./fs.ts";
import { lockInstance } from "./instance-lock.ts";
import { journalOn, pruneLanes } from "./journal.ts";
import { Monitor } from "./monitor.ts";
import { psTable } from "./probe.ts";
import { clearRecord, readRecord, serverUrl, writeRecord, type ServerRecord } from "./record.ts";
import { createHandler, type Assets } from "./server.ts";
import { readSetup } from "./setup.ts";
import { adapters, type Homes } from "./sources.ts";
import { monitorVersion } from "./version.ts";
import type { Snapshot } from "./wire.ts";

// Process lifecycle for the monitor server: a detached
// daemon that outlives the session that started it, one per user.

export const DEFAULT_PORT = 47317;
const LAUNCHER = fileURLToPath(new URL("../bin/psf-monitor", import.meta.url));
const POLL_INTERVAL_MS = 100;
const START_TIMEOUT_MS = 20_000;

export interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export interface ServeOptions {
  readonly port: number;
  readonly windowHours: number;
  readonly assets: () => Promise<Assets>;
}

export interface StartOptions {
  readonly port: number;
  readonly windowHours: number;
  readonly harness: Harness | null;
  readonly focus: string | null;
}

interface Health {
  readonly app: string;
  readonly version: string;
  readonly instance: string;
  readonly pid: number;
}

async function health(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
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

export function launchUrl(record: ServerRecord, harness: Harness | null, focus: string | null): string {
  const query = new URLSearchParams({ token: record.token });
  if (harness !== null) query.set("harness", harness);
  if (focus !== null) query.set("focus", focus);
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

/** The setup as this process sees it: its own environment and PATH. */
export function diskSetup(where: Homes) {
  return readSetup({ where, fs: diskFileSystem, env: process.env, which: (command) => Bun.which(command), home: homedir(), platform: process.platform });
}

async function runningRecord(where: Homes): Promise<ServerRecord | null> {
  const record = readRecord(where.state);
  if (record === null) return null;
  const running = await health(record.port);
  return running?.instance === record.instance && running.pid === record.pid ? record : null;
}

function reportRunning(record: ServerRecord, io: Io): void {
  io.stderr(`psf-monitor is already running globally (PID ${record.pid}, port ${record.port}); using the existing monitor.\n`);
  if (record.version !== monitorVersion()) io.stderr("The running monitor uses a different build. Run `psf-monitor stop` then `psf-monitor start` to update it.\n");
}

/** One server per user state directory, including foreground and concurrent launches. */
export async function serve(where: Homes, options: ServeOptions, io: Io): Promise<number> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existing = await runningRecord(where);
    if (existing !== null) { reportRunning(existing, io); return 0; }
    const release = lockInstance(where.state);
    if (release !== null) {
      try {
        // An older build may own the record without taking the instance lock.
        const running = await runningRecord(where);
        if (running !== null) { reportRunning(running, io); return 0; }
        return await serveLocked(where, options, io);
      } finally { release(); }
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  io.stderr("Another psf-monitor is starting or not responding. Check `psf-monitor status` and the server log.\n");
  return 69;
}

/** Runs while holding the instance lock, until SIGINT, SIGTERM, or a stop request. */
async function serveLocked(where: Homes, options: ServeOptions, io: Io): Promise<number> {
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
    lanes: where.lanes,
  });
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const inbox = new MessageInbox(where.state);
  const handler = createHandler(monitor, {
    inbox,
    port: options.port,
    token,
    assets: await options.assets(),
    lanes: where.lanes,
    cancel: (id) => cancelLane(monitor.store, psTable, id),
    setup: () => diskSetup(where),
    stop: resolveStopped,
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: options.port, fetch: (request, bun) => handler(request, bun) });
  } catch (error) {
    inbox.close();
    io.stderr(`port ${options.port} is unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return 69;
  }
  process.once("SIGTERM", resolveStopped);
  process.once("SIGINT", resolveStopped);
  try {
    writeRecord(where.state, {
      pid: process.pid,
      port: options.port,
      token,
      version,
      instance,
      startedAt: new Date().toISOString(),
    });
    io.stdout(`psf-monitor ${version} serving ${serverUrl({ port: options.port })} · all projects\n`);
    await monitor.start();
    await stopped;
    return 0;
  } finally {
    monitor.stop();
    inbox.close();
    server.stop(true);
    clearRecord(where.state, instance);
    process.removeListener("SIGTERM", resolveStopped);
    process.removeListener("SIGINT", resolveStopped);
  }
}

/** Starts the global daemon, or reports the existing one and prints its link. */
export async function start(where: Homes, options: StartOptions, io: Io): Promise<number> {
  // Watching agents means wanting external lanes too; say so the first time, since lane output is kept on disk.
  if (journalOn(where.lanes) === "enabled") {
    io.stderr(
      `lane journal on: external pstack lanes are recorded in ${where.lanes} and kept 7 days. ` +
        "`psf-monitor journal off` stops it and deletes them.\n",
    );
  }
  const existing = await runningRecord(where);
  if (existing !== null) {
    reportRunning(existing, io);
    io.stdout(`${launchUrl(existing, options.harness, options.focus)}\n`);
    return 0;
  }

  mkdirSync(where.state, { recursive: true, mode: 0o700 });
  const logPath = join(where.state, "server.log");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [LAUNCHER, "serve", "--port", String(options.port), "--hours", String(options.windowHours)],
    // Detached with its output in a file, so the caller's shell or tool call returns at once.
    { detached: true, stdio: ["ignore", log, log], env: {
      ...process.env, CLAUDE_CONFIG_DIR: where.claude, CODEX_HOME: where.codex,
      PSTACK_FLEX_LANES_DIR: where.lanes, PSF_MONITOR_DIR: where.state,
    } },
  );
  closeSync(log);
  let exitCode: number | null = null;
  let spawnError: string | null = null;
  child.once("error", (error) => { spawnError = error.message; });
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A concurrent launcher may have won; both callers get the same live instance.
    const record = await runningRecord(where);
    if (record !== null) {
      if (record.pid !== child.pid) reportRunning(record, io);
      io.stdout(`${launchUrl(record, options.harness, options.focus)}\n`);
      return 0;
    }
    if (spawnError !== null || exitCode !== null) {
      io.stderr(`psf-monitor exited before it was ready (${spawnError ?? `status ${exitCode}`}). Log: ${logPath}\n${logTail(logPath)}\n`);
      return 69;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  io.stderr(`psf-monitor is still starting or not responding. Check \`psf-monitor status\`. Log: ${logPath}\n`);
  return 69;
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

export function summarize(nodes: readonly AgentNode[]): string {
  const agents = nodes.filter((node) => node.flavor.kind !== "skill");
  const skills = nodes.length - agents.length;
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.status.kind, (counts.get(agent.status.kind) ?? 0) + 1);
  const parts = [`${agents.length} ${agents.length === 1 ? "agent" : "agents"}`];
  if (skills > 0) parts.push(`${skills} ${skills === 1 ? "skill" : "skills"}`);
  for (const kind of ["running", "idle", "failed", "done", "cancelled", "ended", "unknown"]) {
    const count = counts.get(kind);
    if (count !== undefined) parts.push(`${count} ${kind}`);
  }
  return parts.join(" · ");
}

export async function status(where: Homes, io: Io): Promise<number> {
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
    io.stdout(`psf-monitor ${running.version} · ${summarize(snapshot.agents)}${indexing}\n${launchUrl(record, null, null)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`psf-monitor did not answer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
