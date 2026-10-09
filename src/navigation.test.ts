import { describe, expect, it } from "bun:test";
import { Navigation, pageFromHash, type HistoryPort, type Page } from "./navigation.ts";

function browser(url: string) {
  const entries = [{ url: new URL(url, "http://127.0.0.1:47317"), state: null as unknown }];
  let position = 0;
  const seen: Page[] = [];
  const port: HistoryPort = {
    read: () => ({ ...{ pathname: entries[position].url.pathname, search: entries[position].url.search, hash: entries[position].url.hash }, state: entries[position].state }),
    push: (state, url) => { entries.splice(++position); entries.push({ url: new URL(url, entries[0].url), state }); },
    replace: (state, url) => { entries[position] = { url: new URL(url, entries[0].url), state }; },
    back: () => { position = Math.max(0, position - 1); navigation.restore(); },
  };
  const navigation = new Navigation(port, (page) => seen.push(page));
  return { navigation, entries, seen, current: port.read, forward: () => { position = Math.min(entries.length - 1, position + 1); navigation.restore(); } };
}

describe("workspace navigation", () => {
  it("returns through visited pages with Back and Forward without losing link parameters", () => {
    const app = browser('/?scope=all&focus=claude%3Ademo#sessions');
    app.navigation.visit("overview");
    app.navigation.visit("models");
    app.navigation.back();
    expect(app.current().hash).toBe("#overview");
    app.navigation.back();
    expect(app.current().hash).toBe("#sessions");
    app.forward();
    expect(app.current().hash).toBe("#overview");
    expect(app.current().search).toBe("?scope=all&focus=claude%3Ademo");
    expect(app.seen).toEqual(["overview", "models", "overview", "sessions", "overview"]);
    expect(app.entries).toHaveLength(3);
  });

  it("provides a Sessions fallback for a directly opened configuration page", () => {
    const app = browser('/?harness=codex#providers');
    app.navigation.back();
    expect(app.current().hash).toBe("#sessions");
    expect(app.current().search).toBe("?harness=codex");
  });

  it("keeps old setup links useful and avoids duplicate visits", () => {
    const app = browser('/#setup');
    expect(app.current().hash).toBe("#overview");
    app.navigation.visit("overview");
    expect(app.entries).toHaveLength(1);
    expect(pageFromHash('#unknown')).toBe('sessions');
  });
});
