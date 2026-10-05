import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "./adapters/claude.ts";
import { parseArgs } from "./cli.ts";
import { launchUrl, summarize } from "./daemon.ts";
import { diskFileSystem } from "./fs.ts";
import { Monitor } from "./monitor.ts";
import { createHandler } from "./server.ts";
import type { Snapshot, TimelinePage } from "./wire.ts";

const PORT = 47001;
const TOKEN = "secret-token";
let scratch: string;
let monitor: Monitor;
let handle: ReturnType<typeof createHandler>;

function request(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
  });
}

const authed = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "psf-monitor-server-"));
  const projects = join(scratch, "projects", "-repo");
  mkdirSync(projects, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(projects, "s1.jsonl"), [
    { type: "user", sessionId: "s1", cwd: "/repo", entrypoint: "cli", timestamp: at, message: { role: "user", content: "hello" } },
    { type: "assistant", sessionId: "s1", cwd: "/repo", timestamp: at, message: { id: "m1", content: [{ type: "text", text: "hi there" }] } },
  ].map((record) => `${JSON.stringify(record)}\n`).join(""));
  monitor = new Monitor({
    adapters: [claudeAdapter(scratch)],
    fs: diskFileSystem,
    table: async () => new Map(),
    windowHours: 24,
    version: "test",
    instance: "instance-1",
  });
  await monitor.start();
  handle = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: "<!doctype html>", css: "", js: "" } });
});

afterAll(() => {
  monitor.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe("access control", () => {
  it("answers the health check without a token and reveals no data", async () => {
    const response = await handle(request("/api/health"));
    expect(await response.json()).toEqual({ app: "psf-monitor", version: "test", instance: "instance-1", pid: process.pid });
  });

  it("requires the token everywhere else", async () => {
    expect((await handle(request("/api/snapshot"))).status).toBe(401);
    expect((await handle(request("/"))).status).toBe(401);
    expect((await handle(request("/api/snapshot", { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await handle(request("/api/snapshot", authed))).status).toBe(200);
    expect((await handle(request("/api/snapshot", { cookie: `psf_monitor_${PORT}=${TOKEN}` }))).status).toBe(200);
  });

  it("rejects foreign hosts and origins even with the token", async () => {
    expect((await handle(request("/api/snapshot", { ...authed, host: "evil.example" }))).status).toBe(403);
    expect((await handle(request("/api/snapshot", { ...authed, origin: "http://evil.example" }))).status).toBe(403);
    expect((await handle(request("/api/snapshot", { ...authed, origin: `http://localhost:${PORT}` }))).status).toBe(200);
  });

  it("is read-only", async () => {
    expect((await handle(request("/api/snapshot", authed, "POST"))).status).toBe(405);
  });

  it("trades the link's token for a strict cookie and drops it from the URL", async () => {
    const response = await handle(request(`/?token=${TOKEN}&harness=codex`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?harness=codex");
    expect(response.headers.get("set-cookie")).toBe(`psf_monitor_${PORT}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    expect((await handle(request("/?token=nope"))).status).toBe(401);
  });

  it("sends a strict content security policy", async () => {
    const response = await handle(request("/", authed));
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("themes the first paint from the link and accepts only known harnesses", async () => {
    const themed = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: '<html data-harness="claude">', css: "", js: "" } });
    expect(await (await themed(request("/?harness=codex", authed))).text()).toBe('<html data-harness="codex">');
    expect(await (await themed(request('/?harness="><script>', authed))).text()).toBe('<html data-harness="claude">');
  });
});

describe("data", () => {
  it("serves the snapshot", async () => {
    const snapshot = (await (await handle(request("/api/snapshot", authed))).json()) as Snapshot;
    expect(snapshot.server).toMatchObject({ app: "psf-monitor", indexing: false });
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["claude:s1"] as never);
  });

  it("serves timelines by agent id only", async () => {
    const page = (await (await handle(request("/api/timeline?agent=claude:s1", authed))).json()) as TimelinePage;
    expect(page.items.map((item) => item.kind)).toEqual(["prompt", "text"]);
    expect(page.older).toBeNull();
    expect((await handle(request("/api/timeline", authed))).status).toBe(400);
    expect((await handle(request("/api/timeline?agent=../../etc/passwd", authed))).status).toBe(404);
  });

  it("streams a snapshot, then the watched agent's timeline", async () => {
    const response = await handle(request("/api/events?watch=claude:s1", authed));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: timeline")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(text.indexOf("event: snapshot")).toBeLessThan(text.indexOf("event: timeline"));
  });
});

describe("launcher", () => {
  it("defaults the focus to the asking harness's own session", () => {
    expect(parseArgs(["start", "--parent", "claude"], { CLAUDE_CODE_SESSION_ID: "abc" })).toMatchObject({ harness: "claude", focus: "claude:abc" });
    expect(parseArgs(["start", "--parent", "codex"], { CODEX_THREAD_ID: "t1" })).toMatchObject({ focus: "codex:t1" });
    expect(parseArgs(["start"], { CLAUDE_CODE_SESSION_ID: "abc" })).toMatchObject({ harness: null, focus: null });
    expect(() => parseArgs(["start", "--parent", "cursor"], {})).toThrow("--parent");
    expect(() => parseArgs(["start", "--port", "99999"], {})).toThrow("--port");
    expect(parseArgs(["start"], {})).toMatchObject({ scope: "pstack" });
    expect(parseArgs(["start", "--all"], {})).toMatchObject({ scope: "all" });
  });

  it("builds a link that carries the token, theme, and focus", () => {
    const url = launchUrl({ pid: 1, port: 47317, token: "t", version: "v", instance: "i", startedAt: "s" }, "codex", "codex:t1");
    expect(url).toBe("http://127.0.0.1:47317/?token=t&harness=codex&focus=codex%3At1");
    const all = launchUrl({ pid: 1, port: 47317, token: "t", version: "v", instance: "i", startedAt: "s" }, null, null, "all");
    expect(all).toBe("http://127.0.0.1:47317/?token=t&all=1");
  });

  it("summarizes agent counts in a stable order", () => {
    const node = (kind: "running" | "done") => ({ status: kind === "running" ? { kind, evidence: "pid" } : { kind, at: null } }) as never;
    expect(summarize([node("done"), node("running"), node("running")])).toBe("3 agents · 2 running · 1 done");
  });
});
