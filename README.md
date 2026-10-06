# psf-monitor

psf-monitor is a live local view of [pstack](https://github.com/thisguymartin/pstack-flex) work on your machine. It draws each pstack session in Claude Code, Codex, or OpenCode as a tree of steps: the pstack skills it ran, the skills those skills started, and the subagents and external model lanes each skill launched. Click any step to see what started it, its model, what it is doing now, and its final response.

```
session
└─ poteto-mode            typed by you · opus 5.5
   ├─ lane "bug-fix"      gpt-6-sol · final response
   └─ deslop              step 2
      └─ no-comments      step 1
         └─ subagent comment-sicko   final response
```

It shows pstack sessions only. A session appears once it runs a pstack skill or `/pstack:` command, spawns a pstack agent, or launches a pstack lane. Other Claude Code, Codex, and OpenCode sessions never reach the page.

The monitor is global for your OS user, across all projects in the configured Claude Code, Codex, OpenCode, and pstack lane directories. The directory you launch it from does not limit what it sees. `--parent` and `--focus` only choose the initial theme and selected session. By default it indexes the last 24 hours.

Only one monitor runs per state directory (`~/.psf-monitor/` by default). Starting it again reports **already running globally** and returns the existing monitor's link, even if you request another port or launch from another checkout. Concurrent starts and foreground `serve` use the same instance lock. To change the port, history window, source directories, or running build, stop the monitor and start it again. `PSF_MONITOR_DIR` is an explicit override for isolated environments; using different values intentionally creates separate instances.

From the page you can:

- Browse agents in the default **Nested** list, expanding branches as needed. Switch to **Runs** for expandable task, activity, and result summaries, or **Graph** for the relationship map.
- Filter by status (including running only), agent type, or search across names, models, and latest activity. Nested and Graph keep matching agents' parents for context. Toggle **Show skills** to simplify the hierarchy.
- Open an agent's live transcript from any view. View choice is remembered; filters and expanded branches stay in place while live updates arrive.
- Cancel a running pstack lane. The monitor sends SIGTERM to the lane's runner, and the runner records a `cancelled` receipt.
- Copy the command that resumes a Claude Code, Codex, or OpenCode session.
- Turn pstack's lane journal on or off.
- Open **Setup** to see pstack's skills, providers, model roles, and settings.
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
bin/psf-monitor setup
bin/psf-monitor journal <on|off|status>
```

| Option | Effect |
| --- | --- |
| `--parent <claude\|codex>` | Sets the page theme and selects that harness's current session. |
| `--focus <session id>` | Selects a session first. |
| `--port <n>` | Port on 127.0.0.1. The default is 47317. |
| `--hours <n>` | How far back to index. The default is 24. |

## Skills as steps

Claude Code records which skill was active when each transcript record was written, and the call that starts a skill records the skill that called it. psf-monitor uses that to place each pstack skill run under the run that triggered it, and each subagent or lane under the skill that was active when it started. Siblings are numbered in the order they started.

- A skill you typed as a `/pstack:` command shows "typed by you". A skill the model chose on its own shows "the model's choice".
- A lane is matched to the command that launched it by its receipt path, output path, or label, or else by time.
- A skill's panel shows its trigger, the agent running it, its model, its steps, and its last text as markdown. A subagent or lane shows its final response as markdown; a lane's comes from the output file pstack's runner wrote.
- **Skills: shown / hidden** in the canvas controls switches to an agents-only view. Drag a card to move it, or Shift-drag to move it with everything under it; positions are kept per session, and **Reset layout** clears them.
- Codex records no skill attribution. A Codex skill run starts when the thread reads a pstack `SKILL.md`, and Codex runs stay flat under their thread.

## Setup view

**Setup** in the top bar switches from the session graph to a view of how pstack is configured on this machine. `psf-monitor setup` prints the same list in a terminal.

- **Providers.** One card for each provider in pstack's model matrix: Claude, Codex, Grok, DeepSeek, MiniMax, and any provider a later pstack adds. A card shows the provider's models, whether its CLI is on `PATH`, the roles assigned to it, and its agents in the indexed window. A provider that is not in the matrix gets a card once one of its lanes runs.
- **API key providers.** DeepSeek and MiniMax cards also show whether the key variable is set, the endpoint, and the config directory. The page reports only that a key is set, never its value. When the key is missing, the card lists the commands that store it in your keychain and load it into your shell.
- **Model roles.** The lanes each role runs on, from `~/.claude/pstack-models.md` and `~/.codex/pstack-models.md`, or pstack's first-run roles when no sheet exists. A lane whose provider cannot start is marked.
- **Skills.** Every skill in the installed pstack with its description, the roles it fans out, and its runs in the indexed window. Filter by name, sort by use, and show or hide the principle leaves.
- **Settings.** The lane journal, the indexed window, the address, the installed pstack versions, and the directories with the variable that moves each.

The view reads; it does not write. Change a role's model or a family's effort with `/pstack:setup-pstack`, which probes each model before it writes the sheet. A lane reads its API key from the session that launches it, so the monitor cannot set one. The key and CLI checks use the environment the monitor started with; start it from the shell that starts your sessions.

## Sending messages

Agent details open at the full available width every time. Drag the edge to resize for the current opening, or use the width toggle.

Expand **Send a message** in an agent’s details:

- **Steer at next step** adds your guidance at the next tool boundary (or before the agent finishes).
- **Follow up after this work** waits until the agent finishes its current turn, then asks it to continue with your request. Resuming an idle session also delivers waiting messages.

Messaging currently supports Claude Code and Codex. OpenCode observation and resume commands work, but OpenCode message delivery is not available.

Enable the psf-monitor plugin in your harness and restart/resume the session to load its hooks. In Codex, review and trust the bundled hook definition when prompted; installing the plugin alone does not grant hook trust. Bun must be on the harness’s `PATH`. If you only launch the standalone monitor, observation works but messaging needs the plugin installed too.

The composer names the recipient. Native sessions/subagents receive their own messages; skills and external model lanes route messages to their owning agent. Lane processes cannot receive arbitrary prompts directly. Steering does not interrupt an in-flight tool, and messages do not wake idle agents. Use the session’s terminal to interrupt immediately.

**Queued** means the message is waiting. **Delivered to hook** means the harness hook consumed it, not that the agent completed the request. Remove a queued message before delivery if needed. Messages expire after 24 hours; each recipient can hold up to 20 queued messages of 2000 characters. The private inbox lives in `~/.psf-monitor/messages.sqlite` (or `PSF_MONITOR_DIR`); use the same directory for the server and harness hooks.

To monitor OpenCode, run `bun bin/psf-monitor start --parent opencode` from this checkout. No OpenCode hooks are needed for observation.

## How it works

Observation reads files the harnesses already write and needs no hooks. Message delivery uses the plugin’s bundled command hooks; the monitor does not edit your harness settings.

- **Claude Code.** Session and subagent transcripts under `~/.claude/projects/`, their `.meta.json` sidecars, and process records in `~/.claude/sessions/`. `CLAUDE_CONFIG_DIR` moves them.
- **Codex.** Rollouts under `~/.codex/sessions/`. `CODEX_HOME` moves them.
- **OpenCode.** Native sessions and child sessions from `~/.local/share/opencode/opencode.db`, opened read-only, including live WAL updates. `XDG_DATA_HOME` moves the data directory. Text, reasoning, tools, turn status, models, and token usage are indexed. OpenCode runner lanes use the same lane journal as other providers. Lanes without a parent session ID attach only when an OpenCode tool command contains their exact output or receipt path in the same working directory; otherwise they remain separate roots.
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
| Setup says a key is not set, but your shell has it | The monitor started from another environment. | `psf-monitor stop`, then `start` from that shell. |

## Development

```text
bun install
bun test src
bun run typecheck
claude plugin validate .
```

## License

MIT. psf-monitor started as the agent monitor in pstack-flex.
