import type { AgentId, AgentNode, AgentStatus, MessageLink } from "../domain.ts";
import { activityLine, kindLabel, modelOf, quietFor, stalled, statusLine, triggerPhrase } from "../format.ts";
import type { Tree } from "../graph.ts";
import { connector, layout, messageArc, type Bounds, type Layout } from "../layout.ts";
import { applyOffsets, clearOffsets, moveNode, moveSubtree, type Offset } from "../offsets.ts";
import { h, icon, providerIcon, svgElement, type IconName } from "./dom.ts";

// The node canvas: cards for agents, wires for spawn
// links, a model node under each card, and motion that only ever reports work.

const STATUS_ICON: Record<AgentStatus["kind"], IconName> = {
  running: "spinner",
  idle: "pause",
  done: "check",
  failed: "cross",
  cancelled: "stop",
  ended: "dot",
  unknown: "question",
};

function quietness(node: AgentNode, now: number): "stalled" | "quiet" | "no" {
  return stalled(node, now) ? "stalled" : quietFor(node, now) !== null ? "quiet" : "no";
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.75;
const FIT_PADDING = 72;
const READABLE_ZOOM = 0.62;
const MOVE_MS = 360;
const CAMERA_MS = 480;
const MAX_SPARKS = 24;
const TETHER_X = 44;
const TETHER_LENGTH = 22;
const DRAG_THRESHOLD = 4;
const OFFSET_KEY = "psf-monitor.offsets.";

function loadOffsets(root: AgentId): Map<AgentId, Offset> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${OFFSET_KEY}${root}`) ?? "null");
    if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
    return new Map(Object.entries(value).flatMap(([id, offset]) => {
      if (offset === null || typeof offset !== "object" || Array.isArray(offset)) return [];
      const { x, y } = offset as { x?: unknown; y?: unknown };
      return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
        ? [[id as AgentId, { x, y }] as const] : [];
    }));
  } catch { return new Map(); }
}

function storeOffsets(root: AgentId, offsets: ReadonlyMap<AgentId, Offset>): void {
  try {
    if (offsets.size === 0) localStorage.removeItem(`${OFFSET_KEY}${root}`);
    else localStorage.setItem(`${OFFSET_KEY}${root}`, JSON.stringify(Object.fromEntries(offsets)));
  } catch { /* Storage is unavailable; positions last for this page only. */ }
}

interface View {
  readonly card: HTMLButtonElement;
  readonly glyph: HTMLElement;
  readonly title: HTMLElement;
  readonly kind: HTMLElement;
  readonly status: HTMLElement;
  readonly activity: HTMLElement;
  readonly badge: HTMLElement;
  readonly step: HTMLElement;
  satellite: HTMLElement | null;
  tether: SVGGElement | null;
  node: AgentNode;
  x: number;
  y: number;
  width: number;
  height: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

interface Wire {
  readonly base: SVGPathElement;
  readonly glow: SVGPathElement;
  readonly flow: SVGPathElement;
  readonly label: SVGTextElement;
  readonly from: AgentId;
  readonly to: AgentId;
}

interface Talk {
  readonly path: SVGPathElement;
  readonly badge: HTMLElement;
  readonly count: HTMLElement;
  readonly from: AgentId;
  readonly to: AgentId;
}

interface Camera {
  x: number;
  y: number;
  k: number;
}

export interface CanvasEvents {
  select(id: AgentId): void;
  toggleSkills(): void;
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 4);

export class Canvas {
  readonly element: HTMLElement;
  private readonly world: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly tethers: SVGGElement;
  private readonly wiresBase: SVGGElement;
  private readonly wiresFlow: SVGGElement;
  private readonly talkLayer: SVGGElement;
  private readonly sparks: SVGGElement;
  private readonly talks = new Map<string, Talk>();
  private readonly zoomLabel: HTMLElement;
  private readonly followButton: HTMLButtonElement;
  private readonly skillsButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly empty: HTMLElement;
  private readonly views = new Map<AgentId, View>();
  private readonly wires = new Map<string, Wire>();
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private current: Layout | null = null;
  private base: Layout | null = null;
  private tree: Tree | null = null;
  private offsets = new Map<AgentId, Offset>();
  private suppressClick: AgentId | null = null;
  private rootId: AgentId | null = null;
  private selected: AgentId | null = null;
  private camera: Camera = { x: 0, y: 0, k: 1 };
  private moveFrame: number | null = null;
  private cameraFrame: number | null = null;
  private following = true;
  /** Space on the right covered by the detail panel, kept clear when framing. */
  private rightInset = 0;

  constructor(private readonly events: CanvasEvents) {
    const svg = svgElement("svg", { class: "wires", "aria-hidden": "true" });
    const arrow = svgElement("marker", {
      id: "talk-arrow",
      viewBox: "0 0 10 10",
      refX: 8,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
      markerUnits: "userSpaceOnUse",
    });
    arrow.append(svgElement("path", { d: "M 1 1.5 L 9 5 L 1 8.5 Z", class: "talk-arrow" }));
    const defs = svgElement("defs");
    defs.append(arrow);
    this.wiresBase = svgElement("g", { class: "wires-base" });
    this.talkLayer = svgElement("g", { class: "talks" });
    this.wiresFlow = svgElement("g", { class: "wires-flow" });
    this.sparks = svgElement("g", { class: "sparks" });
    svg.append(defs, this.wiresBase, this.talkLayer, this.wiresFlow, this.sparks);
    // Tethers sit above the cards so the model port reads as attached to the card's edge.
    const overlay = svgElement("svg", { class: "wires", "aria-hidden": "true" });
    this.tethers = svgElement("g", { class: "tethers" });
    overlay.append(this.tethers);
    this.cards = h("div", { class: "cards" });
    this.world = h("div", { class: "world" }, svg, this.cards, overlay);
    this.zoomLabel = h("span", { class: "controls-zoom", text: "100%" });
    this.followButton = h(
      "button",
      { class: "control", title: "Follow activity", attrs: { type: "button", "aria-label": "Follow activity", "aria-pressed": "true" } },
      icon("follow"),
    );
    this.followButton.addEventListener("click", () => this.setFollowing(!this.following, true));
    this.skillsButton = h("button", { class: "control control-text", attrs: { type: "button", "aria-pressed": "true" } }, icon("skills"), h("span"));
    this.skillsButton.addEventListener("click", () => this.events.toggleSkills());
    this.setSkillsShown(true);
    this.resetButton = h("button", { class: "control control-text", attrs: { type: "button", hidden: "", title: "Reset layout" } }, icon("reset"), h("span", { text: "Reset layout" }));
    this.resetButton.addEventListener("click", () => this.resetLayout());
    const control = (name: "minus" | "plus" | "fit", label: string, action: () => void): HTMLButtonElement => {
      const button = h("button", { class: "control", title: label, attrs: { type: "button", "aria-label": label } }, icon(name));
      button.addEventListener("click", action);
      return button;
    };
    const controls = h(
      "div",
      { class: "controls", attrs: { role: "toolbar", "aria-label": "Canvas" } },
      control("minus", "Zoom out", () => this.zoomBy(1 / 1.2)),
      this.zoomLabel,
      control("plus", "Zoom in", () => this.zoomBy(1.2)),
      h("span", { class: "controls-rule" }),
      control("fit", "Fit to view", () => this.fit(true)),
      this.followButton,
      h("span", { class: "controls-rule" }),
      this.skillsButton,
      this.resetButton,
    );
    this.empty = h("div", { class: "canvas-empty", attrs: { hidden: "" } });
    this.element = h("div", { class: "viewport", attrs: { tabindex: "0", "aria-label": "Agent graph" } }, this.world, this.empty, controls);
    this.bindPointer();
    this.bindKeys();
    new ResizeObserver(() => {
      if (this.following && this.current !== null) this.fit(false);
    }).observe(this.element);
  }

  setEmpty(content: Node | null): void {
    this.empty.replaceChildren(...(content === null ? [] : [content]));
    this.empty.toggleAttribute("hidden", content === null);
  }

  setSkillsShown(shown: boolean): void {
    const label = shown ? "Skills: shown" : "Skills: hidden";
    this.skillsButton.querySelector("span")!.textContent = label;
    this.skillsButton.title = label;
    this.skillsButton.setAttribute("aria-label", label);
    this.skillsButton.setAttribute("aria-pressed", String(shown));
  }

  /** Puts every card of the current session back where the layout placed it. Reset all calls this for the open session. */
  resetLayout(): void {
    if (this.rootId === null || this.base === null) return;
    this.offsets = clearOffsets();
    storeOffsets(this.rootId, this.offsets);
    this.resetButton.hidden = true;
    this.showOffsets();
  }

  /** `reveal: false` while a drag is still changing the inset, so the camera does not chase it. */
  setRightInset(pixels: number, reveal = true): void {
    this.rightInset = pixels;
    if (reveal && this.selected !== null) this.reveal(this.selected);
  }

  render(tree: Tree | null, selected: AgentId | null, now: number, links: readonly MessageLink[] = []): void {
    this.selected = selected;
    if (tree === null) {
      this.reset();
      this.rootId = null;
      return;
    }
    const fresh = tree.root.id !== this.rootId;
    if (fresh) {
      this.reset();
      this.rootId = tree.root.id;
      this.offsets = loadOffsets(tree.root.id);
      this.following = true;
      this.followButton.setAttribute("aria-pressed", "true");
    }
    this.tree = tree;
    this.base = layout(tree, (node) => node.flavor.kind !== "skill" && modelOf(node) !== null);
    const next = applyOffsets(this.base, this.offsets);
    this.resetButton.hidden = this.offsets.size === 0;
    const seen = new Set<AgentId>();
    let added = false;

    for (const node of tree.nodes) {
      const place = next.placed.get(node.id);
      if (place === undefined) continue;
      seen.add(node.id);
      let view = this.views.get(node.id);
      if (view === undefined) {
        const parent = node.parent === null ? undefined : this.views.get(node.parent);
        // A new agent emerges from its parent's output port.
        const startX = fresh || parent === undefined ? place.x : parent.x + parent.width - 40;
        const startY = fresh || parent === undefined ? place.y : parent.y + (parent.height - place.height) / 2;
        view = this.createView(node, startX, startY, !fresh);
        this.views.set(node.id, view);
        if (!fresh) added = true;
      }
      view.width = place.width;
      view.height = place.height;
      view.fromX = view.x;
      view.fromY = view.y;
      view.toX = place.x;
      view.toY = place.y;
      this.updateView(view, node, now, node.id === selected, tree.step.get(node.id) ?? null);
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      view.card.remove();
      view.satellite?.remove();
      view.tether?.remove();
      this.views.delete(id);
    }

    const liveWires = new Set<string>();
    for (const edge of next.edges) {
      const key = `${edge.from}>${edge.to}`;
      liveWires.add(key);
      let wire = this.wires.get(key);
      if (wire === undefined) {
        wire = this.createWire(edge.from, edge.to, !fresh);
        this.wires.set(key, wire);
      }
      const child = this.views.get(edge.to)?.node;
      const parent = this.views.get(edge.from)?.node;
      const action = child?.flavor.kind === "skill" ? "invoked" : child?.flavor.kind === "lane" ? "launched" : "spawned";
      wire.base.setAttribute("aria-label", `${parent?.title ?? "parent"} ${action} ${child?.title ?? "child"}`);
      wire.label.textContent = child?.flavor.kind === "skill" || parent?.flavor.kind === "skill" ? action : "";
      const state = child === undefined ? "idle" : wireState(child);
      wire.base.dataset.state = state;
      wire.flow.dataset.state = state;
      wire.glow.dataset.state = state;
    }
    for (const [key, wire] of this.wires) {
      if (liveWires.has(key)) continue;
      wire.base.remove();
      wire.flow.remove();
      wire.glow.remove();
      wire.label.remove();
      this.wires.delete(key);
    }

    const liveTalks = new Set<string>();
    for (const link of links) {
      const from = this.views.get(link.from);
      const to = this.views.get(link.to);
      if (from === undefined || to === undefined) continue;
      const key = `${link.from}>${link.to}`;
      liveTalks.add(key);
      let talk = this.talks.get(key);
      if (talk === undefined) {
        talk = this.createTalk(link.from, link.to);
        this.talks.set(key, talk);
      }
      talk.count.textContent = String(link.count);
      const label = `${link.count} ${link.count === 1 ? "message" : "messages"} from ${from.node.title} to ${to.node.title}`;
      talk.badge.title = label;
      talk.badge.setAttribute("aria-label", label);
    }
    for (const [key, talk] of this.talks) {
      if (liveTalks.has(key)) continue;
      talk.path.remove();
      talk.badge.remove();
      this.talks.delete(key);
    }

    this.current = next;
    this.animateMoves(fresh || this.reducedMotion.matches);
    if (fresh) this.fit(false);
    else if (added && this.following) this.fitIfOverflowing();
  }

  /** Refreshes the time-dependent status lines without touching layout. */
  tick(now: number): void {
    for (const view of this.views.values()) {
      if (view.node.status.kind === "running" || view.node.status.kind === "idle") {
        view.status.textContent = statusLine(view.node, now);
        view.card.dataset.quiet = quietness(view.node, now);
      }
    }
  }

  /** One spark travels the wire into the agent that just did something. */
  pulse(id: AgentId): void {
    const view = this.views.get(id);
    if (view === undefined) return;
    view.card.classList.remove("is-pulsing");
    void view.card.offsetWidth;
    view.card.classList.add("is-pulsing");
    const parent = view.node.parent;
    const wire = parent === null ? undefined : this.wires.get(`${parent}>${id}`);
    if (wire !== undefined) this.spark(wire.base, "spark");
  }

  /** A message travels its arc from sender to recipient. */
  pulseMessage(from: AgentId, to: AgentId): void {
    const talk = this.talks.get(`${from}>${to}`);
    if (talk === undefined) return;
    talk.badge.classList.remove("is-pulsing");
    void talk.badge.offsetWidth;
    talk.badge.classList.add("is-pulsing");
    this.spark(talk.path, "spark spark-talk");
  }

  private spark(path: SVGPathElement, className: string): void {
    if (this.reducedMotion.matches || document.hidden || this.sparks.childElementCount >= MAX_SPARKS) return;
    const spark = svgElement("circle", { r: 3.5, class: className });
    const motion = svgElement("animateMotion", {
      dur: "0.85s",
      fill: "freeze",
      path: path.getAttribute("d") ?? "",
      calcMode: "spline",
      keyPoints: "0;1",
      keyTimes: "0;1",
      keySplines: "0.3 0 0.2 1",
    });
    spark.append(motion);
    this.sparks.append(spark);
    motion.beginElement();
    window.setTimeout(() => spark.remove(), 900);
  }

  /** Pans so an agent sits inside the visible area, unless it already does. */
  reveal(id: AgentId): void {
    const view = this.views.get(id);
    if (view === undefined) return;
    const { width, height } = this.visibleSize();
    const left = view.x * this.camera.k + this.camera.x;
    const top = view.y * this.camera.k + this.camera.y;
    const right = left + view.width * this.camera.k;
    const bottom = top + view.height * this.camera.k;
    const margin = 48;
    if (left >= margin && top >= margin && right <= width - margin && bottom <= height - margin) return;
    const target = {
      k: this.camera.k,
      x: width / 2 - (view.x + view.width / 2) * this.camera.k,
      y: height / 2 - (view.y + view.height / 2) * this.camera.k,
    };
    this.moveCamera(target, true);
  }

  fit(animated: boolean): void {
    if (this.current === null) return;
    this.moveCamera(this.framing(this.current.bounds), animated && !this.reducedMotion.matches);
  }

  zoomBy(factor: number, origin?: { x: number; y: number }): void {
    const { width, height } = this.visibleSize();
    const point = origin ?? { x: width / 2, y: height / 2 };
    const k = clamp(this.camera.k * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = k / this.camera.k;
    this.moveCamera({ k, x: point.x - (point.x - this.camera.x) * ratio, y: point.y - (point.y - this.camera.y) * ratio }, false);
  }

  private setFollowing(value: boolean, refit: boolean): void {
    this.following = value;
    this.followButton.setAttribute("aria-pressed", String(value));
    if (value && refit) this.fit(true);
  }

  private fitIfOverflowing(): void {
    if (this.current === null) return;
    const bounds = this.current.bounds;
    const { width, height } = this.visibleSize();
    const left = bounds.x * this.camera.k + this.camera.x;
    const top = bounds.y * this.camera.k + this.camera.y;
    const right = left + bounds.width * this.camera.k;
    const bottom = top + bounds.height * this.camera.k;
    if (left < 0 || top < 0 || right > width || bottom > height) this.fit(true);
  }

  private visibleSize(): { width: number; height: number } {
    return { width: Math.max(1, this.element.clientWidth - this.rightInset), height: Math.max(1, this.element.clientHeight) };
  }

  private framing(bounds: Bounds): Camera {
    const { width, height } = this.visibleSize();
    const padding = width < 600 ? 20 : FIT_PADDING;
    const fitted = clamp(
      Math.min(1, (width - padding * 2) / Math.max(1, bounds.width), (height - padding * 2) / Math.max(1, bounds.height)),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    // On a phone a whole tree shrinks past legibility; keep cards readable, anchor on the root, and let the user pan.
    const k = width < 600 ? Math.max(fitted, READABLE_ZOOM) : fitted;
    const root = this.rootId === null ? undefined : this.views.get(this.rootId);
    if (k > fitted && root !== undefined) {
      return { k, x: padding - root.toX * k, y: height / 2 - (root.toY + root.height / 2) * k };
    }
    return {
      k,
      x: (width - bounds.width * k) / 2 - bounds.x * k,
      y: (height - bounds.height * k) / 2 - bounds.y * k,
    };
  }

  private moveCamera(target: Camera, animated: boolean): void {
    if (this.cameraFrame !== null) cancelAnimationFrame(this.cameraFrame);
    this.cameraFrame = null;
    if (!animated) {
      this.camera = target;
      this.applyCamera();
      return;
    }
    const start = { ...this.camera };
    const began = performance.now();
    const step = (time: number): void => {
      const t = Math.min(1, (time - began) / CAMERA_MS);
      const e = easeOut(t);
      this.camera = {
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
        k: start.k + (target.k - start.k) * e,
      };
      this.applyCamera();
      this.cameraFrame = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.cameraFrame = requestAnimationFrame(step);
  }

  private applyCamera(): void {
    const { x, y, k } = this.camera;
    this.world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
    this.element.style.setProperty("--grid-size", `${22 * k}px`);
    this.element.style.setProperty("--grid-x", `${x}px`);
    this.element.style.setProperty("--grid-y", `${y}px`);
    this.zoomLabel.textContent = `${Math.round(k * 100)}%`;
  }

  private animateMoves(immediate: boolean): void {
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
    const moving = [...this.views.values()].some((view) => view.fromX !== view.toX || view.fromY !== view.toY);
    if (immediate || !moving) {
      for (const view of this.views.values()) {
        view.x = view.toX;
        view.y = view.toY;
      }
      this.drawPositions();
      return;
    }
    const began = performance.now();
    const step = (time: number): void => {
      const t = Math.min(1, (time - began) / MOVE_MS);
      const e = easeOut(t);
      for (const view of this.views.values()) {
        view.x = view.fromX + (view.toX - view.fromX) * e;
        view.y = view.fromY + (view.toY - view.fromY) * e;
      }
      this.drawPositions();
      this.moveFrame = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.moveFrame = requestAnimationFrame(step);
  }

  private drawPositions(): void {
    for (const view of this.views.values()) {
      view.card.style.transform = `translate3d(${view.x}px, ${view.y}px, 0)`;
      if (view.satellite !== null && view.tether !== null) {
        const top = view.y + view.height;
        const x = view.x + TETHER_X;
        view.satellite.style.transform = `translate3d(${x - 48}px, ${top + TETHER_LENGTH}px, 0)`;
        const [line, port] = view.tether.children;
        line?.setAttribute("d", `M ${x} ${top + 4.5} V ${top + TETHER_LENGTH}`);
        port?.setAttribute("d", `M ${x} ${top - 4.5} l 4.5 4.5 l -4.5 4.5 l -4.5 -4.5 Z`);
      }
    }
    for (const wire of this.wires.values()) {
      const from = this.views.get(wire.from);
      const to = this.views.get(wire.to);
      if (from === undefined || to === undefined) continue;
      const d = connector(from, to);
      wire.base.setAttribute("d", d);
      wire.flow.setAttribute("d", d);
      wire.glow.setAttribute("d", d);
      wire.label.setAttribute("x", String((from.x + from.width + to.x) / 2));
      wire.label.setAttribute("y", String((from.y + from.height / 2 + to.y + to.height / 2) / 2 - 8));
    }
    for (const talk of this.talks.values()) {
      const from = this.views.get(talk.from);
      const to = this.views.get(talk.to);
      if (from === undefined || to === undefined) continue;
      const arc = messageArc(from, to);
      talk.path.setAttribute("d", arc.d);
      talk.badge.style.transform = `translate3d(${arc.midX}px, ${arc.midY}px, 0)`;
    }
  }

  private createTalk(from: AgentId, to: AgentId): Talk {
    const path = svgElement("path", { class: "talk", "marker-end": "url(#talk-arrow)" });
    this.talkLayer.append(path);
    const count = h("span", { class: "talk-count" });
    const badge = h("span", { class: "talk-badge", attrs: { role: "img" } }, icon("reply"), count);
    this.cards.append(badge);
    return { path, badge, count, from, to };
  }

  private createView(node: AgentNode, x: number, y: number, entering: boolean): View {
    const glyph = h("span", { class: "card-glyph" });
    const title = h("span", { class: "card-title" });
    const kind = h("span", { class: "card-kind" });
    const status = h("span", { class: "card-status" });
    const activity = h("span", { class: "card-activity" });
    const badge = h("span", { class: "card-badge", attrs: { "aria-hidden": "true" } });
    const step = h("span", { class: "skill-step", attrs: { "aria-hidden": "true" } });
    const card = h(
      "button",
      { class: "card", attrs: { type: "button" } },
      h("span", { class: "card-ring", attrs: { "aria-hidden": "true" } }),
      h("span", { class: "port port-in", attrs: { "aria-hidden": "true" } }),
      glyph,
      h("span", { class: "card-text" }, title, h("span", { class: "card-meta" }, kind, h("span", { class: "card-sep", text: "·" }), status), activity),
      step,
      badge,
      h("span", { class: "port port-out", attrs: { "aria-hidden": "true" } }),
    );
    card.addEventListener("click", (event) => {
      if (this.suppressClick === node.id) { this.suppressClick = null; event.preventDefault(); return; }
      this.events.select(node.id);
    });
    if (entering && !this.reducedMotion.matches) card.classList.add("is-entering");
    this.cards.append(card);
    return {
      card,
      glyph,
      title,
      kind,
      status,
      activity,
      badge,
      step,
      satellite: null,
      tether: null,
      node,
      x,
      y,
      width: 0,
      height: 0,
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
    };
  }

  private updateView(view: View, node: AgentNode, now: number, selected: boolean, step: number | null): void {
    const previous = view.node;
    view.node = node;
    const card = view.card;
    const status = node.status;
    card.dataset.status = status.kind;
    card.dataset.kind = node.flavor.kind;
    card.dataset.provider = node.model.provider;
    card.dataset.harness = node.harness;
    card.dataset.health = node.health;
    card.dataset.attention = String(status.kind === "idle" && status.detail !== null);
    card.dataset.evidence = status.kind === "running" || status.kind === "idle" ? status.evidence : "";
    card.dataset.quiet = quietness(node, now);
    card.dataset.pending = String(node.pending !== null);
    card.setAttribute("aria-pressed", String(selected));
    view.title.textContent = node.title;
    view.step.textContent = step === null ? "" : String(step);
    view.step.hidden = node.flavor.kind !== "skill";
    // The root's glyph already names the harness; its card needs only a short label.
    view.kind.textContent = node.flavor.kind === "skill" ? [node.flavor.trigger.kind === "skill" ? null : triggerPhrase(node.flavor.trigger.kind), modelOf(node)].filter((part) => part !== null).join(" · ") : node.flavor.kind === "session" ? (node.harness === "claude" ? "Claude Code" : "Codex") : kindLabel(node);
    view.status.textContent = statusLine(node, now);
    const doing = activityLine(node);
    view.activity.textContent = doing ?? "";
    view.activity.hidden = doing === null;
    card.setAttribute("aria-label", `${node.title}, ${kindLabel(node)}, ${statusLine(node, now)}`);
    card.title = node.title;
    const glyphName = node.flavor.kind === "skill" ? "file" : node.flavor.kind === "session" ? providerIcon(node.harness) : providerIcon(node.model.provider);
    if (view.glyph.dataset.icon !== glyphName) {
      view.glyph.dataset.icon = glyphName;
      view.glyph.replaceChildren(icon(glyphName));
    }
    if (previous.status.kind !== status.kind || view.badge.childElementCount === 0) {
      view.badge.replaceChildren(icon(STATUS_ICON[status.kind]));
    }
    this.updateSatellite(view, node);
  }

  private updateSatellite(view: View, node: AgentNode): void {
    const model = modelOf(node);
    if (model === null) {
      view.satellite?.remove();
      view.tether?.remove();
      view.satellite = null;
      view.tether = null;
      return;
    }
    if (view.satellite === null || view.tether === null) {
      view.tether = svgElement("g");
      view.tether.append(svgElement("path", { class: "tether" }), svgElement("path", { class: "tether-port" }));
      this.tethers.append(view.tether);
      view.satellite = h(
        "div",
        { class: "satellite", attrs: { "aria-hidden": "true" } },
        h("span", { class: "satellite-orb" }),
        h("span", { class: "satellite-label" }),
      );
      this.cards.append(view.satellite);
    }
    view.satellite.dataset.provider = node.model.provider;
    const orb = view.satellite.firstElementChild as HTMLElement;
    const glyphName = providerIcon(node.model.provider);
    if (orb.dataset.icon !== glyphName) {
      orb.dataset.icon = glyphName;
      orb.replaceChildren(icon(glyphName));
    }
    const label = view.satellite.lastElementChild as HTMLElement;
    label.textContent = node.model.effort === null ? model : `${model} · ${node.model.effort}`;
  }

  private createWire(from: AgentId, to: AgentId, entering: boolean): Wire {
    const glow = svgElement("path", { class: "wire-glow" });
    const base = svgElement("path", { class: "wire" });
    const flow = svgElement("path", { class: "wire-flow" });
    const label = svgElement("text", { class: "wire-label", "text-anchor": "middle" });
    this.wiresBase.append(glow, base, label);
    this.wiresFlow.append(flow);
    if (entering && !this.reducedMotion.matches) {
      base.classList.add("is-drawing");
      base.addEventListener("animationend", () => base.classList.remove("is-drawing"), { once: true });
    }
    return { base, glow, flow, label, from, to };
  }

  private reset(): void {
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
    this.cards.replaceChildren();
    this.wiresBase.replaceChildren();
    this.wiresFlow.replaceChildren();
    this.talkLayer.replaceChildren();
    this.tethers.replaceChildren();
    this.sparks.replaceChildren();
    this.views.clear();
    this.wires.clear();
    this.talks.clear();
    this.current = null;
    this.base = null;
    this.tree = null;
    this.resetButton.hidden = true;
  }

  private showOffsets(): void {
    if (this.base === null) return;
    this.current = applyOffsets(this.base, this.offsets);
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
    for (const [id, place] of this.current.placed) {
      const view = this.views.get(id);
      if (view === undefined) continue;
      view.x = view.fromX = view.toX = place.x;
      view.y = view.fromY = view.toY = place.y;
    }
    this.drawPositions();
  }

  private bindPointer(): void {
    let drag: { id: number; x: number; y: number; cx: number; cy: number } | null = null;
    let cardDrag: { pointer: number; id: AgentId; card: HTMLButtonElement; x: number; y: number; lastX: number; lastY: number; subtree: boolean; moved: boolean } | null = null;
    this.element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const card = (event.target as Element).closest<HTMLButtonElement>(".card");
      if (card !== null) {
        const entry = [...this.views.values()].find((view) => view.card === card);
        if (entry === undefined) return;
        this.suppressClick = null;
        cardDrag = { pointer: event.pointerId, id: entry.node.id, card, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, subtree: event.shiftKey, moved: false };
        card.setPointerCapture(event.pointerId);
        return;
      }
      if ((event.target as Element).closest(".controls") !== null) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, cx: this.camera.x, cy: this.camera.y };
      this.element.setPointerCapture(event.pointerId);
      this.element.classList.add("is-panning");
    });
    this.element.addEventListener("pointermove", (event) => {
      if (cardDrag !== null && cardDrag.pointer === event.pointerId) {
        if (!cardDrag.moved && Math.hypot(event.clientX - cardDrag.x, event.clientY - cardDrag.y) >= DRAG_THRESHOLD) {
          cardDrag.moved = true;
          cardDrag.card.classList.add("is-dragging");
          this.setFollowing(false, false);
        }
        if (cardDrag.moved) {
          const dx = (event.clientX - cardDrag.lastX) / this.camera.k;
          const dy = (event.clientY - cardDrag.lastY) / this.camera.k;
          if (this.tree !== null) this.offsets = cardDrag.subtree
            ? moveSubtree(this.offsets, this.tree, cardDrag.id, dx, dy)
            : moveNode(this.offsets, cardDrag.id, dx, dy);
          this.showOffsets();
          this.resetButton.hidden = this.offsets.size === 0;
          cardDrag.lastX = event.clientX;
          cardDrag.lastY = event.clientY;
        }
        return;
      }
      if (drag === null || drag.id !== event.pointerId) return;
      this.setFollowing(false, false);
      this.moveCamera({ k: this.camera.k, x: drag.cx + event.clientX - drag.x, y: drag.cy + event.clientY - drag.y }, false);
    });
    const end = (event: PointerEvent): void => {
      if (cardDrag !== null && cardDrag.pointer === event.pointerId) {
        cardDrag.card.classList.remove("is-dragging");
        if (cardDrag.moved) {
          this.suppressClick = cardDrag.id;
          if (this.rootId !== null) storeOffsets(this.rootId, this.offsets);
        }
        cardDrag = null;
        return;
      }
      if (drag === null || drag.id !== event.pointerId) return;
      drag = null;
      this.element.classList.remove("is-panning");
    };
    this.element.addEventListener("pointerup", end);
    this.element.addEventListener("pointercancel", end);
    this.element.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.setFollowing(false, false);
        const rect = this.element.getBoundingClientRect();
        if (event.ctrlKey || event.metaKey) {
          this.zoomBy(Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        } else {
          this.moveCamera({ k: this.camera.k, x: this.camera.x - event.deltaX, y: this.camera.y - event.deltaY }, false);
        }
      },
      { passive: false },
    );
  }

  private bindKeys(): void {
    this.element.addEventListener("keydown", (event) => {
      if (event.target !== this.element) return;
      const pan = 64;
      const moves: Record<string, () => void> = {
        "+": () => this.zoomBy(1.2),
        "=": () => this.zoomBy(1.2),
        "-": () => this.zoomBy(1 / 1.2),
        f: () => this.setFollowing(true, true),
        ArrowLeft: () => this.moveCamera({ ...this.camera, x: this.camera.x + pan }, false),
        ArrowRight: () => this.moveCamera({ ...this.camera, x: this.camera.x - pan }, false),
        ArrowUp: () => this.moveCamera({ ...this.camera, y: this.camera.y + pan }, false),
        ArrowDown: () => this.moveCamera({ ...this.camera, y: this.camera.y - pan }, false),
      };
      const move = moves[event.key];
      if (move === undefined) return;
      event.preventDefault();
      move();
    });
  }
}

function wireState(child: AgentNode): string {
  switch (child.status.kind) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
