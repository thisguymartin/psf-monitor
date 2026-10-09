import type {
  Activity,
  AgentId,
  AgentNode,
  AgentStatus,
  Flavor,
  Harness,
  MessageLink,
  NormalizedUsage,
  PendingCall,
  Prompt,
  Result,
  Scope,
  SourceKind,
  SpawnVia,
} from "./domain.ts";
import type { AgentPatch, ChildOutcome, Endpoint, Fact, Outcome, ProcessRecord } from "./adapter.ts";

// The single owner of agent state. Adapters report
// facts; status is derived here from evidence and never from file mtimes.

interface Ended {
  readonly outcome: Outcome;
  readonly at: string | null;
  readonly reason: string | null;
}

interface AgentState {
  readonly id: AgentId;
  harness: Harness;
  source: SourceKind;
  flavor: Flavor;
  root: AgentId;
  fallbackParent: AgentId | null;
  spawnCall: string | null;
  via: SpawnVia | null;
  agentPath: string | null;
  agentName: string | null;
  cwd: string | null;
  cliVersion: string | null;
  entrypoint: string | null;
  provider: string;
  requestedModel: string | null;
  reportedModel: string | null;
  effort: string | null;
  title: string | null;
  titleHint: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  activity: Activity | null;
  pstack: boolean;
  prompt: Prompt | null;
  readonly openCalls: Map<string, PendingCall>;
  usageTotal: NormalizedUsage | null;
  readonly usageByKey: Map<string, NormalizedUsage>;
  outcome: Ended | null;
  openTurn: string | null;
  lastTurn: Ended | null;
  shapeErrors: number;
  result: Result | null;
  resultPath: string | null;
  receiptPath: string | null;
}

interface ProcessEntry {
  readonly id: AgentId;
  readonly record: ProcessRecord;
  alive: boolean | null;
}

export interface ProbeTarget {
  readonly key: string;
  readonly pid: number;
  readonly startedAtMs: number | null;
}

export interface Flush {
  readonly rev: number;
  readonly upserts: readonly AgentNode[];
  /** Agents that left the page: hidden trees and forgotten lanes. */
  readonly removals: readonly AgentId[];
  /** Every message link, sent whole whenever any of them changed; null when none did. */
  readonly links: readonly MessageLink[] | null;
}

interface Message {
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly at: string | null;
}

export interface StatusView {
  currentSkill(id: AgentId): AgentId | null;
  process(id: AgentId): ProcessEntry | null;
  childOutcome(callId: string): { readonly outcome: ChildOutcome; readonly at: string | null; readonly reason: string | null } | null;
  /** True once the harness is known to keep per-process records on this machine. */
  keepsProcessRecords(harness: Harness): boolean;
  status(id: AgentId): AgentStatus | null;
}

const MAX_OPEN_CALLS = 16;

const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function sumUsage(values: Iterable<NormalizedUsage>): NormalizedUsage | null {
  const total: Record<string, number> = {};
  let any = false;
  for (const usage of values) {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (value === undefined) continue;
      total[field] = (total[field] ?? 0) + value;
      any = true;
    }
  }
  return any ? (total as NormalizedUsage) : null;
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b < a ? b : a;
}

function ended(value: Ended): AgentStatus {
  switch (value.outcome) {
    case "done":
      return { kind: "done", at: value.at };
    case "failed":
      return { kind: "failed", at: value.at, reason: value.reason ?? "failed" };
    case "cancelled":
      return { kind: "cancelled", at: value.at };
  }
}

/** Null when the process is gone. */
function processStatus(entry: ProcessEntry): AgentStatus | null {
  if (entry.alive === false) return null;
  if (entry.alive === null) return { kind: "unknown", why: "process not probed yet" };
  const state = entry.record.state;
  if (state === null || state === "busy" || state === "running") {
    return { kind: "running", evidence: "pid" };
  }
  if (state === "idle") return { kind: "idle", evidence: "pid", detail: null };
  return { kind: "idle", evidence: "pid", detail: state };
}

function childStatusFromOutcome(outcome: ChildOutcome, at: string | null, reason: string | null): AgentStatus | null {
  return outcome === "launched" ? null : ended({ outcome, at, reason });
}

/** Status as a pure function of one agent's evidence and its relatives. */
export function deriveStatus(agent: AgentState, view: StatusView): AgentStatus {
  if (agent.flavor.kind === "skill") {
    const runner = agent.flavor.runner;
    return view.currentSkill(runner) === agent.id && view.status(runner)?.kind === "running"
      ? { kind: "running", evidence: "parent" }
      : { kind: "done", at: agent.lastActivityAt };
  }
  if (agent.outcome !== null) return ended(agent.outcome);
  const flavor = agent.flavor;
  switch (flavor.kind) {
    case "lane": {
      const entry = view.process(agent.id);
      if (entry === null) return { kind: "unknown", why: "lane has no runner pid" };
      if (entry.alive === false) {
        return { kind: "failed", at: agent.lastActivityAt, reason: "runner exited without a receipt" };
      }
      return processStatus(entry) ?? { kind: "unknown", why: "runner state unknown" };
    }
    case "session":
    case "subagent": {
      if (agent.harness === "codex" || agent.harness === "opencode") return codexStatus(agent, flavor.kind === "session");
      if (flavor.kind === "session") return claudeSessionStatus(agent, view);
      return claudeSubagentStatus(agent, view);
    }
  }
}

/** Status from turn boundaries alone; null when no turn was ever recorded. */
function lifecycleStatus(agent: AgentState, isRoot: boolean): AgentStatus | null {
  if (agent.openTurn !== null) return { kind: "running", evidence: "lifecycle" };
  if (agent.lastTurn === null) return null;
  if (isRoot) {
    return agent.lastTurn.outcome === "done"
      ? { kind: "idle", evidence: "lifecycle", detail: null }
      : { kind: "idle", evidence: "lifecycle", detail: agent.lastTurn.outcome === "cancelled" ? "interrupted" : "last turn failed" };
  }
  return ended(agent.lastTurn);
}

function codexStatus(agent: AgentState, isRoot: boolean): AgentStatus {
  return lifecycleStatus(agent, isRoot) ?? { kind: "unknown", why: "no turn recorded yet" };
}

function claudeSessionStatus(agent: AgentState, view: StatusView): AgentStatus {
  const entry = view.process(agent.id);
  if (entry !== null) {
    return processStatus(entry) ?? { kind: "ended", at: agent.lastActivityAt };
  }
  // Terminal sessions always keep a process record; a missing one means the process is gone.
  if (view.keepsProcessRecords("claude") && agent.entrypoint === "cli") {
    return { kind: "ended", at: agent.lastActivityAt };
  }
  // Desktop and SDK sessions keep no process record; their turns are the only evidence.
  const turns = lifecycleStatus(agent, true);
  if (turns !== null) return turns;
  return {
    kind: "unknown",
    why: agent.entrypoint === null ? "no process record" : `${agent.entrypoint} sessions keep no process record`,
  };
}

function claudeSubagentStatus(agent: AgentState, view: StatusView): AgentStatus {
  if (agent.spawnCall !== null) {
    const result = view.childOutcome(agent.spawnCall);
    if (result !== null) {
      const status = childStatusFromOutcome(result.outcome, result.at, result.reason);
      if (status !== null) return status;
    }
  }
  // Its own transcript ending is the earliest proof of done; the parent's result can lag by minutes.
  if (agent.openTurn === null && agent.lastTurn !== null) return ended(agent.lastTurn);
  const root = view.status(agent.root);
  if (root === null) return { kind: "unknown", why: "parent session not indexed" };
  switch (root.kind) {
    case "running":
    case "idle":
      if (agent.openTurn !== null) return { kind: "running", evidence: "lifecycle" };
      return agent.spawnCall === null
        ? { kind: "unknown", why: "teammate; no lifecycle record" }
        : { kind: "running", evidence: "parent" };
    case "unknown":
      return { kind: "unknown", why: root.why };
    default:
      return { kind: "ended", at: agent.lastActivityAt };
  }
}

function defaultTitle(agent: AgentState): string {
  switch (agent.flavor.kind) {
    case "skill": return agent.flavor.skill.slice("pstack:".length);
    case "session":
      return agent.harness === "claude" ? "Claude Code session" : agent.harness === "opencode" ? "OpenCode session" : "Codex session";
    case "subagent":
      return agent.flavor.agentType ?? "subagent";
    case "lane":
      return agent.flavor.label ?? `${agent.provider}:${agent.requestedModel ?? "?"}@${agent.effort ?? "?"}`;
  }
}

export class Store implements StatusView {
  private readonly agents = new Map<AgentId, AgentState>();
  private readonly spawnCalls = new Map<string, AgentId>();
  private readonly laneCalls = new Map<string, { by: AgentId; at: string | null; command: string }>();
  private readonly currentSkills = new Map<AgentId, AgentId | null>();
  private laneMatches: Map<AgentId, { by: AgentId; at: string | null; command: string }> | null = null;
  private readonly childOutcomes = new Map<string, { outcome: ChildOutcome; at: string | null; reason: string | null }>();
  private readonly processes = new Map<string, ProcessEntry>();
  private readonly processByAgent = new Map<AgentId, string>();
  private readonly processRecordHarnesses = new Set<Harness>();
  private readonly sent = new Map<AgentId, string>();
  private readonly statusCache = new Map<AgentId, AgentStatus>();
  private readonly messages = new Map<string, Message>();
  private pstackRoots: Set<AgentId> | null = null;
  /** Tree roots the user hid, with when; a tree active after that time comes back on its own. */
  private readonly hidden = new Map<AgentId, number>();
  private treeActivity: Map<AgentId, number> | null = null;
  private readonly pendingRemovals = new Set<AgentId>();
  private sentLinks = "[]";
  private dirty = false;
  private revision = 0;

  /** Told when a hidden tree became active again, so the hide can be dropped wherever it was kept. */
  onUnhide: (root: AgentId) => void = () => {};

  get rev(): number {
    return this.revision;
  }

  /** Replaces the hide list, as read from disk at startup. */
  setHidden(entries: ReadonlyMap<AgentId, number>): void {
    this.hidden.clear();
    for (const [root, at] of entries) this.hidden.set(root, at);
    this.changed();
  }

  /** Hides the tree under `id` until any agent in it is active after `at`. */
  hide(id: AgentId, at: number): AgentId | null {
    if (!this.agents.has(id)) return null;
    const root = this.treeRoot(id);
    this.hidden.set(root, at);
    for (const member of this.treeIds(root)) {
      this.sent.delete(member);
      this.pendingRemovals.add(member);
    }
    this.changed();
    return root;
  }

  clearHidden(): number {
    const count = this.hidden.size;
    for (const root of this.hidden.keys()) for (const member of this.treeIds(root)) this.sent.delete(member);
    this.hidden.clear();
    this.changed();
    return count;
  }

  hiddenRoots(): AgentId[] {
    this.refreshHidden();
    return [...this.hidden.keys()];
  }

  /** Drops agents the monitor should no longer know about, such as a deleted lane. */
  forget(ids: readonly AgentId[]): void {
    for (const id of ids) {
      if (!this.agents.delete(id)) continue;
      const key = this.processByAgent.get(id);
      if (key !== undefined) this.retractProcess(key);
      this.currentSkills.delete(id);
      this.sent.delete(id);
      this.pendingRemovals.add(id);
    }
    this.changed();
  }

  inScope(id: AgentId, scope: Scope): boolean {
    if (!this.agents.has(id)) return false;
    switch (scope) {
      case "all": return true;
      case "pstack": return this.isPstack(id);
      case "normal": return !this.isPstack(id);
    }
  }

  isHidden(id: AgentId): boolean {
    this.refreshHidden();
    return this.hidden.has(this.treeRoot(id));
  }

  private treeIds(root: AgentId): AgentId[] {
    const ids: AgentId[] = [];
    for (const id of this.agents.keys()) if (this.treeRoot(id) === root) ids.push(id);
    return ids;
  }

  private latestActivity(root: AgentId): number {
    if (this.treeActivity === null) {
      this.treeActivity = new Map();
      for (const agent of this.agents.values()) {
        const at = agent.lastActivityAt === null ? Number.NaN : Date.parse(agent.lastActivityAt);
        if (!Number.isFinite(at)) continue;
        const top = this.treeRoot(agent.id);
        this.treeActivity.set(top, Math.max(this.treeActivity.get(top) ?? Number.NEGATIVE_INFINITY, at));
      }
    }
    return this.treeActivity.get(root) ?? Number.NEGATIVE_INFINITY;
  }

  /** A hidden tree that was active after it was hidden is shown again. */
  private refreshHidden(): void {
    for (const [root, at] of this.hidden) {
      if (this.latestActivity(root) <= at) continue;
      this.hidden.delete(root);
      for (const member of this.treeIds(root)) this.sent.delete(member);
      this.dirty = true;
      this.onUnhide(root);
    }
  }

  apply(fact: Fact): void {
    this.changed();
    switch (fact.kind) {
      case "agent":
        this.patch(this.ensure(fact.id, fact.patch), fact.patch);
        return;
      case "link": {
        const agent = this.ensure(fact.id, {});
        if (agent.fallbackParent?.startsWith("skill:") && !fact.parent.startsWith("skill:") && fact.via === "thread-spawn") return;
        if (fact.parent !== fact.id) agent.fallbackParent = fact.parent;
        agent.via = fact.via;
        return;
      }
      case "link-by-call": {
        const agent = this.ensure(fact.id, {});
        agent.spawnCall = fact.callId;
        if (fact.fallback !== fact.id) agent.fallbackParent = fact.fallback;
        agent.via = "tool-use";
        return;
      }
      case "spawn-call":
        this.spawnCalls.set(fact.callId, fact.by);
        return;
      case "lane-call":
        this.laneCalls.set(fact.callId, { by: fact.by, at: fact.at, command: fact.command });
        return;
      case "current-skill":
        this.currentSkills.set(fact.agent, fact.run);
        return;
      case "result":
        this.ensure(fact.id, {}).result = fact.result;
        return;
      case "message":
        this.messages.set(fact.key, { from: fact.from, to: fact.to, at: fact.at });
        return;
      case "activity": {
        const agent = this.ensure(fact.id, {});
        agent.activity = fact.activity;
        agent.lastActivityAt = later(agent.lastActivityAt, fact.activity.at);
        return;
      }
      case "pstack":
        this.ensure(fact.id, {}).pstack = true;
        return;
      case "prompt": {
        const agent = this.ensure(fact.id, {});
        agent.prompt = { text: fact.text, at: fact.at };
        agent.lastActivityAt = later(agent.lastActivityAt, fact.at);
        return;
      }
      case "call": {
        const agent = this.ensure(fact.id, {});
        if (fact.event.kind === "started") {
          agent.openCalls.delete(fact.callId);
          agent.openCalls.set(fact.callId, { name: fact.event.name, snippet: fact.event.snippet, since: fact.at });
          if (agent.openCalls.size > MAX_OPEN_CALLS) agent.openCalls.delete(agent.openCalls.keys().next().value!);
        } else {
          agent.openCalls.delete(fact.callId);
        }
        agent.lastActivityAt = later(agent.lastActivityAt, fact.at);
        return;
      }
      case "usage": {
        const agent = this.ensure(fact.id, {});
        if (fact.key === null) {
          agent.usageTotal = fact.usage;
          agent.usageByKey.clear();
        } else {
          agent.usageByKey.set(fact.key, fact.usage);
        }
        return;
      }
      case "child-outcome":
        this.childOutcomes.set(fact.callId, { outcome: fact.outcome, at: fact.at, reason: fact.reason });
        return;
      case "outcome": {
        const agent = this.ensure(fact.id, {});
        agent.outcome = { outcome: fact.outcome, at: fact.at, reason: fact.reason };
        agent.openCalls.clear();
        return;
      }
      case "turn": {
        const agent = this.ensure(fact.id, {});
        agent.openCalls.clear();
        if (fact.event.kind === "started") {
          agent.openTurn = fact.turnId;
        } else {
          if (agent.openTurn === fact.turnId || agent.openTurn === null) agent.openTurn = null;
          agent.lastTurn = { outcome: fact.event.outcome, at: fact.at, reason: fact.event.reason };
        }
        agent.lastActivityAt = later(agent.lastActivityAt, fact.at);
        return;
      }
      case "process": {
        // The record is rewritten on every state change; keep the probe result while it names the same process.
        const previous = this.processes.get(fact.key);
        const same = previous !== undefined && previous.id === fact.id && previous.record.pid === fact.process.pid;
        this.retractProcess(fact.key);
        this.ensure(fact.id, {});
        this.processes.set(fact.key, { id: fact.id, record: fact.process, alive: same ? previous.alive : null });
        this.processByAgent.set(fact.id, fact.key);
        return;
      }
      case "process-gone":
        this.retractProcess(fact.key);
        return;
    }
  }

  noteShapeError(id: AgentId): void {
    const agent = this.agents.get(id);
    if (agent === undefined) return;
    agent.shapeErrors += 1;
    this.changed();
  }

  noteProcessRecords(harness: Harness): void {
    if (this.processRecordHarnesses.has(harness)) return;
    this.processRecordHarnesses.add(harness);
    this.changed();
  }

  probeTargets(): readonly ProbeTarget[] {
    return [...this.processes].map(([key, entry]) => ({
      key,
      pid: entry.record.pid,
      startedAtMs: entry.record.startedAtMs,
    }));
  }

  setAlive(key: string, alive: boolean): void {
    const entry = this.processes.get(key);
    if (entry === undefined || entry.alive === alive) return;
    entry.alive = alive;
    this.changed();
  }

  has(id: AgentId): boolean {
    return this.agents.has(id);
  }

  /** Every distinct working directory an indexed session root reported, most recent first. */
  cwds(): string[] {
    const latest = new Map<string, string>();
    for (const agent of this.agents.values()) {
      if (agent.cwd === null || agent.flavor.kind !== "session") continue;
      const at = agent.lastActivityAt ?? agent.startedAt ?? "";
      if (at >= (latest.get(agent.cwd) ?? "")) latest.set(agent.cwd, at);
    }
    return [...latest].sort((a, b) => b[1].localeCompare(a[1])).map(([cwd]) => cwd);
  }

  currentSkill(id: AgentId): AgentId | null {
    return this.currentSkills.get(id) ?? null;
  }

  resultPath(id: AgentId): string | null {
    const node = this.agents.get(id);
    return node?.flavor.kind === "lane" ? node.resultPath : null;
  }

  /** True when the agent's session root has a live process, so its files stay indexed. */
  isLive(id: AgentId): boolean {
    const entry = this.process(id);
    return entry !== null && entry.alive !== false;
  }

  // StatusView
  process(id: AgentId): ProcessEntry | null {
    const key = this.processByAgent.get(id);
    return key === undefined ? null : this.processes.get(key) ?? null;
  }

  childOutcome(callId: string) {
    return this.childOutcomes.get(callId) ?? null;
  }

  keepsProcessRecords(harness: Harness): boolean {
    return this.processRecordHarnesses.has(harness);
  }

  status(id: AgentId): AgentStatus | null {
    const cached = this.statusCache.get(id);
    if (cached !== undefined) return cached;
    const agent = this.agents.get(id);
    if (agent === undefined) return null;
    // Guards a malformed parent cycle; a node never asks about itself twice.
    this.statusCache.set(id, { kind: "unknown", why: "status cycle" });
    const status = deriveStatus(agent, this);
    this.statusCache.set(id, status);
    return status;
  }

  private parentOf(agent: AgentState): AgentId | null {
    if (agent.flavor.kind === "lane") {
      const match = this.matchedLaneCalls().get(agent.id);
      if (match !== undefined) return match.by;
    }
    const parent = agent.spawnCall !== null
      ? this.spawnCalls.get(agent.spawnCall) ?? agent.fallbackParent
      : agent.fallbackParent;
    return parent === agent.id ? null : parent;
  }

  private matchedLaneCalls(): Map<AgentId, { by: AgentId; at: string | null; command: string }> {
    if (this.laneMatches !== null) return this.laneMatches;
    const matches = new Map<AgentId, { by: AgentId; at: string | null; command: string }>();
    const used = new Set<string>();
    const lanes = [...this.agents.values()].filter((agent) => agent.flavor.kind === "lane")
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    for (const lane of lanes) {
      const calls = [...this.laneCalls].filter(([key, call]) => !used.has(key) &&
        (lane.fallbackParent === null
          ? lane.harness === "opencode" && this.agents.get(call.by)?.harness === "opencode" && lane.cwd !== null && this.agents.get(call.by)?.cwd === lane.cwd
          : call.by === lane.fallbackParent || this.agents.get(call.by)?.root === lane.fallbackParent));
      const literal = [lane.receiptPath, lane.resultPath, lane.fallbackParent !== null && lane.flavor.kind === "lane" ? lane.flavor.label : null]
        .filter((value): value is string => value !== null && value.length > 0);
      let selected = calls.find(([, call]) => literal.some((value) => call.command.includes(value)));
      if (selected === undefined && lane.fallbackParent !== null && lane.startedAt !== null) {
        const started = Date.parse(lane.startedAt);
        selected = calls.filter(([, call]) => {
          const at = call.at === null ? Number.NaN : Date.parse(call.at);
          return Number.isFinite(at) && at <= started && started - at <= 120_000;
        }).sort((a, b) => (b[1].at ?? "").localeCompare(a[1].at ?? ""))[0];
      }
      if (selected !== undefined) { used.add(selected[0]); matches.set(lane.id, selected[1]); }
    }
    this.laneMatches = matches;
    return matches;
  }

  /** The top of the spawn tree an agent belongs to, as far as the indexed agents reach. */
  private treeRoot(id: AgentId): AgentId {
    let current = id;
    const seen = new Set<AgentId>();
    for (;;) {
      const agent = this.agents.get(current);
      if (agent === undefined || seen.has(current)) return current;
      seen.add(current);
      const parent = this.parentOf(agent);
      if (parent === null || !this.agents.has(parent)) return current;
      current = parent;
    }
  }

  private resolve(endpoint: Endpoint, codexPaths: Map<string, AgentId>): AgentId | null {
    switch (endpoint.kind) {
      case "agent":
        return this.agents.has(endpoint.id) ? endpoint.id : null;
      case "codex-path": {
        const root = this.treeRoot(endpoint.near);
        return endpoint.path === "/root" ? root : codexPaths.get(`${root}|${endpoint.path}`) ?? null;
      }
      case "claude-target": {
        if (endpoint.target === "main") return this.agents.has(endpoint.session) ? endpoint.session : null;
        const byId = `${endpoint.session}:${endpoint.target}` as AgentId;
        if (this.agents.has(byId)) return byId;
        for (const agent of this.agents.values()) {
          if (agent.root === endpoint.session && agent.id !== endpoint.session && agent.agentName === endpoint.target) {
            return agent.id;
          }
        }
        return null;
      }
    }
  }

  /** Messages summed per sender and recipient. A message whose ends are not both indexed is left out. */
  links(scope: Scope = "pstack"): MessageLink[] {
    const codexPaths = new Map<string, AgentId>();
    for (const agent of this.agents.values()) {
      if (agent.agentPath !== null) codexPaths.set(`${this.treeRoot(agent.id)}|${agent.agentPath}`, agent.id);
    }
    const pairs = new Map<string, { from: AgentId; to: AgentId; count: number; lastAt: string | null }>();
    for (const message of this.messages.values()) {
      const from = this.resolve(message.from, codexPaths);
      const to = this.resolve(message.to, codexPaths);
      if (from === null || to === null || from === to || !this.inScope(from, scope) || !this.inScope(to, scope) || this.isHidden(from) || this.isHidden(to)) continue;
      const key = `${from}>${to}`;
      const pair = pairs.get(key) ?? { from, to, count: 0, lastAt: null };
      pair.count += 1;
      pair.lastAt = later(pair.lastAt, message.at);
      pairs.set(key, pair);
    }
    return [...pairs.values()].sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
  }

  node(id: AgentId): AgentNode | null {
    const agent = this.agents.get(id);
    if (agent === undefined) return null;
    return {
      id: agent.id,
      parent: this.parentOf(agent),
      via: agent.flavor.kind === "lane" && this.parentOf(agent) !== agent.fallbackParent ? "runner" : agent.via,
      spawnCall: agent.spawnCall,
      harness: agent.harness,
      source: agent.source,
      flavor: agent.flavor,
      pstack: this.isPstack(id),
      title: agent.title ?? agent.titleHint ?? defaultTitle(agent),
      cwd: agent.cwd,
      model: {
        provider: agent.provider,
        requested: agent.requestedModel,
        reported: agent.reportedModel,
        effort: agent.effort,
      },
      status: this.status(id) ?? { kind: "unknown", why: "missing" },
      startedAt: agent.startedAt,
      lastActivityAt: agent.lastActivityAt,
      activity: agent.activity,
      prompt: agent.prompt,
      result: agent.flavor.kind === "lane" && agent.resultPath !== null ? { kind: "file", bytes: null } : agent.result,
      pending: [...agent.openCalls.values()].at(-1) ?? null,
      usage: agent.usageTotal ?? sumUsage(agent.usageByKey.values()),
      health: agent.shapeErrors > 0 ? "degraded" : "ok",
    };
  }

  /** True when any agent in the same spawn tree carries pstack evidence. */
  isPstack(id: AgentId): boolean {
    if (!this.agents.has(id)) return false;
    if (this.pstackRoots === null) {
      this.pstackRoots = new Set();
      for (const agent of this.agents.values()) if (agent.pstack) this.pstackRoots.add(this.treeRoot(agent.id));
    }
    return this.pstackRoots.has(this.treeRoot(id));
  }

  /** The agents a page with this scope shows: in scope and not hidden. */
  nodes(scope: Scope = "pstack"): AgentNode[] {
    const result: AgentNode[] = [];
    for (const id of this.agents.keys()) {
      if (!this.inScope(id, scope) || this.isHidden(id)) continue;
      const node = this.node(id);
      if (node !== null) result.push(node);
    }
    return result;
  }

  /**
   * Nodes whose serialized form changed since the last flush, across every scope,
   * with the agents that left and the links if any changed. Callers filter by scope.
   */
  flush(): Flush | null {
    this.refreshHidden();
    if (!this.dirty) return null;
    this.dirty = false;
    const upserts: AgentNode[] = [];
    for (const node of this.nodes("all")) {
      const serialized = JSON.stringify(node);
      if (this.sent.get(node.id) === serialized) continue;
      this.sent.set(node.id, serialized);
      upserts.push(node);
    }
    const removals = [...this.pendingRemovals].filter((id) => !this.agents.has(id) || this.isHidden(id));
    this.pendingRemovals.clear();
    const links = this.links("all");
    const serializedLinks = JSON.stringify(links);
    const linksChanged = serializedLinks !== this.sentLinks;
    this.sentLinks = serializedLinks;
    if (upserts.length === 0 && removals.length === 0 && !linksChanged) return null;
    this.revision += 1;
    return { rev: this.revision, upserts, removals, links: linksChanged ? links : null };
  }

  private changed(): void {
    this.dirty = true;
    this.statusCache.clear();
    this.pstackRoots = null;
    this.treeActivity = null;
    this.laneMatches = null;
  }

  private retractProcess(key: string): void {
    const entry = this.processes.get(key);
    if (entry === undefined) return;
    this.processes.delete(key);
    if (this.processByAgent.get(entry.id) === key) this.processByAgent.delete(entry.id);
  }

  private ensure(id: AgentId, patch: AgentPatch): AgentState {
    const existing = this.agents.get(id);
    if (existing !== undefined) return existing;
    const created: AgentState = {
      id,
      harness: patch.harness ?? "claude",
      source: patch.source ?? "claude-session",
      flavor: patch.flavor ?? { kind: "session" },
      root: patch.root ?? id,
      fallbackParent: null,
      spawnCall: null,
      via: null,
      agentPath: null,
      agentName: null,
      cwd: null,
      cliVersion: null,
      entrypoint: null,
      provider: patch.provider ?? patch.harness ?? "claude",
      requestedModel: null,
      reportedModel: null,
      effort: null,
      title: null,
      titleHint: null,
      startedAt: null,
      lastActivityAt: null,
      activity: null,
      pstack: false,
      prompt: null,
      openCalls: new Map(),
      usageTotal: null,
      usageByKey: new Map(),
      outcome: null,
      openTurn: null,
      lastTurn: null,
      shapeErrors: 0,
      result: null,
      resultPath: null,
      receiptPath: null,
    };
    this.agents.set(id, created);
    return created;
  }

  private patch(agent: AgentState, patch: AgentPatch): void {
    if (patch.harness !== undefined) agent.harness = patch.harness;
    if (patch.source !== undefined) agent.source = patch.source;
    if (patch.flavor !== undefined) agent.flavor = mergeFlavor(agent.flavor, patch.flavor);
    if (agent.flavor.kind === "skill") agent.pstack = true;
    if (patch.root !== undefined) {
      agent.root = patch.root;
      if (agent.fallbackParent === null && patch.root !== agent.id) agent.fallbackParent = patch.root;
    }
    if (patch.agentPath !== undefined) agent.agentPath = patch.agentPath;
    if (patch.agentName !== undefined) agent.agentName = patch.agentName;
    if (patch.cwd !== undefined) agent.cwd = patch.cwd;
    if (patch.cliVersion !== undefined) agent.cliVersion = patch.cliVersion;
    if (patch.entrypoint !== undefined) agent.entrypoint = patch.entrypoint;
    if (patch.provider !== undefined) agent.provider = patch.provider;
    if (patch.requestedModel !== undefined) agent.requestedModel = patch.requestedModel;
    if (patch.reportedModel !== undefined) agent.reportedModel = patch.reportedModel;
    if (patch.effort !== undefined) agent.effort = patch.effort;
    if (patch.title !== undefined) agent.title = patch.title;
    if (patch.titleHint !== undefined && agent.titleHint === null) agent.titleHint = patch.titleHint;
    if (patch.resultPath !== undefined) agent.resultPath = patch.resultPath;
    if (patch.receiptPath !== undefined) agent.receiptPath = patch.receiptPath;
    if (patch.seenAt !== undefined) {
      agent.startedAt = earlier(agent.startedAt, patch.seenAt);
      agent.lastActivityAt = later(agent.lastActivityAt, patch.seenAt);
    }
  }
}

// A subagent's meta and its transcript each report a flavor; neither may erase the other's detail.
function mergeFlavor(current: Flavor, next: Flavor): Flavor {
  if (current.kind === "subagent" && next.kind === "subagent") {
    return { kind: "subagent", agentType: next.agentType ?? current.agentType };
  }
  if (current.kind === "lane" && next.kind === "lane") {
    return {
      kind: "lane",
      mode: next.mode,
      stream: next.stream,
      label: next.label ?? current.label,
      receipt: next.receipt ?? current.receipt,
    };
  }
  return next;
}
