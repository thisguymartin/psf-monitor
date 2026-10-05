# psf-monitor

A live local view of pstack sessions, their subagents, and pstack's external model lanes. It ships as one plugin for Claude Code and Codex: `skills/monitor` is the entry point and `bin/psf-monitor` is the launcher.

Before opening a pull request, run `bun test src`, `bun run typecheck`, and `claude plugin validate .`.

`src/adapters/` is the only code that knows a transcript format. `src/pstack.ts` mirrors pstack's lane journal schema; change it only together with pstack-flex's `runner/flex-journal.ts`.

The server binds 127.0.0.1 only. Every route except the health check requires the per-start token, and every request that changes state also requires a same-origin `Origin` header.
