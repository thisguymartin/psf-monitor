---
name: monitor
description: "Open a live local view of pstack work on this machine: every session that runs pstack and every agent it spawns, including native Claude and Codex subagents and external Codex, Grok, DeepSeek, and MiniMax lanes, with what each is doing now and a button to cancel a running lane. Also stops it. Use for /monitor, 'show me the agents', 'what is running', watching an arena, swarm, or interrogate fan-out, or 'stop / kill / shut down the monitor'."
---

# Monitor

Run one command and relay its output.

| The user asks to | Run |
| --- | --- |
| open, show, or start the monitor (the default) | `psf-monitor start --parent <claude\|codex>` |
| stop, kill, close, or shut down the monitor | `psf-monitor stop` |
| check whether it is running, or get the link again | `psf-monitor status` |

The launcher is `bin/psf-monitor` at the plugin root, two directories above this skill's base directory. Pass the harness you are running in as `--parent`.

`start` returns at once and prints one link. Give the user that link exactly as printed. The link carries an access token: never paste it anywhere else, and never open it with a fetch tool.

The page shows pstack sessions only. A session appears once it runs a pstack skill or command, spawns a pstack agent, or launches a pstack lane.

The first `start` also turns on pstack's lane journal and says so on stderr. Relay that line: lane output is kept on disk for 7 days, and `psf-monitor journal off` stops it and deletes what it kept.

`stop` ends the monitor only, never an agent. To cancel a running pstack lane, the user clicks Cancel in that lane's panel on the page. To stop a Claude Code or Codex session, the user interrupts it in its own terminal.

`psf-monitor doctor` reports how well recent transcripts parsed. Run it when the page warns that a source is degraded, and relay the result.

The monitor needs Bun on `PATH`. If `start` fails because the sandbox blocks a local port, `~/.psf-monitor`, or `~/.pstack-flex/lanes`, do not raise permissions. Give the user the command to run; in Claude Code they can type it after `!`.
