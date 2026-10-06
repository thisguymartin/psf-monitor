import { describe, expect, it } from "bun:test";
import { actionsFor, resumeCommand } from "./actions.ts";
import type { AgentId, AgentNode } from "./domain.ts";

const running = { kind: "running", evidence: "pid" } as const;
const done = { kind: "done", at: null } as const;

function node(id: string, flavor: AgentNode["flavor"], status: AgentNode["status"] = running, cwd: string | null = null): AgentNode {
  return { id: id as AgentId, harness: id.startsWith("opencode:") ? "opencode" : id.startsWith("codex:") ? "codex" : "claude", flavor, status, cwd } as AgentNode;
}

describe("agent actions", () => {
  it("offers cancel only to running lanes", () => {
    const lane = { kind: "lane", mode: "read-only", stream: "live", label: null, receipt: null } as const;
    expect(actionsFor(node("lane:l1", lane, running)).map((action) => action.id)).toEqual(["cancel"]);
    expect(actionsFor(node("lane:l1", lane, done))).toEqual([]);
  });

  it("offers copy resume only to root sessions", () => {
    expect(actionsFor(node("claude:s1", { kind: "session" })).map((action) => action.id)).toEqual(["copy-resume"]);
    expect(actionsFor(node("codex:t1", { kind: "session" })).map((action) => action.id)).toEqual(["copy-resume"]);
    expect(actionsFor(node("claude:s1:a1", { kind: "subagent", agentType: null }))).toEqual([]);
  });

  it("builds resume commands and shell-quotes the working directory", () => {
    expect(actionsFor(node("opencode:s1", { kind: "session" })).map((action) => action.id)).toEqual(["copy-resume"]);
    expect(resumeCommand(node("opencode:s1", { kind: "session" }, done, "/work/my project"))).toBe("cd '/work/my project' && opencode --session s1");
    expect(resumeCommand(node("claude:s1", { kind: "session" }))).toBe("claude --resume s1");
    expect(resumeCommand(node("codex:t1", { kind: "session" }, done, "/work/O'Brien"))).toBe("cd '/work/O'\\''Brien' && codex resume t1");
    expect(resumeCommand(node("claude:s1:a1", { kind: "subagent", agentType: null }))).toBeNull();
  });
});
