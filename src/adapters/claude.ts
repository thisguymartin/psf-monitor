import { join, relative, sep } from "node:path";
import {
  NOTHING,
  parsed,
  problem,
  type Adapter,
  type AgentPatch,
  type ChildOutcome,
  type Claim,
  type Fact,
  type LineParser,
  type Parsed,
} from "../adapter.ts";
import type { AgentId, TimelineItem } from "../domain.ts";
import {
  array,
  clip,
  contentText,
  finite,
  object,
  oneLine,
  parseJson,
  text,
  usageFrom,
} from "../json.ts";
import {
  assistantBlocks,
  BODY_LIMIT,
  callEnded,
  collected,
  itemId,
  promptFact,
  PSTACK_PREFIX,
  toolResult,
} from "./blocks.ts";

// Reads Claude Code's session transcripts, subagent
// transcripts and their sidecars, and per-process session records.

const IGNORED = new Set([
  "attachment",
  "mode",
  "permission-mode",
  "last-prompt",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "atis-latch",
  "progress",
  "summary",
  "tag",
  "agent-name",
  "agent-color",
  "agent-setting",
  "pr-link",
  "worktree-state",
  "content-replacement",
  "cost-state",
]);

const NOTIFICATION_STATUS: Record<string, ChildOutcome> = {
  completed: "done",
  failed: "failed",
  error: "failed",
  killed: "cancelled",
  cancelled: "cancelled",
  stopped: "cancelled",
};

const RESULT_STATUS: Record<string, ChildOutcome> = {
  completed: "done",
  async_launched: "launched",
  failed: "failed",
  error: "failed",
  killed: "cancelled",
  cancelled: "cancelled",
};

/** Claude Code turns never overlap within one transcript, so one id serves them all. */
const TURN = "turn";

const TURN_ENDS = new Set(["end_turn", "stop_sequence"]);

function pstackAttribution(record: Record<string, unknown>): boolean {
  return text(record.attributionPlugin) === "pstack"
    || text(record.attributionSkill)?.startsWith(PSTACK_PREFIX) === true
    || text(record.attributionAgent)?.startsWith(PSTACK_PREFIX) === true;
}

type Location =
  | { readonly kind: "session"; readonly session: string }
  | { readonly kind: "subagent"; readonly session: string; readonly agent: string }
  | { readonly kind: "meta"; readonly session: string; readonly agent: string }
  | { readonly kind: "process" };

export function sessionId(session: string): AgentId {
  return `claude:${session}` as AgentId;
}

export function subagentId(session: string, agent: string): AgentId {
  return `claude:${session}:${agent}` as AgentId;
}

function locate(home: string, path: string): Location | null {
  const parts = relative(home, path).split(sep);
  if (parts[0] === "sessions" && parts.length === 2 && /^\d+\.json$/.test(parts[1]!)) {
    return { kind: "process" };
  }
  if (parts[0] !== "projects") return null;
  if (parts.length === 3 && parts[2]!.endsWith(".jsonl")) {
    return { kind: "session", session: parts[2]!.slice(0, -".jsonl".length) };
  }
  if (parts.length === 5 && parts[3] === "subagents") {
    const name = parts[4]!;
    const match = /^agent-(.+?)(\.meta\.json|\.jsonl)$/.exec(name);
    if (match === null) return null;
    return match[2] === ".jsonl"
      ? { kind: "subagent", session: parts[2]!, agent: match[1]! }
      : { kind: "meta", session: parts[2]!, agent: match[1]! };
  }
  return null;
}

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return match === null ? null : match[1]!.trim();
}

/** `ps -o lstart=` style text, which Claude Code records in UTC. */
export function procStartMs(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) return null;
  const parsedMs = Date.parse(`${raw.replace(/\s+/g, " ")} UTC`);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

class TranscriptParser implements LineParser {
  private readonly runs = new Map<string, AgentId>();
  private readonly callOwners = new Map<string, AgentId>();
  private current: AgentId | null = null;
  constructor(
    private readonly agent: AgentId,
    private readonly root: AgentId,
  ) {}

  private startSkill(skill: string, key: string, at: string | null, model: string | null, trigger: "user" | "skill" | "model", parent: AgentId, facts: Fact[]): AgentId {
    const id = `skill:${this.agent}/${key}` as AgentId;
    this.runs.set(skill, id);
    this.current = id;
    facts.push(
      { kind: "agent", id, patch: { harness: "claude", source: "claude-session", root: this.root, flavor: { kind: "skill", skill, trigger: { kind: trigger }, runner: this.agent }, title: skill.slice(PSTACK_PREFIX.length), ...(at !== null ? { seenAt: at } : {}), ...(model !== null ? { requestedModel: model, reportedModel: model } : {}) } },
      { kind: "link", id, parent, via: "skill" },
      { kind: "current-skill", agent: this.agent, run: id },
    );
    return id;
  }

  line(line: string, offset: number): Parsed {
    const raw = parseJson(line);
    if (raw === undefined) return problem({ kind: "not-json" });
    const record = object(raw);
    if (record === null) return problem({ kind: "shape", recordType: "?", detail: "record is not an object" });
    const type = text(record.type) ?? "?";
    const at = text(record.timestamp);
    const cliVersion = text(record.version);
    const identity: AgentPatch = {
      harness: "claude",
      source: "claude-session",
      flavor: this.agent === this.root ? { kind: "session" } : { kind: "subagent", agentType: null },
      root: this.root,
      ...(text(record.cwd) !== null ? { cwd: text(record.cwd)! } : {}),
      ...(at !== null ? { seenAt: at } : {}),
      ...(cliVersion !== null ? { cliVersion } : {}),
      ...(text(record.entrypoint) !== null ? { entrypoint: text(record.entrypoint)! } : {}),
    };
    const seen: Fact = { kind: "agent", id: this.agent, patch: identity };

    switch (type) {
      case "assistant":
        return this.assistant(record, offset, at, seen, cliVersion);
      case "user":
        return this.user(record, offset, at, seen, cliVersion);
      case "ai-title":
      case "custom-title": {
        const title = text(record.aiTitle) ?? text(record.customTitle) ?? text(record.title);
        return title === null ? NOTHING : parsed([{ kind: "agent", id: this.agent, patch: { title: oneLine(title, 120) } }]);
      }
      case "system": {
        if (record.level !== "error") return parsed([seen], [], cliVersion);
        const body = text(record.content) ?? text(record.subtype) ?? "error";
        return parsed([seen], [{ id: itemId(offset, 0), at, kind: "notice", level: "error", text: oneLine(body, 400) }], cliVersion);
      }
      default:
        if (IGNORED.has(type)) return parsed(at === null ? [] : [seen], [], cliVersion);
        return problem(
          { kind: "unknown-type", recordType: type },
          [{ id: itemId(offset, 0), at, kind: "unparsed", recordType: type, bytes: line.length }],
        );
    }
  }

  private assistant(
    record: Record<string, unknown>,
    offset: number,
    at: string | null,
    seen: Fact,
    cliVersion: string | null,
  ): Parsed {
    const message = object(record.message);
    if (message === null) return problem({ kind: "shape", recordType: "assistant", detail: "missing message" });
    const out = collected();
    out.facts.push(seen);
    const model = text(message.model);
    const attributed = text(record.attributionSkill);
    let run = attributed?.startsWith(PSTACK_PREFIX) ? this.runs.get(attributed) ?? null : null;
    // A subagent's records inherit the parent's attribution; only a session's own records imply a run.
    if (attributed?.startsWith(PSTACK_PREFIX) && run === null && this.agent === this.root) {
      run = this.startSkill(attributed, text(record.uuid) ?? `${offset}`, at, model, "model", this.agent, out.facts);
    }
    if (run !== this.current) {
      this.current = run;
      out.facts.push({ kind: "current-skill", agent: this.agent, run });
    }
    const target = run ?? this.agent;
    if (run !== null && model !== null && model !== "<synthetic>") {
      out.facts.push({ kind: "agent", id: run, patch: { requestedModel: model, reportedModel: model } });
    }
    const effort = text(record.effort);
    if ((model !== null && model !== "<synthetic>") || effort !== null) {
      out.facts.push({
        kind: "agent",
        id: this.agent,
        patch: {
          ...(model !== null && model !== "<synthetic>" ? { reportedModel: model } : {}),
          ...(effort !== null ? { effort } : {}),
        },
      });
    }
    const usage = usageFrom(message.usage);
    if (usage !== null) {
      // One API message is split across several records that repeat its usage.
      out.facts.push({ kind: "usage", id: this.agent, key: text(message.id) ?? `${offset}`, usage });
    }
    assistantBlocks(this.agent, offset, at, message.content, out);
    if (run !== null) {
      out.facts.forEach((fact, index) => {
        if (fact.kind === "spawn-call") out.facts[index] = { ...fact, by: run };
      });
      for (const fact of [...out.facts]) if (fact.kind === "activity" && fact.id === this.agent) out.facts.push({ ...fact, id: run });
    }
    for (const item of out.items) if (item.kind === "tool-call") this.callOwners.set(item.callId, this.agent);
    for (const item of out.items) if (item.kind === "text") {
      if (target !== this.agent) out.facts.push({ kind: "result", id: target, result: { kind: "text", body: item.body } });
      if (this.agent !== this.root) out.facts.push({ kind: "result", id: this.agent, result: { kind: "text", body: item.body } });
    }
    for (const block of array(message.content)) {
      const call = object(block);
      if (call?.type !== "tool_use") continue;
      const input = object(call.input);
      const callId = text(call.id) ?? `${offset}`;
      if (call.name === "Skill") {
        const skill = text(input?.skill);
        if (skill?.startsWith(PSTACK_PREFIX)) this.startSkill(skill, callId, at, model, run === null ? "model" : "skill", target, out.facts);
      }
      if (call.name === "Bash") {
        const command = text(input?.command);
        if (command?.includes("pstack-runner")) out.facts.push({ kind: "lane-call", by: target, callId, at, command });
      }
    }
    if (pstackAttribution(record) && !out.facts.some((fact) => fact.kind === "pstack")) {
      out.facts.push({ kind: "pstack", id: this.agent });
    }
    // Partial records carry a null stop reason and `tool_use` waits on results; only these end the turn.
    if (TURN_ENDS.has(text(message.stop_reason) ?? "")) {
      out.facts.push({ kind: "turn", id: this.agent, turnId: TURN, at, event: { kind: "ended", outcome: "done", reason: null } });
      this.current = null;
      out.facts.push({ kind: "current-skill", agent: this.agent, run: null });
    }
    for (const block of array(message.content)) {
      const call = object(block);
      if (call?.type !== "tool_use" || call.name !== "SendMessage") continue;
      const target = text(object(call.input)?.to);
      // A `uds:` target is another session's socket; that session is not on this canvas.
      if (target === null || target.startsWith("uds:")) continue;
      out.facts.push({
        kind: "message",
        key: `claude:${text(call.id) ?? `${this.agent}:${offset}`}`,
        from: { kind: "agent", id: this.agent },
        to: { kind: "claude-target", session: this.root, target },
        at,
      });
    }
    return parsed(out.facts, out.items, cliVersion);
  }

  private user(
    record: Record<string, unknown>,
    offset: number,
    at: string | null,
    seen: Fact,
    cliVersion: string | null,
  ): Parsed {
    const message = object(record.message);
    if (message === null) return problem({ kind: "shape", recordType: "user", detail: "missing message" });
    const facts: Fact[] = [seen];
    const items: TimelineItem[] = [];
    const content = message.content;

    if (object(record.origin)?.kind === "task-notification") {
      const body = contentText(content);
      const callId = tag(body, "tool-use-id");
      const status = tag(body, "status");
      const outcome = status === null ? undefined : NOTIFICATION_STATUS[status];
      if (callId !== null && outcome !== undefined) {
        facts.push({ kind: "child-outcome", callId, outcome, at, reason: outcome === "failed" ? status : null });
      }
      const summary = tag(body, "summary") ?? `background task ${status ?? "update"}`;
      items.push({ id: itemId(offset, 0), at, kind: "notice", level: outcome === "failed" ? "error" : "info", text: oneLine(summary, 400) });
      return parsed(facts, items, cliVersion);
    }

    const agentResult = object(record.toolUseResult);
    if (agentResult !== null && text(agentResult.agentId) !== null) {
      const callId = array(content).map((block) => text(object(block)?.tool_use_id)).find((id) => id !== null);
      const outcome = RESULT_STATUS[text(agentResult.status) ?? ""];
      if (callId !== undefined && callId !== null && outcome !== undefined) {
        facts.push({ kind: "child-outcome", callId, outcome, at, reason: outcome === "failed" ? text(agentResult.status) : null });
      }
    }

    if (record.isMeta === true) {
      for (const block of array(content)) {
        const callId = text(object(block)?.tool_use_id);
        if (object(block)?.type === "tool_result" && callId !== null) facts.push(callEnded(this.callOwners.get(callId) ?? this.agent, callId, at));
      }
      return parsed(facts, items, cliVersion);
    }

    if (typeof content === "string") {
      this.prompt(content, offset, 0, at, facts, items);
      return parsed(facts, items, cliVersion);
    }
    array(content).forEach((raw, index) => {
      const block = object(raw);
      if (block === null) return;
      if (block.type === "tool_result") {
        const item = toolResult(offset, index, at, block);
        if (item !== null) items.push(item);
        if (item?.kind === "tool-result") facts.push(callEnded(this.callOwners.get(item.callId) ?? this.agent, item.callId, at));
      } else if (block.type === "text") {
        const body = text(block.text);
        if (body !== null) this.prompt(body, offset, index, at, facts, items);
      } else if (block.type === "image") {
        items.push({ id: itemId(offset, index), at, kind: "notice", level: "info", text: "image attached" });
      }
    });
    return parsed(facts, items, cliVersion);
  }

  private prompt(
    body: string,
    offset: number,
    index: number,
    at: string | null,
    facts: Fact[],
    items: TimelineItem[],
  ): void {
    const command = tag(body, "command-name");
    if (command !== null) {
      items.push({ id: itemId(offset, index), at, kind: "notice", level: "info", text: `ran ${oneLine(command, 80)}` });
      // No turn: a built-in command such as /model gets no reply that would close it.
      const skill = command.replace(/^\//, "");
      if (skill.startsWith(PSTACK_PREFIX)) {
        facts.push({ kind: "pstack", id: this.agent });
        this.startSkill(skill, `${offset}.${index}`, at, null, "user", this.agent, facts);
      }
      return;
    }
    if (body.startsWith("<local-command") || body.startsWith("<system-reminder>")) return;
    if (body.startsWith("[Request interrupted")) {
      items.push({ id: itemId(offset, index), at, kind: "notice", level: "info", text: "interrupted by the user" });
      facts.push({ kind: "turn", id: this.agent, turnId: TURN, at, event: { kind: "ended", outcome: "cancelled", reason: "interrupted by the user" } });
      this.current = null;
      facts.push({ kind: "current-skill", agent: this.agent, run: null });
      return;
    }
    items.push({ id: itemId(offset, index), at, kind: "prompt", body: clip(body, BODY_LIMIT) });
    this.current = null;
    facts.push({ kind: "current-skill", agent: this.agent, run: null });
    facts.push(
      { kind: "agent", id: this.agent, patch: { titleHint: oneLine(body, 80) } },
      { kind: "turn", id: this.agent, turnId: TURN, at, event: { kind: "started" } },
      promptFact(this.agent, body, at),
    );
  }
}

export function claudeAdapter(home: string): Adapter {
  return {
    source: "claude-session",
    windowed: true,
    checkedVersion: "2.1.287",
    roots: [
      { dir: join(home, "sessions"), depth: 1, processRecords: "claude" },
      { dir: join(home, "projects"), depth: 4 },
    ],

    claim(path: string): Claim | null {
      const location = locate(home, path);
      if (location === null) return null;
      switch (location.kind) {
        case "process":
          return { kind: "document", agent: null, always: true };
        case "meta":
          return { kind: "document", agent: subagentId(location.session, location.agent), always: false };
        case "session":
          return { kind: "stream", agent: sessionId(location.session), root: sessionId(location.session), header: false };
        case "subagent":
          return {
            kind: "stream",
            agent: subagentId(location.session, location.agent),
            root: sessionId(location.session),
            header: false,
          };
      }
    },

    open(path: string): LineParser {
      const location = locate(home, path);
      if (location?.kind === "subagent") {
        return new TranscriptParser(subagentId(location.session, location.agent), sessionId(location.session));
      }
      const session = location?.kind === "session" ? location.session : path;
      return new TranscriptParser(sessionId(session), sessionId(session));
    },

    document(path: string, body: string): Parsed {
      const location = locate(home, path);
      const record = object(parseJson(body));
      if (location === null) return NOTHING;
      if (record === null) return problem({ kind: "shape", recordType: location.kind, detail: "not a JSON object" });

      if (location.kind === "process") {
        const session = text(record.sessionId);
        const pid = finite(record.pid);
        if (session === null || pid === undefined) {
          return problem({ kind: "shape", recordType: "process", detail: "missing sessionId or pid" });
        }
        const id = sessionId(session);
        return parsed([
          {
            kind: "agent",
            id,
            patch: {
              harness: "claude",
              source: "claude-session",
              flavor: { kind: "session" },
              ...(text(record.cwd) !== null ? { cwd: text(record.cwd)! } : {}),
              ...(text(record.entrypoint) !== null ? { entrypoint: text(record.entrypoint)! } : {}),
            },
          },
          {
            kind: "process",
            key: path,
            id,
            process: { pid, startedAtMs: procStartMs(record.procStart), state: text(record.status) },
          },
        ], [], text(record.version));
      }

      if (location.kind !== "meta") return NOTHING;
      const id = subagentId(location.session, location.agent);
      const root = sessionId(location.session);
      const title = text(record.description) ?? text(record.name);
      const model = text(record.model);
      const facts: Fact[] = [{
        kind: "agent",
        id,
        patch: {
          harness: "claude",
          source: "claude-session",
          flavor: { kind: "subagent", agentType: text(record.agentType) },
          root,
          ...(title !== null ? { title: oneLine(title, 120) } : {}),
          ...(model !== null ? { requestedModel: model } : {}),
          ...(text(record.name) !== null ? { agentName: text(record.name)! } : {}),
        },
      }];
      const toolUseId = text(record.toolUseId);
      if (toolUseId !== null) {
        facts.push({ kind: "link-by-call", id, callId: toolUseId, fallback: root });
      } else if (text(record.teamName) !== null) {
        facts.push({ kind: "link", id, parent: root, via: "team" });
      }
      if (text(record.agentType)?.startsWith(PSTACK_PREFIX) === true) facts.push({ kind: "pstack", id });
      if (record.stoppedByUser === true) {
        facts.push({ kind: "outcome", id, outcome: "cancelled", at: null, reason: "stopped by the user" });
      }
      return parsed(facts);
    },

    removed(path: string) {
      return locate(home, path)?.kind === "process" ? [{ kind: "process-gone", key: path }] : [];
    },
  };
}
