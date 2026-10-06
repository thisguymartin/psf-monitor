import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "./adapters/claude.ts";
import { buildAssets } from "./assets.ts";
import type { AgentId } from "./domain.ts";
import { parseArgs } from "./cli.ts";
import { launchUrl, summarize } from "./daemon.ts";
import { diskFileSystem } from "./fs.ts";
import { Monitor } from "./monitor.ts";
import { cancelLane } from "./control.ts";
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

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json", ...authed, ...headers },
    body: JSON.stringify(body),
  });
}

function commandHandler(cancel: (id: AgentId) => Promise<import("./control.ts").CancelResult>, stop: () => void = () => {}) {
  return createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: "", css: "", js: "" }, lanes: join(scratch, "lanes"), cancel, stop });
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
  writeFileSync(join(projects, "s2.jsonl"), `${JSON.stringify({ type: "user", sessionId: "s2", cwd: "/repo", entrypoint: "cli", timestamp: at, message: { role: "user", content: "ordinary work" } })}\n`);
  monitor = new Monitor({
    adapters: [claudeAdapter(scratch)],
    fs: diskFileSystem,
    table: async () => new Map(),
    windowHours: 24,
    version: "test",
    instance: "instance-1",
    lanes: join(scratch, "lanes"),
  });
  await monitor.start();
  monitor.store.apply({ kind: "pstack", id: "claude:s1" as never });
  handle = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: "<!doctype html>", css: "", js: "" }, lanes: join(scratch, "lanes"), cancel: async () => ({ kind: "unknown-agent" }), stop: () => {} });
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

  it("allows POST only on command routes", async () => {
    expect((await handle(post("/api/snapshot", {}))).status).toBe(405);
    expect((await handle(request("/api/action", authed))).status).toBe(405);
    expect((await handle(request("/api/health", {}, "POST"))).status).toBe(401);
    expect((await handle(post("/api/health", {}))).status).toBe(405);
    expect((await handle(post(`/?token=${TOKEN}`, {}))).status).toBe(405);
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
    const themed = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: '<html data-harness="claude">', css: "", js: "" }, lanes: join(scratch, "lanes"), cancel: async () => ({ kind: "unknown-agent" }), stop: () => {} });
    expect(await (await themed(request("/?harness=codex", authed))).text()).toBe('<html data-harness="codex">');
    expect(await (await themed(request('/?harness="><script>', authed))).text()).toBe('<html data-harness="claude">');
  });
});

describe("data", () => {
  it("serves the bundled page with the token cookie", async () => {
    const assets = await buildAssets();
    const bundled = createHandler(monitor, { port: PORT, token: TOKEN, assets, lanes: join(scratch, "lanes"), cancel: async () => ({ kind: "unknown-agent" }), stop: () => {} });
    const response = await bundled(request("/app.js", { cookie: `psf_monitor_${PORT}=${TOKEN}` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect((await response.text()).length).toBeGreaterThan(10_000);
  });
  it("serves only visible lane results and limits output to 256 KiB", async () => {
    const monitor = new Monitor({ adapters: [], fs: diskFileSystem, table: async () => new Map(), windowHours: 24, version: "test", instance: "result-test", lanes: join(scratch, "lanes") });
    const handle = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: "", css: "", js: "" }, lanes: join(scratch, "lanes"), cancel: async () => ({ kind: "unknown-agent" }), stop: () => {} });
    monitor.store.apply({ kind: "agent", id: "claude:s1" as AgentId, patch: { flavor: { kind: "session" } } });
    monitor.store.apply({ kind: "pstack", id: "claude:s1" as AgentId });
    const lane = "lane:result" as AgentId;
    const output = join(scratch, "result.md");
    const patch = { harness: "claude" as const, source: "runner-lane" as const, flavor: { kind: "lane" as const, mode: "read-only" as const, stream: "live" as const, label: "review", receipt: null }, resultPath: output };
    monitor.store.apply({ kind: "agent", id: lane, patch });
    monitor.store.apply({ kind: "link", id: lane, parent: "claude:s1" as AgentId, via: "runner" });
    writeFileSync(output, "# Final\nDone.");
    const result = await handle(request(`/api/result?agent=${encodeURIComponent(lane)}`, authed));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ agent: lane, format: "markdown", text: "# Final\nDone.", truncated: false });
    writeFileSync(output, "x".repeat(256 * 1024 + 10));
    const large = await handle(request(`/api/result?agent=${encodeURIComponent(lane)}`, authed));
    expect(await large.json()).toMatchObject({ truncated: true, text: "x".repeat(256 * 1024) });
    expect((await handle(request("/api/result?agent=lane:missing", authed))).status).toBe(404);
    expect((await handle(request("/api/result?agent=claude:s1", authed))).status).toBe(404);
    const hidden = "lane:hidden" as AgentId;
    monitor.store.apply({ kind: "agent", id: hidden, patch: { ...patch, resultPath: output } });
    expect((await handle(request("/api/result?agent=lane:hidden", authed))).status).toBe(404);
    rmSync(output);
    expect((await handle(request(`/api/result?agent=${encodeURIComponent(lane)}`, authed))).status).toBe(404);
  });
  it("serves the pstack setup behind the token", async () => {
    const setup = { installs: [], skills: [], providers: [], sheets: [], defaults: [], settings: [], platform: "darwin" };
    const withSetup = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: "", css: "", js: "" }, lanes: join(scratch, "lanes"), cancel: async () => ({ kind: "unknown-agent" }), stop: () => {}, setup: () => setup });
    expect((await withSetup(request("/api/setup"))).status).toBe(401);
    expect(await (await withSetup(request("/api/setup", authed))).json()).toEqual(setup);
    expect((await withSetup(post("/api/setup", {}))).status).toBe(405);
    expect((await handle(request("/api/setup", authed))).status).toBe(404);
  });

  it("serves the snapshot", async () => {
    const snapshot = (await (await handle(request("/api/snapshot", authed))).json()) as Snapshot;
    expect(snapshot.server).toMatchObject({ app: "psf-monitor", indexing: false });
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["claude:s1"] as never);
    expect((await handle(request("/api/timeline?agent=claude:s2", authed))).status).toBe(404);
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

  it("does not stream a hidden agent's timeline", () => {
    const events: string[] = [];
    const unsubscribe = monitor.subscribe({ watch: "claude:s2" as AgentId, send: (event) => events.push(event.event), ping: () => {} });
    expect(events).toEqual(["snapshot"]);
    unsubscribe();
  });
});

describe("launcher", () => {
  it("defaults the focus to the asking harness's own session", () => {
    expect(parseArgs(["start", "--parent", "claude"], { CLAUDE_CODE_SESSION_ID: "abc" })).toMatchObject({ harness: "claude", focus: "claude:abc" });
    expect(parseArgs(["start", "--parent", "codex"], { CODEX_THREAD_ID: "t1" })).toMatchObject({ focus: "codex:t1" });
    expect(parseArgs(["start"], { CLAUDE_CODE_SESSION_ID: "abc" })).toMatchObject({ harness: null, focus: null });
    expect(() => parseArgs(["start", "--parent", "cursor"], {})).toThrow("--parent");
    expect(() => parseArgs(["start", "--port", "99999"], {})).toThrow("--port");
    expect(() => parseArgs(["start", "--all"], {})).toThrow();
  });

  it("builds a link that carries the token, theme, and focus", () => {
    const url = launchUrl({ pid: 1, port: 47317, token: "t", version: "v", instance: "i", startedAt: "s" }, "codex", "codex:t1");
    expect(url).toBe("http://127.0.0.1:47317/?token=t&harness=codex&focus=codex%3At1");
  });

  it("summarizes agent counts in a stable order", () => {
    const node = (kind: "running" | "done", flavor: "session" | "skill" = "session") =>
      ({ flavor: { kind: flavor }, status: kind === "running" ? { kind, evidence: "pid" } : { kind, at: null } }) as never;
    expect(summarize([node("done"), node("running"), node("running")])).toBe("3 agents · 2 running · 1 done");
    expect(summarize([node("running"), node("running", "skill"), node("done", "skill")])).toBe("1 agent · 2 skills · 1 running");
  });
});

describe("commands", () => {
  it("rejects unauthenticated, cross-origin, non-JSON, and oversized requests before control", async () => {
    let calls = 0;
    const handler = commandHandler(async () => { calls += 1; return { kind: "sent" }; });
    const body = { agent: "lane:l1", action: "cancel" };
    const noOrigin = post("/api/action", body);
    noOrigin.headers.delete("origin");
    expect((await handler(noOrigin)).status).toBe(403);
    expect((await handler(post("/api/action", body, { origin: "http://evil.example" }))).status).toBe(403);
    expect((await handler(post("/api/action", body, { authorization: "" }))).status).toBe(401);
    expect((await handler(post("/api/action", body, { host: "evil.example" }))).status).toBe(403);
    expect((await handler(post("/api/action", body, { "content-type": "" }))).status).toBe(400);
    expect((await handler(post("/api/action", body, { "content-type": "text/plain" }))).status).toBe(400);
    expect((await handler(post("/api/action", { ...body, padding: "x".repeat(4_100) }))).status).toBe(400);
    expect((await handler(new Request(`http://127.0.0.1:${PORT}/api/action`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, ...authed, "content-type": "application/json" }, body: "{" }))).status).toBe(400);
    expect((await handler(post("/api/action", { agent: "lane:l1", action: "copy-resume" }))).status).toBe(400);
    expect(calls).toBe(0);
  });

  it("rejects unsafe journal and stop requests without changing state", async () => {
    let stops = 0;
    const handler = commandHandler(async () => ({ kind: "unknown-agent" }), () => { stops += 1; });
    const journal = post("/api/journal", { on: true });
    journal.headers.delete("origin");
    expect((await handler(journal)).status).toBe(403);
    const stop = post("/api/stop", {});
    stop.headers.delete("origin");
    expect((await handler(stop)).status).toBe(403);
    expect(existsSync(join(scratch, "lanes"))).toBe(false);
    await Bun.sleep(30);
    expect(stops).toBe(0);
  });

  it("routes cancel and maps unknown and unavailable lanes", async () => {
    const seen: AgentId[] = [];
    const handler = commandHandler(async (id) => {
      seen.push(id);
      return id === "lane:running" ? { kind: "sent" } : id === "lane:unknown" ? { kind: "unknown-agent" } : { kind: "not-cancellable", reason: "Lane is not running." };
    });
    expect(await (await handler(post("/api/action", { agent: "lane:running", action: "cancel" }))).json()).toEqual({ ok: true, message: "Cancellation sent." });
    expect((await handler(post("/api/action", { agent: "lane:unknown", action: "cancel" }))).status).toBe(404);
    expect((await handler(post("/api/action", { agent: "lane:done", action: "cancel" }))).status).toBe(409);
    expect(seen).toEqual(["lane:running", "lane:unknown", "lane:done"] as never);
  });

  it("uses the current lane status for a non-running lane", async () => {
    const id = "lane:finished" as AgentId;
    monitor.store.apply({ kind: "agent", id, patch: { harness: "claude", source: "runner-lane", flavor: { kind: "lane", mode: "read-only", stream: "live", label: null, receipt: null } } });
    monitor.store.apply({ kind: "pstack", id });
    monitor.store.apply({ kind: "outcome", id, outcome: "done", at: null, reason: null });
    const handler = commandHandler((agent) => cancelLane(monitor.store, async () => new Map(), agent, () => { throw new Error("must not signal"); }));
    expect((await handler(post("/api/action", { agent: id, action: "cancel" }))).status).toBe(409);
  });

  it("toggles the journal directory and publishes journal state", async () => {
    const lanes = join(scratch, "lanes");
    const deltas: boolean[] = [];
    const unsubscribe = monitor.subscribe({ watch: null, send: (event) => { if (event.event === "delta") deltas.push(event.data.journal); }, ping: () => {} });
    const on = await handle(post("/api/journal", { on: true }));
    expect(on.status).toBe(200);
    expect(existsSync(lanes)).toBe(true);
    expect((await (await handle(request("/api/snapshot", authed))).json() as Snapshot).server.journal).toBe(true);
    await Bun.sleep(300);
    expect(deltas).toContain(true);
    const off = await handle(post("/api/journal", { on: false }));
    expect(off.status).toBe(200);
    expect(existsSync(lanes)).toBe(false);
    expect((await (await handle(request("/api/snapshot", authed))).json() as Snapshot).server.journal).toBe(false);
    await Bun.sleep(300);
    expect(deltas).toContain(false);
    unsubscribe();
  });

  it("schedules stop after returning a successful response", async () => {
    let stopped = false;
    const handler = commandHandler(async () => ({ kind: "unknown-agent" }), () => { stopped = true; });
    const response = await handler(post("/api/stop", {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await Bun.sleep(40);
    expect(stopped).toBe(true);
  });
});

describe("message API", () => {
  it("protects prompt delivery, validates input, and exposes receipts only for visible agents", async () => {
    const { MessageInbox } = await import("./messages.ts");
    const inbox = new MessageInbox(join(scratch, "message-state"));
    const handler = createHandler(monitor, { port: PORT, token: TOKEN, assets: { html: "", css: "", js: "" }, lanes: join(scratch, "lanes"), cancel: async () => ({ kind: "unknown-agent" }), stop: () => {}, inbox });
    try {
      const body = { agent: "claude:s1", mode: "steer", text: "Use an expandable list." };
      expect((await handler(post("/api/messages", body, { authorization: "" }))).status).toBe(401);
      expect((await handler(post("/api/messages", body, { origin: "http://evil.example" }))).status).toBe(403);
      expect((await handler(post("/api/messages", body, { origin: "" }))).status).toBe(403);
      expect((await handler(post("/api/messages", { ...body, agent: "claude:s2" }))).status).toBe(404);
      expect((await handler(post("/api/messages", { ...body, mode: "unknown" }))).status).toBe(400);
      expect((await handler(post("/api/messages", { ...body, text: " " }))).status).toBe(400);
      expect((await handler(post("/api/messages", { ...body, text: "x".repeat(2001) }))).status).toBe(400);
      expect((await handler(post("/api/messages", body))).status).toBe(200);
      const state = await (await handler(request("/api/messages?agent=claude:s1", authed))).json();
      expect(state.target.id).toBe("claude:s1");
      expect(state.connected).toBe(false);
      expect(state.messages[0].text).toBe(body.text);
      expect((await handler(request("/api/messages?agent=claude:s1"))).status).toBe(401);
      expect(await (await handler(request("/api/messages?agent=claude:s2", authed))).json()).toEqual({ target: null, connected: false, messages: [] });
      inbox.receive("claude:s1", false);
      const delivered = await (await handler(request("/api/messages?agent=claude:s1", authed))).json();
      expect(delivered.connected).toBe(true);
      expect(delivered.messages[0].deliveredAt).not.toBeNull();
    } finally { inbox.close(); }
  });
});
