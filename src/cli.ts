import { parseArgs as parseNodeArgs } from "node:util";
import { buildAssets } from "./assets.ts";
import { DEFAULT_PORT, serve, start, status, stop, type Io, type Scope } from "./daemon.ts";
import { diagnose, renderReport } from "./doctor.ts";
import type { Harness } from "./domain.ts";
import { journalEnabled, journalOff, journalOn } from "./journal.ts";
import { homes, type Homes } from "./sources.ts";

// Entry point for `psf-monitor`.

const HELP = `Usage: psf-monitor <command> [options]

Commands:
  start     Start the monitor, or reuse the running one, and print its link.
  status    Print a one-line summary and the link.
  stop      Stop the monitor. Agents keep running.
  doctor    Report how well recent transcripts parsed (counts only).
  journal <on|off|status>
            Record external lanes for the monitor. \`off\` deletes the records.
  serve     Run the server in the foreground.

Options:
  --parent <claude|codex>  The harness asking: sets the theme and focuses its session.
  --focus <session id>     Session to select first.
  --all                    Show every session, not only pstack's.
  --port <n>               Port on 127.0.0.1 (default ${DEFAULT_PORT}).
  --hours <n>              How far back to index (default 24).
  -h, --help               Show this help.

The monitor runs until \`psf-monitor stop\`.
`;

const defaultIo: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

class UsageError extends Error {}

const COMMANDS = ["start", "status", "stop", "doctor", "journal", "serve"] as const;
type Command = (typeof COMMANDS)[number];
const JOURNAL_ACTIONS = ["on", "off", "status"] as const;
type JournalAction = (typeof JOURNAL_ACTIONS)[number];

export interface Options {
  readonly command: Command | "help";
  readonly journal: JournalAction;
  readonly port: number;
  readonly hours: number;
  readonly harness: Harness | null;
  readonly focus: string | null;
  readonly scope: Scope;
}

function positiveNumber(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`--${name} must be a number greater than zero`);
  return parsed;
}

/** The harness's own session id, read from the environment it gives its tools. */
function currentSession(harness: Harness | null, env: NodeJS.ProcessEnv): string | null {
  const value = harness === "claude" ? env.CLAUDE_CODE_SESSION_ID : harness === "codex" ? env.CODEX_THREAD_ID : undefined;
  return value !== undefined && value.length > 0 ? value : null;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        parent: { type: "string" },
        focus: { type: "string" },
        port: { type: "string" },
        hours: { type: "string" },
        all: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const command = parsed.positionals[0];
  const port = positiveNumber("port", parsed.values.port, DEFAULT_PORT);
  if (!Number.isInteger(port) || port > 65_535) throw new UsageError("--port must be an integer port number");
  const hours = positiveNumber("hours", parsed.values.hours, 24);
  const parent = parsed.values.parent;
  if (parent !== undefined && parent !== "claude" && parent !== "codex") {
    throw new UsageError("--parent must be claude or codex");
  }
  const harness = parent ?? null;
  const focusValue = typeof parsed.values.focus === "string" && parsed.values.focus.length > 0 ? parsed.values.focus : null;
  const session = focusValue ?? currentSession(harness, env);
  const focus = session === null || harness === null || session.includes(":") ? session : `${harness}:${session}`;
  const scope: Scope = parsed.values.all === true ? "all" : "pstack";
  if (parsed.values.help === true || command === undefined || command === "help") {
    return { command: "help", journal: "status", port, hours, harness, focus, scope };
  }
  if (!(COMMANDS as readonly string[]).includes(command)) throw new UsageError(`unknown command: ${command}`);
  const action = parsed.positionals[1] ?? "status";
  if (command === "journal" && !(JOURNAL_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError("journal takes on, off, or status");
  }
  return { command: command as Command, journal: action as JournalAction, port, hours, harness, focus, scope };
}

function journal(where: Homes, action: JournalAction, io: Io): number {
  switch (action) {
    case "on":
      io.stdout(journalOn(where.lanes) === "enabled"
        ? `lane journal on: external lanes are recorded in ${where.lanes} and kept 7 days\n`
        : `lane journal is already on (${where.lanes})\n`);
      return 0;
    case "off":
      io.stdout(journalOff(where.lanes) === "disabled"
        ? `lane journal off: deleted ${where.lanes}\n`
        : "lane journal is already off\n");
      return 0;
    case "status":
      io.stdout(journalEnabled(where.lanes) ? `lane journal on (${where.lanes})\n` : "lane journal off\n");
      return 0;
  }
}

export async function main(
  argv: readonly string[],
  io: Io = defaultIo,
  where: Homes = homes(),
): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    return 64;
  }
  switch (options.command) {
    case "help":
      io.stdout(HELP);
      return 0;
    case "start":
      return start(where, { port: options.port, windowHours: options.hours, harness: options.harness, focus: options.focus, scope: options.scope }, io);
    case "status":
      return status(where, io, options.scope);
    case "stop":
      return stop(where, io);
    case "journal":
      return journal(where, options.journal, io);
    case "serve":
      return serve(where, { port: options.port, windowHours: options.hours, assets: buildAssets }, io);
    case "doctor": {
      const report = await diagnose(where, Date.now() - options.hours * 3_600_000);
      io.stdout(renderReport(report, options.hours));
      return report.health.some((source) => source.state !== "ok") ? 1 : 0;
    }
  }
}
