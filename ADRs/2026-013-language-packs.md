# 2026-013: Language packs in `packs/`; monorepo split deferred

**Status:** accepted

## Decision

Language-specific harness capability lives in `packs/<lang>/` — a pi package
inside this repo, loaded via a local-path entry in `settings.json`
(`"./packs/ts"`). No npm workspaces, no separate repos, no monorepo
tooling. The harness root stays language-agnostic: nothing TS-specific in
`extensions/`, root `AGENTS.md`, or global skills.

Within a pack, deterministic rules are code (scaffolders in `scripts/`,
lint/architecture configs in the project template); skills are the
agent-facing procedural layer that invokes them. TS-specific *extensions*
are avoided — extensions load in every session; skills load on demand.

## Why

- pi's package mechanism already provides the modularity a monorepo would;
  a local-path package is the same seam as a separate repo, without the
  tooling overhead. Splitting later = move a directory + one settings line.
- One repo in infancy keeps ADR discipline covering cross-layer decisions,
  which is where the interesting calls will be.
- The expensive-to-retrofit decisions are rule *form* (code beats prose)
  and *activation* (on-demand skills vs always-loaded extensions), not
  directory layout — so those are what's fixed here.

## Consequences

- `packs/ts/` starts near-empty; content grows from real app work, not
  up-front design.
- Split trigger: a second language pack exists and `packs/ts` is stable, or
  it needs independent versioning/sharing.
- The "Global scope only" rule in AGENTS.md is amended: globally *loaded*
  is fine; language-specific *content* belongs in a pack.
