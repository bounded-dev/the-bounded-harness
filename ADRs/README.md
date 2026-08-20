# Architecture Decision Records

Decisions about this harness are recorded here as ADRs.

## Scheme

- One file per decision: `YYYY-NNN-slug.md`
- `YYYY` — the year the decision was made
- `NNN` — three-digit number, incrementing, **resetting each year**
  (e.g. `2026-001`, `2026-002`, first of 2027 is `2027-001`)
- `slug` — short kebab-case summary

While the harness is young, rewrite and compact ADRs freely rather than
stacking supersession chains. Once decisions are load-bearing and shared,
prefer `superseded by` over rewriting.

## Format

Keep ADRs very concise. Record only what was actually decided and why:

```markdown
# YYYY-NNN: Title

**Status:** accepted | superseded by YYYY-NNN

## Decision
## Why
## Consequences
```
