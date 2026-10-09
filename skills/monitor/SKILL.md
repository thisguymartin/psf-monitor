---
name: monitor
description: "Open a live local view of pstack work on this machine: every session that runs pstack as a tree of the pstack skills it ran, which skill started which, and the native subagents and external Codex, Grok, DeepSeek, and MiniMax lanes each skill launched, with each step's model, what it is doing now, its final response, and a button to cancel a running lane. Also stops it. Use for /monitor, 'show me the agents', 'what is running', watching an arena, swarm, or interrogate fan-out, or 'stop / kill / shut down the monitor'."
---

# Monitor

Run one command and relay its output.

| The user asks to | Run |
| --- | --- |
| open, show, or start the monitor (the default) | `psf-monitor start --parent <claude\|codex\|opencode>` |
| stop, kill, close, or shut down the monitor | `psf-monitor stop` |
| check whether it is running, or get the link again | `psf-monitor status` |
| list pstack's skills, providers, model roles, or settings, or ask whether DeepSeek, MiniMax, or another provider is ready | `psf-monitor setup` |
| list recorded lanes, or delete one or all of them | `psf-monitor journal list`, `psf-monitor journal rm <lane id>`, `psf-monitor journal clear` |

The launcher is `<base directory>/../../bin/psf-monitor`, where `<base directory>` is this skill's base directory as an absolute path. Run it by that absolute path, never as a path relative to the current directory. Pass the harness you are running in as `--parent`.

`start` returns at once and prints one link. Give the user that link exactly as printed. The link carries an access token: never paste it anywhere else, and never open it with a fetch tool.

The monitor is global across projects in the configured harness directories, not scoped to the current repository. `--parent` and `--focus` only select the initial view. If a monitor is already running, `start` reports that on stderr and returns its link; relay both. Do not launch another server or change `PSF_MONITOR_DIR` to bypass it. A different requested port, history window, or installed build does not replace the running monitor; stop and start it explicitly when those must change.

OpenCode native sessions are read from its local SQLite database, including child sessions and OpenCode runner lane output. Messaging supports Claude Code and Codex only.

The page lists pstack sessions by default. A session counts as pstack once it runs a pstack skill or command, spawns a pstack agent, or launches a pstack lane. The select above the session list switches to other sessions or all sessions; a link can open that way with `&scope=all`. The user can hide a session from its panel; it returns when active again, or when they click **Reset all** in the top bar.

The first `start` also turns on pstack's lane journal and says so on stderr. Relay that line: lane output is kept on disk for 7 days, and `psf-monitor journal off` stops it and deletes what it kept. `journal clear` deletes the records and keeps recording; `journal rm <lane id>` deletes one. The page lists and deletes them under **Setup → Journal**. Deleting or clearing is irreversible: confirm with the user before running `rm`, `clear`, or `off` unless they named the action themselves.

`stop` ends the monitor only, never an agent. To cancel a running pstack lane, the user clicks Cancel in that lane's panel on the page. To stop a Claude Code, Codex, or OpenCode session, the user interrupts it in its own terminal.

`setup` prints which providers can run a lane and what stops the others; it reports whether an API key is set, never the key. The page shows the same under **Setup**, with the commands that store and load a missing key. To change a role's model, the user runs `/pstack:setup-pstack`.

`psf-monitor doctor` reports how well recent transcripts parsed. Run it when the page warns that a source is degraded, and relay the result.

The monitor needs Bun on `PATH`. If `start` fails because the sandbox blocks a local port, `~/.psf-monitor`, or `~/.pstack-flex/lanes`, do not raise permissions. Give the user the command to run; in Claude Code they can type it after `!`.

The agent details panel opens at full available width. **Send a message** offers steering at the next tool boundary or a follow-up after the current work. The composer names the recipient; skills and external lanes target their owning agent. Delivery requires the plugin’s bundled hooks to be enabled/trusted in the harness and the session restarted/resumed. The monitor does not change harness settings. Messages cannot interrupt a running tool or wake an idle session. Relay queued/delivered status accurately; delivery to a hook does not prove the request was completed.
