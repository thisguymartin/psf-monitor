// The lane journal pstack's runner writes, schema version 1. psf-monitor only
// reads it; the writer is pstack-flex's runner/flex-journal.ts, and the two
// change together. Types only, because the browser bundle imports this file.

export type Parent = "claude" | "codex";
export type AccessMode = "read-only" | "isolated-write";

export type ReceiptStatus =
  | "complete"
  | "cancelled"
  | "unavailable-cli"
  | "unauthenticated"
  | "unavailable-model"
  | "timed-out"
  | "child-failed"
  | "malformed-output";

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

/** `lane.json`, written when the lane starts. */
export interface LaneRecord {
  readonly schemaVersion: 1;
  readonly laneId: string;
  readonly runnerPid: number;
  readonly startedAt: string;
  readonly parent: Parent;
  readonly parentSessionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly mode: AccessMode;
  readonly label: string | null;
  readonly cwd: string;
  readonly promptPath: string;
  /** The start of the prompt, so the monitor can say what the lane was asked. */
  readonly promptHead: string | null;
  readonly outputPath: string;
  readonly receiptPath: string;
}

/** The fields of `receipt.json` the monitor reads; the runner writes more. */
export interface RunnerReceipt {
  readonly schemaVersion: 1;
  readonly status: ReceiptStatus;
  readonly provider: string;
  readonly mode: AccessMode;
  readonly completedAt: string;
  readonly reportedModel: string | null;
  readonly usage: NormalizedUsage | null;
  readonly error: { readonly message: string; readonly evidence: string } | null;
}
