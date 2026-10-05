import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import type { AgentId, TimelineItem } from "./domain.ts";
import { diskFileSystem } from "./fs.ts";
import { Index, newerVersion } from "./index.ts";
import { Store } from "./store.ts";
import type { TimelinePage } from "./wire.ts";

let scratch: string;
let claudeHome: string;
let codexHome: string;

const now = Date.now();
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
const jsonl = (...records: Record<string, unknown>[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

function claudeRecord(type: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { type, sessionId: "s1", cwd: "/repo", version: "2.1.287", entrypoint: "cli", timestamp: iso(), uuid: crypto.randomUUID(), ...extra };
}

function assistant(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return claudeRecord("assistant", { message: { id: crypto.randomUUID(), model: "claude-test-model", content: [{ type: "text", text }], usage: { output_tokens: 1 } }, ...extra });
}

function setup(): { store: Store; index: Index; appended: Map<AgentId, TimelineItem[]> } {
  const store = new Store();
  const appended = new Map<AgentId, TimelineItem[]>();
  const index = new Index([claudeAdapter(claudeHome), codexAdapter(codexHome)], store, diskFileSystem, {
    sinceMs: now - 24 * 3_600_000,
    watched: () => true,
    onItems: (agent, items) => appended.set(agent, [...(appended.get(agent) ?? []), ...items]),
  });
  return { store, index, appended };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "psf-monitor-"));
  claudeHome = join(scratch, "claude");
  codexHome = join(scratch, "codex");
  mkdirSync(join(claudeHome, "projects", "-repo", "s1", "subagents"), { recursive: true });
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const day = new Date(now);
  const dayDir = join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  mkdirSync(dayDir, { recursive: true });

  writeFileSync(join(claudeHome, "projects", "-repo", "s1.jsonl"), jsonl(
    claudeRecord("user", { message: { role: "user", content: "Build the monitor" } }),
    claudeRecord("assistant", {
      message: { id: "m1", model: "claude-test-model", usage: { output_tokens: 5 }, content: [{ type: "tool_use", id: "call-1", name: "Agent", input: { description: "Explore" } }] },
    }),
  ));
  writeFileSync(join(claudeHome, "projects", "-repo", "s1", "subagents", "agent-a1.jsonl"), jsonl(
    claudeRecord("user", { isSidechain: true, agentId: "a1", message: { role: "user", content: "Explore the repo" } }),
    assistant("Reading files", { isSidechain: true, agentId: "a1" }),
  ));
  writeFileSync(join(claudeHome, "projects", "-repo", "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Explore", toolUseId: "call-1" }));
  writeFileSync(join(dayDir, "rollout-2026-10-01T10-00-00-01a0aaaa-0000-7000-8000-000000000001.jsonl"), jsonl(
    { timestamp: iso(), ordinal: 0, type: "session_meta", payload: { id: "01a0aaaa-0000-7000-8000-000000000001", cwd: "/repo", source: "cli", cli_version: "0.999.0" } },
    { timestamp: iso(), ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "u1" } },
  ));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("Index", () => {
  it("builds the agent tree from both harnesses", async () => {
    const { store, index } = setup();
    await index.refresh(true);
    store.apply({ kind: "pstack", id: "claude:s1" as AgentId });
    store.apply({ kind: "pstack", id: "codex:01a0aaaa-0000-7000-8000-000000000001" as AgentId });
    const nodes = new Map(store.nodes().map((node) => [node.id, node]));
    expect(nodes.get("claude:s1" as AgentId)).toMatchObject({ title: "Build the monitor", harness: "claude" });
    expect(nodes.get("claude:s1:a1" as AgentId)).toMatchObject({ parent: "claude:s1", title: "Explore", flavor: { kind: "subagent", agentType: "Explore" } });
    expect(nodes.get("codex:01a0aaaa-0000-7000-8000-000000000001" as AgentId)?.status).toEqual({ kind: "running", evidence: "lifecycle" });
    const health = index.health();
    expect(health.find((source) => source.source === "claude-session")).toMatchObject({ state: "ok", files: 3, unchecked: [] });
    expect(health.find((source) => source.source === "codex-rollout")?.unchecked).toEqual(["0.999.0"]);
  });

  it("tails appended lines and reports them to watchers", async () => {
    const { store, index, appended } = setup();
    await index.refresh(true);
    appended.clear();
    appendFileSync(join(claudeHome, "projects", "-repo", "s1", "subagents", "agent-a1.jsonl"), jsonl(assistant("Found the runner", { agentId: "a1" })));
    await index.refresh(false);
    expect(store.node("claude:s1:a1" as AgentId)?.activity).toMatchObject({ what: "text", snippet: "Found the runner" });
    expect(appended.get("claude:s1:a1" as AgentId)?.map((item) => item.kind)).toEqual(["text"]);
  });

  it("does not consume a line that is still being written", async () => {
    const { store, index } = setup();
    await index.refresh(true);
    const path = join(claudeHome, "projects", "-repo", "s1", "subagents", "agent-a1.jsonl");
    const line = JSON.stringify(assistant("half", { agentId: "a1" }));
    appendFileSync(path, line.slice(0, 20));
    await index.refresh(false);
    expect(store.node("claude:s1:a1" as AgentId)?.activity?.snippet).toBe("Reading files");
    appendFileSync(path, `${line.slice(20)}\n`);
    await index.refresh(false);
    expect(store.node("claude:s1:a1" as AgentId)?.activity?.snippet).toBe("half");
  });

  it("pages a timeline backwards", async () => {
    const path = join(claudeHome, "projects", "-repo", "s1", "subagents", "agent-a1.jsonl");
    appendFileSync(path, jsonl(...Array.from({ length: 30 }, (_, i) => assistant(`step ${i}`, { agentId: "a1" }))));
    const { index } = setup();
    await index.refresh(true);
    const agent = "claude:s1:a1" as AgentId;
    const texts: string[] = [];
    let before: number | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page: TimelinePage = index.timeline(agent, before, 4)!;
      texts.unshift(...page.items.flatMap((item) => (item.kind === "text" || item.kind === "prompt" ? [item.body.text] : [])));
      if (page.older === null) break;
      before = page.older;
    }
    expect(texts).toEqual(["Explore the repo", "Reading files", ...Array.from({ length: 30 }, (_, i) => `step ${i}`)]);
    expect(index.timeline("claude:nope" as AgentId, null, 4)).toBeNull();
  });

  it("leaves old transcripts out unless their session is live", async () => {
    const old = join(claudeHome, "projects", "-repo", "s0.jsonl");
    writeFileSync(old, jsonl(claudeRecord("user", { sessionId: "s0", message: { role: "user", content: "old work" } })));
    const twoDaysAgo = (now - 48 * 3_600_000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);

    const first = setup();
    await first.index.refresh(true);
    expect(first.store.has("claude:s0" as AgentId)).toBe(false);

    writeFileSync(join(claudeHome, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s0", status: "idle", entrypoint: "cli" }));
    const second = setup();
    await second.index.refresh(true);
    expect(second.store.has("claude:s0" as AgentId)).toBe(true);
  });

  it("retracts a process record when its file disappears", async () => {
    const pidFile = join(claudeHome, "sessions", "4243.json");
    writeFileSync(pidFile, JSON.stringify({ pid: 4243, sessionId: "s1", status: "busy", entrypoint: "cli" }));
    const { store, index } = setup();
    await index.refresh(true);
    store.setAlive(pidFile, true);
    expect(store.node("claude:s1" as AgentId)?.status.kind).toBe("running");
    unlinkSync(pidFile);
    await index.refresh(true);
    expect(store.node("claude:s1" as AgentId)?.status.kind).toBe("ended");
  });

  it("counts shape problems against the source and the agent", async () => {
    appendFileSync(join(claudeHome, "projects", "-repo", "s1.jsonl"), jsonl({ type: "assistant", timestamp: iso() }));
    const { store, index } = setup();
    await index.refresh(true);
    expect(index.health().find((source) => source.source === "claude-session")?.state).toBe("degraded");
    expect(store.node("claude:s1" as AgentId)?.health).toBe("degraded");
  });
});

describe("newerVersion", () => {
  it("compares dotted versions numerically", () => {
    expect(newerVersion("0.160.1", "0.160.0")).toBe(true);
    expect(newerVersion("2.1.300", "2.1.287")).toBe(true);
    expect(newerVersion("2.1.287", "2.1.287")).toBe(false);
    expect(newerVersion("2.0.999", "2.1.0")).toBe(false);
  });
});
