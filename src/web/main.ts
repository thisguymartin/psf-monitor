import type { AgentId, AgentNode, Harness, MessageLink, SourceKind } from "../domain.ts";
import { compactNumber, shortPath, working } from "../format.ts";
import { countsOf, isLive, rootOf, rootsOf, treeOf, withoutSkills } from "../graph.ts";
import type { Delta, JournalResponse, ServerInfo, Snapshot, SourceHealth, TimelineAppend, TimelinePage } from "../wire.ts";
import { Canvas } from "./canvas.ts";
import { postJson } from "./commands.ts";
import { h, icon, logo } from "./dom.ts";
import { Panel, PANEL_MIN } from "./panel.ts";
import { Rail, type Descendants } from "./rail.ts";

// The page controller: one event stream, one state,
// and a render that every view reads from.

const SOURCE_NAME: Record<SourceKind, string> = {
  "claude-session": "Claude Code",
  "codex-rollout": "Codex",
  "runner-lane": "pstack lanes",
};

const RETRY_MS = 3_000;
/** Canvas kept visible beside the panel; narrower than this and the panel overlays it. */
const CANVAS_MIN = 360;
const PANEL_GUTTER = 240;
const SKILLS_KEY = "psf-monitor.skills-shown";

function storedSkillsShown(): boolean {
  try { return localStorage.getItem(SKILLS_KEY) !== "false"; }
  catch { return true; }
}

function storeSkillsShown(shown: boolean): void {
  try { localStorage.setItem(SKILLS_KEY, String(shown)); }
  catch { /* Storage is unavailable; the choice lasts for this page only. */ }
}

type Connection = "connecting" | "live" | "retrying" | "expired" | "stopped";

interface State {
  nodes: Map<AgentId, AgentNode>;
  links: readonly MessageLink[];
  health: readonly SourceHealth[];
  server: ServerInfo | null;
  session: AgentId | null;
  agent: AgentId | null;
  connection: Connection;
  dismissed: string;
}

const params = new URLSearchParams(location.search);
const defaultHarness: Harness = params.get("harness") === "codex" ? "codex" : "claude";
let pendingFocus = params.get("focus") as AgentId | null;

const state: State = {
  nodes: new Map(),
  links: [],
  health: [],
  server: null,
  session: null,
  agent: null,
  connection: "connecting",
  dismissed: "",
};

let skillsShown = storedSkillsShown();

const canvas = new Canvas({ select: (id) => selectAgent(id), toggleSkills: () => {
  skillsShown = !skillsShown;
  storeSkillsShown(skillsShown);
  canvas.setSkillsShown(skillsShown);
  if (state.session !== null && !visibleNodes().has(state.session)) state.session = chooseSession();
  if (!skillsShown && state.agent !== null && state.nodes.get(state.agent)?.flavor.kind === "skill") selectAgent(null);
  else render();
} });
canvas.setSkillsShown(skillsShown);
const panel = new Panel({
  close: () => selectAgent(null),
  select: (id) => selectAgent(id),
  loadOlder: (agent, before) => fetchTimeline(agent, before),
  resized: (width, settled) => canvas.setRightInset(insetFor(width), settled),
});
const rail = new Rail({ select: (root) => selectSession(root) });

const sessionTitle = h("h1", { class: "bar-title" });
const sessionPath = h("span", { class: "bar-path mono" });
const stats = h("div", { class: "bar-stats", attrs: { "aria-label": "This session" } });
const liveText = h("span", { class: "live-text" });
const live = h("div", { class: "live", attrs: { role: "status" } }, h("span", { class: "live-dot", attrs: { "aria-hidden": "true" } }), liveText);
const railToggle = h("button", { class: "icon-button rail-toggle", title: "Sessions", attrs: { type: "button", "aria-label": "Show sessions" } }, icon("sessions"));
railToggle.addEventListener("click", () => toggleRail());
const banner = h("div", { class: "banner", attrs: { hidden: "", role: "note" } });
const journalButton = h("button", { class: "quiet-action", attrs: { type: "button" } });
const stopButton = h("button", { class: "quiet-action", attrs: { type: "button" } }, icon("stop"), h("span", { text: "Stop monitor" }));
const controlMessage = h("span", { class: "bar-command-message", attrs: { role: "status", hidden: "" } });
const barControls = h("div", { class: "bar-controls" }, journalButton, stopButton, controlMessage);

const bar = h(
  "header",
  { class: "bar" },
  railToggle,
  h("div", { class: "brand" }, logo(), h("span", { class: "brand-name", text: "psf-monitor" })),
  h("div", { class: "bar-session" }, sessionTitle, sessionPath),
  stats,
  barControls,
  live,
);

let journalConfirmUntil = 0;
let stopConfirmUntil = 0;
let journalPending = false;
let stopPending = false;

function renderControls(): void {
  const journal = state.server?.journal === true;
  const journalArmed = journal && journalConfirmUntil > Date.now();
  journalButton.replaceChildren(icon("lane"), h("span", { text: state.server === null ? "Journal…" : journalPending ? "Updating…" : journalArmed ? "Confirm: Delete recorded lanes?" : `Journal: ${journal ? "on" : "off"}` }));
  journalButton.title = journal ? "Turn off lane journal and delete its records" : "Turn on lane journal";
  journalButton.disabled = state.server === null || journalPending || state.connection === "stopped";
  stopButton.replaceChildren(icon("stop"), h("span", { text: stopPending ? "Stopping…" : stopConfirmUntil > Date.now() ? "Confirm: Stop monitor?" : "Stop monitor" }));
  stopButton.disabled = state.server === null || stopPending || state.connection === "stopped";
}

function controlError(message: string): void {
  controlMessage.textContent = message;
  controlMessage.hidden = message.length === 0;
}

journalButton.addEventListener("click", () => {
  if (state.server?.journal === true && journalConfirmUntil <= Date.now()) {
    journalConfirmUntil = Date.now() + 4_000;
    renderControls();
    window.setTimeout(renderControls, 4_050);
    return;
  }
  journalConfirmUntil = 0;
  journalPending = true;
  controlError("");
  renderControls();
  void (async () => {
    try {
      const { status, data } = await postJson<JournalResponse>("/api/journal", { on: state.server?.journal !== true });
      if (status !== 200 || !data.ok) controlError(data.message);
      else if (state.server !== null) state.server = { ...state.server, journal: data.journal };
    } catch {
      controlError("Could not reach the monitor.");
    }
    journalPending = false;
    renderControls();
  })();
});

stopButton.addEventListener("click", () => {
  if (stopConfirmUntil <= Date.now()) {
    stopConfirmUntil = Date.now() + 4_000;
    renderControls();
    window.setTimeout(renderControls, 4_050);
    return;
  }
  stopConfirmUntil = 0;
  stopPending = true;
  controlError("");
  renderControls();
  void (async () => {
    try {
      const { status, data } = await postJson<{ ok: boolean; message?: string }>("/api/stop", {});
      if (status !== 200 || !data.ok) controlError(data.message ?? "Could not stop the monitor.");
      else {
        source?.close();
        source = null;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = null;
        state.nodes = new Map();
        state.links = [];
        state.session = null;
        state.agent = null;
        panel.close();
        setConnection("stopped");
      }
    } catch {
      controlError("Could not reach the monitor.");
    }
    stopPending = false;
    renderControls();
  })();
});

const stage = h("main", { class: "stage" }, canvas.element, banner, panel.element);
const scrim = h("div", { class: "scrim", attrs: { "aria-hidden": "true" } });
scrim.addEventListener("click", () => toggleRail(false));
document.body.append(bar, rail.element, stage, scrim);
document.documentElement.dataset.harness = defaultHarness;

// --- data ------------------------------------------------------------------

let source: EventSource | null = null;
let retryTimer: number | null = null;

function visibleNodes(): ReadonlyMap<AgentId, AgentNode> {
  return skillsShown ? state.nodes : withoutSkills(state.nodes);
}

function connect(): void {
  if (state.connection === "stopped") return;
  source?.close();
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  const url = state.agent === null ? "/api/events" : `/api/events?watch=${encodeURIComponent(state.agent)}`;
  const stream = new EventSource(url);
  source = stream;
  stream.addEventListener("open", () => setConnection("live"));
  stream.addEventListener("snapshot", (event) => onSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot));
  stream.addEventListener("delta", (event) => onDelta(JSON.parse((event as MessageEvent<string>).data) as Delta));
  stream.addEventListener("timeline", (event) => panel.setPage(JSON.parse((event as MessageEvent<string>).data) as TimelinePage));
  stream.addEventListener("append", (event) => {
    const data = JSON.parse((event as MessageEvent<string>).data) as TimelineAppend;
    panel.append(data.agent, data.items);
  });
  stream.addEventListener("error", () => {
    if (stream !== source) return;
    if (stream.readyState === EventSource.CLOSED) void diagnoseClosed();
    else setConnection("retrying");
  });
}

// A closed stream is either a server that restarted with a new token or one that is down.
async function diagnoseClosed(): Promise<void> {
  if (state.connection === "stopped") return;
  try {
    const response = await fetch("/api/snapshot");
    if (response.status === 401) {
      setConnection("expired");
      return;
    }
  } catch {
    // The server is down; keep trying.
  }
  setConnection("retrying");
  retryTimer = window.setTimeout(connect, RETRY_MS);
}

async function fetchTimeline(agent: AgentId, before: number): Promise<TimelinePage | null> {
  try {
    const response = await fetch(`/api/timeline?agent=${encodeURIComponent(agent)}&before=${before}`);
    return response.ok ? ((await response.json()) as TimelinePage) : null;
  } catch {
    return null;
  }
}

function onSnapshot(snapshot: Snapshot): void {
  state.nodes = new Map(snapshot.agents.map((node) => [node.id, node]));
  state.links = snapshot.links;
  state.health = snapshot.health;
  state.server = snapshot.server;
  const shown = visibleNodes();
  if (state.session === null || !shown.has(state.session)) state.session = chooseSession();
  if (state.agent !== null && !shown.has(state.agent)) state.agent = null;
  setConnection("live");
  render();
}

function onDelta(delta: Delta): void {
  const pulses: AgentId[] = [];
  for (const node of delta.upserts) {
    const previous = state.nodes.get(node.id);
    if (previous !== undefined && node.activity !== null && (previous.activity?.at !== node.activity.at || previous.activity?.snippet !== node.activity.snippet)) {
      pulses.push(node.id);
    }
    state.nodes.set(node.id, node);
  }
  const talks: MessageLink[] = [];
  if (delta.links !== null) {
    const before = new Map(state.links.map((link) => [`${link.from}>${link.to}`, link.count]));
    for (const link of delta.links) {
      if (link.count > (before.get(`${link.from}>${link.to}`) ?? 0)) talks.push(link);
    }
    state.links = delta.links;
  }
  if (delta.health !== null) state.health = delta.health;
  if (state.server !== null) state.server = { ...state.server, indexing: delta.indexing, journal: delta.journal };
  if (state.session === null || !visibleNodes().has(state.session)) state.session = chooseSession();
  render();
  for (const id of pulses) canvas.pulse(id);
  for (const link of talks) canvas.pulseMessage(link.from, link.to);
}

function chooseSession(): AgentId | null {
  const shown = visibleNodes();
  if (pendingFocus !== null) {
    const focus = pendingFocus;
    if (state.nodes.has(focus)) {
      const root = rootOf(focus, state.nodes);
      pendingFocus = null;
      if (shown.has(root)) return root;
    }
  }
  const now = Date.now();
  const roots = rootsOf(shown, now);
  return (roots.find((root) => isLive(root, now)) ?? roots[0])?.id ?? null;
}

// --- selection -------------------------------------------------------------

function selectSession(root: AgentId): void {
  toggleRail(false);
  if (state.session === root) return;
  state.session = root;
  if (state.agent !== null) {
    state.agent = null;
    panel.close();
    canvas.setRightInset(0);
  }
  render();
}

function selectAgent(id: AgentId | null): void {
  if (id === state.agent) return;
  const shown = visibleNodes();
  if (id !== null && !shown.has(id)) return;
  state.agent = id;
  if (id === null) {
    panel.close();
    canvas.setRightInset(0);
    render();
    connect();
    return;
  }
  const node = shown.get(id);
  if (node === undefined) return;
  const root = rootOf(id, shown);
  if (root !== state.session) state.session = root;
  panel.open(node, shown, Date.now());
  render();
  canvas.setRightInset(insetFor(panel.width));
  canvas.reveal(id);
  // The stream carries the watched agent's timeline, so a new selection reconnects.
  connect();
}

/** The panel overlays the canvas when keeping both side by side would leave the canvas too narrow. */
function insetFor(width: number): number {
  return stage.clientWidth - width >= CANVAS_MIN ? width : 0;
}

function fitPanel(): void {
  panel.setMaxWidth(Math.max(PANEL_MIN, stage.clientWidth - PANEL_GUTTER));
  canvas.setRightInset(state.agent === null ? 0 : insetFor(panel.width), false);
}

function toggleRail(open?: boolean): void {
  const next = open ?? document.body.dataset.rail !== "open";
  document.body.dataset.rail = next ? "open" : "closed";
  railToggle.setAttribute("aria-expanded", String(next));
}

// --- rendering -------------------------------------------------------------

function render(): void {
  const now = Date.now();
  const all = state.nodes;
  const shown = visibleNodes();
  const roots = rootsOf(shown, now);
  const descendants = new Map<AgentId, Descendants>();
  for (const node of all.values()) {
    const root = rootOf(node.id, all);
    if (root === node.id) continue;
    const entry = descendants.get(root) ?? { total: 0, skills: 0, running: 0 };
    descendants.set(root, { total: entry.total + (node.flavor.kind === "skill" ? 0 : 1), skills: entry.skills + (node.flavor.kind === "skill" ? 1 : 0), running: entry.running + (node.flavor.kind !== "skill" && working(node, now) ? 1 : 0) });
  }
  const hours = state.server?.windowHours ?? 24;
  rail.render(roots, descendants, state.session, now, `Last ${hours} hours`);

  const tree = state.session === null ? null : treeOf(state.session, shown);
  const fullTree = state.session === null ? null : treeOf(state.session, all);
  canvas.render(tree, state.agent, now, state.links);
  document.documentElement.dataset.harness = tree?.root.harness ?? defaultHarness;

  if (state.connection === "stopped") {
    canvas.setEmpty(h("div", { class: "empty" }, logo(), h("h2", { text: "Monitor stopped" }), h("p", {}, "Run ", h("code", { text: "psf-monitor start" }), " to start it again.")));
  } else if (state.connection === "expired") {
    canvas.setEmpty(
      h(
        "div",
        { class: "empty" },
        logo(),
        h("h2", { text: "Link expired" }),
        h("p", {}, "Run ", h("code", { text: "psf-monitor start" }), " and open the new link."),
      ),
    );
  } else if (all.size === 0) {
    canvas.setEmpty(emptyState(state.server?.indexing === true));
  } else if (tree !== null && tree.nodes.length === 1) {
    canvas.setEmpty(h("p", { class: "canvas-hint", text: "No agents spawned yet." }));
  } else {
    canvas.setEmpty(null);
  }

  if (tree === null) {
    sessionTitle.textContent = "No session selected";
    sessionPath.textContent = "";
    stats.replaceChildren();
  } else {
    sessionTitle.textContent = tree.root.title;
    sessionPath.textContent = shortPath(tree.root.cwd);
    sessionPath.title = tree.root.cwd ?? "";
    const counts = countsOf(fullTree!, now);
    const members = new Set(fullTree!.nodes.map((node) => node.id));
    const messages = state.links
      .filter((link) => members.has(link.from) && members.has(link.to))
      .reduce((sum, link) => sum + link.count, 0);
    stats.replaceChildren(
      stat("running", counts.running, "running"),
      stat("waiting", counts.waiting, "waiting"),
      stat("spawned", counts.spawned, counts.spawned === 1 ? "agent" : "agents"),
      stat("skills", counts.skills, counts.skills === 1 ? "skill" : "skills"),
      stat("done", counts.done, "done"),
      stat("failed", counts.failed, "failed"),
      ...(messages > 0 ? [stat("messages", messages, messages === 1 ? "message" : "messages")] : []),
      stat("tokens", counts.tokens, "tokens", compactNumber(counts.tokens)),
    );
    document.title = counts.running > 0 ? `(${counts.running}) psf-monitor` : "psf-monitor";
  }

  if (state.agent !== null) panel.update(shown, now, state.links);
  renderBanner();
  renderLive();
  renderControls();
}

function stat(kind: string, value: number, label: string, shown = String(value)): HTMLElement {
  return h("span", { class: "stat", attrs: { "data-kind": kind, "data-zero": String(value === 0) } }, h("b", { text: shown }), h("span", { text: ` ${label}` }));
}

function emptyState(indexing: boolean): HTMLElement {
  const hours = state.server?.windowHours ?? 24;
  if (indexing) return h("div", { class: "empty" }, logo(), h("h2", { text: "Reading recent transcripts…" }));
  return h(
    "div",
    { class: "empty" },
    logo(),
    h("h2", { text: `No pstack sessions in the last ${hours} hours` }),
    h("p", { text: "Run a pstack skill in Claude Code or Codex and it appears here." }),
  );
}

function renderBanner(): void {
  const messages: string[] = [];
  for (const source of state.health) {
    if (!source.present) continue;
    const name = SOURCE_NAME[source.source];
    if (source.state === "degraded") {
      messages.push(`${name}: ${source.shape} unrecognized ${source.shape === 1 ? "record" : "records"}; some activity may be missing.`);
    } else if (source.unchecked.length > 0) {
      messages.push(`${name} ${source.unchecked.join(", ")} is newer than this monitor was checked against.`);
    }
  }
  const text = messages.join(" ");
  if (text.length === 0 || text === state.dismissed) {
    banner.hidden = true;
    return;
  }
  const dismiss = h("button", { class: "icon-button", title: "Dismiss", attrs: { type: "button", "aria-label": "Dismiss" } }, icon("close"));
  dismiss.addEventListener("click", () => {
    state.dismissed = text;
    banner.hidden = true;
  });
  banner.replaceChildren(icon("alert"), h("p", {}, text, " Run ", h("code", { text: "psf-monitor doctor" }), " for details."), dismiss);
  banner.hidden = false;
}

function setConnection(next: Connection): void {
  if (state.connection === "stopped" && next !== "stopped") return;
  if (state.connection === next) return;
  const wasExpired = state.connection === "expired";
  state.connection = next;
  if (wasExpired || next === "expired" || next === "stopped") render();
  else renderLive();
}

function renderLive(): void {
  const indexing = state.server?.indexing === true;
  const shown: Connection | "indexing" = state.connection === "live" && indexing ? "indexing" : state.connection;
  live.dataset.state = shown;
  liveText.textContent = {
    connecting: "Connecting…",
    live: "Live",
    indexing: "Indexing…",
    retrying: "Reconnecting…",
    expired: "Link expired",
    stopped: "Stopped",
  }[shown];
  live.title = shown === "expired" ? "Run `psf-monitor start` and open the new link." : "";
}

// --- clocks and keys -------------------------------------------------------

window.setInterval(() => {
  const now = Date.now();
  canvas.tick(now);
  panel.tick(now);
}, 1_000);

window.setInterval(() => render(), 30_000);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (document.body.dataset.rail === "open") toggleRail(false);
  else if (state.agent !== null) selectAgent(null);
});

new ResizeObserver(() => fitPanel()).observe(stage);

renderControls();
connect();
