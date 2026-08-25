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
- **Design-quality guard** — landed (issue #3): contract-purity now also runs
  `no-naked-primitives`, so `isbn: string` / `authors: string[]` /
  `pagesRead: number` are blocks, not silent passes, and
  `scripts/new-value-object.ts` writes the fix. Verified against the run-2/3
  contracts (8 blocks) and the run-1 contract (clean). **Not yet exercised in
  a live run** — the next dogfood run is the real test of whether the messages
  bounce a weak model into value objects rather than into confusion.

Read the guard log (`<project>/.pi/guard-log.jsonl`) after each run: `block`
verdicts are drift the guards caught; `pass` verdicts prove a guard ran.

## Themes so far

- **The skill survives weak readers.** Both Sonnet and Haiku found and
  followed `ts-contract-authoring` (ports, branded ids, declaration-only) from
  a purely domain prompt.
- **Zero blocks in either run — but that's not a clean bill of health.** The
  only design-quality guard was contract-purity (declaration-only). Semantic
  gaps (naked primitives, dropped invariants) passed silently. → became the
  evidence for #3, now enforced by `no-naked-primitives`. Cardinality
  (`authors: string[]` allowing empty) is still prose-only: undecidable from
  the contract alone, so the rule prompts for it instead of enforcing it.
- **Dogfooding finds real bugs.** Run 1 surfaced a silent-bad-output defect in
  the scaffolder (#6), now fixed.

## Run log

### Run 5 — Opus · subscription-billing · THREE ARMS · PLANNED

Pre-registered before any arm runs. Run 4 validated the *bundle*; this run
decomposes it. Same domain and prompt as Run 4 (`docs/dogfood/run4-prompt.md`),
so arm-to-arm and run-to-run comparison both work, but on **Opus** throughout.

- **A · harness** — `~/dev/dogfood-r5-harness`. Full `developer-stage`
  pipeline: three blind roles, deterministic gates, scaffolder, path gate.
- **B · skill only** — `~/dev/dogfood-r5-skill`. One agent, ordinary tools.
  Gets `CONTRACT-GUIDE.md` (the design guidance from `ts-contract-authoring`
  with every reference to gates, scaffolder and guard log stripped) and
  nothing else. **No gates, no blindness, no role separation.**
- **C · bare** — `~/dev/dogfood-r5-bare`. Prompt only, as Run 4's control.

**The question:** Run 4 showed arm A produced branded value objects, errors as
values, and an adversarial test suite, where the bare control shipped
`CalendarDate = Date` and a tautological invariant test. But arm A had four
advantages at once — contract-first design, the authoring skill, deterministic
gates, and blindness. Arm B isolates the cheap half. Expected discriminations:

- If **B matches A's contract quality** → the value-object win came from the
  *skill*, and costs ~5% of the machinery. Blindness narrows to test quality.
- If **B's tests self-confirm like C's** (tautological invariants, tests named
  after the implementation) → blindness is doing work nothing cheaper does,
  and the 3× is buying it.
- If **B is type-dirty where A is clean** → the gates are load-bearing
  independently of blindness (issue #7's territory).

Scored on Run 4's criteria, unchanged: per-rule coverage, adversarial probes
run against all three arms, naked primitives at the boundary, invariants in
types vs prose, ports vs ambient time, `npm run check`, whether the tests
graded their own exam, and cost.

**Fixes in the harness since Run 4** (so arm A is not re-running known bugs):
verified gate invocations and a `sleep` ban in the orchestration skill;
`run_tests` non-convergence nudge; a builder dispute budget; orientation
guidance so no role opens with a blocked `ls .`; `no-naked-primitives` live
from the start this time rather than landing mid-run.

**Result:** _pending._

### Run 4 — Sonnet · subscription-billing · A/B: harness vs. no harness · PLANNED

**Pre-registered before either arm runs.** The first test of whether the
machinery *adds* anything a good model doesn't already do. Runs 1–3 showed the
pipeline holds a weak model up; this asks the harder question.

- **Arms** (identical toolchain — vitest 4.1.11, TypeScript 5.9.3, the same
  strict `tsconfig.json` including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`):
  - **A · harness** — `~/dev/dogfood-billing-harness`, orchestrated through the
    `developer-stage` skill on Sonnet (orchestrator + all three workers).
  - **B · control** — `~/dev/dogfood-billing-control`, one Claude Code session
    on Sonnet, ordinary tools, no gates, no blindness, no skills.
- **Prompt: the same text, verbatim, to both.** Domain requirements plus one
  line of guidance ("Keep the code clean and well separated. Write it
  test-first."). Arm A's extra guidance comes only from the harness's own
  skills — which is precisely the variable. The exact text is committed at
  `docs/dogfood/run4-prompt.md` so the runs are reproducible.
- **Domain:** subscription billing with mid-period plan changes. Chosen for
  scope for error, not size: money + currency, dates and whole-day proration,
  rounding to the smallest unit, a capped charge, idempotency under a caller
  operation id, a rejected back-date, a cancelled-state machine, and a stated
  cross-cutting invariant (invoices summed == amount charged).

**What we measure** (fixed now; scored after both arms finish):

1. **Rule coverage** — for each of the prompt's numbered rules, does a test in
   that arm's suite actually pin it? Scored per rule, not in aggregate.
2. **Adversarial probes** — one probe suite per rule, written against each
   arm's own API *after* the runs, and run against both. Same scenarios both
   sides: proration cap not exceeded; rounding at the smallest unit; replayed
   operation id does not double-charge; back-dated operation rejected; cross-
   currency change rejected; change on a cancelled subscription rejected;
   invoices sum to charges after a change + renew sequence. This is the
   objective half — the arms' own suites grade themselves, the probes don't.
3. **Naked primitives at the boundary** — is money a `number`, a date a
   `string`, a currency a `string`? Direct evidence for #3, which all three
   earlier runs already implicate.
4. **Invariants in types vs. in prose** — non-empty collections, states that
   forbid operations, currency agreement: encoded or merely documented?
5. **Ports for side effects** — is time a `Clock` port or a `Date.now()` call?
6. **Type-clean** — does `npm run check` pass? Arm A's gates now enforce this
   (#7); arm B has nothing forcing it, which is the point.
7. **Did the tests grade their own exam?** — in arm B, were tests written
   before the implementation they cover, and do they assert behaviour or
   restate it?
8. **Cost** — turns and wall-clock per arm. The machinery has to be worth it.

**Result: the harness arm is the more robust artifact, and the margin is in
exactly the places the separation targets.** Both arms shipped working code —
arm A 49/49 green and type-clean, arm B 46/46 green and type-clean, neither a
false green. On behavioural probes they are near-identical (same proration
arithmetic, same invoice consistency, both reject back-dating, cross-currency,
and post-cancel operations). The differences are architectural.

**1. Value objects (measure 3) — decisive for arm A.** Arm A branded every
boundary type: `CurrencyCode`, `ISODate`, `MinorUnits`, `SubscriptionId`,
`PlanId`, `InvoiceId`, `OperationId`, `ArgsFingerprint`. Arm B shipped
`currency: string`, `Plan.id: string`, `operationId: string`, and — the worst
defect in either arm — `export type CalendarDate = Date`, a bare alias to a
mutable built-in whose "always UTC midnight" invariant exists only in a doc
comment. Probed: mutating a `Date` the caller still holds rewrites arm B's
stored billing period to `2030-03-01 → 2026-04-01`, a period ending before it
starts. Arm A cannot express that bug: an `ISODate` is an immutable string.
Both arms *do* leak the caller's `Plan` object by reference (both showed a
mutated price of 999999), so arm A is better here, not clean.

**2. Errors as values vs exceptions.** Arm A returns
`BillingResult<T> = {ok:true,value} | {ok:false,error}` over a closed
eight-member `BillingErrorCode` union — the type system forces every caller to
handle failure. Arm B throws nine error classes; nothing makes a caller catch
them. For a billing component this is the difference between a missed case
being a compile error and being a production incident.

**3. Pure state machine vs mutable object.** Arm A is `(state, args) →
BillingResult<Outcome>` with an explicit `BillingState` and a visible
idempotency `ledger`. Arm B is a mutable class with private fields and a
private `operations` Map. Arm A's shape gives replay, audit, and trivial
testing for free.

**4. Test quality — the clearest evidence for the separation (measure 7).**
Arm B's suite twice agreed with its own implementation rather than the prompt:
its cross-cutting invariant test is tautological (`totalCharged()` sums
`invoice.total`; the test asserts the sum equals `totalCharged()` — it cannot
fail), and a test named *"takes effect immediately in status"* directly
contradicts the prompt's "cancel takes effect at the end of the current
period". Arm A's test-writer, which never saw an implementation, produced
tests no implementer writes against themselves: *"a failed call does not
consume the operationId"*, *"a failed call leaves the ledger untouched"*,
*"start and renew must not share operationId namespace"*, *"a true replay
returns ok:true even when business rules would now fail"*, *"never charges
more than the new plan's full period price, across several remainingDays"*.
Two of those caught a real defect in the builder's first implementation — the
15-minute stall documented below is the loop working, expensively.

**5. Cost.** Arm B: 19.5 min, 20 tool calls, one session. Arm A: ~60 min, 62
orchestrator tool calls plus 8 worker spawns (architect ×3, test-writer ×3,
builder ×2), ~$1.35 in worker tokens, plus a 364-line `spec.md` arm B has no
equivalent of. Roughly 3× the wall clock for the better artifact.

**Caveats on this run.** (a) Arm A was contaminated mid-run: the
`no-naked-primitives` rule from issue #3 landed in the live checkout at
22:01 UTC and blocked arm A's contract at 22:10, costing one extra architect
round-trip. The rule was disabled for the remainder. Arm A's contract was
*already* fully branded before the rule fired, so the value-object verdict
above does not depend on the contamination — but it is not a clean result and
should not be cited as one. (b) Timing figures were measured on a machine at
load average 12 with two wedged `find /` processes; treat them as upper
bounds. (c) Both arms ran Sonnet; arm A's orchestrator spent its first two
minutes on Haiku before being switched.

**Verdict: the machinery earned its keep on this run, on quality, at ~3× the
cost.** The gap is not that the strong model *couldn't* produce arm A's design
— it plainly could — but that nothing in arm B made it, and nothing caught it
when it didn't.

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
