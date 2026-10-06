import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecord, type ServerRecord } from "./record.ts";
import type { Snapshot } from "./wire.ts";

let dir: string;
let env: NodeJS.ProcessEnv;
const children: ReturnType<typeof Bun.spawn>[] = [];
const launcher = join(import.meta.dir, "../bin/psf-monitor");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psf-daemon-"));
  env = { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), PSTACK_FLEX_LANES_DIR: join(dir, "lanes"), PSF_MONITOR_DIR: join(dir, "state") };
  for (const project of ["first", "second"]) {
    const path = join(env.CLAUDE_CONFIG_DIR!, "projects", project);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, `${project}.jsonl`), `${JSON.stringify({
      type: "user", sessionId: project, cwd: `/${project}`, entrypoint: "cli", timestamp: new Date().toISOString(),
      message: { role: "user", content: "<command-name>/pstack:monitor</command-name>" },
    })}\n`);
  }
});

function launch(...args: string[]) {
  const child = Bun.spawn([process.execPath, launcher, ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return child;
}

async function command(...args: string[]) {
  const child = launch(...args);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

function ports(): [number, number] {
  const servers = [Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })];
  const result: [number, number] = [servers[0]!.port!, servers[1]!.port!];
  for (const server of servers) server.stop(true);
  return result;
}

async function ready(): Promise<ServerRecord> {
  for (let i = 0; i < 100; i++) {
    const record = readRecord(env.PSF_MONITOR_DIR!);
    if (record !== null) {
      const snapshot = await fetch(`http://127.0.0.1:${record.port}/api/snapshot`, { headers: { Authorization: `Bearer ${record.token}` } }).then((response) => response.json()) as Snapshot;
      if (!snapshot.server.indexing) return record;
    }
    await Bun.sleep(25);
  }
  throw new Error("Test daemon did not finish indexing");
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill(); await child.exited; }
  const record = readRecord(env.PSF_MONITOR_DIR!);
  if (record !== null) {
    try { process.kill(record.pid, "SIGTERM"); } catch { /* Already stopped by the test. */ }
    for (let i = 0; i < 100 && readRecord(env.PSF_MONITOR_DIR!) !== null; i++) await Bun.sleep(25);
  }
  rmSync(dir, { recursive: true, force: true });
});

it("concurrent starts on different ports reuse one global monitor and index both projects", async () => {
  const [firstPort, secondPort] = ports();
  const [first, second] = await Promise.all([command("start", "--port", String(firstPort)), command("start", "--port", String(secondPort), "--parent", "codex", "--focus", "example")]);
  expect(first.code).toBe(0);
  expect(second.code).toBe(0);
  const record = await ready();
  expect(new URL(first.stdout.trim()).port).toBe(String(record.port));
  expect(new URL(second.stdout.trim()).port).toBe(String(record.port));
  expect(new URL(second.stdout.trim()).searchParams.get("focus")).toBe("codex:example");
  expect((first.stderr + second.stderr).includes("already running globally")).toBe(true);
  const snapshot = await fetch(`http://127.0.0.1:${record.port}/api/snapshot`, { headers: { Authorization: `Bearer ${record.token}` } }).then((response) => response.json()) as Snapshot;
  expect(snapshot.agents.filter((node) => node.flavor.kind === "session").map((node) => node.cwd).sort()).toEqual(["/first", "/second"]);

  const repeated = await command("start", "--port", String(record.port === firstPort ? secondPort : firstPort));
  expect(repeated.code).toBe(0);
  expect(repeated.stderr.includes("already running globally")).toBe(true);
  expect(readRecord(env.PSF_MONITOR_DIR!)?.instance).toBe(record.instance);
  const foreground = await command("serve", "--port", String(record.port === firstPort ? secondPort : firstPort));
  expect(foreground.code).toBe(0);
  expect(foreground.stderr.includes("already running globally")).toBe(true);
  expect(readRecord(env.PSF_MONITOR_DIR!)?.instance).toBe(record.instance);
}, 15_000);

it("recovers from a killed server and its stale record", async () => {
  const [port] = ports();
  const first = launch("serve", "--port", String(port));
  const previous = await ready();
  first.kill("SIGKILL");
  await first.exited;
  const restarted = await command("start", "--port", String(port));
  expect(restarted.code).toBe(0);
  expect((await ready()).instance).not.toBe(previous.instance);
}, 15_000);

it("reports an older running build without replacing it", async () => {
  const [port, otherPort] = ports();
  const child = Bun.spawn([process.execPath, "-e", `
    import { writeRecord } from ${JSON.stringify(join(import.meta.dir, "record.ts"))};
    const info = { app: "psf-monitor", version: "older-build", instance: "legacy-test", pid: process.pid };
    Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json(info) });
    writeRecord(process.env.PSF_MONITOR_DIR, { ...info, port: ${port}, token: "synthetic-test-token", startedAt: new Date().toISOString() });
    console.log("ready");
  `], { env, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const first = await child.stdout.getReader().read();
  expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
  const result = await command("start", "--port", String(otherPort));
  expect(result.code).toBe(0);
  expect(result.stderr.includes("already running globally")).toBe(true);
  expect(result.stderr.includes("different build")).toBe(true);
  expect(child.exitCode).toBeNull();
  expect(readRecord(env.PSF_MONITOR_DIR!)?.instance).toBe("legacy-test");
}, 15_000);
