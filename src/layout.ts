import type { AgentId, AgentNode } from "./domain.ts";
import type { Tree } from "./graph.ts";

// Left-to-right tree layout. Columns are spawn depth;
// leaves take consecutive rows and parents center on their children, so a
// new child appends below its siblings instead of reshuffling the canvas.

export const CARD_WIDTH = 264;
export const CARD_HEIGHT = 84;
export const SKILL_HEIGHT = 64;
export const ROOT_WIDTH = 304;
export const ROOT_HEIGHT = 100;
export const COLUMN_GAP = 112;
export const ROW_GAP = 24;
/** Room under a card for its model node and label. */
export const SATELLITE_SPACE = 76;

export interface Placed {
  readonly id: AgentId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly satellite: boolean;
}

export interface Edge {
  readonly from: AgentId;
  readonly to: AgentId;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Layout {
  readonly placed: ReadonlyMap<AgentId, Placed>;
  readonly edges: readonly Edge[];
  readonly bounds: Bounds;
}

/** The root column is wider than the rest. */
export function columnX(depth: number): number {
  return depth === 0 ? 0 : ROOT_WIDTH + COLUMN_GAP + (depth - 1) * (CARD_WIDTH + COLUMN_GAP);
}

export function layout(tree: Tree, hasSatellite: (node: AgentNode) => boolean): Layout {
  const placed = new Map<AgentId, Placed>();
  const edges: Edge[] = [];
  let cursor = 0;

  // Returns the vertical center of the node's card.
  const place = (node: AgentNode, depth: number): number => {
    const height = node === tree.root ? ROOT_HEIGHT : node.flavor.kind === "skill" ? SKILL_HEIGHT : CARD_HEIGHT;
    const satellite = hasSatellite(node);
    const slot = height + (satellite ? SATELLITE_SPACE : 0);
    const children = (tree.children.get(node.id) ?? []).filter((child) => tree.depth.get(child.id) === depth + 1);
    let center: number;
    if (children.length === 0) {
      center = cursor + height / 2;
      cursor += slot + ROW_GAP;
    } else {
      const start = cursor;
      const centers = children.map((child) => {
        edges.push({ from: node.id, to: child.id });
        return place(child, depth + 1);
      });
      center = (centers[0]! + centers[centers.length - 1]!) / 2;
      // A parent's own card and model node must not reach past its subtree.
      const top = center - height / 2;
      if (top < start) center += start - top;
      cursor = Math.max(cursor, center - height / 2 + slot + ROW_GAP);
    }
    placed.set(node.id, {
      id: node.id,
      x: columnX(depth),
      y: Math.round(center - height / 2),
      width: node === tree.root ? ROOT_WIDTH : CARD_WIDTH,
      height,
      satellite,
    });
    return center;
  };

  place(tree.root, 0);
  let maxX = 0;
  let maxY = 0;
  for (const node of placed.values()) {
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height + (node.satellite ? SATELLITE_SPACE : 0));
  }
  return { placed, edges, bounds: { x: 0, y: 0, width: maxX, height: maxY } };
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Arc {
  readonly d: string;
  readonly midX: number;
  readonly midY: number;
}

/** Where a ray from the box's center toward a point leaves the box. */
function exitPoint(box: Box, towardX: number, towardY: number): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const t = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy),
  );
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * A message from one agent to another: a curve between their edges that bows
 * to the left of travel, so a reply between the same pair takes the other side.
 */
export function messageArc(from: Box, to: Box): Arc {
  const ax = from.x + from.width / 2;
  const ay = from.y + from.height / 2;
  const bx = to.x + to.width / 2;
  const by = to.y + to.height / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(160, Math.max(56, length * 0.28));
  const controlX = (ax + bx) / 2 + (dy / length) * bend;
  const controlY = (ay + by) / 2 - (dx / length) * bend;
  const start = exitPoint(from, controlX, controlY);
  const end = exitPoint(to, controlX, controlY);
  return {
    d: `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`,
    midX: 0.25 * start.x + 0.5 * controlX + 0.25 * end.x,
    midY: 0.25 * start.y + 0.5 * controlY + 0.25 * end.y,
  };
}

/** A cubic connector from a parent's output port to a child's input port. */
export function connector(from: Box, to: Box): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const bend = Math.max(48, (x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
