# Agent instructions: pi-harness

This repo **is** the user's live pi config home — `~/.pi/agent` symlinks here.
Every change takes effect immediately for all pi sessions on this machine.

## Rules

- **Global scope only.** Everything here applies to every project. Never add
  project-specific config; project dependencies belong in that project's
  `.pi/settings.json`.
- **Packages via `pi install`.** Add third-party packages with
  `pi install npm:<pkg>` (or `git:`), which records them in `settings.json`.
  Don't hand-edit `settings.json`'s `packages` list or touch `npm/`/`git/`.
- **Never commit secrets or state.** `auth.json`, `sessions/`, API-key files
  are gitignored — keep them that way.
- **Record decisions as ADRs.** Any change to *how the harness works* gets an
  ADR in `ADRs/` — scheme and format in `ADRs/README.md` (`YYYY-NNN-slug.md`,
  number resets yearly, very concise).
- Extensions live in `extensions/` and auto-load on session start; no install
  step. TypeScript, `import type { ExtensionAPI } from
  "@earendil-works/pi-coding-agent"`. Run `npm run check` (tsc) after editing
  any hand-written extension; `extensions/orca-*.ts` are Orca-managed — never
  hand-edit them (ADR 2026-010).
- **Canonical project commands.** Projects declare `check` / `test` / `build`
  / `lint`; look for these names first in any project before inventing
  alternatives (ADR 2026-011).
- **Subagent roster** is deliberately minimal: `scout` (read-only) and
  `delegate` (write-capable worker). Don't add roles ad hoc — ADR 2026-009.

## Current state

See `README.md` for layout and bootstrap, `ADRs/` for decisions to date.
