import { describe, expect, it } from "bun:test";
import { buildAssets } from "./assets.ts";

describe("buildAssets", () => {
  it("bundles the page in memory with no inline script or style", async () => {
    const assets = await buildAssets();
    expect(assets.js.length).toBeGreaterThan(10_000);
    expect(assets.css).toContain("--accent");
    expect(assets.html).toContain('<script type="module" src="/app.js"></script>');
    expect(assets.html).toContain('data-harness="claude"');
    // The page's content security policy allows only same-origin scripts and styles.
    expect(assets.html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(assets.html).not.toMatch(/<style\b|\sstyle=/);
  });
});
