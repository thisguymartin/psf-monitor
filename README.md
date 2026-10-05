# psf-monitor

psf-monitor is a live local view of [pstack](https://github.com/thisguymartin/pstack-flex) work on your machine. It draws each pstack session in Claude Code or Codex, every subagent it spawns, and every external model lane pstack's runner launches. Click an agent to see its task, what it is doing now, and its full activity as it streams.

It shows pstack sessions only. A session appears once it runs a pstack skill or `/pstack:` command, spawns a pstack agent, or launches a pstack lane. Other Claude Code and Codex sessions never reach the page.

From the page you can:

- Cancel a running pstack lane. The monitor sends SIGTERM to the lane's runner, and the runner records a `cancelled` receipt.
- Copy the command that resumes a Claude Code or Codex session.
- Turn pstack's lane journal on or off.
- Stop the monitor.

## Requirements

- [Bun](https://bun.sh) on `PATH`.
- pstack ([pstack-flex](https://github.com/thisguymartin/pstack-flex)) installed in Claude Code or Codex.

## Install

Claude Code:

```text
/plugin marketplace add thisguymartin/psf-monitor
/plugin install psf-monitor@psf-monitor
```

Codex:

```text
codex plugin marketplace add thisguymartin/psf-monitor
codex plugin add psf-monitor@psf-monitor
```

## Use

In Claude Code, run `/psf-monitor:monitor`. In Codex, ask for `psf-monitor:monitor`. The skill starts the server in the background and prints a link such as `http://127.0.0.1:47317/?token=…`. Open it in your browser.

The link carries an access token that changes each time the monitor starts. The monitor runs until you stop it from the page, ask the skill to stop it, or run `psf-monitor stop`.

You can also run the launcher directly from a clone:

```text
bin/psf-monitor start
bin/psf-monitor status
bin/psf-monitor stop
bin/psf-monitor doctor
bin/psf-monitor journal <on|off|status>
```

| Option | Effect |
| --- | --- |
| `--parent <claude\|codex>` | Sets the page theme and selects that harness's current session. |
| `--focus <session id>` | Selects a session first. |
| `--port <n>` | Port on 127.0.0.1. The default is 47317. |
| `--hours <n>` | How far back to index. The default is 24. |

## How it works

psf-monitor reads files the harnesses already write. It adds no hook and changes no harness setting.

- **Claude Code.** Session and subagent transcripts under `~/.claude/projects/`, their `.meta.json` sidecars, and process records in `~/.claude/sessions/`. `CLAUDE_CONFIG_DIR` moves them.
- **Codex.** Rollouts under `~/.codex/sessions/`. `CODEX_HOME` moves them.
- **pstack lanes.** pstack's runner writes a lane journal under `~/.pstack-flex/lanes/` while that directory exists: `lane.json`, `stream.jsonl` with output as it arrives, and a copy of `receipt.json`. `PSTACK_FLEX_LANES_DIR` moves it. The first `start` creates the directory. `journal off` deletes it and everything it recorded. The server prunes lanes older than 7 days.
- **Own state.** The server record and log live in `~/.psf-monitor/`. `PSF_MONITOR_DIR` moves them.

Status comes from evidence, never from file times: live process records, turn boundaries, parent tool results, and lane receipts.

`src/pstack.ts` mirrors schema version 1 of the lane journal. The writer is `runner/flex-journal.ts` in pstack-flex, and a change to one needs a matching change to the other.

## Security

The server binds 127.0.0.1 only. It rejects foreign `Host` and `Origin` headers. Every route except a data-free health check requires the per-start token, which the link exchanges for an `HttpOnly`, `SameSite=Strict` cookie. A request that changes anything must also send a same-origin `Origin` header and a JSON body. Transcript text is rendered only as text.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `port 47317 is unavailable` | Another program uses the port. | `psf-monitor start --port 47400` |
| The page says the link expired | The monitor restarted. | Run `start` again and open the new link. |
| A banner says a source is degraded | A CLI update changed its transcript format. | Run `psf-monitor doctor` and open an issue with its output. |
| A lane never appears | The journal was off when the lane started. | `psf-monitor journal on`, then rerun the lane. |
| A session is missing | It has not used pstack yet. | It appears once it runs a pstack skill or launches a lane. |

## Development

```text
bun install
bun test src
bun run typecheck
claude plugin validate .
```

## License

MIT. psf-monitor started as the agent monitor in pstack-flex.
