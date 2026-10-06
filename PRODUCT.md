# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

Developers monitoring local pstack sessions across Claude Code, Codex, subagents, and external model lanes. Large sessions must remain readable as more agents spawn. Users need to find running work and progressively inspect the work they care about.

## Workflows

The default session view is a nested, expandable list, confirmed by the user. Status and search filters narrow the visible work. A Runs view provides expandable summaries inspired by GitHub Actions; Graph retains the relationship map. Selecting an agent opens its existing live transcript and actions.

## Constraints

Use the existing Bun and TypeScript application and harness-specific themes. Preserve session selection, setup, journal controls, and monitor controls. Bind only to loopback; preserve per-start authentication and same-origin state changes. Transcript-format knowledge belongs in adapters.

## Evidence

The user supplied screenshots of the existing large graph and GitHub Actions job and step views. The existing application supplies real parent relationships, status, model, activity, prompt, result, and timeline data.
