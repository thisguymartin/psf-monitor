import type { AgentId, AgentNode, Scope } from "./domain.ts";
import { stalled, working } from "./format.ts";
import { rootOf } from "./graph.ts";
import type { PstackSetup, ProviderSetup } from "./wire.ts";

export interface ObservedModel {
  readonly provider: string;
  readonly model: string | null;
  entries: number;
  running: number;
  tokens: number | null;
  reporting: number;
  partial: boolean;
}

export interface RelevantBlocker {
  readonly provider: ProviderSetup;
  readonly activity: boolean;
  readonly assignments: boolean;
}

export function summarizeOverview(nodes: ReadonlyMap<AgentId, AgentNode>, scope: Scope, now: number, setup: PstackSetup | null) {
  const scoped = new Map([...nodes].filter(([, node]) => scope === "all" || node.pstack === (scope === "pstack")));
  const entries = [...scoped.values()].filter((node) => node.flavor.kind !== "skill");
  const running = entries.filter((node) => working(node, now));
  const attention = entries.filter((node) => node.status.kind === "failed" || stalled(node, now))
    .sort((a, b) => Number(b.status.kind === "failed") - Number(a.status.kind === "failed") || (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  const current = entries.filter((node) => working(node, now) || stalled(node, now) || (node.status.kind === "idle" && node.status.evidence === "pid"));
  const runningSessions = new Set(running.map((node) => rootOf(node.id, scoped))).size;
  const models = new Map<string, ObservedModel>();
  for (const node of entries) {
    const model = node.model.reported ?? node.model.requested;
    const key = JSON.stringify([node.model.provider, model]);
    const row = models.get(key) ?? { provider: node.model.provider, model, entries: 0, running: 0, tokens: null, reporting: 0, partial: false };
    row.entries += 1;
    if (working(node, now)) row.running += 1;
    const input = node.usage?.inputTokens;
    const output = node.usage?.outputTokens;
    const total = node.usage?.totalTokens;
    if (total != null || input != null || output != null) {
      row.tokens = (row.tokens ?? 0) + (total ?? (input ?? 0) + (output ?? 0));
      row.reporting += 1;
      if (total == null && (input == null || output == null)) row.partial = true;
    }
    models.set(key, row);
  }

  const activityProviders = new Set(current.map((node) => node.model.provider));
  const assignedProviders = new Set<string>();
  if (setup !== null) {
    for (const node of current) {
      const root = scoped.get(rootOf(node.id, scoped));
      const cwd = node.cwd ?? root?.cwd;
      const project = cwd == null ? undefined : setup.projects
        .filter((entry) => cwd === entry.root || cwd.startsWith(`${entry.root.replace(/\/$/, "")}/`))
        .sort((a, b) => b.root.length - a.root.length)[0];
      const sheet = project?.sheets.find((entry) => entry.harness === node.harness && entry.present)
        ?? setup.sheets.find((entry) => entry.harness === node.harness && entry.present);
      for (const role of sheet?.roles ?? setup.defaults) {
        for (const lane of role.lanes) {
          const separator = lane.indexOf(":");
          if (separator > 0) assignedProviders.add(lane.slice(0, separator));
        }
      }
    }
  }
  const blockers: RelevantBlocker[] = (setup?.providers ?? [])
    .filter((provider) => provider.blocked !== null && (activityProviders.has(provider.provider) || assignedProviders.has(provider.provider)))
    .map((provider) => ({ provider, activity: activityProviders.has(provider.provider), assignments: assignedProviders.has(provider.provider) }));
  return {
    nodes: scoped,
    entries: entries.length,
    running,
    runningSessions,
    attention,
    blockers,
    models: [...models.values()].sort((a, b) => b.running - a.running || (b.tokens ?? -1) - (a.tokens ?? -1) || a.provider.localeCompare(b.provider)),
  };
}
