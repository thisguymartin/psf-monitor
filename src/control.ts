import { agentAction } from "./actions.ts";
import type { AgentId } from "./domain.ts";
import { alive, type ProcessTable } from "./probe.ts";
import type { Store } from "./store.ts";

export type CancelResult =
  | { readonly kind: "sent" }
  | { readonly kind: "unknown-agent" }
  | { readonly kind: "not-cancellable"; readonly reason: string }
  | { readonly kind: "process-gone" };

export async function cancelLane(
  store: Store,
  table: ProcessTable,
  id: AgentId,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): Promise<CancelResult> {
  const node = store.node(id);
  if (node === null) return { kind: "unknown-agent" };
  if (!agentAction("cancel").available(node)) return { kind: "not-cancellable", reason: "Lane is not running." };
  const record = store.process(id)?.record;
  if (record === undefined || record.startedAtMs === null) return { kind: "process-gone" };
  try {
    const current = await table([record.pid]);
    if (!alive({ key: String(id), pid: record.pid, startedAtMs: record.startedAtMs }, current)) return { kind: "process-gone" };
    kill(record.pid, "SIGTERM");
    return { kind: "sent" };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return { kind: "process-gone" };
    return { kind: "not-cancellable", reason: error instanceof Error ? error.message : "Could not cancel lane." };
  }
}
