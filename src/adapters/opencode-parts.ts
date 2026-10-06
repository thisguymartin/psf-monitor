import { NOTHING, parsed, problem, type Fact, type Parsed } from "../adapter.ts";
import type { AgentId, NormalizedUsage, TimelineItem } from "../domain.ts";
import { clip, finite, object, pretty, text } from "../json.ts";
import { BODY_LIMIT, callEnded, describeTool, itemId, promptFact, textActivity } from "./blocks.ts";

export function openCodeUsage(value: unknown): NormalizedUsage | null {
  const tokens = object(value);
  if (tokens === null) return null;
  const cache = object(tokens.cache);
  const fields = { inputTokens: finite(tokens.input), outputTokens: finite(tokens.output), reasoningTokens: finite(tokens.reasoning), totalTokens: finite(tokens.total), cachedInputTokens: finite(cache?.read), cacheCreationInputTokens: finite(cache?.write) };
  return Object.values(fields).some((value) => value !== undefined) ? Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) : null;
}

export function openCodePart(agent: AgentId, value: unknown, offset: number, at: string | null, role = "assistant"): Parsed {
  const part = object(value);
  if (part === null) return problem({ kind: "shape", recordType: "opencode-part", detail: "missing part" });
  const type = text(part.type) ?? "?";
  switch (type) {
    case "text": {
      const body = text(part.text);
      if (body === null) return problem({ kind: "shape", recordType: type, detail: "missing text" });
      const facts: Fact[] = role === "user" ? [promptFact(agent, body, at)] : [textActivity(agent, body, at)];
      if (role === "user" && /(?:^|\s)\/?pstack:/.test(body)) facts.push({ kind: "pstack", id: agent });
      return parsed(facts, [{ id: itemId(offset, 0), at, kind: role === "user" ? "prompt" : "text", body: clip(body, BODY_LIMIT) }]);
    }
    case "reasoning": {
      const body = text(part.text);
      return parsed([{ kind: "activity", id: agent, activity: { what: "thinking", snippet: "thinking", at } }], [{ id: itemId(offset, 0), at, kind: "thinking", body: body === null ? null : clip(body, BODY_LIMIT) }]);
    }
    case "step-start": return NOTHING;
    case "step-finish": {
      const usage = openCodeUsage(part.tokens);
      return usage === null ? NOTHING : parsed([{ kind: "usage", id: agent, key: `step:${text(part.id) ?? offset}`, usage }]);
    }
    case "tool": {
      const name = text(part.tool);
      const callId = text(part.callID) ?? text(part.id) ?? String(offset);
      const state = object(part.state);
      if (name === null || state === null) return problem({ kind: "shape", recordType: type, detail: "missing tool or state" });
      const input = object(state.input);
      const snippet = describeTool(name, state.input);
      const facts: Fact[] = [
        { kind: "activity", id: agent, activity: { what: "tool", snippet, at } },
        { kind: "call", id: agent, callId, at, event: { kind: "started", name, snippet } },
      ];
      const items: TimelineItem[] = [{ id: itemId(offset, 0), at, kind: "tool-call", callId, name, input: clip(pretty(state.input), BODY_LIMIT) }];
      const skill = text(input?.name) ?? text(input?.skill);
      const command = text(input?.command);
      if ((name === "skill" && skill?.startsWith("pstack") === true) || command?.includes("pstack-runner") === true || command?.includes("/pstack/") === true) facts.push({ kind: "pstack", id: agent });
      if (command?.includes("pstack-runner")) facts.push({ kind: "lane-call", by: agent, callId, at, command });
      const child = text(object(state.metadata)?.sessionId) ?? text(object(state.metadata)?.sessionID);
      if (name === "task" && child !== null) {
        facts.push({ kind: "spawn-call", by: agent, callId }, { kind: "link-by-call", id: `opencode:${child}` as AgentId, callId, fallback: agent });
      }
      if (state.status === "completed" || state.status === "error") {
        facts.push(callEnded(agent, callId, at));
        items.push({ id: itemId(offset, 1), at, kind: "tool-result", callId, ok: state.status === "completed", output: clip(text(state.error) ?? text(state.output) ?? "", BODY_LIMIT) });
      }
      return parsed(facts, items);
    }
    // Bookkeeping and attachments contain no agent activity to display.
    case "snapshot": case "patch": case "file": case "agent": case "subtask": case "retry": case "compaction": return NOTHING;
    default: return problem({ kind: "unknown-type", recordType: `opencode/${type}` });
  }
}
