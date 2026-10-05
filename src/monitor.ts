import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "./adapter.ts";
import type { AgentId, TimelineItem } from "./domain.ts";
import type { FileSystem } from "./fs.ts";
import { Index } from "./index.ts";
import { journalEnabled } from "./journal.ts";
import { alive, type ProcessTable } from "./probe.ts";
import { Store } from "./store.ts";
import type { ServerEvent, ServerInfo, Snapshot, SourceHealth, TimelinePage } from "./wire.ts";

// The live model behind the server: it keeps the index
// current, probes recorded processes, and pushes changes to subscribers.

const POLL_MS = 2_000;
const SCAN_MS = 10_000;
const FLUSH_MS = 250;
const HEARTBEAT_MS = 15_000;
const HINT_DELAY_MS = 75;
export const FIRST_PAGE = 80;

export interface Subscriber {
  readonly watch: AgentId | null;
  send(event: ServerEvent): void;
  ping(): void;
}

export interface MonitorOptions {
  readonly adapters: readonly Adapter[];
  readonly fs: FileSystem;
  readonly table: ProcessTable;
  readonly windowHours: number;
  readonly version: string;
  readonly instance: string;
  readonly lanes: string;
  readonly now?: () => number;
}

export class Monitor {
  readonly store = new Store();
  private readonly index: Index;
  private readonly subscribers = new Set<Subscriber>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly watchers: FSWatcher[] = [];
  private readonly pendingHints = new Set<string>();
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHealth = "";
  private lastJournal: boolean;
  private watching: ServerInfo["watching"] = "poll";
  private readonly startedAt: string;

  constructor(private readonly options: MonitorOptions) {
    const now = options.now ?? Date.now;
    this.startedAt = new Date(now()).toISOString();
    this.lastJournal = journalEnabled(options.lanes);
    this.index = new Index(options.adapters, this.store, options.fs, {
      sinceMs: now() - options.windowHours * 3_600_000,
      watched: (agent) => this.isWatched(agent),
      onItems: (agent, items) => this.append(agent, items),
      yieldTurn: () => new Promise((resolve) => setImmediate(resolve)),
    });
  }

  info(): ServerInfo {
    return {
      app: "psf-monitor",
      version: this.options.version,
      instance: this.options.instance,
      pid: process.pid,
      startedAt: this.startedAt,
      watching: this.watching,
      indexing: this.index.isIndexing,
      windowHours: this.options.windowHours,
      journal: journalEnabled(this.options.lanes),
    };
  }

  snapshot(): Snapshot {
    return {
      rev: this.store.rev,
      agents: this.store.nodes(),
      links: this.store.links(),
      health: this.index.health(),
      server: this.info(),
    };
  }

  health(): readonly SourceHealth[] {
    return this.index.health();
  }

  timeline(agent: AgentId, before: number | null, limit: number): TimelinePage | null {
    if (!this.store.isPstack(agent)) return null;
    const node = this.store.node(agent);
    if (node?.flavor.kind === "skill") return { agent, items: [], older: null };
    return this.index.timeline(agent, before, limit);
  }

  resultPath(agent: AgentId): string | null {
    return this.store.resultPath(agent);
  }

  /** Indexes the window, probes processes once, then keeps everything current. */
  async start(): Promise<void> {
    await this.index.refresh(true);
    await this.probe();
    this.flush();
    this.watchRoots();
    this.timers.push(
      setInterval(() => void this.cycle(false), POLL_MS),
      setInterval(() => void this.cycle(true), SCAN_MS),
      setInterval(() => this.flush(), FLUSH_MS),
      setInterval(() => this.heartbeat(), HEARTBEAT_MS),
    );
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber.send({ event: "snapshot", data: this.snapshot() });
    if (subscriber.watch !== null) {
      const page = this.timeline(subscriber.watch, null, FIRST_PAGE);
      if (page !== null) subscriber.send({ event: "timeline", data: page });
    }
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private async cycle(full: boolean): Promise<void> {
    await this.index.refresh(full);
    await this.probe();
  }

  private async probe(): Promise<void> {
    const targets = this.store.probeTargets();
    if (targets.length === 0) return;
    const table = await this.options.table([...new Set(targets.map((target) => target.pid))]);
    for (const target of targets) this.store.setAlive(target.key, alive(target, table));
  }

  private flush(): void {
    const changes = this.store.flush();
    const health = this.index.health();
    const serializedHealth = JSON.stringify(health);
    const healthChanged = serializedHealth !== this.lastHealth;
    this.lastHealth = serializedHealth;
    const journal = journalEnabled(this.options.lanes);
    const journalChanged = journal !== this.lastJournal;
    this.lastJournal = journal;
    if (changes === null && !healthChanged && !journalChanged) return;
    this.broadcast({
      event: "delta",
      data: {
        rev: changes?.rev ?? this.store.rev,
        upserts: changes?.upserts ?? [],
        links: changes?.links ?? null,
        health: healthChanged ? health : null,
        indexing: this.index.isIndexing,
        journal,
      },
    });
  }

  private append(agent: AgentId, items: readonly TimelineItem[]): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.watch === agent && this.store.isPstack(agent)) this.deliver(subscriber, { event: "append", data: { agent, items } });
    }
  }

  private broadcast(event: ServerEvent): void {
    for (const subscriber of this.subscribers) this.deliver(subscriber, event);
  }

  private heartbeat(): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.ping();
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private deliver(subscriber: Subscriber, event: ServerEvent): void {
    try {
      subscriber.send(event);
    } catch {
      this.subscribers.delete(subscriber);
    }
  }

  private isWatched(agent: AgentId): boolean {
    for (const subscriber of this.subscribers) if (subscriber.watch === agent && this.store.isPstack(agent)) return true;
    return false;
  }

  // File events only make polling sooner; when they are unavailable polling still covers everything.
  private watchRoots(): void {
    for (const adapter of this.options.adapters) {
      for (const root of adapter.roots) {
        if (this.options.fs.stat(root.dir)?.directory !== true) continue;
        try {
          this.watchers.push(watch(root.dir, { recursive: true }, (_event, name) => {
            if (typeof name === "string") this.hint(join(root.dir, name));
          }));
          this.watching = "events";
        } catch {
          // Recursive watching is unsupported here; the poll loop covers it.
        }
      }
    }
  }

  private hint(path: string): void {
    this.pendingHints.add(path);
    if (this.hintTimer !== null) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      const paths = [...this.pendingHints];
      this.pendingHints.clear();
      void (async () => {
        const tracked = new Set(this.index.paths);
        const unknown = paths.some((path) => !tracked.has(path));
        for (const path of paths) if (tracked.has(path)) await this.index.touch(path);
        // A new file appeared: find it now rather than at the next scan.
        if (unknown) await this.index.refresh(true);
        this.flush();
      })();
    }, HINT_DELAY_MS);
  }
}
