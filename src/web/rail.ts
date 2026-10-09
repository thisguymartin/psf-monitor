import type { AgentId, AgentNode, Scope } from "../domain.ts";
import { activityLine, ago, kindLabel, working } from "../format.ts";
import { h, icon, providerIcon } from "./dom.ts";

// The session list, grouped by whether anyone is working.

export interface RailEvents {
  select(root: AgentId): void;
  scope(next: Scope): void;
}

export const SCOPE_LABEL: Record<Scope, string> = { pstack: "pstack sessions", normal: "Other sessions", all: "All sessions" };
const SCOPE_EMPTY: Record<Scope, string> = {
  pstack: "No pstack sessions yet.",
  normal: "No other sessions in this window.",
  all: "No sessions in this window.",
};

export interface Descendants {
  readonly total: number;
  readonly skills: number;
  readonly running: number;
}

type Group = "working" | "open" | "earlier";

const GROUPS: readonly { readonly key: Group; readonly label: string }[] = [
  { key: "working", label: "Working" },
  { key: "open", label: "Open" },
  { key: "earlier", label: "Earlier" },
];

function groupOf(root: AgentNode, counts: Descendants | undefined, now: number): Group {
  if (working(root, now) || (counts?.running ?? 0) > 0) return "working";
  if (root.status.kind === "idle" && root.status.evidence === "pid") return "open";
  return "earlier";
}

function folderName(cwd: string | null): string {
  if (cwd === null) return "";
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? cwd;
}

/** The row's second line: what the session is doing, or when it last did anything. */
function rowActivity(root: AgentNode, group: Group, now: number): string {
  const when = ago(root.lastActivityAt, now);
  if (group === "working") return activityLine(root) ?? "working";
  if (group === "open") return `waiting for input${when.length > 0 ? ` · ${when}` : ""}`;
  return [folderName(root.cwd), when].filter((part) => part.length > 0).join(" · ");
}

export class Rail {
  readonly element: HTMLElement;
  private readonly lists = new Map<Group, HTMLUListElement>();
  private readonly groups = new Map<Group, HTMLElement>();
  private readonly title: HTMLElement;
  private readonly count: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly scopeSelect: HTMLSelectElement;
  private scope: Scope = "pstack";

  constructor(private readonly events: RailEvents) {
    this.title = h("span", { class: "rail-title" });
    this.count = h("span", { class: "rail-count" });
    this.scopeSelect = h("select", { class: "rail-scope", attrs: { "aria-label": "Which sessions to list" } },
      ...(Object.keys(SCOPE_LABEL) as Scope[]).map((scope) => h("option", { text: SCOPE_LABEL[scope], attrs: { value: scope } })));
    this.scopeSelect.addEventListener("change", () => this.events.scope(this.scopeSelect.value as Scope));
    const sections = GROUPS.map(({ key, label }) => {
      const list = h("ul", { class: "sessions" });
      const section = h("section", { class: "rail-group", attrs: { "data-group": key } }, h("h2", { class: "rail-heading", text: label }), list);
      this.lists.set(key, list);
      this.groups.set(key, section);
      return section;
    });
    this.empty = h("p", { class: "rail-empty" });
    this.foot = h("p", { class: "rail-foot" });
    this.element = h(
      "nav",
      { class: "rail", attrs: { "aria-label": "Sessions" } },
      h("header", { class: "rail-head" }, h("span", { class: "rail-names" }, this.title, this.count), this.scopeSelect),
      h("div", { class: "rail-scroll" }, ...sections, this.empty),
      this.foot,
    );
  }

  render(
    roots: readonly AgentNode[],
    descendants: ReadonlyMap<AgentId, Descendants>,
    selected: AgentId | null,
    now: number,
    footer: string,
    scope: Scope,
  ): void {
    this.scope = scope;
    this.scopeSelect.value = scope;
    const rows = new Map<Group, HTMLElement[]>(GROUPS.map(({ key }) => [key, []]));
    for (const root of roots) {
      const counts = descendants.get(root.id);
      const group = groupOf(root, counts, now);
      rows.get(group)!.push(this.row(root, counts, group, root.id === selected, now));
    }
    for (const { key } of GROUPS) {
      const items = rows.get(key)!;
      this.lists.get(key)!.replaceChildren(...items);
      this.groups.get(key)!.hidden = items.length === 0;
    }
    this.title.textContent = scope === "pstack" ? "pstack" : scope === "normal" ? "Other" : "All";
    this.empty.textContent = SCOPE_EMPTY[scope];
    this.empty.hidden = roots.length > 0;
    this.count.textContent = String(roots.length);
    this.foot.textContent = footer;
  }

  private row(root: AgentNode, counts: Descendants | undefined, group: Group, selected: boolean, now: number): HTMLElement {
    const total = counts?.total ?? 0;
    const skills = counts?.skills ?? 0;
    const running = counts?.running ?? 0;
    const button = h(
      "button",
      {
        class: "session",
        title: `${root.title}\n${kindLabel(root)}${root.cwd === null ? "" : `\n${root.cwd}`}`,
        attrs: {
          type: "button",
          "data-group": group,
          "data-status": root.status.kind,
          "data-harness": root.harness,
          ...(selected ? { "aria-current": "true" } : {}),
        },
      },
      h("span", { class: "session-glyph" }, icon(providerIcon(root.harness))),
      h(
        "span",
        { class: "session-text" },
        h("span", { class: "session-title", text: root.title }),
        h("span", { class: "session-meta", text: rowActivity(root, group, now) }),
      ),
      h(
        "span",
        {
          class: "session-side",
          attrs: { "aria-label": `${total} ${total === 1 ? "agent" : "agents"}, ${skills} ${skills === 1 ? "skill" : "skills"}${running > 0 ? `, ${running} running` : ""}` },
        },
        this.scope !== "pstack" && root.pstack ? h("span", { class: "session-tag", text: "pstack", title: "This session ran pstack" }) : null,
        total > 0 ? h("span", { class: "session-count", attrs: { "data-running": String(running > 0) } }, icon("agent"), h("span", { text: String(total) })) : null,
        skills > 0 ? h("span", { class: "session-count", text: `${skills} ${skills === 1 ? "skill" : "skills"}` }) : null,
        h("span", { class: "session-dot", attrs: { "aria-hidden": "true" } }),
      ),
    );
    button.addEventListener("click", () => this.events.select(root.id));
    return h("li", {}, button);
  }
}
