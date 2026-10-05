import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assets } from "./server.ts";

// Bundles the page in memory when the server starts, so
// the installed plugin needs no build step and writes nothing to disk.

const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));

export async function buildAssets(): Promise<Assets> {
  const result = await Bun.build({
    entrypoints: [join(WEB_DIR, "main.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  const bundle = result.outputs[0];
  if (!result.success || bundle === undefined) {
    throw new Error(`could not bundle the monitor page:\n${result.logs.map(String).join("\n")}`);
  }
  return {
    html: readFileSync(join(WEB_DIR, "index.html"), "utf8"),
    css: readFileSync(join(WEB_DIR, "app.css"), "utf8"),
    js: await bundle.text(),
  };
}
