import { join, relative, sep } from "node:path";
import {
  NOTHING,
  parsed,
  problem,
  type Adapter,
  type Claim,
  type Fact,
  type LineParser,
  type Parsed,
} from "../adapter.ts";
import type { AgentId, TimelineItem } from "../domain.ts";
import {
  array,
  basename,
  clip,
  contentText,
  finite,
  object,
  oneLine,
  parseJson,
  pretty,
  text,
  usageFrom,
} from "../json.ts";
import { BODY_LIMIT, callEnded, describeTool, itemId, promptFact, textActivity } from "./blocks.ts";

// Reads Codex rollouts. Each thread, including every
// spawned child, writes its own rollout; children name their parent thread.

const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

const IGNORED_TYPES = new Set([
  "world_state",
  "token_usage_record",
  "compacted",
  "inter_agent_communication_metadata",
]);

/** Paths and commands only pstack's skills and runner use. */
const PSTACK_MARKERS = ["pstack-runner", "open-pstack/pstack/", "/pstack/skills/"];
const PSTACK_WORD = /\bpstack\b/i;
const SKILL_PATH = /(?:\/pstack\/[^/"\s]+\/skills\/|plugins\/pstack\/skills\/)([^/"\s]+)\/SKILL\.md/;
const THREAD_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const IGNORED_ITEMS = new Set(["ghost_snapshot"]);

export function threadId(thread: string): AgentId {
  return `codex:${thread}` as AgentId;
}

function threadOf(home: string, path: string): string | null {
  const parts = relative(home, path).split(sep);
  if (parts[0] !== "sessions" || parts.length !== 5) return null;
  return ROLLOUT.exec(parts[4]!)?.[1] ?? null;
}

/** Enter only date folders that can hold rollouts written inside the window. */
export function enterDateFolder(sessionsDir: string, dir: string, sinceMs: number): boolean {
  const parts = relative(sessionsDir, dir).split(sep).filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  // A day folder holds threads that started that day and may still be writing; allow a day of slack.
  const since = new Date(sinceMs - 86_400_000);
  const floor = [
    String(since.getFullYear()),
    String(since.getMonth() + 1).padStart(2, "0"),
    String(since.getDate()).padStart(2, "0"),
  ];
  const prefix = parts.join("-");
  return prefix >= floor.slice(0, parts.length).join("-");
}

// The CLI injects context as user messages wrapped in tags; they are not prompts.
function isInjectedContext(body: string): boolean {
  const trimmed = body.trimStart();
  return trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md");
}

class RolloutParser implements LineParser {
  private metaSeen = false;
  private historyStart: number | null = null;
  private isChild = false;
  private current: AgentId | null = null;
  private readonly spawnParents = new Map<string, AgentId>();
  private readonly callOwners = new Map<string, AgentId>();
  private model: string | null = null;

  constructor(private readonly agent: AgentId) {}

  line(line: string, offset: number): Parsed {
    const raw = parseJson(line);
    if (raw === undefined) return problem({ kind: "not-json" });
    const record = object(raw);
    if (record === null) return problem({ kind: "shape", recordType: "?", detail: "record is not an object" });
    const type = text(record.type) ?? "?";
    const payload = object(record.payload);
    const at = text(record.timestamp);

    if (type === "session_meta") {
      // A forked child copies its parent's history, including the parent's meta, after its own.
      if (this.metaSeen) return NOTHING;
      this.metaSeen = true;
      if (payload === null) return problem({ kind: "shape", recordType: type, detail: "missing payload" });
      return this.meta(payload, at);
    }
    const ordinal = finite(record.ordinal);
    if (this.historyStart !== null && ordinal !== undefined && ordinal < this.historyStart) return NOTHING;
    if (payload === null) {
      return IGNORED_TYPES.has(type) ? NOTHING : problem({ kind: "shape", recordType: type, detail: "missing payload" });
    }

    switch (type) {
      case "turn_context":
        return parsed([this.settings(text(payload.model), text(payload.effort), text(payload.cwd))]);
      case "event_msg":
        return this.event(payload, offset, at);
      case "response_item":
        return this.item(payload, offset, at, line.length);
      default:
        if (IGNORED_TYPES.has(type)) return NOTHING;
        return problem(
          { kind: "unknown-type", recordType: type },
          [{ id: itemId(offset, 0), at, kind: "unparsed", recordType: type, bytes: line.length }],
        );
    }
  }

  private meta(payload: Record<string, unknown>, at: string | null): Parsed {
    const source = object(payload.source);
    const subagent = object(source?.subagent);
    const spawn = object(subagent?.thread_spawn);
    const parent = text(payload.parent_thread_id) ?? text(spawn?.parent_thread_id);
    this.isChild = parent !== null;
    this.historyStart = finite(payload.subagent_history_start_ordinal) ?? null;
    const nickname = text(payload.agent_nickname) ?? text(spawn?.agent_nickname);
    const agentPath = text(payload.agent_path) ?? text(spawn?.agent_path);
    const role = text(payload.agent_role) ?? text(spawn?.agent_role) ?? text(subagent?.other);
    const task = agentPath === null ? null : basename(agentPath);
    const named = [nickname, task].filter((part) => part !== null).join(" · ");
    const title = role === "guardian" ? "guardian review" : named.length > 0 ? named : null;
    const cliVersion = text(payload.cli_version);
    const started = text(payload.timestamp) ?? at;
    const facts: Fact[] = [{
      kind: "agent",
      id: this.agent,
      patch: {
        harness: "codex",
        source: "codex-rollout",
        provider: "codex",
        flavor: this.isChild ? { kind: "subagent", agentType: role ?? task } : { kind: "session" },
        ...(text(payload.cwd) !== null ? { cwd: text(payload.cwd)! } : {}),
        ...(started !== null ? { seenAt: started } : {}),
        ...(cliVersion !== null ? { cliVersion } : {}),
        ...(text(payload.originator) !== null ? { entrypoint: text(payload.originator)! } : {}),
        ...(title !== null ? { title } : {}),
        // Codex addresses agents by path within a tree; the root thread is `/root`.
        ...(agentPath !== null ? { agentPath } : this.isChild ? {} : { agentPath: "/root" }),
      },
    }];
    if (parent !== null) facts.push({ kind: "link", id: this.agent, parent: threadId(parent), via: "thread-spawn" });
    return parsed(facts, [], cliVersion);
  }

  private settings(model: string | null, effort: string | null, cwd: string | null): Fact {
    if (model !== null) this.model = model;
    return {
      kind: "agent",
      id: this.agent,
      patch: {
        ...(model !== null ? { requestedModel: model, reportedModel: model } : {}),
        ...(effort !== null ? { effort } : {}),
        ...(cwd !== null ? { cwd } : {}),
      },
    };
  }

  private event(payload: Record<string, unknown>, offset: number, at: string | null): Parsed {
    const turnId = text(payload.turn_id) ?? "turn";
    switch (payload.type) {
      case "task_started":
        this.current = null;
        return parsed([{ kind: "turn", id: this.agent, turnId, at, event: { kind: "started" } }, { kind: "current-skill", agent: this.agent, run: null }]);
      case "task_complete": {
        this.current = null;
        const error = text(object(payload.error)?.message);
        const items: TimelineItem[] = error === null
          ? []
          : [{ id: itemId(offset, 0), at, kind: "notice", level: "error", text: oneLine(error, 400) }];
        return parsed(
          [{ kind: "turn", id: this.agent, turnId, at, event: { kind: "ended", outcome: error === null ? "done" : "failed", reason: error } }, { kind: "current-skill", agent: this.agent, run: null }],
          items,
        );
      }
      case "turn_aborted": {
        this.current = null;
        const reason = text(payload.reason);
        return parsed(
          [{ kind: "turn", id: this.agent, turnId, at, event: { kind: "ended", outcome: "cancelled", reason } }, { kind: "current-skill", agent: this.agent, run: null }],
          [{ id: itemId(offset, 0), at, kind: "notice", level: "info", text: `turn aborted${reason === null ? "" : `: ${reason}`}` }],
        );
      }
      case "token_count": {
        const usage = usageFrom(object(payload.info)?.total_token_usage);
        return usage === null ? NOTHING : parsed([{ kind: "usage", id: this.agent, key: null, usage }]);
      }
      case "thread_settings_applied": {
        const settings = object(payload.thread_settings);
        return settings === null
          ? NOTHING
          : parsed([this.settings(text(settings.model), text(settings.reasoning_effort), text(settings.cwd))]);
      }
      default:
        // event_msg is a wide family of UI events; the response items carry the content.
        return NOTHING;
    }
  }

  private item(payload: Record<string, unknown>, offset: number, at: string | null, bytes: number): Parsed {
    const id = itemId(offset, 0);
    const type = text(payload.type) ?? "?";
    switch (type) {
      case "message": {
        const role = text(payload.role);
        const body = contentText(payload.content);
        if (body.length === 0 || role === "developer" || role === "system") return NOTHING;
        if (role === "assistant") {
          const target = this.current ?? this.agent;
          const clipped = clip(body, BODY_LIMIT);
          return parsed([textActivity(target, body, at), ...(target !== this.agent ? [{ kind: "result" as const, id: target, result: { kind: "text" as const, body: clipped } }] : []), ...(this.isChild ? [{ kind: "result" as const, id: this.agent, result: { kind: "text" as const, body: clipped } }] : [])], [{ id, at, kind: "text", body: clipped }]);
        }
        if (isInjectedContext(body)) return NOTHING;
        this.current = null;
        const facts: Fact[] = this.isChild ? [] : [{ kind: "agent", id: this.agent, patch: { titleHint: oneLine(body, 80) } }];
        facts.push({ kind: "current-skill", agent: this.agent, run: null });
        facts.push(promptFact(this.agent, body, at));
        // A child's prompt can quote its parent's history, so only a root prompt counts as asking for pstack.
        if (!this.isChild && PSTACK_WORD.test(body)) facts.push({ kind: "pstack", id: this.agent });
        return parsed(facts, [{ id, at, kind: "prompt", body: clip(body, BODY_LIMIT) }]);
      }
      case "reasoning": {
        const summary = array(payload.summary)
          .map((part) => text(object(part)?.text))
          .filter((part): part is string => part !== null)
          .join("\n");
        return parsed(
          [{ kind: "activity", id: this.agent, activity: { what: "thinking", snippet: "thinking", at } }],
          [{ id, at, kind: "thinking", body: summary.length === 0 ? null : clip(summary, BODY_LIMIT) }],
        );
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call":
      case "web_search_call": {
        const name = text(payload.name) ?? (type === "web_search_call" ? "web_search" : "shell");
        const input = type === "function_call"
          ? prettyArguments(payload.arguments)
          : type === "custom_tool_call"
            ? text(payload.input) ?? ""
            : pretty(payload.action);
        const callId = text(payload.call_id) ?? text(payload.id) ?? `${offset}`;
        const snippet = describeTool(name, firstLine(input));
        const facts: Fact[] = [
          { kind: "activity", id: this.current ?? this.agent, activity: { what: "tool", snippet, at } },
          { kind: "call", id: this.current ?? this.agent, callId, at, event: { kind: "started", name, snippet } },
        ];
        this.callOwners.set(callId, this.current ?? this.agent);
        const skill = SKILL_PATH.exec(input)?.[1];
        if (skill !== undefined) {
          const run = `skill:${this.agent}/${callId}` as AgentId;
          this.current = run;
          facts.push(
            { kind: "agent", id: run, patch: { harness: "codex", source: "codex-rollout", root: this.agent, flavor: { kind: "skill", skill: `pstack:${skill}`, trigger: { kind: "model" }, runner: this.agent }, title: skill, ...(at !== null ? { seenAt: at } : {}), ...(this.model !== null ? { requestedModel: this.model, reportedModel: this.model } : {}) } },
            { kind: "link", id: run, parent: this.agent, via: "skill" },
            { kind: "current-skill", agent: this.agent, run },
          );
        }
        if (name === "spawn_agent") {
          this.spawnParents.set(callId, this.current ?? this.agent);
          facts.push({ kind: "spawn-call", by: this.current ?? this.agent, callId });
        }
        if (input.includes("pstack-runner")) facts.push({ kind: "lane-call", by: this.current ?? this.agent, callId, at, command: input });
        if (PSTACK_MARKERS.some((marker) => input.includes(marker))) facts.push({ kind: "pstack", id: this.agent });
        return parsed(facts, [{ id, at, kind: "tool-call", callId, name, input: clip(input, BODY_LIMIT) }]);
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        const callId = text(payload.call_id);
        if (callId === null) return problem({ kind: "shape", recordType: `response_item/${type}`, detail: "missing call_id" });
        const output = typeof payload.output === "string" ? payload.output : contentText(payload.output);
        const facts: Fact[] = [callEnded(this.callOwners.get(callId) ?? this.agent, callId, at)];
        const child = this.spawnParents.get(callId);
        const thread = THREAD_UUID.exec(output)?.[0];
        if (child !== undefined && thread !== undefined) facts.push({ kind: "link", id: threadId(thread), parent: child, via: "thread-spawn" });
        return parsed(facts, [{ id, at, kind: "tool-result", callId, ok: null, output: clip(output, BODY_LIMIT) }]);
      }
      case "agent_message": {
        // Recorded once, in the recipient's rollout.
        const author = text(payload.author);
        const recipient = text(payload.recipient);
        const body = contentText(payload.content);
        const facts: Fact[] = author === null || recipient === null
          ? []
          : [{
              kind: "message",
              key: `codex:${text(payload.id) ?? `${this.agent}:${offset}`}`,
              from: { kind: "codex-path", near: this.agent, path: author },
              to: { kind: "codex-path", near: this.agent, path: recipient },
              at,
            }];
        return parsed(facts, [{ id, at, kind: "notice", level: "info", text: `${author ?? "agent"} → ${recipient ?? "agent"}: ${oneLine(body, 600)}` }]);
      }
      case "compaction":
        return parsed([], [{ id, at, kind: "notice", level: "info", text: "context compacted" }]);
      default:
        if (IGNORED_ITEMS.has(type)) return NOTHING;
        return problem(
          { kind: "unknown-type", recordType: `response_item/${type}` },
          [{ id, at, kind: "unparsed", recordType: `response_item/${type}`, bytes }],
        );
    }
  }
}

function prettyArguments(value: unknown): string {
  if (typeof value !== "string") return pretty(value);
  const parsedValue = parseJson(value);
  return parsedValue === undefined ? value : pretty(parsedValue);
}

function firstLine(value: string): string {
  const trimmed = value.trim();
  const end = trimmed.indexOf("\n");
  return end === -1 ? trimmed : trimmed.slice(0, end);
}

export function codexAdapter(home: string): Adapter {
  const sessions = join(home, "sessions");
  return {
    source: "codex-rollout",
    windowed: true,
    checkedVersion: "0.160.0",
    roots: [{ dir: sessions, depth: 4, enter: (dir, sinceMs) => enterDateFolder(sessions, dir, sinceMs) }],

    claim(path: string): Claim | null {
      const thread = threadOf(home, path);
      if (thread === null) return null;
      return { kind: "stream", agent: threadId(thread), root: threadId(thread), header: true };
    },

    open(path: string): LineParser {
      return new RolloutParser(threadId(threadOf(home, path) ?? path));
    },

    document(): Parsed {
      return NOTHING;
    },

    removed() {
      return [];
    },
  };
}
