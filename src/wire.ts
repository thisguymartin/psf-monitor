import type { AgentId, AgentNode, Health, MessageLink, SourceKind, TimelineItem } from "./domain.ts";
import type { AgentActionId } from "./actions.ts";

// The JSON shapes the server sends the browser.

export interface SourceHealth {
  readonly source: SourceKind;
  readonly state: Health;
  readonly present: boolean;
  readonly files: number;
  readonly lines: number;
  readonly parsed: number;
  readonly notJson: number;
  readonly shape: number;
  readonly oversized: number;
  readonly unknownTypes: Readonly<Record<string, number>>;
  readonly cliVersions: readonly string[];
  /** Versions newer than the one the adapter was checked against. */
  readonly unchecked: readonly string[];
}

export interface ServerInfo {
  readonly app: "psf-monitor";
  readonly version: string;
  readonly instance: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly watching: "events" | "poll";
  readonly indexing: boolean;
  readonly windowHours: number;
  readonly journal: boolean;
}

export interface Snapshot {
  readonly rev: number;
  readonly agents: readonly AgentNode[];
  readonly links: readonly MessageLink[];
  readonly health: readonly SourceHealth[];
  readonly server: ServerInfo;
}

export interface Delta {
  readonly rev: number;
  readonly upserts: readonly AgentNode[];
  /** The whole link list when it changed; null when it did not. */
  readonly links: readonly MessageLink[] | null;
  readonly health: readonly SourceHealth[] | null;
  readonly indexing: boolean;
  readonly journal: boolean;
}

export interface ActionRequest {
  readonly agent: string;
  readonly action: AgentActionId;
}

export interface ActionResponse {
  readonly ok: boolean;
  readonly message: string;
}

export interface JournalRequest { readonly on: boolean }
export interface JournalResponse extends ActionResponse { readonly journal: boolean }
export interface StopResponse { readonly ok: true }

export interface TimelinePage {
  readonly agent: AgentId;
  readonly items: readonly TimelineItem[];
  /** Pass as `before` to load older items; null at the start of the transcript. */
  readonly older: number | null;
}

export interface TimelineAppend {
  readonly agent: AgentId;
  readonly items: readonly TimelineItem[];
}

export type ServerEvent =
  | { readonly event: "snapshot"; readonly data: Snapshot }
  | { readonly event: "delta"; readonly data: Delta }
  | { readonly event: "timeline"; readonly data: TimelinePage }
  | { readonly event: "append"; readonly data: TimelineAppend };
