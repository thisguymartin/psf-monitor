import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "./domain.ts";
import { Store } from "./store.ts";
import { MessageInbox, messageTarget } from "./messages.ts";
import { deliverHook } from "./message-hook.ts";

const directories: string[] = [];
function inbox(): MessageInbox {
  const directory = mkdtempSync(join(tmpdir(), "psf-messages-"));
  directories.push(directory);
  return new MessageInbox(directory);
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("prompt delivery", () => {
  it("delivers steering at a tool boundary and follow-ups at Stop exactly once", () => {
    const box = inbox();
    box.enqueue("codex:thread", "codex:thread", "steer", "Use the smaller layout.");
    box.enqueue("codex:thread", "codex:thread", "follow-up", "Then check keyboard navigation.");
    const input = { session_id: "thread", hook_event_name: "PreToolUse" };
    const first = deliverHook(box, "codex", input) as { hookSpecificOutput: { additionalContext: string } };
    expect(first.hookSpecificOutput.additionalContext).toContain("Use the smaller layout.");
    expect(first.hookSpecificOutput.additionalContext).not.toContain("Then check");
    expect(deliverHook(box, "codex", input)).toEqual({});
    expect(deliverHook(box, "codex", { ...input, hook_event_name: "Stop" })).toEqual({ decision: "block", reason: expect.stringContaining("Then check keyboard navigation.") });
    expect(deliverHook(box, "codex", { ...input, hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
    expect(box.list("codex:thread").every((message) => message.deliveredAt !== null)).toBe(true);
    expect(box.connected("codex:thread")).toBe(true);
    box.close();
  });
  it("isolates sessions, harnesses, and Claude subagents", () => {
    const box = inbox();
    box.enqueue("claude:root:child", "claude:root:child", "steer", "Review the child task.");
    expect(deliverHook(box, "claude", { session_id: "root", hook_event_name: "PreToolUse" })).toEqual({});
    expect(deliverHook(box, "codex", { session_id: "root", agent_id: "child", hook_event_name: "PreToolUse" })).toEqual({});
    expect(deliverHook(box, "claude", { session_id: "root", agent_id: "child", hook_event_name: "SubagentStop" })).toEqual({ decision: "block", reason: expect.stringContaining("Review the child task.") });
    box.enqueue("codex:child", "codex:child", "follow-up", "Finish the child.");
    expect(deliverHook(box, "codex", { session_id: "root", agent_id: "child", hook_event_name: "SubagentStop" })).toEqual({ decision: "block", reason: expect.stringContaining("Finish the child.") });
    box.close();
  });
  it("persists messages privately, bounds queues, and permits removing only queued messages", () => {
    const box = inbox();
    expect(statSync(join(directories.at(-1)!, "messages.sqlite")).mode & 0o777).toBe(0o600);
    box.enqueue("codex:a", "codex:a", "steer", "remove me");
    const id = box.list("codex:a")[0]!.id;
    expect(box.cancel("codex:b", id)).toBe(false);
    expect(box.cancel("codex:a", id)).toBe(true);
    for (let i = 0; i < 20; i++) box.enqueue("codex:a", "codex:a", "steer", `message ${i}`);
    expect(() => box.enqueue("codex:a", "codex:a", "steer", "overflow")).toThrow("20 queued");
    box.close();
    const reopened = new MessageInbox(directories.at(-1)!);
    expect(reopened.list("codex:a")).toHaveLength(20);
    reopened.receive("codex:a", false);
    expect(reopened.cancel("codex:a", reopened.list("codex:a")[0]!.id)).toBe(false);
    reopened.close();
  });
  it("does not consume messages for invalid or unrelated hook events", () => {
    const box = inbox();
    box.enqueue("codex:a", "codex:a", "steer", "Keep this queued.");
    for (const input of [null, {}, { session_id: "a", hook_event_name: "Interrupt" }, { session_id: "../a", hook_event_name: "Stop" }]) expect(deliverHook(box, "codex", input)).toEqual({});
    expect(box.list("codex:a")[0]!.deliveredAt).toBeNull();
    box.close();
  });
  it("bundled command reads stdin and emits harness-compatible JSON", async () => {
    const box = inbox();
    box.enqueue("codex:thread", "codex:thread", "follow-up", "Continue with this request.");
    box.close();
    const result = Bun.spawn([process.execPath, "bin/psf-message-hook", "codex"], { env: { ...process.env, PSF_MONITOR_DIR: directories.at(-1)! }, stdin: new Response(JSON.stringify({ session_id: "thread", hook_event_name: "Stop" })), stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(await new Response(result.stdout).text())).toEqual({ decision: "block", reason: expect.stringContaining("Continue with this request.") });
    expect(await result.exited).toBe(0);
  });
});


it("routes a lane or skill to its native owner and leaves hidden agents inaccessible", () => {
  const store = new Store();
  const root = "codex:root" as AgentId;
  const skill = "skill:root" as AgentId;
  const lane = "lane:child" as AgentId;
  store.apply({ kind: "agent", id: root, patch: { harness: "codex", flavor: { kind: "session" } } });
  store.apply({ kind: "agent", id: skill, patch: { harness: "codex", flavor: { kind: "skill", skill: "plan", trigger: { kind: "user" }, runner: root } } });
  store.apply({ kind: "agent", id: lane, patch: { flavor: { kind: "lane", mode: "read-only", stream: "live", label: null, receipt: null } } });
  store.apply({ kind: "link", id: lane, parent: skill, via: "runner" });
  expect(messageTarget(store, "codex:hidden" as AgentId)).toBeNull();
  store.apply({ kind: "pstack", id: lane });
  expect(messageTarget(store, lane)?.id).toBe(root);
  store.apply({ kind: "pstack", id: skill });
  expect(messageTarget(store, skill)?.id).toBe(root);
});
