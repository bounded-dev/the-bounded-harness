# 2026-010: Orca-managed extensions stay tracked; never hand-edit

**Status:** accepted

## Decision

`extensions/orca-*.ts` files (marked `// @orca-managed-pi-extension`) remain
tracked in git alongside hand-written extensions. Policy: never hand-edit
them; when Orca rewrites one, commit the diff promptly so the repo stays
clean. They are excluded from `npm run check` (untyped by design).

## Why

Orca writes these files at a fixed path it owns; moving them to a gitignored
subdirectory would just have Orca recreate them at the old path. The
realistic choice was accept-and-document vs. fighting the tool. Tracking
them keeps the harness reproducible and the diffs visible — Orca's rewrites
show up in history instead of being invisible.

## Consequences

- Occasional noise diffs when Orca updates — commit and move on.
- Hand-written extensions must not depend on orca-managed modules.
- If the noise becomes real, revisit with an `extensions/orca/` +
  gitattributes or ignore scheme.
