import type { AgentNode } from "./domain.ts";

export type AgentActionId = "cancel" | "copy-resume";

export interface AgentAction {
  readonly id: AgentActionId;
  readonly label: string;
  readonly runs: "server" | "client";
  readonly confirm: string | null;
  available(node: AgentNode): boolean;
}

export const AGENT_ACTIONS: readonly AgentAction[] = [
  {
    id: "cancel",
    label: "Cancel lane",
    runs: "server",
    confirm: "Cancel this lane?",
    available: (node) => node.flavor.kind === "lane" && node.status.kind === "running",
  },
  {
    id: "copy-resume",
    label: "Copy resume command",
    runs: "client",
    confirm: null,
    available: (node) => node.flavor.kind === "session" && (node.harness === "claude" || node.harness === "codex" || node.harness === "opencode"),
  },
];

export function agentAction(id: AgentActionId): AgentAction {
  return AGENT_ACTIONS.find((action) => action.id === id)!;
}

export function actionsFor(node: AgentNode): readonly AgentAction[] {
  return AGENT_ACTIONS.filter((action) => action.available(node));
}

export function resumeCommand(node: AgentNode): string | null {
  if (!agentAction("copy-resume").available(node)) return null;
  const prefix = `${node.harness}:`;
  if (!node.id.startsWith(prefix)) return null;
  const session = node.id.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(session)) return null;
  const command = node.harness === "claude" ? `claude --resume ${session}` : node.harness === "opencode" ? `opencode --session ${session}` : `codex resume ${session}`;
  return node.cwd === null ? command : `cd '${node.cwd.replaceAll("'", "'\\''")}' && ${command}`;
}
