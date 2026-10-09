import { expect, it } from "bun:test";
import type { AgentId, AgentNode } from "./domain.ts";
import { treeOf } from "./graph.ts";
import { layout } from "./layout.ts";
import { applyOffsets, clearOffsets, moveNode, moveSubtree } from "./offsets.ts";

const id = (value: string) => value as AgentId;
function node(name: string, parent: string | null): AgentNode {
  return {
    id: id(name), parent: parent === null ? null : id(parent), via: null, spawnCall: null, pstack: true,
    harness: "claude", source: "claude-session", flavor: parent === null ? { kind: "session" } : { kind: "subagent", agentType: null },
    title: name, cwd: null, model: { provider: "claude", requested: null, reported: null, effort: null },
    status: { kind: "done", at: null }, startedAt: null, lastActivityAt: null, activity: null,
    prompt: null, result: null, pending: null, usage: null, health: "ok",
  };
}

it("keeps offsets relative to changing automatic positions and includes moved cards in bounds", () => {
  const nodes = [node("root", null), node("child", "root")];
  const tree = treeOf(id("root"), new Map(nodes.map((entry) => [entry.id, entry])))!;
  const base = layout(tree, () => false);
  const offsets = moveNode(new Map(), id("child"), -500, 80);
  const moved = applyOffsets(base, offsets);
  expect(moved.placed.get(id("child"))?.x).toBe(base.placed.get(id("child"))!.x - 500);
  expect(moved.bounds.x).toBe(-84);
  expect(moved.bounds.y).toBeLessThanOrEqual(moved.placed.get(id("child"))!.y);
  const shifted = { ...base, placed: new Map(base.placed).set(id("child"), { ...base.placed.get(id("child"))!, x: 600 }) };
  expect(applyOffsets(shifted, offsets).placed.get(id("child"))?.x).toBe(100);
  expect(applyOffsets(base, new Map([[id("gone"), { x: 999, y: 999 }]])).bounds).toEqual(base.bounds);
});

it("moves only the chosen node, or its whole subtree with Shift, and clears offsets", () => {
  const nodes = [node("root", null), node("child", "root"), node("leaf", "child"), node("sibling", "root")];
  const tree = treeOf(id("root"), new Map(nodes.map((entry) => [entry.id, entry])))!;
  const single = moveNode(new Map(), id("child"), 10, -5);
  expect([...single]).toEqual([[id("child"), { x: 10, y: -5 }]]);
  const subtree = moveSubtree(single, tree, id("child"), 2, 3);
  expect(subtree.get(id("child"))).toEqual({ x: 12, y: -2 });
  expect(subtree.get(id("leaf"))).toEqual({ x: 2, y: 3 });
  expect(subtree.has(id("sibling"))).toBe(false);
  expect(moveNode(single, id("child"), -10, 5).size).toBe(0);
  expect(clearOffsets().size).toBe(0);
  expect(single.get(id("child"))).toEqual({ x: 10, y: -5 });
});
