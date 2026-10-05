import type { AccessMode, NormalizedUsage, ReceiptStatus } from "./pstack.ts";

// Shared by the monitor server and the browser bundle,
// so this file imports nothing from Bun, Node, or the DOM.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `claude:<session>`, `claude:<session>:<agent>`, `codex:<thread>`, or `lane:<lane>`. */
export type AgentId = Brand<string, "AgentId">;
/** `<byteOffset>.<index>` of the record an item came from, in its agent's file. */
export type ItemId = Brand<string, "ItemId">;

export type Harness = "claude" | "codex";
export type SourceKind = "claude-session" | "codex-rollout" | "runner-lane";
export type Health = "ok" | "degraded";

export type AgentStatus =
  | { readonly kind: "running"; readonly evidence: "pid" | "lifecycle" | "parent" }
  | { readonly kind: "idle"; readonly evidence: "pid" | "lifecycle"; readonly detail: string | null }
  | { readonly kind: "done"; readonly at: string | null }
  | { readonly kind: "failed"; readonly at: string | null; readonly reason: string }
  | { readonly kind: "cancelled"; readonly at: string | null }
  // The owning process is gone and no outcome was recorded.
  | { readonly kind: "ended"; readonly at: string | null }
  | { readonly kind: "unknown"; readonly why: string };

export type Flavor =
  | { readonly kind: "session" }
  | { readonly kind: "subagent"; readonly agentType: string | null }
  | {
      readonly kind: "lane";
      readonly mode: AccessMode;
      // "at-exit" lanes print one blob when the child exits; there is nothing to stream.
      readonly stream: "live" | "at-exit";
      readonly label: string | null;
      readonly receipt: ReceiptStatus | null;
    };

export type SpawnVia = "tool-use" | "thread-spawn" | "runner" | "team";

export interface ModelInfo {
  readonly provider: string;
  readonly requested: string | null;
  readonly reported: string | null;
  readonly effort: string | null;
}

export interface Activity {
  readonly what: "text" | "tool" | "thinking";
  readonly snippet: string;
  readonly at: string | null;
}

export interface Prompt {
  readonly text: string;
  readonly at: string | null;
}

/** A tool call still waiting for its result. */
export interface PendingCall {
  readonly name: string;
  readonly snippet: string;
  readonly since: string | null;
}

export interface AgentNode {
  readonly id: AgentId;
  // May name an agent outside the indexed window; the client then draws this node as a root.
  readonly parent: AgentId | null;
  readonly via: SpawnVia | null;
  /** The parent's tool call that spawned this agent, when the harness records one. */
  readonly spawnCall: string | null;
  readonly harness: Harness;
  readonly source: SourceKind;
  readonly flavor: Flavor;
  readonly title: string;
  readonly cwd: string | null;
  readonly model: ModelInfo;
  readonly status: AgentStatus;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly activity: Activity | null;
  /** True when any agent in this node's spawn tree is pstack work. */
  readonly pstack: boolean;
  readonly prompt: Prompt | null;
  readonly pending: PendingCall | null;
  readonly usage: NormalizedUsage | null;
  readonly health: Health;
}

/** Messages one agent sent another, summed. Direction matters: a reply is its own link. */
export interface MessageLink {
  readonly from: AgentId;
  readonly to: AgentId;
  readonly count: number;
  readonly lastAt: string | null;
}

export interface Clipped {
  readonly text: string;
  /** Characters dropped from the end. */
  readonly omitted: number;
}

export type TimelineItem = { readonly id: ItemId; readonly at: string | null } & (
  | { readonly kind: "prompt" | "text"; readonly body: Clipped }
  // `body: null` means the CLI recorded that thinking happened but not its text.
  | { readonly kind: "thinking"; readonly body: Clipped | null }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: Clipped;
    }
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly ok: boolean | null;
      readonly output: Clipped;
    }
  | { readonly kind: "notice"; readonly level: "info" | "error"; readonly text: string }
  | { readonly kind: "unparsed"; readonly recordType: string | null; readonly bytes: number }
);

export type { AccessMode, NormalizedUsage, ReceiptStatus };
