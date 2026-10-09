import type { AgentId, AgentNode, Scope } from "../domain.ts";
import { activityLine, compactNumber, kindLabel, stalled, statusLine } from "../format.ts";
import { rootOf } from "../graph.ts";
import { summarizeOverview } from "../overview.ts";
import type { PstackSetup, ServerInfo, SourceHealth } from "../wire.ts";
import { h, icon } from "./dom.ts";

interface OverviewState {
  readonly nodes: ReadonlyMap<AgentId, AgentNode>;
  readonly health: readonly SourceHealth[];
  readonly server: ServerInfo | null;
  readonly setup: PstackSetup | null;
  readonly scope: Scope;
  readonly now: number;
  readonly connection: string;
}

const SCOPE_LABEL: Record<Scope, string> = { pstack: "pstack sessions", normal: "Other sessions", all: "All sessions" };
const SOURCE_LABEL = { "claude-session": "Claude Code", "codex-rollout": "Codex", "opencode-session": "OpenCode", "runner-lane": "Model lanes" };

export class Overview {
  readonly element = h("section", { class: "overview", attrs: { "aria-label": "Work overview" } });

  constructor(private readonly events: { navigate(page: string): void; select(id: AgentId): void }) {}

  render(state: OverviewState): void {
    const focused = this.element.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
    const scroll = this.element.scrollTop;
    const summary = summarizeOverview(state.nodes, state.scope, state.now, state.setup);
    const heading = h("header", { class: "overview-head" },
      h("div", {}, h("h2", { text: "Work overview" }), h("p", { text: `${SCOPE_LABEL[state.scope]}${state.server ? ` · Last ${state.server.windowHours} hours` : ""}` })),
      this.navigate("Browse sessions", "sessions"));
    const content: HTMLElement[] = [heading];
    if (state.connection !== "live") content.push(h("p", { class: "overview-notice", attrs: { role: "status" }, text: state.connection === "connecting" ? "Connecting to the monitor…" : `Monitor ${state.connection}. Showing the last received activity; it may be out of date.` }));
    else if (state.server?.indexing) content.push(h("p", { class: "overview-notice", attrs: { role: "status" }, text: "Reading recent transcripts. Counts may change as more work is indexed." }));

    const active = this.section("Working now", summary.running.length > 0 ? `${summary.running.length} running across ${summary.runningSessions} ${summary.runningSessions === 1 ? "session" : "sessions"}` : "No running work in this scope");
    if (summary.running.length === 0) active.append(h("p", { class: "overview-empty", text: summary.entries > 0 ? "Open a session to inspect waiting or completed work." : "Sessions will appear here when they are observed in this scope." }));
    else active.append(this.agents(summary.running, summary.nodes, state.now, "working"));

    const attention = this.section("Needs attention", `${summary.attention.length} ${summary.attention.length === 1 ? "entry" : "entries"}${summary.blockers.length > 0 ? ` · ${summary.blockers.length} provider ${summary.blockers.length === 1 ? "blocker" : "blockers"}` : ""}`);
    if (summary.attention.length > 0 || summary.blockers.length > 0) attention.classList.add("overview-attention");
    if (summary.attention.length > 0) attention.append(this.agents(summary.attention, summary.nodes, state.now, "attention"));
    for (const blocker of summary.blockers) attention.append(h("div", { class: "overview-provider" },
      h("div", {}, h("strong", { text: blocker.provider.provider }), h("p", { text: blocker.provider.blocked ?? "" }), h("small", { text: blocker.activity ? "Used by current work; new lanes are blocked." : "Assigned in the effective model sheet for current work." })),
      this.navigate("Check provider", "providers", blocker.provider.provider)));
    if (summary.attention.length === 0 && summary.blockers.length === 0) attention.append(h("p", { class: "overview-empty", text: "No failed or stalled entries observed in this scope." }));
    if (state.setup === null) attention.append(h("p", { class: "overview-note", text: "Provider readiness is unavailable until setup is loaded." }));
    content.push(h("div", { class: "overview-priority" }, active, attention));

    const usage = this.section("Observed model usage", `${summary.entries} ${summary.entries === 1 ? "entry" : "entries"} · skill steps excluded`);
    usage.append(h("p", { class: "overview-note", text: "Recorded token usage in this scope. Missing usage is not counted; these are not billing totals." }));
    if (summary.models.length === 0) usage.append(h("p", { class: "overview-empty", text: "No model usage observed in this scope yet." }));
    else {
      const table = h("table", { class: "overview-models", attrs: { "aria-label": "Observed model usage by provider and model" } },
        h("thead", {}, h("tr", {}, h("th", { attrs: { scope: "col" }, text: "Model" }), h("th", { attrs: { scope: "col" }, text: "Entries" }), h("th", { attrs: { scope: "col" }, text: "Observed tokens" }))));
      const body = h("tbody");
      for (const row of summary.models) body.append(h("tr", {},
        h("th", { attrs: { scope: "row" } }, h("strong", { text: row.model ?? "Model not reported" }), h("small", { text: row.provider })),
        h("td", {}, String(row.entries), row.running > 0 ? h("small", { text: `${row.running} running` }) : null),
        h("td", {}, row.tokens === null ? "Not reported" : compactNumber(row.tokens), row.tokens !== null ? h("small", { text: `${row.reporting}/${row.entries} entries report usage${row.partial ? " · partial token fields" : ""}` }) : null)));
      table.append(body);
      usage.append(h("div", { class: "overview-table-scroll", attrs: { tabindex: "0", "aria-label": "Observed model usage" } }, table));
    }
    usage.append(this.navigate("Model assignments", "models"));
    content.push(usage);

    const sources = this.section("Monitor sources", "Monitor-wide · all scopes");
    const present = state.health.filter((source) => source.present);
    if (present.length === 0) sources.append(h("p", { class: "overview-empty", text: "No source health received yet." }));
    for (const source of present) sources.append(h("div", { class: "overview-source" }, h("strong", { text: SOURCE_LABEL[source.source] }),
      h("span", { text: source.state === "degraded" ? `${source.shape} unrecognized records; activity may be incomplete` : source.unchecked.length > 0 ? `Version ${source.unchecked.join(", ")} is not yet verified` : "Reading normally", attrs: { "data-health": source.state } })));
    content.push(sources);
    this.element.replaceChildren(...content);
    if (focused !== undefined) this.element.querySelectorAll<HTMLElement>("[data-focus]").forEach((element) => { if (element.dataset.focus === focused) element.focus({ preventScroll: true }); });
    this.element.scrollTop = scroll;
  }

  private section(title: string, description: string): HTMLElement {
    return h("section", { class: "overview-section" }, h("div", { class: "overview-section-head" }, h("h3", { text: title }), h("span", { text: description })));
  }

  private navigate(label: string, page: string, key = page): HTMLButtonElement {
    return h("button", { class: "quiet-action", attrs: { type: "button", "data-focus": `overview-nav:${key}` }, on: { click: () => this.events.navigate(page) } }, label, icon("arrowRight"));
  }

  private agents(nodes: readonly AgentNode[], all: ReadonlyMap<AgentId, AgentNode>, now: number, section: string): HTMLElement {
    const list = h("ul", { class: "overview-agents" });
    for (const node of nodes.slice(0, 6)) {
      const root = all.get(rootOf(node.id, all));
      const snippet = node.status.kind === "failed" ? node.status.reason : activityLine(node) ?? node.prompt?.text ?? "No activity summary recorded.";
      list.append(h("li", {}, h("button", { class: "overview-agent", attrs: { type: "button", "data-focus": `overview:${section}:${node.id}` }, on: { click: () => this.events.select(node.id) } },
        h("span", { class: "overview-agent-copy" }, h("strong", { text: node.title }), h("small", { text: `${kindLabel(node)}${root && root.id !== node.id ? ` · ${root.title}` : ""}` }), h("span", { class: "overview-snippet", text: snippet })),
        h("span", { class: "overview-agent-status", text: node.status.kind === "failed" ? "Failed" : statusLine(node, now), attrs: { "data-status": stalled(node, now) ? "stalled" : node.status.kind } }), icon("arrowRight"))));
    }
    return h("div", {}, list, nodes.length > 6 ? h("div", { class: "overview-list-footer" }, h("span", { text: `Showing 6 of ${nodes.length}` }), this.navigate("Browse sessions", "sessions", `${section}-sessions`)) : null);
  }
}
