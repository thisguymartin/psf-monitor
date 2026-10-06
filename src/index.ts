import { join } from "node:path";
import type { Adapter, Claim, LineParser, Parsed } from "./adapter.ts";
import type { AgentId, SourceKind, TimelineItem } from "./domain.ts";
import type { FileStat, FileSystem } from "./fs.ts";
import type { Store } from "./store.ts";
import { MAX_LINE_BYTES, readBackward, readForward } from "./tail.ts";
import type { SourceHealth, TimelinePage } from "./wire.ts";

// Finds transcript files, tails them, and feeds what
// the adapters parse into the store. Polling is the source of truth; file
// events only make it sooner.

const DOCUMENT_LIMIT = 1024 * 1024;
const SLICE_BYTES = 2 * MAX_LINE_BYTES;

type StreamClaim = Extract<Claim, { kind: "stream" }>;
type DocumentClaim = Extract<Claim, { kind: "document" }>;

interface TrackedStream {
  readonly kind: "stream";
  readonly path: string;
  readonly adapter: Adapter;
  readonly claim: StreamClaim;
  ino: number;
  offset: number;
  midLine: boolean;
  parser: LineParser;
}

interface TrackedDocument {
  readonly kind: "document";
  readonly path: string;
  readonly adapter: Adapter;
  readonly claim: DocumentClaim;
  stamp: string;
}

type Tracked = TrackedStream | TrackedDocument;

interface Candidate {
  readonly path: string;
  readonly adapter: Adapter;
  readonly claim: Claim;
  readonly stat: FileStat;
}

interface Counters {
  present: boolean;
  files: number;
  lines: number;
  parsed: number;
  notJson: number;
  shape: number;
  oversized: number;
  readonly unknownTypes: Map<string, number>;
  readonly cliVersions: Set<string>;
}

export interface IndexOptions {
  readonly sinceMs: number;
  /** Receives timeline items parsed while tailing, for agents someone is watching. */
  readonly onItems?: (agent: AgentId, items: readonly TimelineItem[]) => void;
  readonly watched?: (agent: AgentId) => boolean;
  /** Lets other work run between slices of a large initial index. */
  readonly yieldTurn?: () => Promise<void>;
}

function stampOf(stat: FileStat): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

/** Numeric comparison of dotted versions; missing parts count as zero. */
export function newerVersion(candidate: string, baseline: string): boolean {
  const a = candidate.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const b = baseline.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = Number.isFinite(a[i]) ? a[i]! : 0;
    const right = Number.isFinite(b[i]) ? b[i]! : 0;
    if (left !== right) return left > right;
  }
  return false;
}

export class Index {
  private readonly tracked = new Map<string, Tracked>();
  private readonly streams = new Map<AgentId, TrackedStream>();
  private readonly counters = new Map<SourceKind, Counters>();
  private readonly snapshots = new Map<AgentId, string>();
  private busy = false;
  private indexing = true;

  constructor(
    private readonly adapters: readonly Adapter[],
    private readonly store: Store,
    private readonly fs: FileSystem,
    private readonly options: IndexOptions,
  ) {
    for (const adapter of adapters) {
      this.counters.set(adapter.source, {
        present: false,
        files: 0,
        lines: 0,
        parsed: 0,
        notJson: 0,
        shape: 0,
        oversized: 0,
        unknownTypes: new Map(),
        cliVersions: new Set(),
      });
    }
  }

  get isIndexing(): boolean {
    return this.indexing;
  }

  /** Discover new files, retire vanished ones, and tail everything that grew. */
  async refresh(full: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (full) await this.scan();
      else await this.poll();
      this.readSnapshots();
    } finally {
      this.busy = false;
      this.indexing = false;
    }
  }

  /** A file event hint: tail the file now if it is tracked. */
  async touch(path: string): Promise<void> {
    const tracked = this.tracked.get(path);
    if (tracked === undefined || this.busy) return;
    this.busy = true;
    try {
      await this.update(tracked);
    } finally {
      this.busy = false;
    }
  }

  timeline(agent: AgentId, before: number | null, limit: number): TimelinePage | null {
    for (const adapter of this.adapters) {
      const page = adapter.timeline?.(agent, before, limit);
      if (page != null) return page;
    }
    const stream = this.streams.get(agent);
    if (stream === undefined) return null;
    const end = before === null ? stream.offset : Math.min(before, stream.offset);
    const parser = stream.adapter.open(stream.path);
    if (stream.claim.header && end > 0) this.primeHeader(stream, parser);
    const window = readBackward(this.fs, stream.path, end, limit);
    const items: TimelineItem[] = [];
    let older: number | null = null;
    // Keep whole lines, newest first, until the page holds `limit` items.
    const parsedLines = window.lines.map((line) => ({ line, items: parser.line(line.text, line.offset).items }));
    let taken = 0;
    let first = parsedLines.length;
    for (let i = parsedLines.length - 1; i >= 0 && taken < limit; i--) {
      taken += parsedLines[i]!.items.length;
      first = i;
    }
    for (let i = first; i < parsedLines.length; i++) items.push(...parsedLines[i]!.items);
    const start = parsedLines[first]?.line.offset ?? window.start;
    if (start > 0) older = start;
    return { agent, items, older };
  }

  health(): SourceHealth[] {
    return this.adapters.map((adapter) => {
      const counters = this.counters.get(adapter.source)!;
      const versions = [...counters.cliVersions].sort();
      return {
        source: adapter.source,
        state: counters.shape > 0 ? "degraded" : "ok",
        present: counters.present,
        files: counters.files,
        lines: counters.lines,
        parsed: counters.parsed,
        notJson: counters.notJson,
        shape: counters.shape,
        oversized: counters.oversized,
        unknownTypes: Object.fromEntries(counters.unknownTypes),
        cliVersions: versions,
        unchecked: adapter.checkedVersion === null
          ? []
          : versions.filter((version) => newerVersion(version, adapter.checkedVersion!)),
      };
    });
  }

  /** Every tracked file; used to route file events. */
  get paths(): readonly string[] {
    return [...this.tracked.keys()];
  }

  private readSnapshots(): void {
    for (const adapter of this.adapters) {
      if (adapter.snapshot === undefined) continue;
      const counters = this.counters.get(adapter.source)!;
      try {
        const snapshot = adapter.snapshot(this.options.sinceMs);
        counters.present = snapshot.present;
        counters.files = snapshot.documents.length;
        counters.lines = counters.parsed = counters.shape = counters.notJson = counters.oversized = 0;
        counters.unknownTypes.clear();
        counters.cliVersions.clear();
        for (const document of snapshot.documents) {
          const changed = this.snapshots.get(document.agent) !== document.stamp;
          for (const record of document.records) this.record(adapter.source, document.agent, record, changed);
          if (changed) {
            this.snapshots.set(document.agent, document.stamp);
            if (this.options.watched?.(document.agent)) {
              const page = adapter.timeline?.(document.agent, null, 400);
              if (page !== undefined && page !== null) this.options.onItems?.(document.agent, page.items);
            }
          }
        }
      } catch {
        // An incompatible or temporarily locked database must not stop other sources.
        counters.present = true;
        counters.shape = 1;
        counters.unknownTypes.set("database-read", 1);
      }
    }
  }

  private async scan(): Promise<void> {
    const found = new Map<string, Candidate>();
    for (const adapter of this.adapters) {
      const counters = this.counters.get(adapter.source)!;
      counters.present = false;
      for (const root of adapter.roots) {
        const stat = this.fs.stat(root.dir);
        if (stat === null || !stat.directory) continue;
        counters.present = true;
        if (root.processRecords !== undefined) this.store.noteProcessRecords(root.processRecords);
        this.walk(root.dir, root.depth, root.enter, adapter, found);
      }
    }

    // Process records decide which old transcripts stay indexed, and streams decide which sidecars do.
    const order = (candidate: Candidate): number =>
      candidate.claim.kind === "document" && candidate.claim.always ? 0 : candidate.claim.kind === "stream" ? 1 : 2;
    const candidates = [...found.values()].sort((a, b) => order(a) - order(b));
    for (const candidate of candidates) {
      const existing = this.tracked.get(candidate.path);
      if (existing !== undefined) {
        await this.update(existing, candidate.stat);
      } else if (this.include(candidate)) {
        await this.track(candidate);
      }
    }

    for (const [path, tracked] of this.tracked) {
      if (found.has(path)) continue;
      this.tracked.delete(path);
      this.counters.get(tracked.adapter.source)!.files -= 1;
      if (tracked.kind === "stream") {
        if (this.streams.get(tracked.claim.agent) === tracked) this.streams.delete(tracked.claim.agent);
      } else {
        for (const fact of tracked.adapter.removed(path)) this.store.apply(fact);
      }
    }
  }

  private async poll(): Promise<void> {
    for (const tracked of [...this.tracked.values()]) await this.update(tracked);
  }

  private walk(
    dir: string,
    depth: number,
    enter: ((dir: string, sinceMs: number) => boolean) | undefined,
    adapter: Adapter,
    found: Map<string, Candidate>,
  ): void {
    if (enter !== undefined && !enter(dir, this.options.sinceMs)) return;
    const entries = this.fs.list(dir);
    if (entries === null) return;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.directory) {
        if (depth > 1) this.walk(path, depth - 1, enter, adapter, found);
        continue;
      }
      const claim = adapter.claim(path);
      if (claim === null) continue;
      const stat = this.fs.stat(path);
      if (stat === null || stat.directory) continue;
      found.set(path, { path, adapter, claim, stat });
    }
  }

  private include(candidate: Candidate): boolean {
    const { adapter, claim, stat } = candidate;
    if (!adapter.windowed || stat.mtimeMs >= this.options.sinceMs) return true;
    if (claim.kind === "document") return claim.always || (claim.agent !== null && this.store.has(claim.agent));
    return this.store.isLive(claim.root);
  }

  private async track(candidate: Candidate): Promise<void> {
    const { path, adapter, claim, stat } = candidate;
    this.counters.get(adapter.source)!.files += 1;
    if (claim.kind === "document") {
      const tracked: TrackedDocument = { kind: "document", path, adapter, claim, stamp: "" };
      this.tracked.set(path, tracked);
      this.load(tracked, stat);
      return;
    }
    const tracked: TrackedStream = {
      kind: "stream",
      path,
      adapter,
      claim,
      ino: stat.ino,
      offset: 0,
      midLine: false,
      parser: adapter.open(path),
    };
    this.tracked.set(path, tracked);
    this.streams.set(claim.agent, tracked);
    await this.tail(tracked, stat.size);
  }

  private async update(tracked: Tracked, known?: FileStat): Promise<void> {
    const stat = known ?? this.fs.stat(tracked.path);
    if (stat === null) return;
    if (tracked.kind === "document") {
      if (stampOf(stat) !== tracked.stamp) this.load(tracked, stat);
      return;
    }
    if (stat.ino !== tracked.ino || stat.size < tracked.offset) {
      // Replaced or truncated: start over with a fresh parser.
      tracked.ino = stat.ino;
      tracked.offset = 0;
      tracked.midLine = false;
      tracked.parser = tracked.adapter.open(tracked.path);
    }
    if (stat.size > tracked.offset) await this.tail(tracked, stat.size);
  }

  private load(tracked: TrackedDocument, stat: FileStat): void {
    tracked.stamp = stampOf(stat);
    const body = this.fs.readText(tracked.path, DOCUMENT_LIMIT);
    if (body === null) return;
    this.record(tracked.adapter.source, tracked.claim.agent, tracked.adapter.document(tracked.path, body));
  }

  private async tail(tracked: TrackedStream, size: number): Promise<void> {
    const watching = this.options.watched?.(tracked.claim.agent) === true;
    const appended: TimelineItem[] = [];
    while (tracked.offset < size) {
      const to = Math.min(size, tracked.offset + SLICE_BYTES);
      const result = readForward(this.fs, tracked.path, tracked.offset, to, { discardFirst: tracked.midLine });
      const counters = this.counters.get(tracked.adapter.source)!;
      counters.oversized += result.oversized;
      for (const line of result.lines) {
        const parsedLine = tracked.parser.line(line.text, line.offset);
        this.record(tracked.adapter.source, tracked.claim.agent, parsedLine);
        if (watching) appended.push(...parsedLine.items);
      }
      if (result.next === tracked.offset && !result.midLine) break;
      tracked.offset = result.next;
      tracked.midLine = result.midLine;
      if (to < size && this.options.yieldTurn !== undefined) await this.options.yieldTurn();
    }
    if (appended.length > 0) this.options.onItems?.(tracked.claim.agent, appended);
  }

  private primeHeader(stream: TrackedStream, parser: LineParser): void {
    const head = readForward(this.fs, stream.path, 0, Math.min(stream.offset, MAX_LINE_BYTES + 1));
    const first = head.lines[0];
    if (first !== undefined && first.offset === 0) parser.line(first.text, 0);
  }

  private record(source: SourceKind, agent: AgentId | null, parsedLine: Parsed, apply = true): void {
    const counters = this.counters.get(source)!;
    counters.lines += 1;
    if (parsedLine.cliVersion !== null) counters.cliVersions.add(parsedLine.cliVersion);
    const issue = parsedLine.problem;
    if (issue === null) counters.parsed += 1;
    else if (issue.kind === "not-json") counters.notJson += 1;
    else if (issue.kind === "unknown-type") {
      counters.unknownTypes.set(issue.recordType, (counters.unknownTypes.get(issue.recordType) ?? 0) + 1);
    } else {
      counters.shape += 1;
      if (apply && agent !== null) this.store.noteShapeError(agent);
    }
    if (apply) for (const fact of parsedLine.facts) this.store.apply(fact);
  }
}
