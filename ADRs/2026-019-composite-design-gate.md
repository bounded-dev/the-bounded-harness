# 2026-019: The design phase is one gate call, not four

**Status:** accepted

## Decision

`design_gate` runs contract-purity → scaffold → project typecheck → freeze as
one architect tool call: stops at the first failure, prints each step's output
and wall-clock duration, and ends in one verdict plus a single
`route → architect`. The separate `scaffold` and `freeze_contracts` tools are
removed — they are steps of a sequence, not gates in their own right.
`contract_purity` stays, as the cheap single check while a contract is still
being iterated on.

## Why

The four steps had exactly one legal order and that order lived in prose. It
cost 3–6 minutes of architect round-trips per ticket across the dogfood runs,
and produced the fumbles prose always eventually produces: freezing before
scaffolding, scaffolding a contract that never passed purity, typechecking
before the skeletons existed. A sequence with one entry point cannot be run out
of order, and one verdict is one thing to read. The route is always the
architect because at DESIGN nothing downstream exists — no tests, no
implementation — so no other role could hold the defect; typecheck-routing's
per-owner attribution is still printed, because a diagnostic in a generated
skeleton points at a different contract defect than one in the contract itself.

## Consequences

The phase gate is unchanged: it derives the DESIGN ordering from the inner
guard-log events (`contract-purity`, `scaffold`, `checksum-gate`), and the
composite still logs all three because it calls the same `run*` functions.
It adds one `design-gate` event carrying every step's outcome and duration.
Nothing is reimplemented, so the CLI scripts remain individually callable and
`node design-gate.ts` is the same gate the tool is.
