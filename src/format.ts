import type { AgentNode, AgentStatus } from "./domain.ts";

// Pure display formatting shared by the browser and tests.

export function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ago(iso: string | null, now: number): string {
  if (iso === null) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 10_000) return "just now";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function clockTime(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `claude-opus-5-5` reads as `opus 5.5`; other providers' slugs are already short. */
export function prettyModel(model: string | null): string | null {
  if (model === null) return null;
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(model);
  return match === null ? model : `${match[1]} ${match[2]}.${match[3]}`;
}

export function modelOf(node: AgentNode): string | null {
  return prettyModel(node.model.reported ?? node.model.requested);
}

export const STATUS_WORD: Record<AgentStatus["kind"], string> = {
  running: "running",
  idle: "idle",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  ended: "ended",
  unknown: "unknown",
};

export const QUIET_MS = 90_000;
export const STALE_MS = 15 * 60_000;

const RUNNING_VERB = { pid: "working", lifecycle: "in turn", parent: "running" } as const;

/** How long a running agent has gone without stamped activity, once past `QUIET_MS`. Lanes stamp none. */
export function quietFor(node: AgentNode, now: number): number | null {
  if (node.status.kind !== "running" || node.activity?.at == null || node.lastActivityAt === null) return null;
  const silent = now - Date.parse(node.lastActivityAt);
  return Number.isFinite(silent) && silent > QUIET_MS ? silent : null;
}

/**
 * A turn that opened and then went silent. Only a missing end-of-turn record says it still runs,
 * which is what a process killed mid-turn leaves behind; a live process record is never stalled.
 */
export function stalled(node: AgentNode, now: number): boolean {
  if (node.status.kind !== "running" || node.status.evidence !== "lifecycle" || node.lastActivityAt === null) return false;
  const silent = now - Date.parse(node.lastActivityAt);
  return Number.isFinite(silent) && silent >= STALE_MS;
}

/** Doing work now, as far as the evidence shows. */
export function working(node: AgentNode, now: number): boolean {
  return node.status.kind === "running" && !stalled(node, now);
}

/** What the agent is doing now: the call it waits on, else its latest step. */
export function activityLine(node: AgentNode): string | null {
  if (node.pending !== null) return node.pending.snippet;
  if (node.activity !== null) return node.activity.snippet;
  if (node.status.kind === "running" && node.flavor.kind === "lane" && node.flavor.stream === "at-exit") return "reply arrives at exit";
  return null;
}

/** One line of status for a card, e.g. `working · 2m 14s` or `done · 4m ago`. */
export function statusLine(node: AgentNode, now: number): string {
  const status = node.status;
  const session = node.flavor.kind === "session";
  switch (status.kind) {
    case "running": {
      if (stalled(node, now)) return `stalled · ${ago(node.lastActivityAt, now)}`;
      const since = node.startedAt === null ? null : now - Date.parse(node.startedAt);
      const verb = RUNNING_VERB[status.evidence];
      const line = since === null || !Number.isFinite(since) ? verb : `${verb} · ${duration(since)}`;
      const quiet = quietFor(node, now);
      return quiet === null ? line : `${line} · quiet ${duration(quiet)}`;
    }
    case "idle": {
      if (status.detail !== null) return status.detail.replace(/_/g, " ");
      const since = ago(node.lastActivityAt, now);
      if (session && status.evidence === "pid") return `waiting for input · ${since}`;
      return `${session ? "between turns" : "idle"} · ${since}`;
    }
    case "done":
      return `done · ${ago(status.at ?? node.lastActivityAt, now)}`;
    case "failed":
      return `failed · ${status.reason}`;
    case "cancelled":
      return `cancelled · ${ago(status.at ?? node.lastActivityAt, now)}`;
    case "ended":
      return session ? "ended · process gone" : `ended · ${ago(status.at ?? node.lastActivityAt, now)}`;
    case "unknown":
      return "status unknown";
  }
}

export function kindLabel(node: AgentNode): string {
  switch (node.flavor.kind) {
    case "skill": return `pstack skill · ${triggerPhrase(node.flavor.trigger.kind)}`;
    case "session":
      return node.harness === "claude" ? "Claude Code session" : node.harness === "opencode" ? "OpenCode session" : "Codex session";
    case "subagent": {
      // Plugin agent types are namespaced, e.g. `pstack:poteto-agent`; the namespace adds nothing here.
      const type = node.flavor.agentType;
      return type === null ? "subagent" : type.slice(type.lastIndexOf(":") + 1);
    }
    case "lane":
      return `${node.model.provider} lane · ${node.flavor.mode}`;
  }
}

const INPUT_FIELDS = ["command", "description", "file_path", "path", "pattern", "url", "query", "skill", "prompt", "task_name", "message"];

/** A one-line summary of a tool call's input, from its (possibly clipped) JSON. */
export function summarizeInput(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const field of INPUT_FIELDS) {
        const value = record[field];
        if (typeof value === "string" && value.trim().length > 0) return value.replace(/\s+/g, " ").trim();
      }
    }
  } catch {
    // Clipped or not JSON; fall back to the first line.
  }
  const line = input.trim().split("\n", 1)[0] ?? "";
  return line.replace(/\s+/g, " ");
}

export function shortPath(path: string | null): string {
  if (path === null) return "";
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/** Who started a skill run; a skill trigger is drawn as the edge from its parent run. */
export function triggerPhrase(trigger: "user" | "skill" | "model"): string {
  return trigger === "user" ? "typed by you" : trigger === "skill" ? "called by a skill" : "the model's choice";
}
