import type { AgentId, AgentNode } from "./domain.ts";
import { activityLine, modelOf, stalled, working } from "./format.ts";
import { treeOf, type Tree } from "./graph.ts";

export type StatusFilter = "all" | "running" | "waiting" | "done" | "failed" | "stalled" | "cancelled" | "ended" | "unknown";
export interface AgentFilter {
  readonly query: string;
  readonly status: StatusFilter;
  readonly kind: "all" | AgentNode["flavor"]["kind"];
}

export function matchesAgent(node: AgentNode, filter: AgentFilter, now: number): boolean {
  const status = filter.status;
  if (status === "running" ? !working(node, now)
    : status === "stalled" ? !stalled(node, now)
    : status === "waiting" ? node.status.kind !== "idle"
    : status !== "all" && node.status.kind !== status) return false;
  if (filter.kind !== "all" && node.flavor.kind !== filter.kind) return false;
  const words = filter.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const text = [node.title, node.id, modelOf(node), node.model.provider, activityLine(node), node.flavor.kind === "skill" ? node.flavor.skill : ""].join(" ").toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

/** Keep ancestors for orientation, but distinguish them from actual matches. */
export function filterTree(tree: Tree, filter: AgentFilter, now: number): { tree: Tree; matches: ReadonlySet<AgentId> } {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const matches = new Set(tree.nodes.filter((node) => matchesAgent(node, filter, now)).map((node) => node.id));
  const included = new Set<AgentId>([tree.root.id]);
  for (const id of matches) {
    let current: AgentId | null = id;
    while (current !== null && !included.has(current)) {
      included.add(current);
      current = nodes.get(current)?.parent ?? null;
    }
  }
  return { tree: treeOf(tree.root.id, new Map(tree.nodes.filter((node) => included.has(node.id)).map((node) => [node.id, node])))!, matches };
}
