# Agent instructions: pi-harness

This repo **is** the user's live pi config home — `~/.pi/agent` symlinks here.
Every change takes effect immediately for all pi sessions on this machine.

**This is an open-source project.** Write everything in this repository —
docs, comments, commit messages, gate output, ADRs — for a wide audience of
potential users, not for one machine or one person. No private information:
no credentials, no personal paths presented as canon, no context that only
makes sense to the original author. If a note is genuinely machine- or
person-specific, it belongs in an untracked local file, not here.

**Know the destination.** `docs/VISION.md` is the long-term picture this
harness is building toward — the harness as the owned product, guidance
composed in layers (generic → language → stack → domain), enforcement scaling
where prose cannot. Any non-trivial work on the harness should be shaped with
that end state in mind: prefer designs that survive hundreds of layered
rules, not just today's dozens.

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
- **Determinism over minimalism.** The harness is deliberately built so
  agent output has near-zero chance of deviation: prefer compiler, lint,
  tool-allowlist, and gate-script enforcement over prompt instructions,
  and stack enforcement layers even when one looks over-engineered for
  the present workload. Deterministic guardrails are the product, not a
  cost to be justified per-task.
- **Record decisions as ADRs** in `ADRs/` — `YYYY-NNN-slug.md`, very
  concise, scheme in `ADRs/README.md`. Rewrite/compact freely while young.
- **Extensions** in `extensions/` auto-load on session start. Run
  `npm run check` after editing hand-written ones. `extensions/orca-*.ts`
  are Orca-managed: untracked runtime state, installed by Orca at
  runtime — never hand-edit, never commit (ADR 2026-006).
- **Canonical project commands.** Projects declare `check` / `test` /
  `build` / `lint`; look for these first in any project (ADR 2026-007).
- **Subagent roster** is minimal: `scout` (read-only), `delegate`
  (write-capable worker), `product-expert` — "the PM" (read-only + web,
  product judgment). Don't add roles ad hoc (ADR 2026-003).

## Issue tracking

All work is tracked in GitHub Issues plus a per-repo board (GitHub Projects
v2). Use the `issue-tracking` skill for anything involving issues, boards, or
work status. Temporary agent working files live in the repo's `.agent-state/`
(gitignored).

> Revisit the issue-tracking skill as the development-workflow (do-work-style)
> port lands — enforcement and worktree conventions belong there, not here.

## Git workflow — trunk-based

- Work happens in worktrees, each on a local branch (created automatically).
- Local branches always track `main`; **"push" means push to remote `main`**
  unless explicitly told otherwise.
- Long-running work pushes to a named remote feature branch only when the
  user explicitly says so.

## Current state

See `README.md` for layout and bootstrap, `ADRs/` for decisions to date.
