import type { AgentId } from "./domain.ts";
import type { Tree } from "./graph.ts";
import type { Layout } from "./layout.ts";
import { SATELLITE_SPACE } from "./layout.ts";

export interface Offset { readonly x: number; readonly y: number }
export type Offsets = ReadonlyMap<AgentId, Offset>;

export function applyOffsets(base: Layout, offsets: Offsets): Layout {
  const placed = new Map(base.placed);
  let changed = false;
  for (const [id, offset] of offsets) {
    const place = placed.get(id);
    if (place !== undefined && (offset.x !== 0 || offset.y !== 0)) {
      placed.set(id, { ...place, x: place.x + offset.x, y: place.y + offset.y });
      changed = true;
    }
  }
  if (!changed) return { ...base, placed };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const place of placed.values()) {
    minX = Math.min(minX, place.x);
    minY = Math.min(minY, place.y);
    maxX = Math.max(maxX, place.x + place.width);
    maxY = Math.max(maxY, place.y + place.height + (place.satellite ? SATELLITE_SPACE : 0));
  }
  return { ...base, placed, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

export function moveNode(offsets: Offsets, id: AgentId, dx: number, dy: number): Map<AgentId, Offset> {
  const next = new Map(offsets);
  const previous = next.get(id) ?? { x: 0, y: 0 };
  const x = previous.x + dx;
  const y = previous.y + dy;
  if (x === 0 && y === 0) next.delete(id);
  else next.set(id, { x, y });
  return next;
}

export function moveSubtree(offsets: Offsets, tree: Tree, id: AgentId, dx: number, dy: number): Map<AgentId, Offset> {
  const next = new Map(offsets);
  const visit = (current: AgentId): void => {
    const previous = next.get(current) ?? { x: 0, y: 0 };
    const x = previous.x + dx;
    const y = previous.y + dy;
    if (x === 0 && y === 0) next.delete(current);
    else next.set(current, { x, y });
    for (const child of tree.children.get(current) ?? []) visit(child.id);
  };
  if (tree.depth.has(id)) visit(id);
  return next;
}

export function clearOffsets(): Map<AgentId, Offset> {
  return new Map();
}
