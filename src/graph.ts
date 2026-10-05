import type { AgentId, AgentNode, NormalizedUsage } from "./domain.ts";
import { working } from "./format.ts";

// Pure tree helpers shared by the browser and tests.

export interface Tree {
  readonly root: AgentNode;
  /** Root first, then depth-first in spawn order. */
  readonly nodes: readonly AgentNode[];
  readonly children: ReadonlyMap<AgentId, readonly AgentNode[]>;
  readonly depth: ReadonlyMap<AgentId, number>;
  readonly step: ReadonlyMap<AgentId, number>;
}

export interface Counts {
  readonly spawned: number;
  readonly skills: number;
  readonly running: number;
  readonly waiting: number;
  readonly done: number;
  readonly failed: number;
  readonly tokens: number;
}

/** Working now, or idle in a process known to be alive. A turn boundary alone proves nothing. */
export function isLive(node: AgentNode, now = Date.now()): boolean {
  return working(node, now) || (node.status.kind === "idle" && node.status.evidence === "pid");
}

function byStart(a: AgentNode, b: AgentNode): number {
  const left = a.startedAt ?? "￿";
  const right = b.startedAt ?? "￿";
  return left === right ? (a.id < b.id ? -1 : 1) : left < right ? -1 : 1;
}

function recency(node: AgentNode): string {
  return node.lastActivityAt ?? node.startedAt ?? "";
}

/** The parent a node is drawn under: null when it has none or its parent is not indexed. */
export function parentOf(node: AgentNode, nodes: ReadonlyMap<AgentId, AgentNode>): AgentId | null {
  return node.parent !== null && nodes.has(node.parent) ? node.parent : null;
}

export function withoutSkills(nodes: ReadonlyMap<AgentId, AgentNode>): Map<AgentId, AgentNode> {
  const shown = new Map<AgentId, AgentNode>();
  for (const node of nodes.values()) {
    if (node.flavor.kind === "skill") continue;
    let parent = node.parent;
    const seen = new Set<AgentId>([node.id]);
    while (parent !== null) {
      if (seen.has(parent)) { parent = null; break; }
      seen.add(parent);
      const ancestor = nodes.get(parent);
      if (ancestor === undefined) { parent = null; break; }
      if (ancestor.flavor.kind !== "skill") break;
      parent = ancestor.parent;
    }
    shown.set(node.id, parent === node.parent ? node : { ...node, parent });
  }
  return shown;
}

/** Sessions to list: live ones first, then most recently active. */
export function rootsOf(nodes: ReadonlyMap<AgentId, AgentNode>, now = Date.now()): AgentNode[] {
  return [...nodes.values()]
    .filter((node) => parentOf(node, nodes) === null)
    .sort((a, b) => {
      const live = Number(isLive(b, now)) - Number(isLive(a, now));
      if (live !== 0) return live;
      const left = recency(a);
      const right = recency(b);
      return left === right ? 0 : left < right ? 1 : -1;
    });
}

export function rootOf(id: AgentId, nodes: ReadonlyMap<AgentId, AgentNode>): AgentId {
  let current = id;
  const seen = new Set<AgentId>();
  for (;;) {
    const node = nodes.get(current);
    if (node === undefined || seen.has(current)) return current;
    seen.add(current);
    const parent = parentOf(node, nodes);
    if (parent === null) return current;
    current = parent;
  }
}

export function treeOf(rootId: AgentId, nodes: ReadonlyMap<AgentId, AgentNode>): Tree | null {
  const root = nodes.get(rootId);
  if (root === undefined) return null;
  const children = new Map<AgentId, AgentNode[]>();
  for (const node of nodes.values()) {
    const parent = parentOf(node, nodes);
    if (parent === null || node.id === rootId) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [node]);
    else siblings.push(node);
  }
  for (const siblings of children.values()) siblings.sort(byStart);
  const step = new Map<AgentId, number>();
  for (const siblings of children.values()) siblings.forEach((node, index) => step.set(node.id, index + 1));
  const ordered: AgentNode[] = [];
  const depth = new Map<AgentId, number>();
  const visit = (node: AgentNode, level: number): void => {
    if (depth.has(node.id)) return;
    depth.set(node.id, level);
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) visit(child, level + 1);
  };
  visit(root, 0);
  return { root, nodes: ordered, children, depth, step };
}

export function tokenTotal(usage: NormalizedUsage | null): number {
  if (usage === null) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function countsOf(tree: Tree, now = Date.now()): Counts {
  let running = 0;
  let waiting = 0;
  let done = 0;
  let failed = 0;
  let tokens = 0;
  let skills = 0;
  let spawned = 0;
  for (const node of tree.nodes) {
    if (node.flavor.kind !== "skill") tokens += tokenTotal(node.usage);
    if (node.flavor.kind === "skill") { skills += 1; continue; }
    if (node === tree.root) continue;
    spawned += 1;
    switch (node.status.kind) {
      case "running":
        if (working(node, now)) running += 1;
        break;
      case "idle":
        waiting += 1;
        break;
      case "done":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
      default:
        break;
    }
  }
  return { spawned, skills, running, waiting, done, failed, tokens };
}
