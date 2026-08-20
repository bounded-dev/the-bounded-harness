# Agent instructions: pi-harness

This repo **is** the user's live pi config home — `~/.pi/agent` symlinks here.
Every change takes effect immediately for all pi sessions on this machine.

## Rules

- **Global scope only.** Never add project-specific config; project
  dependencies belong in that project's `.pi/settings.json`.
- **Root stays language-agnostic.** Language-specific capability lives in
  `packs/<lang>/` as on-demand skills and scaffolders — never in
  `extensions/` or this file (ADR 2026-007).
- **Packages via `pi install npm:<pkg>@<version>`** (or `git:`) — pinned,
  recorded in `settings.json`. Don't hand-edit the `packages` list or touch
  `npm/`/`git/` (ADR 2026-006).
- **Never commit secrets or state.** `auth.json`, `sessions/`,
  `web-search.json` are gitignored — keep them that way.
- **Record decisions as ADRs** in `ADRs/` — `YYYY-NNN-slug.md`, very
  concise, scheme in `ADRs/README.md`. Rewrite/compact freely while young.
- **Extensions** in `extensions/` auto-load on session start. Run
  `npm run check` after editing hand-written ones. `extensions/orca-*.ts`
  are Orca-managed — never hand-edit (ADR 2026-006).
- **Canonical project commands.** Projects declare `check` / `test` /
  `build` / `lint`; look for these first in any project (ADR 2026-007).
- **Subagent roster** is minimal: `scout` (read-only), `delegate`
  (write-capable worker). Don't add roles ad hoc (ADR 2026-003).

## Git workflow — trunk-based

- Work happens in worktrees, each on a local branch (created automatically).
- Local branches always track `main`; **"push" means push to remote `main`**
  unless explicitly told otherwise.
- Long-running work pushes to a named remote feature branch only when the
  user explicitly says so.

## Current state

See `README.md` for layout and bootstrap, `ADRs/` for decisions to date.
