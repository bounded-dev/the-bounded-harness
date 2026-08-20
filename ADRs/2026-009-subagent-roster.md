# 2026-009: Minimal subagent roster, matched tool allowlists

**Status:** accepted

## Decision

Two roles, defined in `agents/`:

- **scout** — read-only (`read, grep, find, ls`). Parallel investigation
  with zero collision risk; reports findings with `path:line` evidence.
- **delegate** — write-capable worker (`read, grep, find, ls, bash, edit,
  write`) for one-off background tasks.

Both inherit the parent model for now. Model strategy: add explicit
per-agent model overrides (cheap scouts, strong reviewers) only when a
second model tier is deliberately adopted — not ad hoc.

## Why

Workflows are sticky: every workflow built references whatever roster
exists, so the roster should be deliberate and minimal from the start.
Role-matched allowlists are the cheap control: parallel write-capable
workers sharing a cwd is how you get collisions; read-only scouts can fan
out freely. Write-parallel work should use isolated worktrees instead of
widening tool access.

## Consequences

- New agents are added reluctantly and recorded here (amend or supersede).
- A write-capable **reviewer** role is anticipated but not yet defined —
  add it when a workflow actually needs it.
