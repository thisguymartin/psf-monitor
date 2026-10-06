import { openCodeAdapter } from "./adapters/opencode.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./adapter.ts";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { laneAdapter } from "./adapters/lane.ts";

// Where each harness keeps its files on this machine.

/** Set by pstack's runner too; both read the same variable. */
const LANES_DIR_VAR = "PSTACK_FLEX_LANES_DIR";

export interface Homes {
  readonly claude: string;
  readonly codex: string;
  readonly opencode?: string;
  /** The runner's lane journal; it exists only while journaling is on. */
  readonly lanes: string;
  /** The monitor's own state: server record and log. */
  readonly state: string;
}

function configured(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value !== undefined && value.trim().length > 0 ? value : null;
}

export function homes(env: NodeJS.ProcessEnv = process.env): Homes {
  const home = homedir();
  return {
    claude: configured(env, "CLAUDE_CONFIG_DIR") ?? join(home, ".claude"),
    codex: configured(env, "CODEX_HOME") ?? join(home, ".codex"),
    opencode: join(configured(env, "XDG_DATA_HOME") ?? join(home, ".local", "share"), "opencode"),
    lanes: configured(env, LANES_DIR_VAR) ?? join(home, ".pstack-flex", "lanes"),
    state: configured(env, "PSF_MONITOR_DIR") ?? join(home, ".psf-monitor"),
  };
}

export function adapters(where: Homes): Adapter[] {
  return [claudeAdapter(where.claude), codexAdapter(where.codex), ...(where.opencode === undefined ? [] : [openCodeAdapter(where.opencode)]), laneAdapter(where.lanes)];
}
