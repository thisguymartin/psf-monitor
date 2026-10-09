import { timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { MessageInbox, messageTarget } from "./messages.ts";
import { AGENT_ACTIONS } from "./actions.ts";
import type { CancelResult } from "./control.ts";
import { SCOPES, type AgentId, type Scope } from "./domain.ts";
import { clearLanes, deleteLane, isLaneId, journalEnabled, journalOff, journalOn, listLanes } from "./journal.ts";
import { FIRST_PAGE, type Monitor } from "./monitor.ts";
import type { JournalState, PstackSetup, ServerEvent } from "./wire.ts";

// The monitor's HTTP surface. Loopback only, with a per-start token.

const MAX_PAGE = 400;
const MAX_ID = 300;
const MAX_BODY = 4 * 1024;
const MAX_RESULT = 256 * 1024;

export interface Assets {
  readonly html: string;
  readonly css: string;
  readonly js: string;
}

export interface HandlerOptions {
  readonly port: number;
  readonly token: string;
  readonly assets: Assets;
  readonly lanes: string;
  readonly cancel: (id: AgentId) => Promise<CancelResult>;
  /** Reads how pstack is set up; absent where no one asks. */
  readonly setup?: () => PstackSetup;
  readonly inbox?: MessageInbox;
  readonly stop: () => void;
}

/** The subset of Bun's server the handler uses; absent in tests. */
export interface ServerControl {
  timeout(request: Request, seconds: number): void;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function respond(status: number, body: BodyInit | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function json(value: unknown, status = 200): Response {
  return respond(status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

function plain(status: number, message: string): Response {
  return respond(status, `${message}\n`, { "Content-Type": "text/plain; charset=utf-8" });
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function agentParam(value: string | null): AgentId | null {
  if (value === null || value.length === 0 || value.length > MAX_ID) return null;
  return value as AgentId;
}

/** The page's scope; absent means pstack sessions only, and anything unknown is refused. */
function scopeParam(value: string | null): Scope | null {
  if (value === null) return "pstack";
  return (SCOPES as readonly string[]).includes(value) ? (value as Scope) : null;
}

function cursorParam(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Runs only after the token check, so the body comes from the page itself.
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("Content-Type must be application/json.");
  const body = await request.text();
  if (body.length > MAX_BODY) throw new Error("Request body is too large.");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createHandler(monitor: Monitor, options: HandlerOptions) {
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  const cookieName = `psf_monitor_${options.port}`;

  const authorized = (request: Request): boolean => {
    const bearer = request.headers.get("authorization");
    if (bearer !== null && bearer.startsWith("Bearer ") && sameSecret(bearer.slice(7), options.token)) return true;
    const value = cookie(request, cookieName);
    return value !== null && sameSecret(value, options.token);
  };

  return async (request: Request, server?: ServerControl): Promise<Response> => {
    // A page on another site can reach loopback through DNS rebinding; it cannot fake these headers.
    if (!hosts.has(request.headers.get("host") ?? "")) return plain(403, "forbidden host");
    const origin = request.headers.get("origin");
    if (origin !== null && !origins.has(origin)) return plain(403, "forbidden origin");
    if (request.method !== "GET" && request.method !== "POST") return plain(405, "method not allowed");

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const info = monitor.info();
      return json({ app: info.app, version: info.version, instance: info.instance, pid: info.pid });
    }

    if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (!sameSecret(url.searchParams.get("token") ?? "", options.token)) return plain(401, "invalid token");
      url.searchParams.delete("token");
      const query = url.searchParams.toString();
      return respond(303, null, {
        Location: query.length > 0 ? `/?${query}` : "/",
        "Set-Cookie": `${cookieName}=${options.token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    if (!authorized(request)) {
      return plain(401, "Open the link printed by `psf-monitor start`; it carries this server's access token.");
    }

    if (request.method === "POST") {
      if (!origins.has(origin ?? "")) return plain(403, "origin required");
      if (url.pathname !== "/api/messages" && url.pathname !== "/api/action" && url.pathname !== "/api/journal" && url.pathname !== "/api/reset" && url.pathname !== "/api/stop") return plain(405, "method not allowed");
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        return json({ ok: false, message: error instanceof Error ? error.message : "Invalid request." }, 400);
      }
      if (url.pathname === "/api/messages") {
        if (!object(body) || typeof body.agent !== "string" || agentParam(body.agent) === null) return json({ ok: false, message: "Expected agent." }, 400);
        const target = messageTarget(monitor.store, body.agent as AgentId);
        if (target === null) return json({ ok: false, message: "No supported recipient for this agent." }, 404);
        if (options.inbox === undefined) return json({ ok: false, message: "Message inbox unavailable. Restart the monitor." }, 503);
        if (typeof body.cancel === "string") return json({ ok: options.inbox.cancel(target.id, body.cancel), message: "Queued message removed, or already delivered." });
        if ((body.mode !== "steer" && body.mode !== "follow-up") || typeof body.text !== "string" || body.text.trim().length === 0 || body.text.length > 2000) return json({ ok: false, message: "Choose a delivery mode and enter 1–2000 characters." }, 400);
        try {
          options.inbox.enqueue(target.id, body.agent, body.mode, body.text.trim());
          return json({ ok: true, message: "Message queued." });
        } catch (error) { return json({ ok: false, message: error instanceof Error ? error.message : "Could not queue message." }, 409); }
      }
      if (url.pathname === "/api/action") {
        if (!object(body) || typeof body.agent !== "string" || agentParam(body.agent) === null || typeof body.action !== "string") {
          return json({ ok: false, message: "Expected agent and action." }, 400);
        }
        const action = AGENT_ACTIONS.find((item) => item.id === body.action && item.runs === "server");
        if (action === undefined) return json({ ok: false, message: "Unknown server action." }, 400);
        switch (action.id) {
          case "cancel": {
            const result = await options.cancel(body.agent as AgentId);
            switch (result.kind) {
              case "sent": return json({ ok: true, message: "Cancellation sent." });
              case "unknown-agent": return json({ ok: false, message: "Unknown agent." }, 404);
              case "process-gone": return json({ ok: false, message: "Lane runner is no longer running." }, 409);
              case "not-cancellable": return json({ ok: false, message: result.reason }, 409);
            }
          }
          case "hide":
            return monitor.hide(body.agent as AgentId) === null
              ? json({ ok: false, message: "Unknown agent." }, 404)
              : json({ ok: true, message: "Session hidden. It returns when it is active again." });
          case "copy-resume":
            return json({ ok: false, message: "Unknown server action." }, 400);
        }
      }
      if (url.pathname === "/api/journal") {
        if (!object(body)) return json({ ok: false, message: "Expected JSON object." }, 400);
        try {
          if (typeof body.on === "boolean") {
            const change = body.on ? journalOn(options.lanes) : journalOff(options.lanes);
            return json({ ok: true, journal: journalEnabled(options.lanes), message: change === "enabled" ? "Lane journal on." : change === "disabled" ? "Lane journal off; recorded lanes deleted." : body.on ? "Lane journal is already on." : "Lane journal is already off." });
          }
          if (typeof body.delete === "string") {
            if (!isLaneId(body.delete)) return json({ ok: false, message: "Not a lane id." }, 400);
            if (monitor.laneRunning(body.delete)) return json({ ok: false, message: "This lane is still running. Cancel it first." }, 409);
            const result = deleteLane(options.lanes, body.delete);
            if (result === "missing") return json({ ok: false, message: "Lane records are already gone." }, 404);
            monitor.forgetLane(body.delete);
            return json({ ok: true, journal: journalEnabled(options.lanes), message: "Lane records deleted." });
          }
          if (body.clear === true) {
            const { deleted, kept } = clearLanes(options.lanes, (lane) => monitor.laneRunning(lane));
            for (const lane of deleted) monitor.forgetLane(lane);
            const summary = `${deleted.length} lane${deleted.length === 1 ? "" : "s"} deleted${kept.length > 0 ? `; ${kept.length} running lane${kept.length === 1 ? "" : "s"} kept` : ""}.`;
            return json({ ok: true, journal: journalEnabled(options.lanes), message: summary });
          }
          return json({ ok: false, message: "Expected on, delete, or clear." }, 400);
        } catch {
          return json({ ok: false, message: "Could not change lane journal." }, 500);
        }
      }
      if (url.pathname === "/api/reset") {
        if (!object(body)) return json({ ok: false, message: "Expected JSON object." }, 400);
        const hidden = monitor.resetHidden();
        return json({ ok: true, hidden, message: hidden === 0 ? "No hidden sessions." : `${hidden} hidden session${hidden === 1 ? "" : "s"} shown again.` });
      }
      if (!object(body)) return json({ ok: false, message: "Expected JSON object." }, 400);
      const response = json({ ok: true });
      // Let Bun write the reply before serve() closes its listener.
      setTimeout(options.stop, 25);
      return response;
    }

    switch (url.pathname) {
      case "/": {
        // Theme the first paint from the link, so a Codex session never flashes orange.
        const harness = url.searchParams.get("harness") === "codex" ? "codex" : url.searchParams.get("harness") === "opencode" ? "opencode" : "claude";
        const html = options.assets.html.replace('data-harness="claude"', `data-harness="${harness}"`);
        return respond(200, html, { "Content-Type": "text/html; charset=utf-8" });
      }
      case "/app.js":
        return respond(200, options.assets.js, { "Content-Type": "text/javascript; charset=utf-8" });
      case "/app.css":
        return respond(200, options.assets.css, { "Content-Type": "text/css; charset=utf-8" });
      case "/api/snapshot": {
        const scope = scopeParam(url.searchParams.get("scope"));
        return scope === null ? plain(400, "scope must be pstack, normal, or all") : json(monitor.snapshot(scope));
      }
      case "/api/journal": {
        const state: JournalState = { on: journalEnabled(options.lanes), root: options.lanes, lanes: listLanes(options.lanes, (lane) => monitor.laneRunning(lane)) };
        return json(state);
      }
      case "/api/messages": {
        const agent = agentParam(url.searchParams.get("agent"));
        const target = agent === null ? null : messageTarget(monitor.store, agent);
        if (target === null) return json({ target: null, connected: false, messages: [] });
        if (options.inbox === undefined) return plain(503, "message inbox unavailable");
        return json({ target: { id: target.id, title: target.title }, connected: options.inbox.connected(target.id), messages: options.inbox.list(target.id) });
      }
      case "/api/setup":
        return options.setup === undefined ? plain(404, "not found") : json(options.setup());
      case "/api/result": {
        const agent = agentParam(url.searchParams.get("agent"));
        const path = agent === null ? null : monitor.resultPath(agent);
        if (path === null || agent === null) return plain(404, "result not found");
        try {
          const file = await open(path, "r");
          try {
            if (!(await file.stat()).isFile()) return plain(404, "result not found");
            const buffer = Buffer.alloc(MAX_RESULT + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            const truncated = bytesRead > MAX_RESULT;
            return json({ agent, format: "markdown", text: new TextDecoder().decode(buffer.subarray(0, Math.min(bytesRead, MAX_RESULT))), truncated });
          } finally {
            await file.close();
          }
        } catch {
          return plain(404, "result not found");
        }
      }
      case "/api/timeline": {
        const agent = agentParam(url.searchParams.get("agent"));
        if (agent === null) return plain(400, "agent is required");
        const limit = Math.min(MAX_PAGE, cursorParam(url.searchParams.get("limit")) ?? FIRST_PAGE);
        const page = monitor.timeline(agent, cursorParam(url.searchParams.get("before")), Math.max(1, limit));
        return page === null ? plain(404, "unknown agent") : json(page);
      }
      case "/api/events": {
        const scope = scopeParam(url.searchParams.get("scope"));
        if (scope === null) return plain(400, "scope must be pstack, normal, or all");
        return events(monitor, scope, agentParam(url.searchParams.get("watch")), request, server);
      }
      case "/api/action":
      case "/api/reset":
      case "/api/stop":
        return plain(405, "method not allowed");
      default:
        return plain(404, "not found");
    }
  };
}

function events(monitor: Monitor, scope: Scope, watchAgent: AgentId | null, request: Request, server?: ServerControl): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const close = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = monitor.subscribe({
        scope,
        watch: watchAgent,
        send: (event: ServerEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
        },
        ping: () => controller.enqueue(encoder.encode(": ping\n\n")),
      });
    },
    cancel: close,
  });
  request.signal.addEventListener("abort", close);
  // Server-sent events stay open for as long as the page does.
  server?.timeout(request, 0);
  return respond(200, stream, {
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
  });
}
