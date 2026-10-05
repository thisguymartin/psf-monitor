---
name: monitor
description: "Open a live local view of the pstack sessions on this machine: every subagent they spawn and every external model lane pstack's runner launches, with each agent's activity streaming in a drill-down panel and buttons to cancel running lanes. Also stops it. Use for /monitor, 'show me the agents', 'what is running', watching an arena, swarm, or interrogate fan-out, or 'stop / kill / shut down the monitor'."
---

# Monitor

Start psf-monitor and hand the user its link, or stop it when asked.

Match the request to one command and run only that one:

| The user asks to | Run |
| --- | --- |
| open, show, or start the monitor (the default) | `psf-monitor start --parent <claude\|codex>` |
| stop, kill, close, or shut down the monitor | `psf-monitor stop` |
| check whether it is running, or get the link again | `psf-monitor status` |

The launcher is `bin/psf-monitor` at the plugin root, two directories above this skill's base directory. Run it with the harness you are running in:

```text
<plugin root>/bin/psf-monitor start --parent <claude|codex>
```

`start` returns at once. It reuses a running monitor of the same build, replaces one from an older build, or launches a new one in the background, then prints one link. Give the user that link exactly as printed and say nothing else is needed. The link carries the server's access token: never paste it anywhere but the reply to the user, and never open it with a fetch tool.

The page shows only pstack sessions: a session appears once it uses a pstack skill, spawns a pstack subagent, or launches a pstack lane. Other Claude Code and Codex sessions stay hidden.

The first `start` also turns on pstack's lane journal, so external lanes launched through `pstack-runner` appear while they run, and says so on stderr. Relay that line: the journal keeps lane output on disk for 7 days, and `psf-monitor journal off` stops it and deletes what it kept.

`--parent` sets the page's theme (warm for Claude Code, blue for Codex) and selects your own session first. It names the harness you are; it does not route anything.

`stop` ends the monitor server only and never touches the sessions or agents the page shows. It waits until the server has exited, then prints `psf-monitor stopped`, or `psf-monitor is not running` when there was nothing to stop. Relay that line. Stopping leaves the lane journal as it is; `journal off` is a separate request.

Other commands:

- `psf-monitor doctor` reports how well recent transcripts parsed, as counts only. Run it when the page warns that a source is degraded or newer than the monitor was checked against, and relay the result.
- `psf-monitor journal <on|off|status>` controls the lane journal.

The monitor needs Bun on `PATH`. If `start` fails because the sandbox blocks a local port or `~/.psf-monitor`, do not raise permissions. Give the user the command to run in their own terminal; in Claude Code they can type it after `!`.
