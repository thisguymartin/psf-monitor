import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NOTHING, parsed, problem, type Adapter, type Fact, type Parsed, type SourceDocument } from "../adapter.ts";
import type { AgentId, TimelineItem } from "../domain.ts";
import { clip, object, parseJson, text } from "../json.ts";
import { BODY_LIMIT } from "./blocks.ts";
import { openCodePart, openCodeUsage } from "./opencode-parts.ts";

interface SessionRow {
  id: string; parent_id: string | null; directory: string; title: string; version: string;
  time_created: number; time_updated: number;
}
interface DataRow { id: string; data: string; time_created: number; time_updated: number }
interface PartRow extends DataRow { ordinal: number; message_id: string }
interface CachedSession { stamp: string; document: SourceDocument; items: readonly TimelineItem[] }
const agentId = (session: string): AgentId => `opencode:${session}` as AgentId;
function iso(value: number): string { return new Date(value).toISOString(); }

/** Reads only OpenCode's session/message/part tables, never credentials or provider settings. */
export function openCodeAdapter(directory: string): Adapter {
  const path = join(directory, "opencode.db");
  const cache = new Map<AgentId, CachedSession>();
  return {
    source: "opencode-session", roots: [{ dir: directory, depth: 1 }], windowed: true,
    checkedVersion: "1.18.34", claim: () => null, open: () => ({ line: () => NOTHING }), document: () => NOTHING, removed: () => [],
    snapshot(sinceMs) {
      if (!existsSync(path)) { cache.clear(); return { present: false, documents: [] }; }
      const db = new Database(path, { readonly: true });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=500;");
        // Read one consistent snapshot, including WAL updates from active sessions.
        return db.transaction(() => {
          const sessions = db.query("SELECT id, parent_id, directory, title, version, time_created, time_updated FROM session").all() as SessionRow[];
          const byId = new Map(sessions.map((row) => [row.id, row]));
          const included = new Set<string>();
          for (const session of sessions) {
            if (session.time_updated < sinceMs) continue;
            let current: SessionRow | undefined = session;
            while (current !== undefined && !included.has(current.id)) {
              included.add(current.id);
              current = current.parent_id === null ? undefined : byId.get(current.parent_id);
            }
          }
          const documents: SourceDocument[] = [];
          for (const session of sessions) {
            if (!included.has(session.id)) continue;
            const id = agentId(session.id);
            const messages = db.query("SELECT id, data, time_created, time_updated FROM message WHERE session_id=? ORDER BY time_created, id").all(session.id) as DataRow[];
            const parts = db.query("SELECT rowid AS ordinal, id, message_id, data, time_created, time_updated FROM part WHERE session_id=? ORDER BY rowid").all(session.id) as PartRow[];
            // Part updates do not always update the session timestamp.
            const stamp = JSON.stringify([session, messages.map((row) => [row.id, row.time_updated]), parts.map((row) => [row.id, row.time_updated])]);
            let saved = cache.get(id);
            if (saved?.stamp !== stamp) {
              const records: Parsed[] = [];
              const parent = session.parent_id === null ? null : agentId(session.parent_id);
              let ancestor = session;
              const seen = new Set<string>();
              while (ancestor.parent_id !== null && !seen.has(ancestor.id)) {
                seen.add(ancestor.id);
                const next = byId.get(ancestor.parent_id);
                if (next === undefined) break;
                ancestor = next;
              }
              const root = agentId(ancestor.id);
              const facts: Fact[] = [{ kind: "agent", id, patch: { harness: "opencode", source: "opencode-session", root, flavor: session.parent_id === null ? { kind: "session" } : { kind: "subagent", agentType: null }, cwd: session.directory, title: session.title, seenAt: iso(session.time_created) } }];
              if (parent !== null) facts.push({ kind: "link", id, parent, via: "thread-spawn" });
              records.push(parsed(facts, [], session.version));
              const roles = new Map<string, string>();
              let latestUser: DataRow | null = null;
              for (const row of messages) {
                const message = object(parseJson(row.data));
                if (message === null) { records.push(problem({ kind: "shape", recordType: "message", detail: "not an object" })); continue; }
                roles.set(row.id, text(message.role) ?? "assistant");
                if (message.role === "user") latestUser = row;
                const provider = text(message.providerID);
                const model = text(message.modelID);
                const usage = message.role === "assistant" ? openCodeUsage(message.tokens) : null;
                const metadata: Fact[] = [];
                if (provider !== null || model !== null) metadata.push({ kind: "agent", id, patch: { ...(provider === null ? {} : { provider }), ...(model === null ? {} : { reportedModel: model }), ...(text(message.variant) === null ? {} : { effort: text(message.variant)! }) } });
                if (usage !== null) metadata.push({ kind: "usage", id, key: row.id, usage });
                records.push(parsed(metadata));
              }
              if (latestUser !== null) records.push(parsed([
                { kind: "result", id, result: null },
                { kind: "turn", id, turnId: latestUser.id, at: iso(latestUser.time_created), event: { kind: "started" } },
              ]));
              for (const row of parts) {
                const role = roles.get(row.message_id) ?? "assistant";
                // Message usage is authoritative; step-finish tokens would count it twice.
                const part = object(parseJson(row.data));
                records.push(part?.type === "step-finish" ? NOTHING : openCodePart(id, part, row.ordinal, iso(row.time_created), role));
              }
              if (latestUser !== null) {
                const last = [...messages].reverse().find((row) => row.time_created >= latestUser!.time_created && roles.get(row.id) === "assistant");
                const result = last === undefined ? null : object(parseJson(last.data));
                const finish = text(result?.finish);
                const error = object(result?.error);
                if (error !== null || (finish !== null && finish !== "tool-calls" && finish !== "unknown")) {
                  const time = object(result?.time);
                  const ended = typeof time?.completed === "number" ? time.completed : last!.time_updated;
                  records.push(parsed([{ kind: "turn", id, turnId: latestUser.id, at: iso(ended), event: { kind: "ended", outcome: error === null ? "done" : "failed", reason: text(object(error?.data)?.message) } }]));
                  const answer = parts.filter((row) => row.message_id === last!.id).map((row) => object(parseJson(row.data))).filter((part) => part?.type === "text").map((part) => text(part?.text) ?? "").join("\n");
                  if (answer.length > 0) records.push(parsed([{ kind: "result", id, result: { kind: "text", body: clip(answer, BODY_LIMIT) } }]));
                }
              }
              const items = records.flatMap((record) => record.items);
              saved = { stamp, document: { agent: id, stamp, records }, items };
              cache.set(id, saved);
            }
            documents.push(saved!.document);
          }
          for (const id of cache.keys()) if (!included.has(id.slice("opencode:".length))) cache.delete(id);
          return { present: true, documents };
        })();
      } finally { db.close(); }
    },
    timeline(agent, before, limit) {
      const session = cache.get(agent);
      if (session === undefined) return null;
      const eligible = session.items.filter((item) => before === null || Number(item.id.split(".")[0]) < before);
      let start = Math.max(0, eligible.length - limit);
      // A completed tool has two items from one part; keep both on the same page.
      while (start > 0 && eligible[start]?.id.split(".")[0] === eligible[start - 1]?.id.split(".")[0]) start--;
      const items = eligible.slice(start);
      const oldest = items[0];
      return { agent, items, older: eligible.length > items.length && oldest !== undefined ? Number(oldest.id.split(".")[0]) : null };
    },
  };
}
