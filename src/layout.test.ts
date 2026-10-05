import { describe, expect, it } from "bun:test";
import type { AgentId, AgentNode, AgentStatus } from "./domain.ts";
import { countsOf, rootOf, rootsOf, treeOf } from "./graph.ts";
import { CARD_HEIGHT, COLUMN_GAP, connector, layout, messageArc, ROOT_HEIGHT, ROOT_WIDTH, SATELLITE_SPACE } from "./layout.ts";

function node(id: string, parent: string | null, status: AgentStatus["kind"] = "done", startedAt = "2026-10-01T10:00:00Z"): AgentNode {
  const statuses: Record<AgentStatus["kind"], AgentStatus> = {
    running: { kind: "running", evidence: "pid" },
    idle: { kind: "idle", evidence: "pid", detail: null },
    done: { kind: "done", at: null },
    failed: { kind: "failed", at: null, reason: "x" },
    cancelled: { kind: "cancelled", at: null },
    ended: { kind: "ended", at: null },
    unknown: { kind: "unknown", why: "x" },
  };
  return {
    id: id as AgentId,
    parent: parent as AgentId | null,
    via: null,
    spawnCall: null,
    harness: "claude",
    source: "claude-session",
    flavor: parent === null ? { kind: "session" } : { kind: "subagent", agentType: null },
    title: id,
    cwd: null,
    model: { provider: "claude", requested: null, reported: null, effort: null },
    status: statuses[status],
    startedAt,
    lastActivityAt: startedAt,
    activity: null,
    pstack: false,
    prompt: null,
    pending: null,
    usage: { inputTokens: 10, outputTokens: 5 },
    health: "ok",
  };
}

function index(...nodes: AgentNode[]): Map<AgentId, AgentNode> {
  return new Map(nodes.map((entry) => [entry.id, entry]));
}

describe("graph", () => {
  const nodes = index(
    node("root", null, "running"),
    node("b", "root", "failed", "2026-10-01T10:00:02Z"),
    node("a", "root", "running", "2026-10-01T10:00:01Z"),
    node("a1", "a", "done"),
    node("orphan", "missing-parent", "done", "2026-10-01T09:00:00Z"),
  );

  it("treats nodes whose parent is not indexed as roots, live first", () => {
    expect(rootsOf(nodes).map((entry) => entry.id)).toEqual(["root", "orphan"] as never);
    expect(rootOf("a1" as AgentId, nodes)).toBe("root" as AgentId);
  });

  it("orders children by start time and counts the tree", () => {
    const tree = treeOf("root" as AgentId, nodes)!;
    expect(tree.nodes.map((entry) => entry.id)).toEqual(["root", "a", "a1", "b"] as never);
    expect(countsOf(tree)).toEqual({ spawned: 3, running: 1, waiting: 0, done: 1, failed: 1, tokens: 60 });
  });

  it("survives a parent cycle", () => {
    const cyclic = index(node("x", "y"), node("y", "x"));
    expect(rootOf("x" as AgentId, cyclic)).toBeDefined();
    expect(rootsOf(cyclic)).toEqual([]);
  });
});

describe("layout", () => {
  it("places depth in columns and centers parents on their children", () => {
    const tree = treeOf("root" as AgentId, index(node("root", null), node("a", "root"), node("b", "root")))!;
    const result = layout(tree, () => false);
    const root = result.placed.get("root" as AgentId)!;
    const a = result.placed.get("a" as AgentId)!;
    const b = result.placed.get("b" as AgentId)!;
    expect(a.x).toBe(ROOT_WIDTH + COLUMN_GAP);
    expect(root.width).toBe(ROOT_WIDTH);
    expect(b.y).toBeGreaterThan(a.y + CARD_HEIGHT);
    expect(root.y + ROOT_HEIGHT / 2).toBeCloseTo((a.y + b.y + CARD_HEIGHT) / 2, 0);
    expect(result.edges).toEqual([{ from: "root", to: "a" }, { from: "root", to: "b" }] as never);
  });

  it("reserves room for model nodes so cards never overlap", () => {
    const tree = treeOf("root" as AgentId, index(node("root", null), node("a", "root"), node("b", "root"), node("c", "root")))!;
    const result = layout(tree, () => true);
    const ys = ["a", "b", "c"].map((id) => result.placed.get(id as AgentId)!.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(CARD_HEIGHT + SATELLITE_SPACE);
    const root = result.placed.get("root" as AgentId)!;
    expect(root.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps a lone root inside its bounds", () => {
    const tree = treeOf("root" as AgentId, index(node("root", null)))!;
    expect(layout(tree, () => true).bounds).toEqual({ x: 0, y: 0, width: ROOT_WIDTH, height: ROOT_HEIGHT + SATELLITE_SPACE });
  });

  it("draws a message between card edges, bowing opposite ways for each direction", () => {
    const parent = { x: 0, y: 0, width: 100, height: 40 };
    const child = { x: 300, y: 0, width: 100, height: 40 };
    const down = messageArc(parent, child);
    const up = messageArc(child, parent);
    const start = down.d.split(" ").slice(1, 3).map(Number);
    // The arc leaves from the parent's edge, not its center.
    expect(start[0]! >= 0 && start[0]! <= 100 && (start[1] === 0 || start[0] === 100)).toBe(true);
    expect(down.midY).toBeLessThan(20);
    expect(up.midY).toBeGreaterThan(20);
  });

  it("draws connectors from output port to input port", () => {
    const path = connector({ x: 0, y: 0, width: 100, height: 40 }, { x: 200, y: 100, width: 100, height: 40 });
    expect(path.startsWith("M 100 20 C")).toBe(true);
    expect(path.endsWith("200 120")).toBe(true);
  });
});
