# 2026-008: Third-party packages are pinned

**Status:** accepted

## Decision

npm packages in `settings.json` carry exact versions:
`npm:pi-subagents@0.52.1`, `npm:betterwright@1.10.0`. Updates happen
deliberately: review the package source, then `pi install npm:<pkg>@<ver>`
(or bump the spec) — never a blind `pi update`.

## Why

Versioned specs are skipped by `pi update --extensions`, which turns ADR
2026-003's "review on update" policy from intention into enforcement. A
harness live in every session, building many apps, wants reproducibility
over freshness — an unpinned update previously took effect everywhere at
once with no review gate.

## Consequences

- `pi update --extensions` no longer moves these packages; check
  periodically for new versions and bump by choice.
- The local-path package (`../bounded-dev/skills`) is inherently pinned by
  that repo's own git history.
