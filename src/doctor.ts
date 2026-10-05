import type { AgentStatus } from "./domain.ts";
import { diskFileSystem } from "./fs.ts";
import { Index } from "./index.ts";
import { alive, psTable, type ProcessTable } from "./probe.ts";
import { adapters, type Homes } from "./sources.ts";
import { Store } from "./store.ts";
import type { SourceHealth } from "./wire.ts";

// Indexes the window headlessly and reports how well
// each source parsed. Prints counts and record types only, never content.

export interface DoctorReport {
  readonly health: readonly SourceHealth[];
  readonly statuses: Readonly<Partial<Record<AgentStatus["kind"], number>>>;
  readonly agents: number;
}

export async function diagnose(
  where: Homes,
  sinceMs: number,
  table: ProcessTable = psTable,
): Promise<DoctorReport> {
  const store = new Store();
  const index = new Index(adapters(where), store, diskFileSystem, { sinceMs });
  await index.refresh(true);
  const targets = store.probeTargets();
  const live = await table(targets.map((target) => target.pid));
  for (const target of targets) store.setAlive(target.key, alive(target, live));
  const statuses: Partial<Record<AgentStatus["kind"], number>> = {};
  const nodes = store.nodes();
  for (const node of nodes) statuses[node.status.kind] = (statuses[node.status.kind] ?? 0) + 1;
  return { health: index.health(), statuses, agents: nodes.length };
}

export function renderReport(report: DoctorReport, windowHours: number): string {
  const lines: string[] = [`psf-monitor doctor · last ${windowHours}h · ${report.agents} agents`];
  const statuses = Object.entries(report.statuses).map(([kind, count]) => `${count} ${kind}`);
  if (statuses.length > 0) lines.push(`  status: ${statuses.join(", ")}`);
  for (const source of report.health) {
    lines.push("");
    if (!source.present) {
      lines.push(`${source.source}: not present on this machine`);
      continue;
    }
    lines.push(`${source.source}: ${source.state}`);
    lines.push(`  files ${source.files} · lines ${source.lines} · parsed ${source.parsed}`);
    const issues = [
      source.shape > 0 ? `${source.shape} malformed` : null,
      source.notJson > 0 ? `${source.notJson} not JSON` : null,
      source.oversized > 0 ? `${source.oversized} oversized` : null,
    ].filter((issue) => issue !== null);
    if (issues.length > 0) lines.push(`  problems: ${issues.join(", ")}`);
    const unknown = Object.entries(source.unknownTypes).sort((a, b) => b[1] - a[1]);
    if (unknown.length > 0) {
      lines.push(`  unrecognized record types: ${unknown.map(([type, count]) => `${type} ×${count}`).join(", ")}`);
    }
    if (source.cliVersions.length > 0) lines.push(`  CLI versions: ${source.cliVersions.join(", ")}`);
    if (source.unchecked.length > 0) {
      lines.push(`  newer than the adapter was checked against: ${source.unchecked.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
