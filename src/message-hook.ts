import { MessageInbox } from "./messages.ts";
import { homes } from "./sources.ts";

/** Hook protocol, separate from the transcript readers. */
export function deliverHook(inbox: MessageInbox, harness: "claude" | "codex", input: unknown): object {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const event = record.hook_event_name;
  const session = record.session_id;
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(session)) return {};
  if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"].includes(String(event))) return {};
  const agent = record.agent_id;
  const child = typeof agent === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(agent);
  // Codex child threads have their own session IDs. SubagentStop reports the child's ID on its parent.
  const target = harness === "claude"
    ? `claude:${session}${child ? `:${agent}` : ""}`
    : `codex:${event === "SubagentStop" && child ? agent : session}`;
  const finishing = event === "Stop" || event === "SubagentStop";
  const messages = inbox.receive(target, finishing || event === "UserPromptSubmit" || event === "SessionStart");
  if (messages.length === 0) return {};
  const context = messages.map((message) => `User message from psf-monitor (${message.mode}; about ${message.source}):\n${message.text}`).join("\n\n");
  if (finishing) return { decision: "block", reason: context };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

export async function messageHook(harness: "claude" | "codex"): Promise<void> {
  let inbox: MessageInbox | null = null;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as unknown;
    inbox = new MessageInbox(homes().state);
    process.stdout.write(JSON.stringify(deliverHook(inbox, harness, input)));
  } catch {
    // A failed monitor hook must not prevent the harness from working.
    process.stdout.write("{}");
  } finally { inbox?.close(); }
}
