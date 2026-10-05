import type {
  Activity,
  AgentId,
  Flavor,
  Harness,
  NormalizedUsage,
  SourceKind,
  SpawnVia,
  TimelineItem,
} from "./domain.ts";

// Adapters are the only code that knows a transcript
// format. They turn raw records into facts; the store alone decides state.

export interface AgentPatch {
  readonly harness?: Harness;
  readonly source?: SourceKind;
  readonly flavor?: Flavor;
  /** The session whose process decides this agent's liveness. Defaults to the agent itself. */
  readonly root?: AgentId;
  /** Codex's address for the agent within its tree, such as `/root` or `/root/judge`. */
  readonly agentPath?: string;
  /** The name a Claude Code teammate is addressed by. */
  readonly agentName?: string;
  readonly cwd?: string;
  readonly seenAt?: string;
  readonly cliVersion?: string;
  readonly entrypoint?: string;
  readonly provider?: string;
  readonly requestedModel?: string;
  readonly reportedModel?: string;
  readonly effort?: string;
  /** Wins over any hint. */
  readonly title?: string;
  /** Used only when nothing better is known; the first hint sticks. */
  readonly titleHint?: string;
}

export type Outcome = "done" | "failed" | "cancelled";
export type ChildOutcome = "launched" | Outcome;

/** One end of an agent-to-agent message, as the transcript names it. The store resolves it. */
export type Endpoint =
  | { readonly kind: "agent"; readonly id: AgentId }
  /** A Codex agent path, resolved within the tree that `near` belongs to. */
  | { readonly kind: "codex-path"; readonly near: AgentId; readonly path: string }
  /** A Claude Code `SendMessage` target (an agent id, a name, or `main`), resolved within `session`. */
  | { readonly kind: "claude-target"; readonly session: AgentId; readonly target: string };

export interface ProcessRecord {
  readonly pid: number;
  /** When the recorded process started, so a reused pid is not mistaken for it. */
  readonly startedAtMs: number | null;
  /** The harness's own state word, such as `busy` or `idle`. */
  readonly state: string | null;
}

export type Fact =
  | { readonly kind: "agent"; readonly id: AgentId; readonly patch: AgentPatch }
  | { readonly kind: "link"; readonly id: AgentId; readonly parent: AgentId; readonly via: SpawnVia }
  // The parent is whichever agent made `callId`; `fallback` until that call is seen.
  | {
      readonly kind: "link-by-call";
      readonly id: AgentId;
      readonly callId: string;
      readonly fallback: AgentId;
    }
  | { readonly kind: "spawn-call"; readonly by: AgentId; readonly callId: string }
  // `key` is unique per message, so a message seen twice counts once.
  | {
      readonly kind: "message";
      readonly key: string;
      readonly from: Endpoint;
      readonly to: Endpoint;
      readonly at: string | null;
    }
  | { readonly kind: "activity"; readonly id: AgentId; readonly activity: Activity }
  | { readonly kind: "pstack"; readonly id: AgentId }
  | { readonly kind: "prompt"; readonly id: AgentId; readonly text: string; readonly at: string | null }
  | {
      readonly kind: "call";
      readonly id: AgentId;
      readonly callId: string;
      readonly at: string | null;
      readonly event: { readonly kind: "started"; readonly name: string; readonly snippet: string } | { readonly kind: "ended" };
    }
  // `key: null` is a cumulative total that replaces earlier usage.
  | {
      readonly kind: "usage";
      readonly id: AgentId;
      readonly key: string | null;
      readonly usage: NormalizedUsage;
    }
  | {
      readonly kind: "child-outcome";
      readonly callId: string;
      readonly outcome: ChildOutcome;
      readonly at: string | null;
      readonly reason: string | null;
    }
  | {
      readonly kind: "outcome";
      readonly id: AgentId;
      readonly outcome: Outcome;
      readonly at: string | null;
      readonly reason: string | null;
    }
  | {
      readonly kind: "turn";
      readonly id: AgentId;
      readonly turnId: string;
      readonly at: string | null;
      readonly event:
        | { readonly kind: "started" }
        | { readonly kind: "ended"; readonly outcome: Outcome; readonly reason: string | null };
    }
  // `key` names the record's file so a later removal can retract it.
  | {
      readonly kind: "process";
      readonly key: string;
      readonly id: AgentId;
      readonly process: ProcessRecord;
    }
  | { readonly kind: "process-gone"; readonly key: string };

export type Problem =
  | { readonly kind: "not-json" }
  | { readonly kind: "unknown-type"; readonly recordType: string }
  | { readonly kind: "shape"; readonly recordType: string; readonly detail: string };

export interface Parsed {
  readonly facts: readonly Fact[];
  readonly items: readonly TimelineItem[];
  readonly problem: Problem | null;
  readonly cliVersion: string | null;
}

export const NOTHING: Parsed = { facts: [], items: [], problem: null, cliVersion: null };

export type Claim =
  | {
      readonly kind: "stream";
      readonly agent: AgentId;
      /** The session root whose liveness keeps this file indexed past the window. */
      readonly root: AgentId;
      /** Prime the parser with line 0 before parsing from the middle of the file. */
      readonly header: boolean;
    }
  | {
      readonly kind: "document";
      /** The agent this document describes; indexed whenever that agent is. */
      readonly agent: AgentId | null;
      /** Index regardless of age, such as a live process record. */
      readonly always: boolean;
    };

export interface LineParser {
  line(text: string, offset: number): Parsed;
}

export interface Root {
  readonly dir: string;
  readonly depth: number;
  /** Return false to skip a directory, such as a Codex date folder outside the window. */
  readonly enter?: (dir: string, sinceMs: number) => boolean;
  /** The directory's existence proves this harness keeps per-process records. */
  readonly processRecords?: Harness;
}

export interface Adapter {
  readonly source: SourceKind;
  readonly roots: readonly Root[];
  /** False when every file is indexed regardless of age. */
  readonly windowed: boolean;
  /** Newest CLI version the adapter was checked against; newer versions are flagged. */
  readonly checkedVersion: string | null;
  claim(path: string): Claim | null;
  open(path: string): LineParser;
  document(path: string, text: string): Parsed;
  /** Facts that retract a document that no longer exists. */
  removed(path: string): readonly Fact[];
}

export function parsed(
  facts: readonly Fact[],
  items: readonly TimelineItem[] = [],
  cliVersion: string | null = null
): Parsed {
  return { facts, items, problem: null, cliVersion };
}

export function problem(value: Problem, items: readonly TimelineItem[] = []): Parsed {
  return { facts: [], items, problem: value, cliVersion: null };
}
