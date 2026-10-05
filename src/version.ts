import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A version that changes whenever the installed monitor
// code changes, so `start` can replace a server left over from another build.

const MONITOR_DIR = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_DIR = join(MONITOR_DIR, "..");

function pluginVersion(): string {
  for (const manifest of [".claude-plugin", ".codex-plugin"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(PLUGIN_DIR, manifest, "plugin.json"), "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // Try the other harness's manifest.
    }
  }
  return "dev";
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (!entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
}

export function monitorVersion(): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of sourceFiles(MONITOR_DIR)) {
    hasher.update(file.slice(MONITOR_DIR.length));
    hasher.update(readFileSync(file));
  }
  return `${pluginVersion()}+${hasher.digest("hex").slice(0, 10)}`;
}
