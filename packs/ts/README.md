# packs/ts — TypeScript/React language pack

Everything TypeScript-specific in the harness lives here (ADR 2026-013).
Loaded globally via the root `settings.json` (`"./packs/ts"`), but scoped by
form: skills are on-demand, so presence in a non-TS session costs nothing.

## What belongs where

| Kind | Lives here? | Notes |
| ---- | ----------- | ----- |
| Procedural skills (new TS service, release, db migration, …) | **yes** — `skills/` | Agent-facing glue; point at scaffolders, don't duplicate them |
| Scaffolder scripts (new-route, new-value-object, …) | **yes** — `scripts/` | Deterministic shape is *generated*, not remembered |
| Shared lint/architecture rules (hexagonal boundaries, …) | template, vendored | Projects own their copy and may drift; update the template as the source of truth |
| Project template (committed `.pi/settings.json`, AGENTS.md, canonical commands) | template repo | ADR 2026-011 — the vehicle projects are created from |
| Anything language-agnostic | **no** — harness root | Root stays portable and stock-pi compatible |

## Rules as code, not prose

Architecture rules (hexagonal layering, validated routes, value-object
primitives) should be enforced by eslint/dependency-cruiser/tsconfig and
produced by scaffolders. Prose conventions are for intent and exceptions —
agents follow code always and prose mostly.

## Split trigger

When a second language pack exists and this pack is stable, or it needs
independent versioning/sharing: move this directory to its own repo and
change one line in the root `settings.json` (path or `git:` package). The
package seam makes the split mechanical.
