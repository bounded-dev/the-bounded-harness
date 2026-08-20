# 2026-003: Subagents via pi-subagents, builtins disabled

**Status:** accepted

## Decision

Adopt `npm:pi-subagents` for subagent capability. Disable all bundled agents
(scout, researcher, worker, reviewer, oracle, delegate) via
`"subagents": { "disableBuiltins": true }` in `settings.json`. Custom agent
definitions live as markdown in `agents/` (user scope), tracked in this repo.

## Why

- The wanted part is the **runtime**: spawning child pi sessions,
  foreground/background runs, fleet observability, mid-run steering/intercom,
  spawn budgets and recursion guards, worktree isolation. Building that
  ourselves is expensive (unlike `web.ts`, ADR 2026-002).
- The unwanted part (the bundled roster) is thin markdown; disabling it is one
  settings line that travels with the harness.
- A "team lead" is just a custom agent with spawn rights; nothing extra needed.

## Consequences

- We depend on a third-party package with system access; review on update
  (`pi update --extensions`).
- Custom agents in `agents/` shadow builtins by name if ever re-enabled.
- Selective re-enable per agent: `subagent({ action: "enable", agent })` or
  `subagents.agentOverrides`.
