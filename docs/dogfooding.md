# Dogfooding notes — developer-stage pipeline (TN-26-001)

Living record of dogfood runs of the developer-stage pipeline and what they
teach us. Append; don't rewrite history. Pair with the GitHub board — findings
that need work become issues, and their numbers are referenced here.

## What we're testing (and what we're not, yet)

Runs so far exercise the **DESIGN stage only**: an agent, given a purely
domain prompt + the `ts-contract-authoring` skill, authors `*.contract.ts`
files, runs the **contract-purity** gate, runs the **scaffolder**, and
typechecks. That validates: skill discoverability, contract-authoring UX,
gate/scaffolder error messages, and skeleton quality.

Not yet exercised (pending):
- **Blindness / role enforcement** — the path-gate extension (Phase 2). Until
  it lands, nothing *stops* an agent doing anything; clean runs mean the model
  behaved, not that the harness enforced.
- **Test-writer / builder roles, red/green gates** — Phases 2–3.
- **Design-quality guard** — no rule yet checks value objects / invariants at
  the contract boundary (issue #3). Contract-purity only checks
  *declaration-only* purity, not richness.

Read the guard log (`<project>/.pi/guard-log.jsonl`) after each run: `block`
verdicts are drift the guards caught; `pass` verdicts prove a guard ran.

## Themes so far

- **The skill survives weak readers.** Both Sonnet and Haiku found and
  followed `ts-contract-authoring` (ports, branded ids, declaration-only) from
  a purely domain prompt.
- **Zero blocks in either run — but that's not a clean bill of health.** The
  only design-quality guard is contract-purity (declaration-only). Semantic
  gaps (naked primitives, dropped invariants) pass silently. → evidence for #3.
- **Dogfooding finds real bugs.** Run 1 surfaced a silent-bad-output defect in
  the scaffolder (#6), now fixed.

## Run log

### Run 3 — Haiku · reading-list (FULL PIPELINE) · 2026-08-25

**First real end-to-end run** — orchestrated (developer-stage skill), blindness
enforced, all on Haiku (orchestrator + all three workers). One component
(`ReadingList`: add/list/remove + a persistence port).

- **Outcome:** completed the whole loop — architect → test-writer → builder →
  `green-gate: GREEN (22/22)`. A weak model, carried by the machinery, produced
  a working component.
- **Blindness ENFORCED (the milestone) — 5 path-gate blocks:** architect blocked
  from `read` (its own skill file), `ls .` (root), `ls src`; test-writer blocked
  from `ls .` (src blindness); builder blocked from `ls .` (tests blindness).
  The harness *enforced*, not the model behaving.
- **Every gate fired correctly:** contract-purity; scaffolder; **checksum caught
  a real mid-loop contract revision** (drift → re-scaffold); red-gate rejected
  `22 wrong-reason failures` then accepted `22 NotImplemented`; run_tests showed
  the builder climbing `0→20→22` blind to test source; green.
- **KEY FINDING — GREEN was a false victory (#7):** green-gate passed (22/22)
  while `tsc` still had **2 errors in the test file** (`noUncheckedIndexedAccess`
  on `books[0]`). green = "tests pass at runtime", not "project type-clean". The
  builder can't fix test-file errors (blind + out of zone) — this should route
  BLOCKED→test-writer, but nothing forced it; the orchestrator declared green
  despite an earlier `typecheck: block`. Fix: green must include typecheck; a
  TEST-phase typecheck would catch it earlier.
- **Friction (#8):** all three roles wasted a turn on a blocked orienting `ls .`
  (root overlaps a denied zone); architect noisily blocked reading its own skill.
- **Quality (more #3 evidence):** Haiku's architect contract was *weaker* than
  its DESIGN-only run — `isbn: string`, `authors: string[]` (naked primitives),
  coarse `save(list)/load()` port. Passed contract-purity (no value-object guard).
- **Assessment:** the pipeline works end-to-end with real enforcement — a major
  milestone. Determinism held under a weak model; the gaps found (false green,
  ls friction, value objects) are exactly what dogfooding is for, all fixable.

### Run 2 — Haiku · reading-list · 2026-08-25

- **Model:** Claude Haiku. **Prompt:** reading-list tracker (domain-only, +
  "follow the ts-contract-authoring skill").
- **Guards:** `contract-purity: OK (2 files)`, 2× `scaffold: pass`. **No
  blocks.** `tsc --noEmit` clean.
- **Output:** 2 contracts (`reading-list`, `reading-log`) — no shared book
  vocabulary. Ports (`BookStore`, `ReadingEventStore`, `Clock`), branded
  `BookId`/`ReadingEventId`, declaration-only. Skill followed.
- **Assessment:** Structurally valid but **semantically weaker than Sonnet**,
  entirely in the space the gate doesn't check:
  - `isbn: string` (vs Sonnet `Isbn`), `pagesRead: number` (vs `PagesRead`),
    filter `author?: string` (vs `AuthorName`) — naked primitives.
  - `authors: string[]` **allows empty** — the "one or more authors"
    requirement is lost (Sonnet: `readonly [AuthorName, ...AuthorName[]]`).
  - mutable fields (no `readonly`); `store?: BookStore` optional (smell).
  - **All of it passed every guard.** Concrete evidence that **#3
    (value-objects rule) is load-bearing** — a naked-primitive rule would have
    turned this into a `block`.
- **Artifacts:** guard log in the run's `.pi/`; contracts were reset for the
  next run.

### Run 1 — Sonnet · reading-list · 2026-08-25

- **Model:** Claude Sonnet. **Prompt:** reading-list tracker (domain-only).
- **Guards:** 1× `contract-purity: error` (ran gate before writing — exit-2
  "no files matched", working as designed), then 2 clean cycles of
  `contract-purity: OK (3 files)` + 3× `scaffold: pass`. **No blocks.** `tsc`
  clean.
- **Output:** 3 contracts (`shared/book`, `reading-list`, `reading-log`).
  Strong: branded `Isbn`/`AuthorName`/`PagesRead`/`ProgressEventId`, ports
  (`ReadingListStore`, `ReadingLogStore`, `Clock`), non-empty author tuple,
  `Clock` port for time. Would approve by eye.
- **Assessment:** Strong DESIGN-stage result. One **harness bug found**: a
  `declare class … extends Error` scaffolded a `super()`-less throwing
  constructor that `tsc` rejects (TS2377) while the scaffolder logged `pass` —
  silent bad output. Agent adapted (dropped error classes). Filed + fixed as
  **#6**.
- **Artifacts:** archived at `~/dev/dogfood-reading-list-sonnet/`.

## Open threads

- **#7 GREEN must include typecheck** — a passing suite with tsc errors is a
  false green (Run 3). Highest-priority correctness gap.
- **#3 value-objects rule** — top design-quality gap; all three runs are evidence.
- **#8 path-gate `ls .` friction** — every role trips it; cheap UX fix.
- **#5 model tiering** — Run 3 ran Haiku as orchestrator too; watch whether the
  orchestrator specifically wants the strong model.
- **Scaffolder ordering nit** — CLI creates `src/shared/errors.ts` before
  validating the contract, so a rejected scaffold still leaves the module
  behind. Harmless; tidy later.

_Phases 1–3 of the pipeline are built and pushed; Run 3 exercised all of it._
