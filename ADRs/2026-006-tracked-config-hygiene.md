# 2026-006: Tracked config stays portable, pinned, and tool-agnostic

**Status:** accepted

## Decision

Three policies for everything tracked in this repo:

1. **Portable.** `settings.json` and extensions contain no machine-specific
   paths and no IDE/terminal-specific integrations. (A guarded loader for
   the Zentty app bundle was tried and removed when Zentty was uninstalled.)
   If a tool wants into the harness, it writes its own managed files — the
   Orca pattern — rather than harness code reaching into an app bundle.
2. **Pinned.** Third-party packages in `settings.json` carry exact versions
   (`npm:pi-subagents@0.52.1`, `npm:betterwright@1.10.0`). Versioned specs
   are skipped by `pi update`, so "review source on update" is enforced
   rather than aspirational. Bump deliberately:
   `pi install npm:<pkg>@<version>`.
3. **Orca-managed files** (`extensions/orca-*.ts`, marked
   `// @orca-managed-pi-extension`) stay tracked but are never hand-edited;
   commit Orca's rewrites promptly so the repo stays clean. Excluded from
   `npm run check` (untyped by design).

## Why

- Portability is the bootstrap story: tracked config must apply cleanly on
  any machine and OS without hand-edits.
- A harness that is live in every session wants reproducibility over
  freshness — an unpinned update previously took effect everywhere at once
  with no review gate.
- Orca owns its file paths; tracking the files keeps its rewrites visible
  in history instead of fighting the tool over location.

## Consequences

- New-machine bootstrap needs no settings edits and no sibling-repo layout
  — third-party skills are vendored into `agent/skills/` (ADR 2026-012).
- `pi update --extensions` no longer moves npm packages; check for new
  versions periodically and bump by choice.
- Occasional noise diffs when Orca updates — commit and move on.
