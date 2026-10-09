import type { AgentId, AgentNode, Harness, Scope } from "../domain.ts";
import { ago, compactNumber, working } from "../format.ts";
import type { JournalRequest, JournalState, LaneSummary, ModelSheet, ProjectSetup, ProviderSetup, PstackSetup, ServerInfo, SheetRole, SheetWriteRequest, SheetWriteResponse, SkillInfo } from "../wire.ts";
import { h, icon, providerIcon } from "./dom.ts";
import { PAGE_LABEL, type SetupPage } from "../navigation.ts";

// The setup view: what pstack has installed, which providers can run a lane,
// which model each role uses, what the lane journal holds, and how to change each of those.

const SETUP_COMMAND = "/pstack:setup-pstack";
const HARNESS_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export interface SetupEvents {
  refresh(): void;
  /** Changes the lane journal; resolves to an error message, or null when the change went through. */
  journal(request: JournalRequest): Promise<string | null>;
  /** Writes or deletes a model sheet and refreshes the setup afterwards. */
  sheet(request: SheetWriteRequest): Promise<SheetWriteResponse>;
}

/** One sheet the page can show or edit: a global sheet, or one project's sheet for one harness. */
interface SheetChoice {
  readonly key: string;
  readonly title: string;
  readonly sheet: ModelSheet;
  readonly project: ProjectSetup | null;
}

/** A matrix family the editor can put on a lane, as `provider:model` plus its efforts. */
interface FamilyOption {
  readonly value: string;
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
  /** An open row: the model id is typed, not picked. */
  readonly open: boolean;
  readonly blocked: string | null;
}

const ALIASES = ["inherit-parent", "auto"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function familyOptions(setup: PstackSetup): FamilyOption[] {
  const options: FamilyOption[] = [];
  for (const provider of setup.providers) {
    for (const family of provider.families) {
      const open = family.model.startsWith("<");
      options.push({
        value: open ? `${provider.provider}:` : `${provider.provider}:${family.model}`,
        provider: provider.provider,
        model: open ? "" : family.model,
        label: open ? `${provider.provider}: any model id…` : `${provider.provider}:${family.model}`,
        efforts: family.efforts.length > 0 ? family.efforts : EFFORTS,
        defaultEffort: family.defaultEffort.length > 0 ? family.defaultEffort : "high",
        open,
        blocked: provider.blocked,
      });
    }
  }
  return options;
}

function splitLane(lane: string): { provider: string; model: string; effort: string } | null {
  const colon = lane.indexOf(":");
  const at = lane.lastIndexOf("@");
  if (colon < 1 || at <= colon + 1) return null;
  return { provider: lane.slice(0, colon), model: lane.slice(colon + 1, at), effort: lane.slice(at + 1) };
}

function sheetChoices(setup: PstackSetup): SheetChoice[] {
  const choices: SheetChoice[] = [];
  for (const project of setup.projects) {
    for (const sheet of project.sheets) choices.push({ key: `project:${project.root}:${sheet.harness}`, title: `${project.name} · ${HARNESS_NAME[sheet.harness]}`, sheet, project });
  }
  for (const sheet of setup.sheets) choices.push({ key: `global:${sheet.harness}`, title: `Global · ${HARNESS_NAME[sheet.harness]}`, sheet, project: null });
  return choices;
}

/** The roles pstack would use for a choice right now: its own sheet, else the global one, else the first-run defaults. */
function effectiveRoles(choice: SheetChoice, setup: PstackSetup): { roles: readonly SheetRole[]; from: "project" | "global" | "defaults" } {
  if (choice.sheet.present) return { roles: choice.sheet.roles, from: choice.sheet.scope === "project" ? "project" : "global" };
  const global = setup.sheets.find((sheet) => sheet.harness === choice.sheet.harness);
  if (global?.present) return { roles: global.roles, from: "global" };
  return { roles: setup.defaults, from: "defaults" };
}

export interface SetupInput {
  readonly page: SetupPage;
  readonly scope: Scope;
  readonly setup: PstackSetup | null;
  readonly error: string | null;
  readonly journal: JournalState | null;
  readonly journalError: string | null;
  readonly nodes: ReadonlyMap<AgentId, AgentNode>;
  readonly server: ServerInfo | null;
  readonly now: number;
}

function bytesText(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function laneState(lane: LaneSummary): "ok" | "warn" | "quiet" | "live" {
  switch (lane.status) {
    case "complete": return "ok";
    case "running": return "live";
    case "cancelled":
    case "unknown": return "quiet";
    default: return "warn";
  }
}

interface Usage {
  runs: number;
  running: number;
  failed: number;
  tokens: number;
  lastAt: string | null;
}

type SkillSort = "name" | "used";

function usageFor(map: Map<string, Usage>, key: string): Usage {
  let usage = map.get(key);
  if (usage === undefined) {
    usage = { runs: 0, running: 0, failed: 0, tokens: 0, lastAt: null };
    map.set(key, usage);
  }
  return usage;
}

function count(usage: Usage, node: AgentNode, now: number): void {
  usage.runs += 1;
  if (working(node, now)) usage.running += 1;
  if (node.status.kind === "failed") usage.failed += 1;
  usage.tokens += node.usage?.totalTokens ?? 0;
  const at = node.lastActivityAt ?? node.startedAt;
  if (at !== null && (usage.lastAt === null || at > usage.lastAt)) usage.lastAt = at;
}

/** Skill runs by skill name, and spawned subagents and lanes by provider. */
function usageOf(nodes: ReadonlyMap<AgentId, AgentNode>, now: number, scope: Scope): { skills: Map<string, Usage>; providers: Map<string, Usage> } {
  const skills = new Map<string, Usage>();
  const providers = new Map<string, Usage>();
  for (const node of nodes.values()) {
    if (scope !== "all" && node.pstack !== (scope === "pstack")) continue;
    if (node.flavor.kind === "skill") count(usageFor(skills, node.flavor.skill.replace(/^pstack:/, "")), node, now);
    else if (node.flavor.kind !== "session") count(usageFor(providers, node.model.provider), node, now);
  }
  return { skills, providers };
}

function plural(value: number, one: string, many = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`;
}

function copyButton(value: string, label: string): HTMLButtonElement {
  const button = h("button", { class: "copy", title: label, attrs: { type: "button", "aria-label": label } }, icon("copy"));
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(
      () => {
        button.replaceChildren(icon("check"));
        button.dataset.copied = "true";
        window.setTimeout(() => {
          button.replaceChildren(icon("copy"));
          delete button.dataset.copied;
        }, 1_600);
      },
      () => { button.title = "Could not copy"; },
    );
  });
  return button;
}

function command(value: string): HTMLElement {
  return h("div", { class: "cmd" }, h("code", { class: "cmd-text mono", text: value }), copyButton(value, "Copy command"));
}

function chip(text: string, state: "ok" | "warn" | "quiet" | "live"): HTMLElement {
  return h("span", { class: "chip", text, attrs: { "data-state": state } });
}

function usageText(usage: Usage | undefined, noun: string, now: number): string {
  if (usage === undefined || usage.runs === 0) return `no ${noun}s`;
  return [
    plural(usage.runs, noun),
    usage.running > 0 ? `${usage.running} running` : null,
    usage.failed > 0 ? `${usage.failed} failed` : null,
    usage.tokens > 0 ? `${compactNumber(usage.tokens)} tokens` : null,
    usage.running === 0 ? ago(usage.lastAt, now) : null,
  ].filter((part) => part !== null && part.length > 0).join(" · ");
}

function providerOf(lane: string): string | null {
  const colon = lane.indexOf(":");
  return colon > 0 ? lane.slice(0, colon) : null;
}

/** The sheets that exist, or the first-run defaults when none does. */
function activeSheets(setup: PstackSetup): readonly { title: string; path: string | null; roles: readonly SheetRole[] }[] {
  const written = setup.sheets.filter((sheet: ModelSheet) => sheet.present);
  if (written.length > 0) return written.map((sheet) => ({ title: HARNESS_NAME[sheet.harness], path: sheet.path, roles: sheet.roles }));
  return setup.defaults.length > 0 ? [{ title: "First-run defaults", path: null, roles: setup.defaults }] : [];
}

function rolesUsing(setup: PstackSetup, provider: string): string[] {
  const roles = new Set<string>();
  for (const sheet of activeSheets(setup)) {
    for (const role of sheet.roles) if (role.lanes.some((lane) => providerOf(lane) === provider)) roles.add(role.role);
  }
  return [...roles];
}

export class SetupView {
  readonly element: HTMLElement;
  private readonly body = h("div", { class: "setup-body" });
  private readonly skillList = h("ul", { class: "skill-list" });
  private readonly skillCount = h("span", { class: "rail-count" });
  private readonly search = h("input", { class: "setup-search", attrs: { type: "search", placeholder: "Filter skills", "aria-label": "Filter skills", spellcheck: "false" } });
  private readonly principlesButton = h("button", { class: "quiet-action", attrs: { type: "button" } });
  private readonly sortButton = h("button", { class: "quiet-action", attrs: { type: "button" } });
  private principles = false;
  private sort: SkillSort = "name";
  private last: SetupInput | null = null;
  private drawn = "";
  /** Journal buttons that asked for a second click, by action key, until when. */
  private readonly armed = new Map<string, number>();
  private busy: string | null = null;
  private journalMessage: string | null = null;
  /** The sheet shown in Model roles; null picks the first project, else the global Claude sheet. */
  private sheetKey: string | null = null;
  /** A copy of the roles being edited; null when reading. */
  private draft: { role: string; lanes: string[] }[] | null = null;
  private confirmDiversity = false;
  private moveTo = "";
  private sheetResult: SheetWriteResponse | null = null;
  private sheetBusy = false;
  private readonly openProviders = new Set<string>();

  get hasDraft(): boolean { return this.draft !== null; }

  constructor(private readonly events: SetupEvents) {
    this.element = h("section", { class: "setup", attrs: { hidden: "", "aria-label": "pstack setup" } }, this.body);
    this.search.addEventListener("input", () => this.redraw());
    this.principlesButton.addEventListener("click", () => {
      this.principles = !this.principles;
      this.redraw();
    });
    this.sortButton.addEventListener("click", () => {
      this.sort = this.sort === "name" ? "used" : "name";
      this.redraw();
    });
  }

  render(input: SetupInput, force = false): void {
    const previousPage = this.last?.page;
    this.last = input;
    if (!force && this.draft !== null && previousPage === "models" && input.page === "models") return;
    const usage = usageOf(input.nodes, input.now, input.scope);
    // Rebuild only when something shown changed, so a filter being typed keeps its focus and scroll.
    // The minute keeps "2m ago" honest.
    const signature = JSON.stringify([input.page, input.scope, input.setup, input.error, input.journal, input.journalError, this.busy, this.journalMessage, [...this.armed], this.sheetKey, this.draft, this.confirmDiversity, this.moveTo, this.sheetResult, this.sheetBusy, input.server?.journal, input.server?.windowHours, [...usage.skills], [...usage.providers], Math.floor(input.now / 60_000)]);
    if (signature === this.drawn) return;
    this.drawn = signature;

    this.element.setAttribute("aria-label", PAGE_LABEL[input.page]);
    this.element.dataset.page = input.page;
    const typing = document.activeElement === this.search;
    const focused = document.activeElement instanceof HTMLElement && this.body.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    let section: HTMLElement;
    if (input.page === "journal") section = this.journalSection(input);
    else if (input.setup === null) {
      section = h("div", { class: "setup-wait" }, h("p", { text: input.error ?? "Reading local configuration…" }), input.error === null ? null : this.refreshButton("Try again"));
    } else {
      switch (input.page) {
        case "providers": section = this.providers(input.setup, usage.providers, input); break;
        case "models": section = this.roles(input.setup); break;
        case "skills": section = this.skillsSection(); break;
        case "settings": section = this.settings(input.setup, input); break;
      }
    }
    this.body.replaceChildren(this.head(input), section);
    if (input.page === "skills" && input.setup !== null) this.drawSkills(input.setup, usage.skills, input.now);
    if (typing && input.page === "skills") this.search.focus();
    else if (focused !== undefined) this.body.querySelectorAll<HTMLElement>("[data-focus]").forEach((element) => { if (element.dataset.focus === focused) element.focus({ preventScroll: true }); });
  }

  private redraw(): void {
    if (this.last?.setup == null) return;
    this.drawSkills(this.last.setup, usageOf(this.last.nodes, this.last.now, this.last.scope).skills, this.last.now);
  }

  private refreshButton(label: string): HTMLElement {
    const button = h("button", { class: "quiet-action", attrs: { type: "button" } }, icon("reset"), h("span", { text: label }));
    button.addEventListener("click", () => this.events.refresh());
    return button;
  }

  private head(input: SetupInput): HTMLElement {
    const scope = input.scope === "all" ? "All sessions" : input.scope === "pstack" ? "pstack sessions" : "Other sessions";
    const descriptions: Record<SetupPage, string> = {
      providers: `Provider availability and observed use · ${scope} · Last ${input.server?.windowHours ?? 24} hours`,
      models: "Choose which models each role runs. Project sheets override the global sheet.",
      skills: `Installed skills and where they are used · ${scope} · Last ${input.server?.windowHours ?? 24} hours`,
      journal: "Recorded model lanes across all sessions. Inspect outcomes and manage local records.",
      settings: "Monitor version, source directories, and local configuration.",
    };
    return h("header", { class: "setup-head" },
      h("div", {}, h("h2", { text: PAGE_LABEL[input.page] }), h("p", { text: descriptions[input.page] })), this.refreshButton("Refresh"));
  }

  // --- providers ---------------------------------------------------------------

  private providers(setup: PstackSetup, usage: ReadonlyMap<string, Usage>, input: SetupInput): HTMLElement {
    const known = new Set(setup.providers.map((provider) => provider.provider));
    // A provider pstack's matrix does not list still gets a card once one of its lanes shows up.
    const extra = [...usage.keys()].filter((provider) => !known.has(provider)).sort();
    const hours = input.server?.windowHours ?? 24;
    const ready = setup.providers.filter((provider) => provider.blocked === null).length;
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" }, h("h3", { text: "Availability" }), h("span", { class: "rail-count", text: `${ready} of ${setup.providers.length} ready` })),
      h(
        "div",
        { class: "provider-grid" },
        ...[...setup.providers].sort((a, b) => (usage.get(b.provider)?.running ?? 0) - (usage.get(a.provider)?.running ?? 0) || (usage.get(b.provider)?.runs ?? 0) - (usage.get(a.provider)?.runs ?? 0)).map((provider) => this.provider(provider, setup, usage.get(provider.provider), hours, input.now)),
        ...extra.map((provider) => this.unlisted(provider, usage.get(provider), hours, input.now)),
      ),
      h("p", { class: "setup-note", text: "Key and CLI checks use the environment this monitor started with. A lane reads its key from the session that launches it, so start the monitor from the same shell to keep the two in step." }),
    );
  }

  private provider(provider: ProviderSetup, setup: PstackSetup, usage: Usage | undefined, hours: number, now: number): HTMLElement {
    const roles = rolesUsing(setup, provider.provider);
    const gateway = provider.gateway;
    const facts = h("dl", { class: "facts setup-facts" });
    const fact = (label: string, ...value: (Node | string | null)[]): void => {
      facts.append(h("dt", { text: label }), h("dd", {}, ...value));
    };
    fact("Models", ...provider.families.map((family) => h("span", { class: "model", title: `family ${family.family} · efforts ${family.efforts.join(", ")}` }, family.model, h("small", { text: `@${family.defaultEffort}` }))));
    fact("CLI", provider.cliPath === null ? h("span", { class: "missing", text: `${provider.cli} not found on PATH` }) : h("span", { class: "mono", title: provider.cliPath, text: provider.cliPath }));
    if (gateway !== null) {
      fact("Key", h("span", { class: "mono", text: gateway.keyVar }), h("span", { class: gateway.keySet ? "present" : "missing", text: gateway.keySet ? " is set" : " is not set" }));
      fact("Endpoint", h("span", { class: "mono", title: gateway.baseUrl, text: gateway.baseUrl }));
      fact("Config dir", h("span", { class: "mono", title: gateway.configDir, text: gateway.configDir }));
      if (gateway.maxContext !== null) fact("Context cap", `${gateway.maxContext} tokens`);
    }
    fact("Roles", roles.length === 0 ? h("span", { class: "quiet", text: "none assigned" }) : h("span", { title: roles.join("\n"), text: roles.join(" · ") }));
    fact(`Last ${hours}h`, h("span", { class: usage === undefined ? "quiet" : "", text: usageText(usage, "agent", now) }));

    const details = h("details", { class: "provider-details" },
      h("summary", { text: "Configuration and setup", attrs: { "data-focus": `provider:${provider.provider}` } }), facts, this.guide(provider, roles.length > 0, setup.platform),
      gateway === null ? null : h("p", { class: "provider-vars" }, "Change with ", h("code", { text: gateway.baseUrlVar }), ", ", h("code", { text: gateway.configDirVar }), ", ", h("code", { text: gateway.maxContextVar })));
    details.open = this.openProviders.has(provider.provider);
    details.addEventListener("toggle", () => { if (details.open) this.openProviders.add(provider.provider); else this.openProviders.delete(provider.provider); });
    return h(
      "article",
      { class: "provider", attrs: { "data-provider": provider.provider, "data-ready": String(provider.blocked === null) } },
      h(
        "header",
        { class: "provider-head" },
        h("span", { class: "card-glyph" }, icon(providerIcon(provider.provider))),
        h("div", { class: "provider-names" }, h("h4", { text: provider.provider }), h("p", { text: gateway === null ? "Subscription CLI" : "API key gateway" })),
        h(
          "div",
          { class: "provider-chips" },
          (usage?.running ?? 0) > 0 ? chip(`${usage!.running} running`, "live") : null,
          provider.blocked === null ? chip("ready", "ok") : chip("needs setup", "warn"),
        ),
      ),
      h("p", { class: "provider-summary", text: usageText(usage, "agent", now) }),
      provider.blocked === null ? null : h("p", { class: "provider-blocked", text: provider.blocked }),
      details,
    );
  }

  /** What to do next for a provider that cannot run, or runs nothing yet. */
  private guide(provider: ProviderSetup, assigned: boolean, platform: string): HTMLElement | null {
    const gateway = provider.gateway;
    if (provider.cliPath === null) {
      return h("div", { class: "guide" }, h("p", {}, "Install the ", h("code", { text: provider.cli }), gateway === null ? " CLI and sign in to it, then assign it a role:" : " CLI. A gateway lane runs it against this provider's endpoint; do not sign in to claude.ai for it."), gateway === null ? command(SETUP_COMMAND) : null);
    }
    if (gateway === null) return null;
    if (gateway.login !== "none") {
      return h("div", { class: "guide" }, h("p", {}, gateway.login === "found" ? "A claude.ai login sits in this provider's config dir, so the runner refuses its lanes. Remove " : "The runner cannot read the credentials file here and refuses its lanes. Remove ", h("code", { text: `${gateway.configDir}/.credentials.json` }), ", and never run ", h("code", { text: "claude login" }), " there."));
    }
    if (gateway.keySet) {
      return assigned ? null : h("div", { class: "guide" }, h("p", { text: "The key is set. Assign this provider to a role to use it:" }), command(SETUP_COMMAND));
    }
    const service = `pstack-${provider.provider}`;
    const [store, load] = platform === "darwin"
      ? [`security add-generic-password -a "$USER" -s ${service} -w`, `export ${gateway.keyVar}=$(security find-generic-password -a "$USER" -s ${service} -w)`]
      : [`pass insert pstack/${provider.provider}`, `export ${gateway.keyVar}=$(pass show pstack/${provider.provider})`];
    return h(
      "ol",
      { class: "guide steps" },
      h("li", {}, h("p", { text: platform === "darwin" ? "Store the key in your keychain. It prompts for the value, so nothing lands in shell history." : "Store the key encrypted." }), command(store)),
      h("li", {}, h("p", { text: "Load it in the shell that starts Claude Code or Codex. Put this in a function in your shell profile, not a bare export." }), command(load)),
      h("li", {}, h("p", { text: "Start a session from that shell and assign the provider to a role. Setup probes the model before it writes anything." }), command(SETUP_COMMAND)),
    );
  }

  private unlisted(provider: string, usage: Usage | undefined, hours: number, now: number): HTMLElement {
    return h(
      "article",
      { class: "provider", attrs: { "data-provider": provider, "data-ready": "true" } },
      h(
        "header",
        { class: "provider-head" },
        h("span", { class: "card-glyph" }, icon(providerIcon(provider))),
        h("div", { class: "provider-names" }, h("h4", { text: provider }), h("p", { text: "Seen in lanes; not in the installed model matrix" })),
        h("div", { class: "provider-chips" }, (usage?.running ?? 0) > 0 ? chip(`${usage!.running} running`, "live") : chip("active", "ok")),
      ),
      h("dl", { class: "facts setup-facts" }, h("dt", { text: `Last ${hours}h` }), h("dd", { text: usageText(usage, "agent", now) })),
    );
  }

  // --- model roles -------------------------------------------------------------

  private laneChip(value: string, blocked: ReadonlyMap<string, string>): HTMLElement {
    const provider = providerOf(value);
    if (provider === null) return h("span", { class: "lane-chip", text: value, attrs: { "data-alias": "true" } });
    const reason = blocked.get(provider);
    return h(
      "span",
      { class: "lane-chip", title: reason === undefined ? value : `${value}\nwould not start: ${reason}`, attrs: { "data-provider": provider, ...(reason === undefined ? {} : { "data-blocked": "true" }) } },
      h("i", { attrs: { "aria-hidden": "true" } }),
      value.slice(provider.length + 1),
      reason === undefined ? null : icon("alert"),
    );
  }

  private currentChoice(setup: PstackSetup): SheetChoice | null {
    const choices = sheetChoices(setup);
    return choices.find((choice) => choice.key === this.sheetKey) ?? choices[0] ?? null;
  }

  private selectSheet(key: string): void {
    this.sheetKey = key;
    this.draft = null;
    this.sheetResult = null;
    this.confirmDiversity = false;
    this.rerender();
  }

  private startEditing(roles: readonly SheetRole[]): void {
    if (this.last?.setup) this.sheetKey = this.currentChoice(this.last.setup)?.key ?? null;
    this.draft = roles.map((role) => ({ role: role.role, lanes: [...role.lanes] }));
    this.sheetResult = null;
    this.confirmDiversity = false;
    this.moveTo = "";
    this.rerender();
  }

  private async submitSheet(choice: SheetChoice, roles: readonly SheetRole[] | null): Promise<void> {
    this.sheetBusy = true;
    this.sheetResult = null;
    this.rerender();
    const result = await this.events.sheet({ harness: choice.sheet.harness, scope: choice.sheet.scope, root: choice.project?.root ?? null, roles, confirmDiversity: this.confirmDiversity });
    this.sheetBusy = false;
    this.sheetResult = result;
    if (result.ok) this.draft = null;
    this.rerender();
  }

  /** One lane's controls: what runs it, at which effort, and a way to drop it. */
  private laneEditor(lane: string, families: readonly FamilyOption[], update: (next: string) => void, remove: () => void): HTMLElement {
    const parts = splitLane(lane);
    const alias = (ALIASES as readonly string[]).includes(lane);
    const family = parts === null ? undefined : families.find((option) => option.provider === parts.provider && (option.open || option.model === parts.model));
    const picked = alias ? lane : family === undefined ? "" : family.value;
    const what = h("select", { class: "sheet-select", attrs: { "aria-label": "Model for this lane" } },
      picked === "" ? h("option", { text: lane.length === 0 ? "choose…" : lane, attrs: { value: "", disabled: "" } }) : null,
      ...ALIASES.map((value) => h("option", { text: value, attrs: { value } })),
      ...families.map((option) => h("option", { text: option.blocked === null ? option.label : `${option.label} (cannot start)`, attrs: { value: option.value } })),
    );
    what.value = picked;
    what.addEventListener("change", () => {
      const next = families.find((option) => option.value === what.value);
      if (next === undefined) update(what.value);
      else update(next.open ? `${next.provider}:${parts?.provider === next.provider ? parts.model : ""}@${next.defaultEffort}` : `${next.value}@${next.defaultEffort}`);
    });
    const modelInput = family?.open === true
      ? h("input", { class: "sheet-input mono", attrs: { type: "text", placeholder: family.provider === "openrouter" ? "namespace/model" : "provider/model", "aria-label": "Model id", spellcheck: "false", value: parts?.model ?? "" } })
      : null;
    modelInput?.addEventListener("change", () => update(`${family!.provider}:${modelInput.value.trim()}@${parts?.effort ?? family!.defaultEffort}`));
    const efforts = family?.efforts ?? EFFORTS;
    const effort = alias ? null : h("select", { class: "sheet-select", attrs: { "aria-label": "Effort" } }, ...efforts.map((value) => h("option", { text: `@${value}`, attrs: { value } })));
    if (effort !== null && parts !== null) effort.value = efforts.includes(parts.effort) ? parts.effort : (family?.defaultEffort ?? efforts[0]!);
    effort?.addEventListener("change", () => update(`${parts!.provider}:${parts!.model}@${effort.value}`));
    const drop = h("button", { class: "icon-button lane-remove", title: "Remove this lane", attrs: { type: "button", "aria-label": "Remove this lane" } }, icon("close"));
    drop.addEventListener("click", remove);
    return h("div", { class: "lane-editor" }, what, modelInput, effort, drop);
  }

  private roles(setup: PstackSetup): HTMLElement {
    const blocked = new Map(setup.providers.filter((provider) => provider.blocked !== null).map((provider) => [provider.provider, provider.blocked!]));
    const choices = sheetChoices(setup);
    const choice = this.currentChoice(setup);
    const families = familyOptions(setup);
    const picker = h("select", { class: "sheet-select", attrs: { "aria-label": "Which model sheet to show" } },
      ...choices.map((entry) => h("option", { text: `${entry.title}${entry.sheet.present ? "" : entry.project === null ? " (not written)" : " (uses global)"}`, attrs: { value: entry.key } })));
    if (choice !== null) picker.value = choice.key;
    picker.disabled = this.draft !== null || this.sheetBusy;
    picker.addEventListener("change", () => this.selectSheet(picker.value));

    const children: (Node | null)[] = [];
    if (choice === null) {
      children.push(h("p", { class: "setup-lede", text: "The installed pstack lists no roles." }));
    } else {
      const effective = effectiveRoles(choice, setup);
      const sheet = choice.sheet;
      const status = h("p", { class: "setup-lede" },
        sheet.present
          ? h("span", {}, `pstack reads this sheet for ${choice.project === null ? "every project without its own sheet" : `work in ${choice.project.name}`} under ${HARNESS_NAME[sheet.harness]}. `)
          : choice.project === null
            ? h("span", {}, `No global ${HARNESS_NAME[sheet.harness]} sheet is written; pstack uses ${effective.from === "defaults" ? "its first-run roles" : "the global sheet"}. `)
            : h("span", {}, `${choice.project.name} has no ${HARNESS_NAME[sheet.harness]} sheet of its own, so it uses ${effective.from === "global" ? "the global sheet" : "pstack's first-run roles"} shown here. `),
        sheet.unprobed ? chip("not probed", "warn") : sheet.present ? chip("probed by setup", "ok") : null,
        choice.project !== null ? h("span", { class: "quiet", text: ` ${plural(choice.project.sessions, "session")} in the window` }) : null,
      );
      if (this.draft !== null) children.push(h("p", { class: "draft-note", text: "Unsaved draft. It stays here while you browse other pages. Save or discard it before changing sheets." }));
      children.push(status, h("div", { class: "sheet-head" }, h("span", { class: "mono sheet-path", title: sheet.path, text: sheet.path })));

      if (this.draft === null) {
        const edit = h("button", { class: "quiet-action", attrs: { type: "button" } }, icon("sliders"), h("span", { text: sheet.present ? "Edit" : choice.project === null ? "Edit (run setup first)" : "Create project sheet" }));
        edit.disabled = !sheet.writable || effective.roles.length === 0;
        if (!sheet.writable) edit.title = "The monitor creates project sheets; a global sheet starts with /pstack:setup-pstack, which also wires it into the harness.";
        edit.addEventListener("click", () => this.startEditing(effective.roles));
        const remove = sheet.present && choice.project !== null
          ? this.armedButton("sheet-delete", "Delete project sheet", "Delete this sheet and use the global one?", () => void this.submitSheet(choice, null))
          : null;
        children.push(
          h("div", { class: "sheet-tools" }, edit, remove),
          h("table", { class: "role-table" }, h("tbody", {}, ...effective.roles.map((role) => h("tr", {}, h("th", { text: role.role, attrs: { scope: "row" } }), h("td", {}, h("div", { class: "lane-chips" }, ...role.lanes.map((lane) => this.laneChip(lane, blocked)))))))),
        );
      } else {
        const draft = this.draft;
        const move = h("select", { class: "sheet-select", attrs: { "aria-label": "Move every lane to one model" } },
          h("option", { text: "Move every lane to…", attrs: { value: "" } }),
          ...families.filter((option) => !option.open).map((option) => h("option", { text: option.label, attrs: { value: option.value } })));
        move.value = this.moveTo;
        move.addEventListener("change", () => { this.moveTo = move.value; this.rerender(); });
        const apply = h("button", { class: "quiet-action", attrs: { type: "button" }, title: "Every lane that names a model moves; inherit-parent and auto stay. A panel that would repeat one lane keeps one." }, h("span", { text: "Apply to all" }));
        apply.disabled = this.moveTo === "";
        apply.addEventListener("click", () => {
          const target = families.find((option) => option.value === this.moveTo);
          if (target === undefined) return;
          for (const role of draft) {
            const moved = role.lanes.map((lane) => ((ALIASES as readonly string[]).includes(lane) ? lane : `${target.value}@${target.defaultEffort}`));
            role.lanes = moved.filter((lane, index) => moved.indexOf(lane) === index);
          }
          this.sheetResult = null;
          this.rerender();
        });
        const rows = draft.map((role, roleIndex) => {
          const add = h("button", { class: "quiet-action lane-add", attrs: { type: "button" } }, icon("plus"), h("span", { text: "lane" }));
          add.addEventListener("click", () => { role.lanes.push(""); this.rerender(); });
          return h("tr", {},
            h("th", { text: role.role, attrs: { scope: "row" } }),
            h("td", {}, h("div", { class: "lane-editors" },
              ...role.lanes.map((lane, laneIndex) => this.laneEditor(lane, families,
                (next) => { draft[roleIndex]!.lanes[laneIndex] = next; this.sheetResult = null; this.rerender(); },
                () => { draft[roleIndex]!.lanes.splice(laneIndex, 1); this.sheetResult = null; this.rerender(); })),
              add)));
        });
        const diversity = h("input", { attrs: { type: "checkbox" } });
        diversity.checked = this.confirmDiversity;
        diversity.addEventListener("change", () => { this.confirmDiversity = diversity.checked; });
        const save = h("button", { class: "quiet-action", attrs: { type: "button", "aria-pressed": "true" } }, icon("check"), h("span", { text: this.sheetBusy ? "Writing…" : "Save sheet" }));
        save.disabled = this.sheetBusy || draft.some((role) => role.lanes.length === 0 || role.lanes.some((lane) => lane.length === 0 || lane.endsWith(":@") || /:@[a-z]+$/.test(lane)));
        save.addEventListener("click", () => void this.submitSheet(choice, draft.map((role) => ({ role: role.role, lanes: [...role.lanes] }))));
        const discard = h("button", { class: "quiet-action", attrs: { type: "button" } }, h("span", { text: "Discard" }));
        discard.disabled = this.sheetBusy;
        discard.addEventListener("click", () => { this.draft = null; this.sheetResult = null; this.rerender(); });
        children.push(
          h("div", { class: "sheet-tools" }, move, apply),
          h("table", { class: "role-table sheet-edit" }, h("tbody", {}, ...rows)),
          h("div", { class: "sheet-tools" }, save, discard, h("label", { class: "sheet-check" }, diversity, "accept a single-provider panel")),
        );
      }
      const result = this.sheetResult;
      if (result !== null) {
        children.push(h("p", { class: "setup-note", attrs: { role: "status", "data-ok": String(result.ok) }, text: result.message }));
        if (result.errors.length > 1) children.push(h("ul", { class: "sheet-problems" }, ...result.errors.map((error) => h("li", { text: error }))));
        if (result.warnings.length > 0) children.push(h("ul", { class: "sheet-problems", attrs: { "data-level": "warn" } }, ...result.warnings.map((warning) => h("li", { text: warning }))));
      }
    }
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" }, h("h3", { text: "Assignments" }), h("div", { class: "setup-tools" }, picker)),
      ...children,
      h("div", { class: "guide" }, h("p", { text: "A sheet written here is checked against the installed model matrix but not probed. Setup probes every assigned model live and rewrites the sheet; run it when a lane should be proven before real work." }), command(SETUP_COMMAND)),
    );
  }

  /** A button that asks for a second click within four seconds before acting. */
  private armedButton(key: string, label: string, confirm: string, act: () => void): HTMLButtonElement {
    const armed = (this.armed.get(key) ?? 0) > Date.now();
    const button = h("button", { class: "quiet-action", attrs: { type: "button" } }, h("span", { text: armed ? `Confirm: ${confirm}` : label }));
    button.disabled = this.sheetBusy;
    button.addEventListener("click", () => {
      if ((this.armed.get(key) ?? 0) <= Date.now()) {
        this.armed.set(key, Date.now() + 4_000);
        this.rerender();
        window.setTimeout(() => this.rerender(), 4_050);
        return;
      }
      this.armed.delete(key);
      act();
    });
    return button;
  }

  // --- skills ------------------------------------------------------------------

  private skillsSection(): HTMLElement {
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" }, h("h3", { text: "Installed skills" }), this.skillCount, h("div", { class: "setup-tools" }, this.search, this.sortButton, this.principlesButton)),
      this.skillList,
    );
  }

  private drawSkills(setup: PstackSetup, usage: ReadonlyMap<string, Usage>, now: number): void {
    const query = this.search.value.trim().toLowerCase();
    const leaves = setup.skills.filter((skill) => !skill.invocable).length;
    this.principlesButton.textContent = `Principles: ${this.principles ? "shown" : "hidden"}`;
    this.principlesButton.hidden = leaves === 0;
    this.principlesButton.setAttribute("aria-pressed", String(this.principles));
    this.sortButton.textContent = `Sort: ${this.sort === "name" ? "name" : "most run"}`;
    const shown = setup.skills
      .filter((skill) => this.principles || skill.invocable)
      .filter((skill) => query.length === 0 || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query));
    if (this.sort === "used") shown.sort((a, b) => (usage.get(b.name)?.runs ?? 0) - (usage.get(a.name)?.runs ?? 0) || a.name.localeCompare(b.name));
    this.skillCount.textContent = shown.length === setup.skills.length ? String(shown.length) : `${shown.length} of ${setup.skills.length}`;
    const roles = activeSheets(setup).flatMap((sheet) => sheet.roles);
    this.skillList.replaceChildren(...(shown.length === 0
      ? [h("li", { class: "skill-empty", text: setup.skills.length === 0 ? "No pstack skills found." : "No skill matches that filter." })]
      : shown.map((skill) => this.skill(skill, usage.get(skill.name), roles, now))));
  }

  private skill(skill: SkillInfo, usage: Usage | undefined, roles: readonly SheetRole[], now: number): HTMLElement {
    const name = `/pstack:${skill.name}`;
    // Roles are named after the skill that fans them out, e.g. `arena runners`.
    const own = [...new Map(roles.filter((role) => role.role === skill.name || role.role.startsWith(`${skill.name} `)).map((role) => [role.role, role])).values()];
    return h(
      "li",
      { class: "skill", attrs: { "data-live": String((usage?.running ?? 0) > 0), "data-leaf": String(!skill.invocable) } },
      h(
        "div",
        { class: "skill-main" },
        h("div", { class: "skill-name" }, h("span", { class: "mono", text: skill.invocable ? name : skill.name }), skill.invocable ? copyButton(name, `Copy ${name}`) : chip("principle", "quiet")),
        h("p", { class: "skill-desc", title: skill.description, text: skill.description }),
        own.length === 0 ? null : h("p", { class: "skill-roles" }, ...own.map((role) => h("span", { title: role.lanes.join("\n"), text: `${role.role} · ${plural(role.lanes.length, "lane")}` }))),
      ),
      h("div", { class: "skill-usage", attrs: { "data-zero": String(usage === undefined) } }, (usage?.running ?? 0) > 0 ? chip("running", "live") : null, h("span", { text: usageText(usage, "run", now) })),
    );
  }

  // --- journal -----------------------------------------------------------------

  /** A button that asks once more before doing something that deletes records. */
  private journalButton(key: string, label: string, confirm: string | null, request: JournalRequest, disabled = false, title = ""): HTMLButtonElement {
    const armed = (this.armed.get(key) ?? 0) > Date.now();
    const button = h("button", { class: "quiet-action", text: this.busy === key ? "Working…" : armed ? `Confirm: ${confirm}` : label, attrs: { type: "button" }, title });
    button.disabled = disabled || this.busy !== null;
    button.addEventListener("click", () => {
      if (confirm !== null && (this.armed.get(key) ?? 0) <= Date.now()) {
        this.armed.set(key, Date.now() + 4_000);
        this.rerender();
        window.setTimeout(() => this.rerender(), 4_050);
        return;
      }
      this.armed.delete(key);
      this.busy = key;
      this.journalMessage = null;
      this.rerender();
      void this.events.journal(request).then((error) => {
        this.busy = null;
        this.journalMessage = error;
        this.rerender();
      });
    });
    return button;
  }

  private rerender(): void {
    if (this.last !== null) this.render(this.last, true);
  }

  private journalSection(input: SetupInput): HTMLElement {
    const journal = input.journal;
    const on = journal?.on ?? input.server?.journal ?? false;
    const lanes = journal?.lanes ?? [];
    const running = lanes.filter((lane) => lane.status === "running").length;
    const idle = lanes.length - running;
    const total = lanes.reduce((sum, lane) => sum + lane.bytes, 0);
    const rows = lanes.map((lane) => {
      const live = lane.status === "running";
      const model = [lane.provider, lane.model].filter((part) => part !== null).join(":") + (lane.effort === null ? "" : `@${lane.effort}`);
      return h("tr", { attrs: { "data-status": lane.status } },
        h("td", {}, h("div", { class: "lane-name", text: lane.label ?? "unlabeled lane" }), h("div", { class: "mono lane-id", text: lane.laneId })),
        h("td", { class: "mono", text: model.length > 0 ? model : "?" }),
        h("td", { text: lane.parent === null ? "" : HARNESS_NAME[lane.parent as Harness] ?? lane.parent }),
        h("td", {}, chip(lane.status.replace(/-/g, " "), laneState(lane))),
        h("td", { text: ago(lane.startedAt, input.now), title: lane.startedAt ?? "" }),
        h("td", { class: "lane-size", text: bytesText(lane.bytes) }),
        h("td", {}, this.journalButton(`delete:${lane.laneId}`, "Delete", "Delete this lane's records?", { delete: lane.laneId }, live, live ? "Cancel the lane first." : "")),
      );
    });
    const summary = !on ? "Off: external lanes are not recorded, and lanes from before were deleted."
      : lanes.length === 0 ? "On, with nothing recorded yet. Lanes appear here as pstack runs them."
      : `${plural(lanes.length, "lane")} · ${bytesText(total)}${running > 0 ? ` · ${running} running` : ""}`;
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" },
        h("h3", { text: "Recorded lanes" }),
        chip(on ? "on" : "off", on ? "ok" : "quiet"),
        h("span", { class: "rail-count", text: summary }),
        h("div", { class: "setup-tools" },
          on ? this.journalButton("clear", "Clear all", idle > 0 ? `Delete ${plural(idle, "recorded lane")}?` : null, { clear: true }, idle === 0, idle === 0 ? "Nothing to delete." : "") : null,
          this.journalButton("toggle", on ? "Turn off" : "Turn on", on ? "Turn off and delete every recorded lane?" : null, { on: !on }),
          this.refreshButton("Refresh"),
        ),
      ),
      input.journalError !== null ? h("p", { class: "setup-note", attrs: { role: "alert" }, text: input.journalError }) : null,
      this.journalMessage !== null ? h("p", { class: "setup-note", attrs: { role: "alert" }, text: this.journalMessage }) : null,
      rows.length > 0 ? h("div", { class: "table-scroll" }, h("table", { class: "role-table lane-table" },
        h("thead", {}, h("tr", {}, ...["Lane", "Model", "From", "Status", "Started", "Size", ""].map((text) => h("th", { text, attrs: { scope: "col" } })))),
        h("tbody", {}, ...rows))) : null,
      h("p", { class: "setup-note" },
        journal === null ? "" : h("span", {}, "Records live in ", h("span", { class: "mono", text: journal.root }), ". "),
        "The server prunes lanes older than 7 days. The same list prints with ", h("code", { text: "psf-monitor journal list" }),
        "; ", h("code", { text: "journal rm <lane id>" }), " and ", h("code", { text: "journal clear" }), " delete from a terminal."),
    );
  }

  // --- settings ----------------------------------------------------------------

  private settings(setup: PstackSetup, input: SetupInput): HTMLElement {
    const server = input.server;
    const rows: HTMLElement[] = [];
    const row = (name: string, value: Node | string, how: Node | string): void => {
      rows.push(h("tr", {}, h("th", { text: name, attrs: { scope: "row" } }), h("td", {}, value), h("td", { class: "setting-how" }, how)));
    };
    if (server !== null) {
      row("Lane journal", chip(server.journal ? "on" : "off", server.journal ? "ok" : "quiet"), server.journal
        ? "Records external lanes and keeps them 7 days. The Journal page lists, deletes, and turns them off."
        : "Off: external lanes will not appear. Turn it on in the Journal page.");
      row("Window", `last ${server.windowHours} hours`, h("code", { text: "psf-monitor start --hours <n>" }));
      row("Address", h("span", { class: "mono", text: location.host }), h("code", { text: "psf-monitor start --port <n>" }));
      row("Monitor", h("span", { class: "mono", text: server.version }), `pid ${server.pid} · started ${ago(server.startedAt, input.now)} · watching by ${server.watching === "events" ? "file events" : "polling"}`);
    }
    for (const install of setup.installs) {
      row(`pstack in ${HARNESS_NAME[install.harness]}`, install.version ?? "unknown version", h("span", { class: "mono", title: install.path, text: install.path }));
    }
    for (const setting of setup.settings) {
      row(setting.meaning, h("span", { class: "mono", title: setting.value, text: setting.value }), h("span", {}, h("code", { text: setting.variable }), setting.overridden ? " is set" : " moves it; this is the default"));
    }
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" }, h("h3", { text: "Local monitor" })),
      h("table", { class: "role-table setting-table" }, h("tbody", {}, ...rows)),
      h("p", { class: "setup-note" }, "The same list prints in a terminal with ", h("code", { text: "psf-monitor setup" }), "."),
    );
  }
}
