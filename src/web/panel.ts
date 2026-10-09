import { MessageComposer } from "./messages.ts";
import type { AgentId, AgentNode, Clipped, MessageLink, TimelineItem } from "../domain.ts";
import { actionsFor, resumeCommand, type AgentActionId } from "../actions.ts";
import { activityLine, ago, stalled, clockTime, compactNumber, duration, kindLabel, modelOf, prettyModel, shortPath, statusLine, summarizeInput } from "../format.ts";
import type { ActionResponse, TimelinePage } from "../wire.ts";
import { postJson } from "./commands.ts";
import { h, icon, providerIcon, toolIcon, type IconName } from "./dom.ts";
import { markdown } from "./markdown.ts";

// The drill-down: one agent's facts and its timeline,
// streaming while the agent works.

const STICK_THRESHOLD = 40;
const LOAD_OLDER_THRESHOLD = 160;
const CLAMP_CHARS = 700;
export const PANEL_MIN = 360;
export const PANEL_DEFAULT = 460;
const KEY_STEP = 24;
export interface PanelEvents {
  close(): void;
  select(id: AgentId): void;
  loadOlder(agent: AgentId, before: number): Promise<TimelinePage | null>;
  resized(width: number, settled: boolean): void;
}

type ToolCall = Extract<TimelineItem, { kind: "tool-call" }>;
type ToolResult = Extract<TimelineItem, { kind: "tool-result" }>;

function itemOrder(item: TimelineItem): [number, number] {
  const [offset, index] = item.id.split(".");
  return [Number(offset), Number(index ?? 0)];
}

function compareItems(a: TimelineItem, b: TimelineItem): number {
  const [ao, ai] = itemOrder(a);
  const [bo, bi] = itemOrder(b);
  return ao === bo ? ai - bi : ao - bo;
}

function clippedNote(body: Clipped): HTMLElement | null {
  return body.omitted > 0
    ? h("p", { class: "t-clipped", text: `${body.omitted.toLocaleString()} more characters not shown` })
    : null;
}

export class Panel {
  readonly element: HTMLElement;
  private readonly composer = new MessageComposer();
  private readonly glyph: HTMLElement;
  private readonly title: HTMLElement;
  private readonly kind: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly facts: HTMLElement;
  private readonly steps: HTMLElement;
  private readonly finalResponse: HTMLElement;
  private resultLoadedFor: AgentId | null = null;
  private laneText: string | null = null;
  private laneTruncated = false;
  private renderedResponseKey = "";
  private readonly task: HTMLElement;
  private readonly taskText: HTMLElement;
  private readonly now: HTMLElement;
  private readonly nowLabel: HTMLElement;
  private readonly nowText: HTMLElement;
  private readonly note: HTMLElement;
  private readonly actionBar: HTMLElement;
  private readonly actionMessage: HTMLElement;
  private readonly confirmations = new Map<AgentActionId, number>();
  private cancelPending: AgentId | null = null;
  private copiedUntil = 0;
  private copiedAgent: AgentId | null = null;
  private readonly widen: HTMLButtonElement;
  private preferred: number | null = null;
  private maxWidth = Number.POSITIVE_INFINITY;
  private readonly scroller: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly olderButton: HTMLButtonElement;
  private readonly jump: HTMLButtonElement;
  private readonly emptyNote: HTMLElement;
  private agent: AgentNode | null = null;
  private nodes: ReadonlyMap<AgentId, AgentNode> = new Map();
  private links: readonly MessageLink[] = [];
  private readonly items = new Map<string, TimelineItem>();
  private readonly expanded = new Set<string>();
  private older: number | null = null;
  private loaded = false;
  private loadingOlder = false;
  private stuck = true;

  constructor(private readonly events: PanelEvents) {
    this.glyph = h("span", { class: "panel-glyph" });
    this.title = h("h2", { class: "panel-title", attrs: { id: "panel-title" } });
    this.kind = h("p", { class: "panel-kind" });
    this.chip = h("p", { class: "status-chip" });
    this.facts = h("dl", { class: "facts" });
    this.steps = h("section", { class: "panel-steps", attrs: { hidden: "" } });
    this.finalResponse = h("section", { class: "panel-result", attrs: { hidden: "" } });
    this.taskText = h("p", { class: "panel-task-text" });
    this.task = h("div", { class: "panel-task", attrs: { hidden: "" } }, h("span", { class: "panel-label", text: "Task" }), this.taskText);
    this.nowLabel = h("span", { class: "panel-label" });
    this.nowText = h("span", { class: "panel-now-text" });
    this.now = h("div", { class: "panel-now", attrs: { hidden: "" } }, this.nowLabel, this.nowText);
    this.note = h("p", { class: "panel-note", attrs: { hidden: "" } });
    this.actionBar = h("div", { class: "panel-command-bar" });
    this.actionMessage = h("p", { class: "command-message", attrs: { hidden: "", role: "status" } });
    const close = h("button", { class: "icon-button", title: "Close", attrs: { type: "button", "aria-label": "Close agent details" } }, icon("close"));
    close.addEventListener("click", () => this.events.close());
    this.widen = h("button", { class: "icon-button panel-widen", title: "Toggle full width", attrs: { type: "button", "aria-label": "Toggle full width panel", "aria-pressed": "false" } }, icon("widen"));
    this.widen.addEventListener("click", () => this.setWidth(this.preferred === null ? PANEL_DEFAULT : null, true));
    const resizer = h("div", {
      class: "panel-resizer",
      title: "Drag to resize; double-click to reset",
      attrs: { role: "separator", "aria-orientation": "vertical", "aria-label": "Resize panel", tabindex: "0" },
    });
    this.bindResizer(resizer);
    this.olderButton = h("button", { class: "older", text: "Load earlier activity", attrs: { type: "button", hidden: "" } });
    this.olderButton.addEventListener("click", () => void this.loadOlder());
    this.list = h("ol", { class: "timeline-items" });
    this.emptyNote = h("p", { class: "timeline-empty", attrs: { hidden: "" } });
    this.scroller = h("div", { class: "timeline", attrs: { tabindex: "0", "aria-label": "Activity" } }, this.composer.element, this.steps, this.finalResponse, this.olderButton, this.list, this.emptyNote);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.jump = h("button", { class: "jump", attrs: { type: "button", hidden: "" } }, icon("arrowDown"), h("span", { text: "New activity" }));
    this.jump.addEventListener("click", () => this.scrollToEnd(true));
    this.element = h(
      "aside",
      { class: "panel", attrs: { "aria-labelledby": "panel-title", "data-open": "false" } },
      resizer,
      h(
        "header",
        { class: "panel-head" },
        h("div", { class: "panel-identity" }, this.glyph, h("div", { class: "panel-names" }, this.title, this.kind), h("div", { class: "panel-actions" }, this.widen, close)),
        this.chip,
        this.actionBar,
        this.actionMessage,
        this.task,
        this.now,
        this.facts,
        this.note,
      ),
      this.scroller,
      this.jump,
    );
  }

  get current(): AgentId | null {
    return this.agent?.id ?? null;
  }

  get width(): number {
    return Math.max(PANEL_MIN, Math.min(this.preferred ?? this.maxWidth, this.maxWidth));
  }

  /** Tracks available space; a newly opened panel fills it. */
  setMaxWidth(pixels: number): void {
    this.maxWidth = Math.max(PANEL_MIN, pixels);
    this.applyWidth();
  }

  private setWidth(pixels: number | null, settled: boolean): void {
    this.preferred = pixels;
    this.applyWidth();
    this.events.resized(this.width, settled);
  }

  private applyWidth(): void {
    this.element.style.setProperty("--panel-width", `${this.width}px`);
    this.widen.setAttribute("aria-pressed", String(this.preferred === null));
  }

  private bindResizer(resizer: HTMLElement): void {
    let start: { x: number; width: number } | null = null;
    let frame: number | null = null;
    let next = 0;
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      start = { x: event.clientX, width: this.width };
      this.element.dataset.resizing = "true";
    });
    resizer.addEventListener("pointermove", (event) => {
      if (start === null) return;
      next = start.width + start.x - event.clientX;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        this.setWidth(next, false);
      });
    });
    const finish = (): void => {
      if (start === null) return;
      start = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      delete this.element.dataset.resizing;
      this.setWidth(this.width, true);
    };
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
    resizer.addEventListener("dblclick", () => this.setWidth(null, true));
    resizer.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.setWidth(this.width + (event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP), true);
    });
  }

  open(node: AgentNode, nodes: ReadonlyMap<AgentId, AgentNode>, now: number): void {
    const switched = this.agent?.id !== node.id;
    this.preferred = null;
    this.agent = node;
    this.composer.open(node.id);
    this.nodes = nodes;
    if (switched) {
      this.resultLoadedFor = null;
      this.laneText = null;
      this.laneTruncated = false;
      this.renderedResponseKey = "";
      this.confirmations.clear();
      this.actionMessage.hidden = true;
      this.items.clear();
      this.expanded.clear();
      this.older = null;
      this.loaded = false;
      this.stuck = true;
      this.list.replaceChildren(this.skeleton());
      this.emptyNote.hidden = true;
      this.olderButton.hidden = true;
      this.jump.hidden = true;
    }
    this.element.dataset.open = "true";
    this.applyWidth();
    this.renderHeader(now);
  }

  close(): void {
    this.composer.close();
    this.agent = null;
    this.element.dataset.open = "false";
  }

  update(nodes: ReadonlyMap<AgentId, AgentNode>, now: number, links: readonly MessageLink[]): void {
    if (this.agent === null) return;
    this.nodes = nodes;
    this.links = links;
    const latest = nodes.get(this.agent.id);
    if (latest !== undefined) this.agent = latest;
    this.renderHeader(now);
    if (this.loaded) this.renderItems(false);
  }

  setPage(page: TimelinePage): void {
    if (page.agent !== this.agent?.id) return;
    this.items.clear();
    for (const item of page.items) this.items.set(item.id, item);
    this.older = page.older;
    this.loaded = true;
    this.renderItems(false);
    if (this.agent?.flavor.kind === "skill" || this.agent?.result !== null) this.scroller.scrollTop = 0;
    else this.scrollToEnd(false);
  }

  append(agent: AgentId, items: readonly TimelineItem[]): void {
    if (agent !== this.agent?.id || !this.loaded) return;
    for (const item of items) this.items.set(item.id, item);
    this.renderItems(false);
    if (this.stuck) this.scrollToEnd(false);
    else this.jump.hidden = false;
  }

  tick(now: number): void {
    if (this.agent === null) return;
    if (this.agent.status.kind === "running" || this.agent.status.kind === "idle") this.renderHeader(now);
  }

  private renderHeader(now: number): void {
    const node = this.agent;
    if (node === null) return;
    this.element.dataset.harness = node.harness;
    this.element.dataset.provider = node.model.provider;
    const glyphName = node.flavor.kind === "skill" ? "file" : node.flavor.kind === "session" ? providerIcon(node.harness) : providerIcon(node.model.provider);
    if (this.glyph.dataset.icon !== glyphName) {
      this.glyph.dataset.icon = glyphName;
      this.glyph.replaceChildren(icon(glyphName));
    }
    this.title.textContent = node.title;
    this.kind.textContent = kindLabel(node);
    this.chip.dataset.status = node.status.kind;
    this.chip.dataset.stalled = String(stalled(node, now));
    this.chip.replaceChildren(icon(statusIcon(node)), h("span", { text: statusLine(node, now) }));
    this.renderActions();

    this.task.hidden = node.prompt === null;
    this.taskText.textContent = node.prompt?.text ?? "";
    this.taskText.title = node.prompt?.text ?? "";
    const running = node.status.kind === "running" && !stalled(node, now);
    const doing = activityLine(node);
    const since = node.pending?.since ?? node.activity?.at ?? null;
    const age = since === null ? "" : ago(since, now);
    this.now.hidden = doing === null;
    this.now.dataset.pending = String(node.pending !== null && running);
    this.nowLabel.textContent = running ? "Now" : "Last";
    this.nowText.textContent = doing === null ? "" : age.length > 0 ? `${doing} · ${age}` : doing;
    this.nowText.title = doing ?? "";

    const rows: [string, Node | string][] = [];
    if (node.flavor.kind === "skill") {
      const trigger = node.flavor.trigger.kind;
      const parent = node.parent === null ? null : this.nodes.get(node.parent) ?? null;
      const parentName = parent?.flavor.kind === "skill" ? parent.flavor.skill : parent?.title ?? "another skill";
      rows.push(["Trigger", trigger === "user" ? "Typed by you" : trigger === "skill" ? `Started by ${parentName}` : "Started by the model"]);
      const runner = this.nodes.get(node.flavor.runner);
      if (runner !== undefined) {
        const link = h("button", { class: "link", text: runner.title, attrs: { type: "button" } });
        link.addEventListener("click", () => this.events.select(runner.id));
        rows.push(["Runner", link]);
      }
    }
    const model = modelOf(node);
    if (model !== null) {
      const requested = prettyModel(node.model.requested);
      const reported = prettyModel(node.model.reported);
      rows.push(["Model", requested !== null && reported !== null && requested !== reported ? `${reported} (asked for ${requested})` : model]);
    }
    if (node.model.effort !== null) rows.push(["Effort", node.model.effort]);
    if (node.startedAt !== null) rows.push(["Started", `${clockTime(node.startedAt)}`]);
    const span = elapsed(node, now);
    if (span !== null) rows.push([node.status.kind === "running" ? "Running for" : "Took", duration(span)]);
    if (node.usage !== null) {
      const input = node.usage.inputTokens ?? 0;
      const output = node.usage.outputTokens ?? 0;
      const cached = node.usage.cachedInputTokens ?? 0;
      rows.push(["Tokens", `${compactNumber(input)} in · ${compactNumber(output)} out${cached > 0 ? ` · ${compactNumber(cached)} cached` : ""}`]);
    }
    const parent = node.parent === null ? undefined : this.nodes.get(node.parent);
    if (parent !== undefined) {
      const link = h("button", { class: "link", text: parent.title, attrs: { type: "button" } });
      link.addEventListener("click", () => this.events.select(parent.id));
      rows.push([node.flavor.kind === "skill" ? "Parent" : "Spawned by", link]);
    }
    const sent = this.links.filter((link) => link.from === node.id).reduce((sum, link) => sum + link.count, 0);
    const received = this.links.filter((link) => link.to === node.id).reduce((sum, link) => sum + link.count, 0);
    if (sent + received > 0) rows.push(["Messages", `${sent} sent · ${received} received`]);
    if (node.cwd !== null) rows.push(["Folder", h("span", { class: "mono", text: shortPath(node.cwd), title: node.cwd })]);
    this.facts.replaceChildren(...rows.flatMap(([term, value]) => [h("dt", { text: term }), h("dd", {}, value)]));

    const children = [...this.nodes.values()].filter((child) => child.parent === node.id)
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id));
    this.steps.replaceChildren(h("h3", { text: "Steps" }), ...children.map((child, index) => {
      const button = h("button", { class: "panel-step", attrs: { type: "button" } },
        h("span", { text: `${index + 1}. ${child.title}` }),
        h("small", { text: `${kindLabel(child)} · ${modelOf(child) ?? "model unknown"} · ${child.status.kind}` }));
      button.addEventListener("click", () => this.events.select(child.id));
      return button;
    }));
    this.steps.hidden = node.flavor.kind !== "skill" || children.length === 0;
    const response = node.result?.kind === "text" ? node.result.body.text : node.result?.kind === "file" ? this.laneText : null;
    const omitted = node.result?.kind === "text" ? node.result.body.omitted : this.laneTruncated ? 1 : 0;
    const responseKey = JSON.stringify([response, omitted]);
    if (responseKey !== this.renderedResponseKey) {
      this.renderedResponseKey = responseKey;
      this.finalResponse.replaceChildren(...(response === null ? [] : [
        h("h3", { text: "Final response" }), markdown(response),
        ...(omitted > 0 ? [h("p", { class: "t-clipped", text: node.result?.kind === "file" ? "Response truncated at 256 KiB" : `${omitted.toLocaleString()} more characters not shown` })] : []),
      ]));
    }
    this.finalResponse.hidden = response === null;
    if (node.result?.kind === "file" && this.resultLoadedFor !== node.id) {
      this.resultLoadedFor = node.id;
      this.laneText = null;
      void fetch(`/api/result?agent=${encodeURIComponent(node.id)}`).then(async (reply) => {
        if (!reply.ok) throw new Error("result unavailable");
        const data = await reply.json() as { text: string; truncated: boolean };
        if (this.agent?.id !== node.id) return;
        this.laneText = data.text;
        this.laneTruncated = data.truncated;
        this.renderHeader(Date.now());
      }).catch(() => {
        if (this.agent?.id !== node.id) return;
        this.resultLoadedFor = null;
        window.setTimeout(() => { if (this.agent?.id === node.id) this.renderHeader(Date.now()); }, 2_000);
      });
    }

    const notes: string[] = [];
    if (node.status.kind === "unknown") notes.push(capitalize(node.status.why));
    if (node.health === "degraded") notes.push("Some records were not recognized.");
    this.note.textContent = notes.join(" ");
    this.note.hidden = notes.length === 0;
  }

  private renderActions(): void {
    const node = this.agent;
    if (node === null) return;
    if (this.cancelPending === node.id && node.status.kind !== "running") this.cancelPending = null;
    const buttons = actionsFor(node).map((action) => {
      const pending = action.id === "cancel" && this.cancelPending === node.id;
      const armed = (this.confirmations.get(action.id) ?? 0) > Date.now();
      const copied = action.id === "copy-resume" && this.copiedAgent === node.id && this.copiedUntil > Date.now();
      const button = h("button", {
        class: "quiet-action",
        text: pending ? "Cancelling…" : copied ? "Copied" : armed ? `Confirm: ${action.confirm}` : action.label,
        attrs: { type: "button" },
      });
      button.disabled = pending;
      button.addEventListener("click", () => {
        if (action.confirm !== null && (this.confirmations.get(action.id) ?? 0) <= Date.now()) {
          this.confirmations.set(action.id, Date.now() + 4_000);
          this.renderActions();
          window.setTimeout(() => this.renderActions(), 4_050);
          return;
        }
        this.confirmations.delete(action.id);
        if (action.id === "copy-resume") void this.copyResume(node);
        else if (action.id === "hide") void this.hideSession(node);
        else void this.cancelLane(node);
      });
      return button;
    });
    this.actionBar.replaceChildren(...buttons);
    this.actionBar.hidden = buttons.length === 0;
  }

  private showActionMessage(message: string): void {
    this.actionMessage.textContent = message;
    this.actionMessage.hidden = message.length === 0;
  }

  private async copyResume(node: AgentNode): Promise<void> {
    const command = resumeCommand(node);
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      if (this.agent?.id !== node.id) return;
      this.showActionMessage("");
      this.copiedAgent = node.id;
      this.copiedUntil = Date.now() + 2_000;
      this.renderActions();
      window.setTimeout(() => this.renderActions(), 2_050);
    } catch {
      if (this.agent?.id === node.id) this.showActionMessage("Could not copy the resume command.");
    }
  }

  /** The server drops the tree from the stream; the page closes the panel once the request is accepted. */
  private async hideSession(node: AgentNode): Promise<void> {
    this.showActionMessage("");
    try {
      const { status, data } = await postJson<ActionResponse>("/api/action", { agent: node.id, action: "hide" });
      if (status === 200 && data.ok) {
        if (this.agent?.id === node.id) this.events.close();
        return;
      }
      if (this.agent?.id === node.id) this.showActionMessage(data.message);
    } catch {
      if (this.agent?.id === node.id) this.showActionMessage("Could not reach the monitor.");
    }
  }

  private async cancelLane(node: AgentNode): Promise<void> {
    this.cancelPending = node.id;
    this.showActionMessage("");
    this.renderActions();
    try {
      const { status, data } = await postJson<ActionResponse>("/api/action", { agent: node.id, action: "cancel" });
      if (status === 200 && data.ok) return;
      this.cancelPending = null;
      if (this.agent?.id === node.id) this.showActionMessage(data.message);
    } catch {
      this.cancelPending = null;
      if (this.agent?.id === node.id) this.showActionMessage("Could not reach the monitor.");
    }
    this.renderActions();
  }

  private renderItems(prepended: boolean): void {
    const node = this.agent;
    if (node === null) return;
    const previousHeight = this.scroller.scrollHeight;
    const sorted = [...this.items.values()].sort(compareItems);
    const calls = new Set<string>();
    const results = new Map<string, ToolResult>();
    for (const item of sorted) if (item.kind === "tool-call") calls.add(item.callId);
    for (const item of sorted) if (item.kind === "tool-result" && calls.has(item.callId)) results.set(item.callId, item);
    const spawned = new Map<string, AgentNode>();
    for (const candidate of this.nodes.values()) {
      if (candidate.parent === node.id && candidate.spawnCall !== null) spawned.set(candidate.spawnCall, candidate);
    }

    const rows: HTMLElement[] = [];
    let unparsed: { count: number; types: Set<string> } | null = null;
    const flushUnparsed = (): void => {
      if (unparsed === null) return;
      const types = [...unparsed.types].join(", ");
      rows.push(row("unparsed", "question", h("p", {
        class: "t-quiet",
        text: `${unparsed.count} unrecognized ${unparsed.count === 1 ? "record" : "records"}${types.length > 0 ? ` (${types})` : ""}`,
      })));
      unparsed = null;
    };
    for (const item of sorted) {
      if (item.kind === "unparsed") {
        unparsed ??= { count: 0, types: new Set() };
        unparsed.count += 1;
        if (item.recordType !== null) unparsed.types.add(item.recordType);
        continue;
      }
      flushUnparsed();
      if (item.kind === "tool-result" && calls.has(item.callId)) continue;
      rows.push(this.renderItem(item, results, spawned));
    }
    flushUnparsed();

    this.list.replaceChildren(...rows);
    this.olderButton.hidden = this.older === null;
    this.emptyNote.hidden = rows.length > 0;
    this.emptyNote.textContent = node.flavor.kind === "lane" && node.flavor.stream === "at-exit"
      ? "The reply arrives when the lane exits."
      : node.flavor.kind === "skill" ? "Activity is recorded in the runner's transcript."
      : "No activity yet.";
    if (prepended) this.scroller.scrollTop += this.scroller.scrollHeight - previousHeight;
  }

  private renderItem(item: TimelineItem, results: ReadonlyMap<string, ToolResult>, spawned: ReadonlyMap<string, AgentNode>): HTMLElement {
    switch (item.kind) {
      case "prompt":
        return row("prompt", "user", head("Prompt", item.at), this.longText(item.id, item.body));
      case "text":
        return row("text", "reply", head("Response", item.at), this.longText(item.id, item.body));
      case "thinking": {
        if (item.body === null) return row("thinking", "thought", head("Thinking", item.at, h("span", { class: "t-quiet", text: "not recorded" })));
        const open = this.expanded.has(item.id);
        const toggle = this.toggle(item.id, "Thinking", item.at, open);
        return row("thinking", "thought", toggle, open ? h("div", {}, h("p", { class: "t-text t-thinking", text: item.body.text }), clippedNote(item.body)) : null);
      }
      case "tool-call":
        return this.toolRow(item, results.get(item.callId) ?? null, spawned.get(item.callId) ?? null);
      case "tool-result": {
        const open = this.expanded.has(item.id);
        return row(
          "tool",
          item.ok === false ? "alert" : "tool",
          this.toggle(item.id, "Result", item.at, open),
          open ? h("div", {}, h("pre", { class: "t-pre", text: item.output.text }), clippedNote(item.output)) : null,
        );
      }
      case "notice":
        return row(item.level === "error" ? "error" : "notice", item.level === "error" ? "alert" : "info", h("p", { class: "t-notice", text: item.text }));
      case "unparsed":
        return row("unparsed", "question", h("p", { class: "t-quiet", text: "unrecognized record" }));
    }
  }

  private toolRow(call: ToolCall, result: ToolResult | null, child: AgentNode | null): HTMLElement {
    const open = this.expanded.has(call.id);
    const state = result === null ? "pending" : result.ok === false ? "error" : "ok";
    const summary = summarizeInput(call.input.text);
    const toggle = h(
      "button",
      { class: "t-toggle t-tool", attrs: { type: "button", "aria-expanded": String(open) } },
      icon(open ? "chevronDown" : "chevronRight", "icon t-chevron"),
      h("span", { class: "t-tool-name", text: call.name }),
      h("span", { class: "t-tool-summary mono", text: summary }),
      h("span", { class: "t-tool-state", attrs: { "data-state": state, "aria-label": state === "pending" ? "running" : state === "error" ? "failed" : "done" } }, icon(state === "pending" ? "spinner" : state === "error" ? "cross" : "check")),
      h("time", { class: "t-time", text: clockTime(call.at), attrs: { datetime: call.at ?? "" } }),
    );
    toggle.addEventListener("click", () => this.flip(call.id));
    const childLink = child === null ? null : (() => {
      const button = h(
        "button",
        { class: "t-child", attrs: { type: "button", "data-status": child.status.kind } },
        icon("agent"),
        h("span", { class: "t-child-title", text: child.title }),
        h("span", { class: "t-child-status", text: statusLine(child, Date.now()) }),
        icon("arrowRight"),
      );
      button.addEventListener("click", () => this.events.select(child.id));
      return button;
    })();
    const details = open
      ? h(
          "div",
          { class: "t-io" },
          h("p", { class: "t-io-label", text: "Input" }),
          h("pre", { class: "t-pre", text: call.input.text }),
          clippedNote(call.input),
          h("p", { class: "t-io-label", text: "Output" }),
          result === null
            ? h("p", { class: "t-quiet", text: "Waiting for output…" })
            : h("pre", { class: "t-pre", attrs: { "data-state": state }, text: result.output.text.length > 0 ? result.output.text : "(empty)" }),
          result === null ? null : clippedNote(result.output),
        )
      : null;
    return row("tool", toolIcon(call.name), toggle, childLink, details);
  }

  private longText(id: string, body: Clipped): HTMLElement {
    const long = body.text.length > CLAMP_CHARS || body.text.split("\n").length > 10;
    const open = this.expanded.has(id);
    const text = h("p", { class: "t-text", text: body.text });
    if (long && !open) text.classList.add("is-clamped");
    const more = long
      ? (() => {
          const button = h("button", { class: "t-more", text: open ? "Show less" : "Show all", attrs: { type: "button" } });
          button.addEventListener("click", () => this.flip(id));
          return button;
        })()
      : null;
    return h("div", {}, text, open ? clippedNote(body) : null, more);
  }

  private toggle(id: string, label: string, at: string | null, open: boolean): HTMLButtonElement {
    const button = h(
      "button",
      { class: "t-toggle", attrs: { type: "button", "aria-expanded": String(open) } },
      icon(open ? "chevronDown" : "chevronRight", "icon t-chevron"),
      h("span", { class: "t-label", text: label }),
      h("time", { class: "t-time", text: clockTime(at), attrs: { datetime: at ?? "" } }),
    );
    button.addEventListener("click", () => this.flip(id));
    return button;
  }

  private flip(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    const top = this.scroller.scrollTop;
    this.renderItems(false);
    this.scroller.scrollTop = top;
  }

  private skeleton(): HTMLElement {
    return h("li", { class: "t-skeleton", attrs: { "aria-hidden": "true" } }, h("span"), h("span"), h("span"));
  }

  private onScroll(): void {
    const distance = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
    this.stuck = distance < STICK_THRESHOLD;
    if (this.stuck) this.jump.hidden = true;
    if (this.scroller.scrollTop < LOAD_OLDER_THRESHOLD) void this.loadOlder();
  }

  private async loadOlder(): Promise<void> {
    const agent = this.agent;
    if (agent === null || this.older === null || this.loadingOlder) return;
    this.loadingOlder = true;
    this.olderButton.textContent = "Loading…";
    try {
      const page = await this.events.loadOlder(agent.id, this.older);
      if (page === null || this.agent?.id !== agent.id) return;
      for (const item of page.items) this.items.set(item.id, item);
      this.older = page.older;
      this.renderItems(true);
    } finally {
      this.loadingOlder = false;
      this.olderButton.textContent = "Load earlier activity";
    }
  }

  private scrollToEnd(smooth: boolean): void {
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    this.stuck = true;
    this.jump.hidden = true;
  }
}

function row(kind: string, iconName: IconName, ...content: (Node | null)[]): HTMLElement {
  return h("li", { class: "t", attrs: { "data-kind": kind } }, h("span", { class: "t-icon" }, icon(iconName)), h("div", { class: "t-body" }, ...content));
}

function head(label: string, at: string | null, extra: Node | null = null): HTMLElement {
  return h(
    "div",
    { class: "t-head" },
    h("span", { class: "t-label", text: label }),
    extra,
    h("time", { class: "t-time", text: clockTime(at), attrs: { datetime: at ?? "" } }),
  );
}

function statusIcon(node: AgentNode): IconName {
  switch (node.status.kind) {
    case "running":
      return "spinner";
    case "idle":
      return "pause";
    case "done":
      return "check";
    case "failed":
      return "cross";
    case "cancelled":
      return "stop";
    case "ended":
      return "dot";
    case "unknown":
      return "question";
  }
}

function elapsed(node: AgentNode, now: number): number | null {
  if (node.startedAt === null) return null;
  const start = Date.parse(node.startedAt);
  const status = node.status;
  const endIso = status.kind === "running"
    ? null
    : ("at" in status && status.at !== null ? status.at : node.lastActivityAt);
  const end = endIso === null ? now : Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
