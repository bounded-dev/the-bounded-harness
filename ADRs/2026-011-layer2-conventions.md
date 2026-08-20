# 2026-011: Layer 2 conventions — canonical project commands, skills split

**Status:** accepted

## Decision

The harness stays language-agnostic; multi-app leverage lives in Layer 2
(projects). Two conventions are fixed now, before projects accumulate:

1. **Canonical commands.** Every project declares `check`, `test`, `build`,
   `lint` (npm scripts or equivalent) in its committed `.pi/settings.json`
   context / AGENTS.md. Any agent session in any project looks for these
   names first. A TS project template repo (carrying a committed
   `.pi/settings.json`, project AGENTS.md, and these scripts) is the
   vehicle — to be created as its own repo.
2. **Skills split.** `skills/` here: harness-procedural skills (how to work
   with this harness). `bounded-dev/skills`: standalone utilities
   (flight-status style). App-building procedural skills ("new TS service",
   "release", "db migration") belong in the project template, not the global
   harness.

## Why

Retrofitting conventions across N live projects is the most expensive
change on the horizon; defining the convention costs almost nothing now.
Keeping TS specifics out of the harness preserves the "stock pi + this
repo" litmus test (2026-001).

## Consequences

- Harness AGENTS.md documents the canonical-command convention so every
  session inherits it.
- Next concrete step: create the TS project template repo; until then this
  ADR is the contract projects conform to.
