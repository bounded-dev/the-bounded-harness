# Technical Notes

Project thinking lives here as numbered Technical Notes (TNs) — one file per
note, born from a GitHub issue.

## Scheme

- One file per note: `TN-YY-NNN-slug.md` — `YY` year, `NNN` incrementing
  within the year, slug kebab-case.
- Front matter: `number`, `title`, `kind` (`design` | `process` | `research`),
  `status` (`draft` | `active` | `ratified` | `superseded`), `issue` (GitHub
  issue number).
- Written once, as synthesis — never accumulated as transcript (ADR 2026-009).
- Terms resolved in a TN land in the root `CONTEXT.md`; hard-to-reverse
  decisions may be promoted to ADRs.

## Index

| TN | Title | Status |
| --- | --- | --- |
| [TN-26-001](TN-26-001-developer-stage-pipeline.md) | Developer stage: architect / test-writer / builder pipeline | draft |
| [TN-26-002](TN-26-002-mechanism-vs-guidance.md) | Mechanism vs guidance: the six-cell experiment | draft |
| [TN-26-003](TN-26-003-change-cycle.md) | The change cycle — evolving a delivered component | draft |
| [TN-26-004](TN-26-004-api-service-reference-set.md) | The API-service reference set — one deterministic way onto the wire | draft |
| [TN-26-005](TN-26-005-pack-composition.md) | Pack composition — sockets in the core, contributions from packs | draft |
| [TN-26-006](TN-26-006-web-frontend-reference-set.md) | The web-frontend reference set — FSD layers, shadcn, typed client | draft |
