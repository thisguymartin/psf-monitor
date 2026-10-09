import type { AgentId, AgentNode } from "../domain.ts";
import { filterTree, type AgentFilter, type StatusFilter } from "../explorer.ts";
import { activityLine, compactNumber, kindLabel, modelOf, stalled, statusLine } from "../format.ts";
import { tokenTotal, type Tree } from "../graph.ts";
import { h, icon, type IconName } from "./dom.ts";

type Mode = "tree" | "runs" | "graph";
const MODE_KEY = "psf-monitor.session-view";
const STATUS: ReadonlyArray<readonly [StatusFilter, string]> = [
  ["all", "All statuses"], ["running", "Running"], ["waiting", "Waiting / idle"],
  ["failed", "Failed"], ["done", "Done"], ["stalled", "Stalled"],
  ["cancelled", "Cancelled"], ["ended", "Ended"], ["unknown", "Unknown"],
];
const STATUS_ICON: Record<AgentNode["status"]["kind"], IconName> = {
  running: "spinner", idle: "pause", done: "check", failed: "cross", cancelled: "stop", ended: "dot", unknown: "question",
};

function storedMode(): Mode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === "runs" || value === "graph" ? value : "tree";
  } catch { return "tree"; }
}

export class Explorer {
  readonly element: HTMLElement;
  readonly content: HTMLElement;
  readonly graphHost = h("div", { class: "explorer-graph" });
  private mode = storedMode();
  private readonly filter: { query: string; status: StatusFilter; kind: AgentFilter["kind"] } = { query: "", status: "all", kind: "all" };
  private readonly search = h("input", { attrs: { type: "search", placeholder: "Search agents, models, activity…", "aria-label": "Search agents, models, and activity" } });
  private readonly status = h("select", { attrs: { "aria-label": "Filter by status" } }, ...STATUS.map(([value, label]) => h("option", { text: label, attrs: { value } })));
  private readonly kind = h("select", { attrs: { "aria-label": "Filter by type" } }, ...([ ["all", "All types"], ["subagent", "Agents"], ["lane", "Model lanes"], ["skill", "Skills"], ["session", "Session"] ] as const).map(([value, label]) => h("option", { text: label, attrs: { value } })));
  private readonly skills = h("input", { attrs: { type: "checkbox" } });
  private readonly count = h("span", { class: "explorer-count", attrs: { role: "status" } });
  private readonly list = h("div", { class: "explorer-list" });
  private readonly notice = h("div", { class: "explorer-notice", attrs: { hidden: "" } });
  private readonly expand = h("button", { class: "quiet-action", text: "Expand all", attrs: { type: "button" } });
  private readonly collapse = h("button", { class: "quiet-action", text: "Collapse all", attrs: { type: "button" } });
  private readonly reset = h("button", { class: "quiet-action", text: "Clear filters", attrs: { type: "button" } });
  private readonly buttons = new Map<Mode, HTMLButtonElement>();
  private readonly branches = new Map<AgentId, boolean>();
  private readonly summaries = new Set<AgentId>();
  private tree: Tree | null = null;
  private selected: AgentId | null = null;
  private now = Date.now();
  private message: string | null = null;

  constructor(private readonly events: { change(): void; select(id: AgentId): void; skills(shown: boolean): void }) {
    const views = h("div", { class: "explorer-views", attrs: { role: "group", "aria-label": "Session view" } });
    for (const [mode, label, glyph] of [["tree", "Nested", "sessions"], ["runs", "Runs", "terminal"], ["graph", "Graph", "agent"]] as const) {
      const button = h("button", { attrs: { type: "button", "aria-pressed": String(mode === this.mode) }, on: { click: () => {
        this.mode = mode;
        try { localStorage.setItem(MODE_KEY, mode); } catch { /* Keep the choice for this page. */ }
        this.events.change();
      } } }, icon(glyph), label);
      this.buttons.set(mode, button);
      views.append(button);
    }
    this.search.addEventListener("input", () => { this.filter.query = this.search.value; this.events.change(); });
    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.search.value !== "") {
        event.stopPropagation(); this.search.value = ""; this.filter.query = ""; this.events.change();
      }
    });
    this.status.addEventListener("change", () => { this.filter.status = this.status.value as StatusFilter; this.events.change(); });
    this.kind.addEventListener("change", () => {
      this.filter.kind = this.kind.value as AgentFilter["kind"];
      if (this.filter.kind === "skill" && !this.skills.checked) this.events.skills(true);
      else this.events.change();
    });
    this.skills.addEventListener("change", () => this.events.skills(this.skills.checked));
    this.reset.addEventListener("click", () => this.clearFilters());
    this.expand.addEventListener("click", () => this.expandAll(true));
    this.collapse.addEventListener("click", () => this.expandAll(false));
    this.content = h("div", { class: "explorer-content" }, this.list, this.graphHost, this.notice);
    this.element = h("section", { class: "explorer", attrs: { "aria-label": "Session agents" } },
      h("div", { class: "explorer-toolbar" }, views, h("label", { class: "explorer-search" }, icon("search"), this.search)),
      h("div", { class: "explorer-filters" }, this.status, this.kind, h("label", { class: "explorer-skills" }, this.skills, "Show skills"), this.reset),
      h("div", { class: "explorer-summary" }, this.count, h("div", { class: "explorer-expansion" }, this.expand, this.collapse)),
      this.content);
  }

  get isGraph(): boolean { return this.mode === "graph"; }

  clearFilters(): void {
    this.filter.query = ""; this.filter.status = "all"; this.filter.kind = "all";
    this.search.value = ""; this.status.value = "all"; this.kind.value = "all";
    this.events.change();
  }
  private get filtering(): boolean { return this.filter.query.trim() !== "" || this.filter.status !== "all" || this.filter.kind !== "all"; }

  render(tree: Tree | null, selected: AgentId | null, now: number, skillsShown: boolean, message: string | null): Tree | null {
    this.tree = tree; this.selected = selected; this.now = now; this.message = message;
    this.skills.checked = skillsShown;
    if (!skillsShown && this.filter.kind === "skill") { this.filter.kind = "all"; this.kind.value = "all"; }
    for (const [mode, button] of this.buttons) button.setAttribute("aria-pressed", String(mode === this.mode));
    this.element.dataset.mode = this.mode;
    this.graphHost.hidden = !this.isGraph;
    this.list.hidden = this.isGraph;
    this.expand.hidden = this.collapse.hidden = this.isGraph;
    this.expand.disabled = this.collapse.disabled = tree === null || (this.mode === "tree" && this.filtering);
    this.reset.hidden = !this.filtering;
    const filtered = tree === null ? null : filterTree(tree, this.filter, now);
    const matches = filtered?.matches.size ?? 0;
    this.count.textContent = tree === null ? "Session activity" : this.filtering
      ? `${matches} of ${tree.nodes.length} match${matches === 1 ? "" : "es"}${this.mode !== "runs" && matches > 0 ? " · parents kept for context" : ""}`
      : `${tree.nodes.length} entries · ${this.mode === "tree" ? "Expand a branch to explore its agents" : this.mode === "runs" ? "Expand a run for its task and latest activity" : "Select a node to inspect it"}`;
    const empty = message ?? (tree === null ? "Select a session to explore its agents." : matches === 0 ? "No agents match these filters. Clear filters to see the whole session." : null);
    this.notice.hidden = empty === null;
    this.notice.replaceChildren(h("h2", { text: matches === 0 && tree !== null && message === null ? "No matching agents" : "Session activity" }), h("p", { text: empty ?? "" }));
    this.draw(filtered?.tree ?? null, filtered?.matches ?? new Set());
    return filtered === null || matches === 0 ? null : filtered.tree;
  }

  private expandAll(open: boolean): void {
    for (const node of this.tree?.nodes ?? []) {
      if (this.mode === "runs") { if (open) this.summaries.add(node.id); else this.summaries.delete(node.id); }
      else this.branches.set(node.id, open);
    }
    this.events.change();
  }

  private draw(tree: Tree | null, matches: ReadonlySet<AgentId>): void {
    const scrollTop = this.list.scrollTop;
    const outputScroll = new Map(Array.from(this.list.querySelectorAll<HTMLElement>("[data-output]"), (element) => [element.dataset.output, element.scrollTop]));
    const focused = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    this.list.replaceChildren();
    if (this.isGraph || tree === null || matches.size === 0 || this.message !== null) return;
    if (this.mode === "runs") {
      for (const node of tree.nodes) if (matches.has(node.id)) this.list.append(this.run(node));
    } else {
      const visit = (node: AgentNode): HTMLLIElement => {
        const children = tree.children.get(node.id) ?? [];
        const open = this.filtering || (this.branches.get(node.id) ?? node.id === tree.root.id);
        const toggle = h("button", { class: "explorer-toggle", attrs: { type: "button", "aria-label": `${open ? "Collapse" : "Expand"} ${node.title}`, "aria-expanded": String(open), "data-focus": `branch:${node.id}` } }, icon(open ? "chevronDown" : "chevronRight"));
        toggle.disabled = children.length === 0 || this.filtering;
        if (children.length === 0) toggle.style.visibility = "hidden";
        toggle.addEventListener("click", () => { this.branches.set(node.id, !open); this.events.change(); });
        const select = h("button", { class: "explorer-agent", attrs: { type: "button", "data-focus": `agent:${node.id}`, "aria-current": String(this.selected === node.id) }, on: { click: () => this.events.select(node.id) } },
          this.glyph(node), h("span", { class: "explorer-identity" }, h("strong", { text: node.title }), h("span", { class: "explorer-activity", text: activityLine(node) ?? kindLabel(node) })),
          h("span", { class: "explorer-model", text: modelOf(node) ?? kindLabel(node) }), this.statusLabel(node),
          children.length > 0 ? h("span", { class: "explorer-child-count", text: `${children.length} inside` }) : null);
        const row = h("div", { class: "explorer-row", attrs: { "data-context": String(!matches.has(node.id)), "data-selected": String(this.selected === node.id) } }, toggle, select);
        row.style.setProperty("--depth", String(Math.min(tree.depth.get(node.id) ?? 0, 6)));
        const item = h("li", {}, row);
        if (open && children.length > 0) item.append(h("ul", { class: "explorer-branch", attrs: { "aria-label": `Agents under ${node.title}` } }, ...children.map(visit)));
        return item;
      };
      this.list.append(h("ul", { class: "explorer-branch", attrs: { "aria-label": "Agent hierarchy" } }, visit(tree.root)));
    }
    if (focused !== undefined) this.list.querySelectorAll<HTMLElement>("[data-focus]").forEach((element) => { if (element.dataset.focus === focused) element.focus({ preventScroll: true }); });
    this.list.scrollTop = scrollTop;
    this.list.querySelectorAll<HTMLElement>("[data-output]").forEach((element) => { element.scrollTop = outputScroll.get(element.dataset.output) ?? 0; });
  }

  private glyph(node: AgentNode): HTMLElement {
    return h("span", { class: "explorer-status-icon", attrs: { "data-status": stalled(node, this.now) ? "stalled" : node.status.kind } }, icon(stalled(node, this.now) ? "alert" : STATUS_ICON[node.status.kind]));
  }

  private statusLabel(node: AgentNode): HTMLElement {
    return h("span", { class: "explorer-status", text: statusLine(node, this.now), title: statusLine(node, this.now) });
  }

  private run(node: AgentNode): HTMLElement {
    const open = this.summaries.has(node.id);
    const parent = this.tree?.nodes.find((entry) => entry.id === node.parent);
    const bodyId = `run-${node.id}`;
    const summary = h("button", { class: "explorer-run-summary", attrs: { type: "button", "aria-expanded": String(open), "aria-controls": bodyId, "data-focus": `run:${node.id}` }, on: { click: () => {
      if (open) this.summaries.delete(node.id); else this.summaries.add(node.id);
      this.events.change();
    } } }, icon(open ? "chevronDown" : "chevronRight"), this.glyph(node),
    h("span", { class: "explorer-identity" }, h("strong", { text: node.title }), h("span", { class: "explorer-activity", text: parent ? `${parent.title} / ${kindLabel(node)}` : kindLabel(node) })), this.statusLabel(node));
    const body = h("div", { class: "explorer-run-body", attrs: { id: bodyId } });
    body.hidden = !open;
    if (open) {
      body.append(h("div", { class: "explorer-run-facts", text: [modelOf(node), node.model.provider, node.flavor.kind !== "skill" && node.usage !== null ? `${compactNumber(tokenTotal(node.usage))} tokens` : null].filter(Boolean).join(" · ") }));
      for (const [label, text] of [["Task", node.prompt?.text], ["Latest activity", activityLine(node)], ["Result", node.result?.kind === "text" ? node.result.body.text : null], ["Failure", node.status.kind === "failed" ? node.status.reason : null]] as const) {
        if (text) body.append(h("h3", { text: label }), h("pre", { class: "explorer-output", text, attrs: { "data-output": `${node.id}:${label}`, "data-focus": `output:${node.id}:${label}`, tabindex: "0", "aria-label": `${node.title}: ${label}` } }));
      }
      if (!node.prompt && !activityLine(node) && !node.result) body.append(h("p", { text: "No activity summary recorded yet." }));
      body.append(h("button", { class: "quiet-action explorer-open", attrs: { type: "button", "data-focus": `transcript:${node.id}` }, on: { click: () => this.events.select(node.id) } }, icon("terminal"), "Open transcript", icon("arrowRight")));
    }
    return h("article", { class: "explorer-run", attrs: { "data-selected": String(this.selected === node.id) } }, summary, body);
  }
}
