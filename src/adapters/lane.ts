import { relative, sep } from "node:path";
import type { LaneRecord, ReceiptStatus, RunnerReceipt } from "../pstack.ts";
import {
  NOTHING,
  parsed,
  problem,
  type Adapter,
  type Claim,
  type Fact,
  type LineParser,
  type Outcome,
  type Parsed,
} from "../adapter.ts";
import type { AgentId, Flavor, TimelineItem } from "../domain.ts";
import { array, clip, contentText, finite, object, oneLine, parseJson, pretty, text, usageFrom } from "../json.ts";
import { assistantBlocks, BODY_LIMIT, callEnded, collected, describeTool, itemId, promptFact, textActivity, toolResult } from "./blocks.ts";

// Reads the runner's lane journal: one directory per
// external lane holding its start record, its raw stdout, and its receipt.

export function laneId(lane: string): AgentId {
  return `lane:${lane}` as AgentId;
}

/** Providers whose CLI streams events while it works; the rest print one result at exit. */
function streams(provider: string): boolean {
  return provider === "codex" || provider === "grok";
}

function outcomeOf(status: ReceiptStatus): Outcome {
  switch (status) {
    case "complete":
      return "done";
    case "cancelled":
      return "cancelled";
    case "unavailable-cli":
    case "unauthenticated":
    case "unavailable-model":
    case "timed-out":
    case "child-failed":
    case "malformed-output":
      return "failed";
  }
}

function locate(root: string, path: string): { lane: string; file: string } | null {
  const parts = relative(root, path).split(sep);
  return parts.length === 2 && parts[0]!.length > 0 && !parts[0]!.startsWith(".") ? { lane: parts[0]!, file: parts[1]! } : null;
}

function flavor(provider: string, mode: unknown, label: string | null, receipt: ReceiptStatus | null): Flavor {
  return {
    kind: "lane",
    mode: mode === "isolated-write" ? "isolated-write" : "read-only",
    stream: streams(provider) ? "live" : "at-exit",
    label,
    receipt,
  };
}

/** Parses the lane's stdout whichever CLI wrote it: Codex exec events or Claude-style messages. */
class StreamParser implements LineParser {
  private readonly started = new Set<string>();

  constructor(private readonly agent: AgentId) {}

  line(line: string, offset: number): Parsed {
    const raw = parseJson(line);
    if (raw === undefined) return problem({ kind: "not-json" });
    const event = object(raw);
    if (event === null) return problem({ kind: "shape", recordType: "?", detail: "event is not an object" });
    const type = text(event.type) ?? "?";
    if (type.startsWith("item.")) return this.item(type, object(event.item), offset);
    switch (type) {
      case "thread.started":
      case "turn.started":
      case "system":
        return NOTHING;
      case "turn.completed": {
        const usage = usageFrom(event.usage);
        return usage === null ? NOTHING : parsed([{ kind: "usage", id: this.agent, key: `turn:${offset}`, usage }]);
      }
      case "turn.failed":
      case "error": {
        const message = text(object(event.error)?.message) ?? text(event.message) ?? "the lane reported an error";
        return parsed([], [{ id: itemId(offset, 0), at: null, kind: "notice", level: "error", text: oneLine(message, 400) }]);
      }
      case "assistant": {
        const out = collected();
        assistantBlocks(this.agent, offset, null, object(event.message)?.content, out);
        return parsed(out.facts, out.items);
      }
      case "user": {
        const items: TimelineItem[] = [];
        const facts: Fact[] = [];
        array(object(event.message)?.content).forEach((block, index) => {
          const record = object(block);
          if (record?.type !== "tool_result") return;
          const item = toolResult(offset, index, null, record);
          if (item?.kind !== "tool-result") return;
          items.push(item);
          facts.push(callEnded(this.agent, item.callId, null));
        });
        return parsed(facts, items);
      }
      case "result": {
        const body = text(event.result);
        const facts: Fact[] = [];
        const items: TimelineItem[] = [];
        const usage = usageFrom(event.usage);
        if (usage !== null) facts.push({ kind: "usage", id: this.agent, key: null, usage });
        if (body !== null) {
          items.push({ id: itemId(offset, 0), at: null, kind: "text", body: clip(body, BODY_LIMIT) });
          facts.push(textActivity(this.agent, body, null));
        }
        if (event.is_error === true) {
          items.push({ id: itemId(offset, 1), at: null, kind: "notice", level: "error", text: "the CLI reported an error result" });
        }
        return parsed(facts, items);
      }
      default:
        return problem({ kind: "unknown-type", recordType: type }, [
          { id: itemId(offset, 0), at: null, kind: "unparsed", recordType: type, bytes: line.length },
        ]);
    }
  }

  private item(type: string, item: Record<string, unknown> | null, offset: number): Parsed {
    if (item === null) return problem({ kind: "shape", recordType: type, detail: "missing item" });
    const kind = text(item.type) ?? "?";
    const callId = text(item.id) ?? `${offset}`;
    const completed = type === "item.completed";
    const call = (name: string, input: string): Parsed => {
      if (this.started.has(callId)) return NOTHING;
      this.started.add(callId);
      const snippet = describeTool(name, input);
      return parsed(
        [
          { kind: "activity", id: this.agent, activity: { what: "tool", snippet, at: null } },
          { kind: "call", id: this.agent, callId, at: null, event: { kind: "started", name, snippet } },
        ],
        [{ id: itemId(offset, 0), at: null, kind: "tool-call", callId, name, input: clip(input, BODY_LIMIT) }],
      );
    };
    const callAndResult = (name: string, input: string, ok: boolean | null, output: string): Parsed => {
      const opened = call(name, input);
      if (!completed) return opened;
      return parsed([...opened.facts, callEnded(this.agent, callId, null)], [
        ...opened.items,
        { id: itemId(offset, 1), at: null, kind: "tool-result", callId, ok, output: clip(output, BODY_LIMIT) },
      ]);
    };
    switch (kind) {
      case "agent_message": {
        const body = text(item.text);
        if (!completed || body === null) return NOTHING;
        return parsed([textActivity(this.agent, body, null)], [{ id: itemId(offset, 0), at: null, kind: "text", body: clip(body, BODY_LIMIT) }]);
      }
      case "reasoning": {
        if (!completed) return NOTHING;
        const body = text(item.text);
        return parsed(
          [{ kind: "activity", id: this.agent, activity: { what: "thinking", snippet: "thinking", at: null } }],
          [{ id: itemId(offset, 0), at: null, kind: "thinking", body: body === null ? null : clip(body, BODY_LIMIT) }],
        );
      }
      case "command_execution": {
        const exit = finite(item.exit_code);
        return callAndResult("shell", text(item.command) ?? "", exit === undefined ? null : exit === 0, text(item.aggregated_output) ?? "");
      }
      case "file_change":
        if (!completed) return NOTHING;
        return callAndResult("apply_patch", pretty(item.changes), item.status === "completed" ? true : item.status === "failed" ? false : null, text(item.status) ?? "");
      case "mcp_tool_call": {
        const name = [text(item.server), text(item.tool)].filter((part) => part !== null).join(".") || "mcp";
        const error = text(object(item.error)?.message);
        return callAndResult(name, pretty(item.arguments), error === null ? (completed ? true : null) : false, error ?? contentText(object(item.result)?.content));
      }
      case "web_search":
        return call("web_search", text(item.query) ?? "");
      case "todo_list": {
        if (!completed) return NOTHING;
        const steps = array(item.items).map(object);
        const doneCount = steps.filter((step) => step?.completed === true).length;
        return parsed([], [{ id: itemId(offset, 0), at: null, kind: "notice", level: "info", text: `plan: ${doneCount} of ${steps.length} steps done` }]);
      }
      case "error":
        return parsed([], [{ id: itemId(offset, 0), at: null, kind: "notice", level: "error", text: oneLine(text(item.message) ?? "error", 400) }]);
      default:
        return problem({ kind: "unknown-type", recordType: `item/${kind}` }, [
          { id: itemId(offset, 0), at: null, kind: "unparsed", recordType: `item/${kind}`, bytes: 0 },
        ]);
    }
  }
}

export function laneAdapter(root: string): Adapter {
  return {
    source: "runner-lane",
    windowed: false,
    checkedVersion: null,
    roots: [{ dir: root, depth: 2 }],

    claim(path: string): Claim | null {
      const location = locate(root, path);
      if (location === null) return null;
      switch (location.file) {
        case "lane.json":
        case "receipt.json":
          return { kind: "document", agent: laneId(location.lane), always: true };
        case "stream.jsonl":
          return { kind: "stream", agent: laneId(location.lane), root: laneId(location.lane), header: false };
        default:
          return null;
      }
    },

    open(path: string): LineParser {
      return new StreamParser(laneId(locate(root, path)?.lane ?? path));
    },

    document(path: string, body: string): Parsed {
      const location = locate(root, path);
      const record = object(parseJson(body));
      if (location === null) return NOTHING;
      if (record === null) return problem({ kind: "shape", recordType: location.file, detail: "not a JSON object" });
      const id = laneId(location.lane);
      if (location.file === "lane.json") return laneRecord(path, id, record as Partial<LaneRecord>);
      return laneReceipt(id, record as Partial<RunnerReceipt>);
    },

    removed(path: string) {
      return locate(root, path)?.file === "lane.json" ? [{ kind: "process-gone", key: path }] : [];
    },
  };
}

function laneRecord(path: string, id: AgentId, record: Partial<LaneRecord>): Parsed {
  const provider = text(record.provider);
  const parent = record.parent === "claude" || record.parent === "codex" ? record.parent : null;
  const pid = finite(record.runnerPid);
  if (provider === null || parent === null || pid === undefined) {
    return problem({ kind: "shape", recordType: "lane.json", detail: "missing provider, parent, or runner pid" });
  }
  const label = text(record.label);
  const started = text(record.startedAt);
  const head = text(record.promptHead);
  const startedMs = started === null ? Number.NaN : Date.parse(started);
  const facts: Fact[] = [
    {
      kind: "agent",
      id,
      patch: {
        harness: parent,
        source: "runner-lane",
        provider,
        flavor: flavor(provider, record.mode, label, null),
        ...(text(record.model) !== null ? { requestedModel: text(record.model)! } : {}),
        ...(text(record.effort) !== null ? { effort: text(record.effort)! } : {}),
        ...(text(record.cwd) !== null ? { cwd: text(record.cwd)! } : {}),
        ...(started !== null ? { seenAt: started } : {}),
        ...(label !== null ? { title: oneLine(label, 120) } : {}),
        ...(head !== null ? { titleHint: oneLine(head, 80) } : {}),
        ...(text(record.outputPath) !== null ? { resultPath: text(record.outputPath)! } : {}),
        ...(text(record.receiptPath) !== null ? { receiptPath: text(record.receiptPath)! } : {}),
      },
    },
    // Only pstack's runner writes a lane record.
    { kind: "pstack", id },
    {
      kind: "process",
      key: path,
      id,
      process: { pid, startedAtMs: Number.isFinite(startedMs) ? startedMs : null, state: "running" },
    },
  ];
  if (head !== null) facts.push(promptFact(id, head, started));
  const session = text(record.parentSessionId);
  if (session !== null) facts.push({ kind: "link", id, parent: `${parent}:${session}` as AgentId, via: "runner" });
  return parsed(facts);
}

const RECEIPT_STATUSES = new Set<string>([
  "complete",
  "cancelled",
  "unavailable-cli",
  "unauthenticated",
  "unavailable-model",
  "timed-out",
  "child-failed",
  "malformed-output",
]);

function laneReceipt(id: AgentId, receipt: Partial<RunnerReceipt>): Parsed {
  const status = text(receipt.status);
  const provider = text(receipt.provider);
  if (status === null || !RECEIPT_STATUSES.has(status) || provider === null) {
    return problem({ kind: "shape", recordType: "receipt.json", detail: "missing or unknown status" });
  }
  const known = status as ReceiptStatus;
  const completedAt = text(receipt.completedAt);
  const outcome = outcomeOf(known);
  const message = text(receipt.error?.message);
  const facts: Fact[] = [
    {
      kind: "agent",
      id,
      patch: {
        provider,
        flavor: flavor(provider, receipt.mode, null, known),
        ...(text(receipt.reportedModel) !== null ? { reportedModel: text(receipt.reportedModel)! } : {}),
        ...(completedAt !== null ? { seenAt: completedAt } : {}),
      },
    },
    {
      kind: "outcome",
      id,
      outcome,
      at: completedAt,
      reason: outcome === "failed" ? `${known.replace(/-/g, " ")}${message === null ? "" : `: ${message}`}` : null,
    },
  ];
  const usage = receipt.usage;
  if (usage !== null && usage !== undefined && Object.values(usage).some((value) => typeof value === "number")) {
    facts.push({ kind: "usage", id, key: null, usage });
  }
  return parsed(facts);
}
