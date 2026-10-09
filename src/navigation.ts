export const PAGES = ["overview", "sessions", "providers", "models", "skills", "journal", "settings"] as const;
export type Page = typeof PAGES[number];
export type SetupPage = Exclude<Page, "overview" | "sessions">;
export const PAGE_LABEL: Record<Page, string> = {
  overview: "Overview", sessions: "Sessions", providers: "Providers", models: "Model roles",
  skills: "Skills", journal: "Journal", settings: "Settings",
};

export function pageFromHash(hash: string): Page {
  const value = hash.replace(/^#\/?/, "");
  if (value === "setup") return "overview";
  return PAGES.find((page) => page === value) ?? "sessions";
}

export function isSetupPage(page: Page): page is SetupPage {
  return page !== "overview" && page !== "sessions";
}

interface LocationState {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly state: unknown;
}
export interface HistoryPort {
  read(): LocationState;
  push(state: unknown, url: string): void;
  replace(state: unknown, url: string): void;
  back(): void;
}

function depthOf(state: unknown): number {
  if (typeof state !== "object" || state === null || !("monitorDepth" in state)) return 0;
  return typeof state.monitorDepth === "number" && Number.isSafeInteger(state.monitorDepth) && state.monitorDepth >= 0 ? state.monitorDepth : 0;
}

export class Navigation {
  constructor(private readonly port: HistoryPort, private readonly changed: (page: Page) => void) {
    const current = port.read();
    port.replace({ monitorDepth: depthOf(current.state) }, `${current.pathname}${current.search}#${pageFromHash(current.hash)}`);
  }

  visit(page: Page): void {
    const current = this.port.read();
    if (pageFromHash(current.hash) === page) return;
    this.port.push({ monitorDepth: depthOf(current.state) + 1 }, `${current.pathname}${current.search}#${page}`);
    this.changed(page);
  }

  restore(): void {
    this.changed(pageFromHash(this.port.read().hash));
  }

  back(): void {
    if (depthOf(this.port.read().state) > 0) this.port.back();
    else this.visit("sessions");
  }
}
