import { timingSafeEqual } from "node:crypto";
import type { AgentId } from "./domain.ts";
import { FIRST_PAGE, type Monitor } from "./monitor.ts";
import type { ServerEvent } from "./wire.ts";

// The monitor's HTTP surface. Read-only, loopback only,
// and every route but the health check requires the per-start token.

const MAX_PAGE = 400;
const MAX_ID = 300;

export interface Assets {
  readonly html: string;
  readonly css: string;
  readonly js: string;
}

export interface HandlerOptions {
  readonly port: number;
  readonly token: string;
  readonly assets: Assets;
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

function cursorParam(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "read-only");

    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const info = monitor.info();
      return json({ app: info.app, version: info.version, instance: info.instance, pid: info.pid });
    }

    if (url.pathname === "/" && url.searchParams.has("token")) {
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

    switch (url.pathname) {
      case "/": {
        // Theme the first paint from the link, so a Codex session never flashes orange.
        const harness = url.searchParams.get("harness") === "codex" ? "codex" : "claude";
        const html = options.assets.html.replace('data-harness="claude"', `data-harness="${harness}"`);
        return respond(200, html, { "Content-Type": "text/html; charset=utf-8" });
      }
      case "/app.js":
        return respond(200, options.assets.js, { "Content-Type": "text/javascript; charset=utf-8" });
      case "/app.css":
        return respond(200, options.assets.css, { "Content-Type": "text/css; charset=utf-8" });
      case "/api/snapshot":
        return json(monitor.snapshot());
      case "/api/timeline": {
        const agent = agentParam(url.searchParams.get("agent"));
        if (agent === null) return plain(400, "agent is required");
        const limit = Math.min(MAX_PAGE, cursorParam(url.searchParams.get("limit")) ?? FIRST_PAGE);
        const page = monitor.timeline(agent, cursorParam(url.searchParams.get("before")), Math.max(1, limit));
        return page === null ? plain(404, "unknown agent") : json(page);
      }
      case "/api/events":
        return events(monitor, agentParam(url.searchParams.get("watch")), request, server);
      default:
        return plain(404, "not found");
    }
  };
}

function events(monitor: Monitor, watchAgent: AgentId | null, request: Request, server?: ServerControl): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const close = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = monitor.subscribe({
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
