import type { AgentId, AgentNode, Harness } from "../domain.ts";
import { ago, compactNumber, working } from "../format.ts";
import type { JournalRequest, JournalState, LaneSummary, ModelSheet, ProviderSetup, PstackSetup, ServerInfo, SheetRole, SkillInfo } from "../wire.ts";
import { h, icon, providerIcon } from "./dom.ts";

// The setup view: what pstack has installed, which providers can run a lane,
// which model each role uses, what the lane journal holds, and how to change each of those.

const SETUP_COMMAND = "/pstack:setup-pstack";
const HARNESS_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

export interface SetupEvents {
  refresh(): void;
  /** Changes the lane journal; resolves to an error message, or null when the change went through. */
  journal(request: JournalRequest): Promise<string | null>;
}

export interface SetupInput {
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
function usageOf(nodes: ReadonlyMap<AgentId, AgentNode>, now: number): { skills: Map<string, Usage>; providers: Map<string, Usage> } {
  const skills = new Map<string, Usage>();
  const providers = new Map<string, Usage>();
  for (const node of nodes.values()) {
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

  render(input: SetupInput): void {
    this.last = input;
    const usage = usageOf(input.nodes, input.now);
    // Rebuild only when something shown changed, so a filter being typed keeps its focus and scroll.
    // The minute keeps "2m ago" honest.
    const signature = JSON.stringify([input.setup, input.error, input.journal, input.journalError, this.busy, this.journalMessage, [...this.armed], input.server?.journal, input.server?.windowHours, [...usage.skills], [...usage.providers], Math.floor(input.now / 60_000)]);
    if (signature === this.drawn) return;
    this.drawn = signature;

    if (input.setup === null) {
      this.body.replaceChildren(
        h("div", { class: "setup-wait" }, h("p", { text: input.error ?? "Reading the pstack setup…" }), input.error === null ? null : this.refreshButton("Try again")),
      );
      return;
    }
    const setup = input.setup;
    const typing = document.activeElement === this.search;
    this.body.replaceChildren(
      this.head(setup),
      this.providers(setup, usage.providers, input),
      this.roles(setup),
      this.skillsSection(),
      this.journalSection(input),
      this.settings(setup, input),
    );
    this.drawSkills(setup, usage.skills, input.now);
    if (typing) this.search.focus();
  }

  private redraw(): void {
    if (this.last?.setup == null) return;
    this.drawSkills(this.last.setup, usageOf(this.last.nodes, this.last.now).skills, this.last.now);
  }

  private refreshButton(label: string): HTMLElement {
    const button = h("button", { class: "quiet-action", attrs: { type: "button" } }, icon("reset"), h("span", { text: label }));
    button.addEventListener("click", () => this.events.refresh());
    return button;
  }

  private head(setup: PstackSetup): HTMLElement {
    const installed = setup.installs.length === 0
      ? "pstack is not installed in Claude Code or Codex on this machine."
      : `pstack ${setup.installs.map((install) => `${install.version ?? "?"} in ${HARNESS_NAME[install.harness]}`).join(", ")}`;
    return h(
      "header",
      { class: "setup-head" },
      h("div", {}, h("h2", { text: "pstack setup" }), h("p", { text: installed })),
      this.refreshButton("Refresh"),
    );
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
      h("div", { class: "setup-title" }, h("h3", { text: "Providers" }), h("span", { class: "rail-count", text: `${ready} of ${setup.providers.length} ready` })),
      h(
        "div",
        { class: "provider-grid" },
        ...setup.providers.map((provider) => this.provider(provider, setup, usage.get(provider.provider), hours, input.now)),
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
      facts,
      this.guide(provider, roles.length > 0, setup.platform),
      gateway === null ? null : h(
        "p",
        { class: "provider-vars" },
        "Change with ",
        h("code", { text: gateway.baseUrlVar }),
        ", ",
        h("code", { text: gateway.configDirVar }),
        ", ",
        h("code", { text: gateway.maxContextVar }),
      ),
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

  private roles(setup: PstackSetup): HTMLElement {
    const blocked = new Map(setup.providers.filter((provider) => provider.blocked !== null).map((provider) => [provider.provider, provider.blocked!]));
    const sheets = activeSheets(setup);
    const written = setup.sheets.some((sheet) => sheet.present);
    const lane = (value: string): HTMLElement => {
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
    };
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" }, h("h3", { text: "Model roles" })),
      h("p", { class: "setup-lede" }, written
        ? "Each role runs on the lanes listed here, one lane per entry. "
        : "No model sheet is written yet, so pstack uses its first-run roles. ", "A lane marked with a warning would not start with the providers above."),
      ...sheets.map((sheet) => h(
        "div",
        { class: "sheet" },
        h("div", { class: "sheet-head" }, h("span", { class: "sheet-name", text: sheet.title }), sheet.path === null ? null : h("span", { class: "mono sheet-path", text: sheet.path })),
        h("table", { class: "role-table" }, h("tbody", {}, ...sheet.roles.map((role) => h("tr", {}, h("th", { text: role.role, attrs: { scope: "row" } }), h("td", {}, h("div", { class: "lane-chips" }, ...role.lanes.map(lane))))))),
      )),
      sheets.length === 0 ? h("p", { class: "setup-lede", text: "The installed pstack lists no roles." }) : null,
      h("div", { class: "guide" }, h("p", { text: "Change a role's model or a family's effort with setup. It probes every assigned model first and writes the sheet only when all of them answer." }), command(SETUP_COMMAND)),
    );
  }

  // --- skills ------------------------------------------------------------------

  private skillsSection(): HTMLElement {
    return h(
      "section",
      { class: "setup-section" },
      h("div", { class: "setup-title" }, h("h3", { text: "Skills" }), this.skillCount, h("div", { class: "setup-tools" }, this.search, this.sortButton, this.principlesButton)),
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
    if (this.last !== null) this.render(this.last);
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
        h("h3", { text: "Journal" }),
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
        ? "Records external lanes and keeps them 7 days. The Journal section above lists, deletes, and turns them off."
        : "Off: external lanes will not appear. Turn it on in the Journal section above.");
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
      h("div", { class: "setup-title" }, h("h3", { text: "Settings" })),
      h("table", { class: "role-table setting-table" }, h("tbody", {}, ...rows)),
      h("p", { class: "setup-note" }, "The same list prints in a terminal with ", h("code", { text: "psf-monitor setup" }), "."),
    );
  }
}
