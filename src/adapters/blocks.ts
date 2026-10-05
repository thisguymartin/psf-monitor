import type { Fact } from "../adapter.ts";
import type { AgentId, ItemId, TimelineItem } from "../domain.ts";
import { array, clip, contentText, object, oneLine, pretty, text } from "../json.ts";

// Claude-style message content blocks. Claude Code transcripts, `claude -p`
// output, and Grok's streaming events all use this shape.

export const BODY_LIMIT = 16_000;
export const SNIPPET_LIMIT = 140;
export const PROMPT_LIMIT = 300;
export const PSTACK_PREFIX = "pstack:";

const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export interface Collected {
  readonly items: TimelineItem[];
  readonly facts: Fact[];
}

export function collected(): Collected {
  return { items: [], facts: [] };
}

export function itemId(offset: number, index: number): ItemId {
  return `${offset}.${index}` as ItemId;
}

export function describeTool(name: string, input: unknown): string {
  const record = object(input);
  const detail = record === null
    ? text(input)
    : text(record.command)
      ?? text(record.description)
      ?? text(record.file_path)
      ?? text(record.path)
      ?? text(record.pattern)
      ?? text(record.url)
      ?? text(record.query)
      ?? text(record.skill)
      ?? text(record.prompt);
  return detail === null ? name : `${name} · ${oneLine(detail, SNIPPET_LIMIT)}`;
}

export function promptFact(agent: AgentId, body: string, at: string | null): Fact {
  return { kind: "prompt", id: agent, text: oneLine(body, PROMPT_LIMIT), at };
}

export function callEnded(agent: AgentId, callId: string, at: string | null): Fact {
  return { kind: "call", id: agent, callId, at, event: { kind: "ended" } };
}

/** A pstack skill or a pstack agent named by a Claude-style tool call. */
export function namesPstack(name: string, input: unknown): boolean {
  const record = object(input);
  if (record === null) return false;
  const target = name === "Skill" ? text(record.skill) : SPAWN_TOOLS.has(name) ? text(record.subagent_type) : null;
  return target?.startsWith(PSTACK_PREFIX) === true;
}

export function textActivity(agent: AgentId, body: string, at: string | null): Fact {
  return { kind: "activity", id: agent, activity: { what: "text", snippet: oneLine(body, SNIPPET_LIMIT), at } };
}

export function assistantBlocks(
  agent: AgentId,
  offset: number,
  at: string | null,
  content: unknown,
  out: Collected
): void {
  array(content).forEach((raw, index) => {
    const block = object(raw);
    if (block === null) return;
    const id = itemId(offset, index);
    switch (block.type) {
      case "text": {
        const body = text(block.text);
        if (body === null) return;
        out.items.push({ id, at, kind: "text", body: clip(body, BODY_LIMIT) });
        out.facts.push(textActivity(agent, body, at));
        return;
      }
      case "thinking":
      case "redacted_thinking": {
        const body = text(block.thinking);
        out.items.push({ id, at, kind: "thinking", body: body === null ? null : clip(body, BODY_LIMIT) });
        out.facts.push({ kind: "activity", id: agent, activity: { what: "thinking", snippet: "thinking", at } });
        return;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const name = text(block.name) ?? "tool";
        const callId = text(block.id) ?? id;
        const snippet = describeTool(name, block.input);
        out.items.push({ id, at, kind: "tool-call", callId, name, input: clip(pretty(block.input), BODY_LIMIT) });
        out.facts.push(
          { kind: "activity", id: agent, activity: { what: "tool", snippet, at } },
          { kind: "call", id: agent, callId, at, event: { kind: "started", name, snippet } },
        );
        if (SPAWN_TOOLS.has(name)) out.facts.push({ kind: "spawn-call", by: agent, callId });
        if (namesPstack(name, block.input)) out.facts.push({ kind: "pstack", id: agent });
        return;
      }
    }
  });
}

export function toolResult(
  offset: number,
  index: number,
  at: string | null,
  block: Record<string, unknown>
): TimelineItem | null {
  const callId = text(block.tool_use_id);
  if (callId === null) return null;
  return {
    id: itemId(offset, index),
    at,
    kind: "tool-result",
    callId,
    ok: block.is_error !== true,
    output: clip(contentText(block.content), BODY_LIMIT),
  };
}
