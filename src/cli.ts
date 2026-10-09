import { parseArgs as parseNodeArgs } from "node:util";
import { buildAssets } from "./assets.ts";
import { DEFAULT_PORT, diskSetup, serve, start, status, stop, type Io } from "./daemon.ts";
import { diagnose, renderReport } from "./doctor.ts";
import type { Harness } from "./domain.ts";
import { clearLanes, deleteLane, journalEnabled, journalOff, journalOn, listLanes } from "./journal.ts";
import { renderSetup } from "./setup.ts";
import { homes, type Homes } from "./sources.ts";

// Entry point for `psf-monitor`.

const HELP = `Usage: psf-monitor <command> [options]

Commands:
  start     Start the global monitor, or report the running one and print its link.
  status    Print a one-line summary and the link.
  stop      Stop the monitor. Agents keep running.
  doctor    Report how well recent transcripts parsed (counts only).
  setup     List pstack's skills, providers, model roles, and settings.
  journal <on|off|status|list|clear|rm <lane id>>
            Record external lanes for the monitor. \`off\` deletes the records
            and turns recording off; \`clear\` deletes them and keeps recording;
            \`rm\` deletes one lane; \`list\` shows what is recorded.
  serve     Run the server in the foreground.

Options:
  --parent <claude|codex|opencode>  The harness asking: sets the theme and focuses its session.
  --focus <session id>     Session to select first.
  --port <n>               Port on 127.0.0.1 (default ${DEFAULT_PORT}).
  --hours <n>              How far back to index (default 24).
  -h, --help               Show this help.

One monitor covers all projects in the configured harness directories.
Repeat starts reuse it, including when --port or --hours differs.
The monitor runs until \`psf-monitor stop\`.
`;

const defaultIo: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

class UsageError extends Error {}

const COMMANDS = ["start", "status", "stop", "doctor", "setup", "journal", "serve"] as const;
type Command = (typeof COMMANDS)[number];
const JOURNAL_ACTIONS = ["on", "off", "status", "list", "clear", "rm"] as const;
type JournalAction = (typeof JOURNAL_ACTIONS)[number];

export interface Options {
  readonly command: Command | "help";
  readonly journal: JournalAction;
  /** The lane `journal rm` removes. */
  readonly lane: string | null;
  readonly port: number;
  readonly hours: number;
  readonly harness: Harness | null;
  readonly focus: string | null;
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
  if (parent !== undefined && parent !== "claude" && parent !== "codex" && parent !== "opencode") {
    throw new UsageError("--parent must be claude, codex, or opencode");
  }
  const harness = parent ?? null;
  const focusValue = typeof parsed.values.focus === "string" && parsed.values.focus.length > 0 ? parsed.values.focus : null;
  const session = focusValue ?? currentSession(harness, env);
  const focus = session === null || harness === null || session.includes(":") ? session : `${harness}:${session}`;
  if (parsed.values.help === true || command === undefined || command === "help") {
    return { command: "help", journal: "status", lane: null, port, hours, harness, focus };
  }
  if (!(COMMANDS as readonly string[]).includes(command)) throw new UsageError(`unknown command: ${command}`);
  const action = parsed.positionals[1] ?? "status";
  if (command === "journal" && !(JOURNAL_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError("journal takes on, off, status, list, clear, or rm <lane id>");
  }
  const lane = parsed.positionals[2] ?? null;
  if (command === "journal" && action === "rm" && lane === null) throw new UsageError("journal rm needs a lane id; see `journal list`");
  return { command: command as Command, journal: action as JournalAction, lane, port, hours, harness, focus };
}

function laneLine(lane: ReturnType<typeof listLanes>[number]): string {
  const model = [lane.provider, lane.model].filter((part) => part !== null).join(":") + (lane.effort === null ? "" : `@${lane.effort}`);
  const size = lane.bytes >= 1_048_576 ? `${(lane.bytes / 1_048_576).toFixed(1)} MB` : lane.bytes >= 1024 ? `${Math.round(lane.bytes / 1024)} KB` : `${lane.bytes} B`;
  return `${lane.laneId}  ${lane.status.padEnd(16)}  ${(lane.startedAt ?? "?").padEnd(24)}  ${size.padStart(8)}  ${model}${lane.label === null ? "" : `  "${lane.label}"`}`;
}

function journal(where: Homes, action: JournalAction, lane: string | null, io: Io): number {
  switch (action) {
    case "list": {
      const lanes = listLanes(where.lanes);
      if (!journalEnabled(where.lanes)) io.stdout("lane journal off\n");
      else if (lanes.length === 0) io.stdout(`no recorded lanes in ${where.lanes}\n`);
      else io.stdout(`${lanes.map(laneLine).join("\n")}\n`);
      return 0;
    }
    case "clear": {
      const { deleted } = clearLanes(where.lanes);
      io.stdout(`deleted ${deleted.length} recorded lane${deleted.length === 1 ? "" : "s"}; lane journal ${journalEnabled(where.lanes) ? "stays on" : "is off"}\n`);
      return 0;
    }
    case "rm": {
      const result = deleteLane(where.lanes, lane ?? "");
      if (result === "deleted") { io.stdout(`deleted lane ${lane}\n`); return 0; }
      io.stderr(result === "invalid" ? `error: ${lane} is not a lane id; see \`journal list\`\n` : `error: no recorded lane ${lane}\n`);
      return 1;
    }
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
      return start(where, { port: options.port, windowHours: options.hours, harness: options.harness, focus: options.focus }, io);
    case "status":
      return status(where, io);
    case "stop":
      return stop(where, io);
    case "journal":
      return journal(where, options.journal, options.lane, io);
    case "serve":
      return serve(where, { port: options.port, windowHours: options.hours, assets: buildAssets }, io);
    case "setup":
      io.stdout(renderSetup(diskSetup(where, [process.cwd()])));
      return 0;
    case "doctor": {
      const report = await diagnose(where, Date.now() - options.hours * 3_600_000);
      io.stdout(renderReport(report, options.hours));
      return report.health.some((source) => source.state !== "ok") ? 1 : 0;
    }
  }
}
