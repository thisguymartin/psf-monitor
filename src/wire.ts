import type { AgentId, AgentNode, Harness, Health, MessageLink, ReceiptStatus, SourceKind, TimelineItem } from "./domain.ts";
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
  /** Agents the page should drop: hidden sessions and deleted lanes. */
  readonly removals: readonly AgentId[];
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

export type JournalRequest = { readonly on: boolean } | { readonly delete: string } | { readonly clear: true };
export interface JournalResponse extends ActionResponse { readonly journal: boolean }
export interface ResetResponse extends ActionResponse { readonly hidden: number }
export interface StopResponse { readonly ok: true }

/** One recorded lane in pstack's journal, as the page lists it. */
export interface LaneSummary {
  readonly laneId: string;
  readonly label: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly parent: string | null;
  readonly startedAt: string | null;
  /** The receipt's status; "running" while a live runner owns the lane; "unknown" when nothing says. */
  readonly status: ReceiptStatus | "running" | "unknown";
  readonly bytes: number;
}

export interface JournalState {
  readonly on: boolean;
  readonly root: string;
  readonly lanes: readonly LaneSummary[];
}

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

// --- pstack setup -----------------------------------------------------------

export interface PstackInstall {
  readonly harness: Harness;
  readonly version: string | null;
  readonly path: string;
}

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** False for the principle leaves a skill reads by path; nobody types those. */
  readonly invocable: boolean;
}

/** One row of pstack's model matrix: a `(provider, model)` pair with its own effort. */
export interface ModelFamily {
  readonly family: string;
  readonly model: string;
  readonly defaultEffort: string;
  readonly efforts: readonly string[];
}

/** What the lane runner would find for a provider that runs on an API key. Never carries the key. */
export interface GatewaySetup {
  readonly keyVar: string;
  readonly keySet: boolean;
  readonly baseUrlVar: string;
  readonly baseUrl: string;
  readonly baseUrlOverridden: boolean;
  readonly configDirVar: string;
  readonly configDir: string;
  readonly configDirOverridden: boolean;
  readonly maxContextVar: string;
  readonly maxContext: string | null;
  /** A claude.ai login in the config dir makes the runner refuse the lane. */
  readonly login: "none" | "found" | "unreadable";
}

export interface ProviderSetup {
  readonly provider: string;
  readonly kind: "subscription" | "gateway";
  /** The binary the lane runner starts for this provider. */
  readonly cli: string;
  readonly cliPath: string | null;
  readonly families: readonly ModelFamily[];
  readonly gateway: GatewaySetup | null;
  /** Null when a lane could start; otherwise what stops it. */
  readonly blocked: string | null;
}

export interface SheetRole {
  readonly role: string;
  /** `provider:model@effort`, `inherit-parent`, or `auto`; one lane per entry. */
  readonly lanes: readonly string[];
}

export interface ModelSheet {
  readonly harness: Harness;
  readonly path: string;
  readonly present: boolean;
  readonly roles: readonly SheetRole[];
}

export interface SetupSetting {
  readonly variable: string;
  readonly value: string;
  readonly overridden: boolean;
  readonly meaning: string;
}

export interface PstackSetup {
  readonly installs: readonly PstackInstall[];
  readonly skills: readonly SkillInfo[];
  readonly providers: readonly ProviderSetup[];
  readonly sheets: readonly ModelSheet[];
  /** The roles pstack uses until a sheet is written. */
  readonly defaults: readonly SheetRole[];
  readonly settings: readonly SetupSetting[];
  readonly platform: string;
}

export type PromptMode = "steer" | "follow-up";
export interface PromptMessage {
  readonly id: string;
  readonly source: string;
  readonly mode: PromptMode;
  readonly text: string;
  readonly queuedAt: number;
  readonly deliveredAt: number | null;
}
export interface MessageState {
  readonly target: { readonly id: string; readonly title: string } | null;
  readonly connected: boolean;
  readonly messages: readonly PromptMessage[];
}
