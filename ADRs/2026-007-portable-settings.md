# 2026-007: settings.json stays portable; machine-specific extensions are guarded

**Status:** accepted

## Decision

`settings.json` contains only portable entries. Machine-specific extensions
load through guarded harness extensions: `extensions/zentty.ts` checks for
the Zentty app bundle's absolute path and dynamically imports it when
present, no-op otherwise. pi has no per-machine settings overlay (only
global + project), so the guard lives in code, not config.

## Why

An absolute macOS path (`/Applications/Zentty.app/...`) was committed in the
global extensions list — a second machine (or Linux/WSL) would break or need
hand-edits to a tracked file. Portability is the bootstrap story; tracked
config must apply cleanly everywhere.

## Consequences

- Bootstrap on a new machine needs no settings edits.
- The `../bounded-dev/skills` sibling-directory requirement remains (already
  documented in README); everything else in settings.json is
  machine-agnostic.
- If the Zentty extension misbehaves under dynamic import, fall back to a
  per-machine uncommitted `extensions` entry and revisit.
