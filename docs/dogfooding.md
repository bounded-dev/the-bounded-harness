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

### Run 6 — Sonnet · subscription-billing · bare vs FOLDED harness · PLANNED

Pre-registered before either arm runs. **The question is narrow on purpose:
did folding the orchestrator and the architect into one role (issue #12) cost
any quality, and did it buy back any of the time?** Run 5's harness arm is the
yardstick for quality; Run 5's bare arm is the yardstick for whether the
separation still pays at all.

Same baseline commit as Run 5 (`b6bc308` in `~/dev/dogfood-billing`), same
prompt byte-for-byte (`docs/dogfood/run4-prompt.md`), same toolchain (vitest
4.1.11, TypeScript 5.9.3), **Sonnet throughout**. The AGENTS.md operational
block is byte-identical between arms; one line differs, naming what the
environment offers.

- **1 · bare** — `~/dev/dogfood-r6-bare`, branch `r6-bare`. One agent, ordinary
  tools, no skills. *"Nothing special. Build it with your ordinary tools, the
  way you think it should be built."*
- **2 · folded** — `~/dev/dogfood-r6-folded`, branch `r6-folded`. Launched with
  `agent/scripts/pi-ticket`, which binds the architect role at launch. *"This
  project is built through the `developer-stage` skill. Invoke it and follow
  it."*

**What changed in the harness since Run 5.** The architect now owns the ticket
end to end — designs it, commissions the test-writer and builder, runs every
gate, arbitrates. There is no separate orchestrator and no PLAN phase. It reads
everything and writes only `spec.md` and `*.contract.ts`. It has no `bash`: six
gate tools plus `git`, and `--exclude-tools bash` so the tool is not even
visible to reach for. `.pi/` became write-denied to every role.

**Predictions, recorded now so they can be wrong.**

1. **Quality holds.** Test count in the 80–110 band (Run 5: 95), the ordering
   tests still present, and no tautological invariant test. If the folded arm
   drops toward the bare arm's 31, the separate architect was doing something
   we did not measure.
2. **Cost falls.** One fewer subagent spawn, no plan document, and no
   gate-invocation archaeology (Run 4 lost ~3 minutes to it; the tool schemas
   now carry the invocations). Expect under Run 5's ~33 minutes and under its
   $2.44, though stalls dominate the wall clock and could swamp the saving.
3. **The bare arm writes a tautological invariant test again.** It has done so
   twice, on two different days. A third would make it the most replicated
   finding in this file.

**The specific risk this run is watching: laundered blindness.** The architect
can now read `tests/`, which it could not before. It writes the spec *before*
any test exists, so the first pass is safe — but on a dispute or revision pass
it may read a test and then revise the spec, and the builder reads the spec.
That is a path for test detail to reach the builder without either of them
breaking a rule. **Check every spec revision that happens after the red gate
against the tests that existed at that moment.** If specifics leak, the fix is
a narrower rule (no spec edits after red without a logged rationale), not a
retreat from the fold.

**Second watch item: does it stay in its lane?** The path gate logs every
refused write. A folded architect that repeatedly tries to edit `tests/` or
`src/` is telling us the role is uncomfortable, even if the gate holds. Read
`.pi/guard-log.jsonl` for `path-gate` blocks and count them by target.

**Scored on Run 4's criteria, unchanged:** per-rule coverage, adversarial
probes run against both arms, naked primitives at the boundary, invariants in
types vs prose, ports vs ambient time, `npm run check`, whether the tests
graded their own exam, and cost.

**Pre-flight, run before registering this.** The gated session starts, blocks a
write to `tests/probe.test.ts` with the expected message, writes that block to
the guard log, and — after a fix this pre-flight prompted — no longer sees
`bash` at all. Run 5 lost two attempts to void runs; this is the cheap
insurance against a third.

**Hygiene.** Arms share one repo on separate worktrees and branches. **Do not
push to pi-harness main while arm 2 runs** — it resolves gates through
`~/.pi/agent` → the live checkout, which is how Run 4's harness arm got
contaminated mid-flight.

### Run 5 — Sonnet · subscription-billing · bare vs harness · PLANNED

Pre-registered before either arm runs. Same domain as Run 4
(`docs/dogfood/run4-prompt.md`), **Sonnet throughout**, prompt **byte-identical
in both arms** — the only variable is the environment.

Layout: one repo, `~/dev/dogfood-billing`, two git worktrees on branches off a
shared baseline. Each arm has one setup commit; score its output as the diff
from that commit. Each arm carries an `AGENTS.md` with an **identical**
operational block (layout, toolchain, `npm run check` is the bar, no new
dependencies, don't commit) and exactly one differing line naming what that
environment offers — the method itself lives in the skill, never in
`AGENTS.md`, so an inadequate skill shows up as a result rather than being
papered over by the setup.

- **1 · bare** — `~/dev/dogfood-arm1-bare`. Claude Code, one agent, no skills.
  *"Nothing special. Build it with your ordinary tools, the way you think it
  should be built."*
- **3 · harness** — `~/dev/dogfood-arm3-harness`. pi, full `developer-stage`
  pipeline: three blind roles, deterministic gates, scaffolder, path gate.
  *"This project is built through the `developer-stage` skill. Invoke it and
  follow it."*

**A skill-only middle arm was planned and dropped before running.** The intent
was to decompose the bundle: does the quality come from the authoring skill or
from blindness? But the arm as built gave the single agent only
`ts-contract-authoring`, while most of the harness's guidance now lives in the
three agent definitions (the architect's design judgment, the test-writer's
enumeration method, the builder's craft rules). That arm would have carried
roughly a fifth of the harness's advice, understating the cheap intervention
and flattering blindness. **The decomposition question therefore remains
open.** A faithful version would hand a single agent the combined guidance
from all three agent defs with no blindness, gates or orchestration — worth
building for a later run.

Scored on Run 4's criteria, unchanged: per-rule coverage, adversarial probes
run against both arms, naked primitives at the boundary, invariants in types
vs prose, ports vs ambient time, `npm run check`, whether the tests graded
their own exam, and cost.

**Fixes in the harness since Run 4** (so arm 3 is not re-running known bugs):
verified gate invocations and a `sleep` ban in the orchestration skill;
`run_tests` non-convergence nudge; a builder dispute budget; orientation
guidance so no role opens with a blocked `ls .`; `no-naked-primitives` live
from the start; and the `developer-stage` skill description rewritten to
trigger on the task shape it serves.

**Aborted first attempts (kept as evidence, branches `arm1-void-firstattempt`
and `arm3-void-noskill`).** Arm 3's first attempt never loaded the
`developer-stage` skill: no subagent spawned, no gate run, no `.pi/` written.
It read `package.json`, said *"Project scaffold already exists. Now I'll build
the full implementation"*, and wrote `src/*.ts` directly — pi behaving as a
single agent. Cause: the skill's description (*"turn an approved plan into
tested code… use when driving a task from plan to green through the
architect/test-writer/builder pipeline"*) only matched a user who already knew
the pipeline existed. A skill that must be known about before it can be found
is not discoverable — the same class of defect as Run 1's silent scaffolder
bug, and visible only because the arms were given identical prompts.

**Known confound.** All three pipeline agent definitions gained personality and
method between Run 4 and Run 5. Run 4's test-writer produced its sharpest tests
with none of it, so any arm-3 improvement over Run 4 cannot be attributed to
blindness alone. Watch: whether arm 3's spec comes in under Run 4's 364 lines
without losing the tests that traced to it, and whether the builder disputes
promptly rather than stalling (Run 4 lost ~15 min there).

**Hygiene.** Arms share one repo, so run them concurrently or don't commit arm
output until scoring. Do not push to pi-harness main while arm 3 runs — it
resolves gates through `~/.pi/agent` → the live checkout, which is how Run 4's
harness arm got contaminated mid-flight.

**Result: the harness arm is decisively better on test quality, and the bare
arm's failure mode reproduced exactly.** Both shipped working, type-clean code
— arm 1 `31 tests / 3 files`, arm 3 `95 tests / 8 files` plus a 335-line spec.
Every behavioural probe passes identically on both (proration, idempotent
replay, back-dating, cross-currency, post-cancel rejection, invoice/line-item
consistency), and both leak the caller's `Plan` object by reference. On
*behaviour* they are equivalent. The differences are architectural and, above
all, in the tests.

**1. The tautological invariant reproduced.** Arm 1, independently and on a
different model session from Run 4's control, wrote the same self-confirming
test: it sums `invoice.total` into `summed`, then asserts `totalCharged`
equals it — and `totalCharged` is implemented as that same sum. It cannot
fail. Arm 3's equivalent derives every expected value by hand from the spec's
formula (`proratedAmount(1200, 31, 21) = floor(50431/62) = 813`) and asserts
literals, so a drift in the rounding rule breaks it. **Two bare runs, two
tautologies; two harness runs, none.** This is the clearest evidence yet that
the separation buys something prompting does not.

**2. Precondition ordering: tested by arm 3, absent from arm 1.** Arm 3's
`ordering.test.ts` pins which error wins when several checks would all fail —
*"renew on a cancelled subscription reports back-dated-operation, not
subscription-cancelled, when both would fail"*, and a three-way version. It
also covers replay-after-the-world-moved-on (*"changePlan replay succeeds
after the subscription has since been cancelled"*) and replay-with-different-
arguments. Arm 1 has none of these. This is the test-writer's new enumeration
method (*"one test per check, plus one where two would fail and the earlier
must win"*) firing in its first live run.

**3. Value objects.** Arm 3 branded the whole surface via a `Brand<T,B>`
helper — `CurrencyCode`, `MinorUnits`, `DayCount`, every id, `Description`,
and `CalendarDate` as a branded *string*. Arm 1 has zero branded types and
`export type CurrencyCode = string`, so `"usd" !== "USD"` and `""` is a valid
currency. Arm 1 did, however, avoid Run 4's catastrophic `Date` aliasing bug
by normalising dates on entry — a better bare run than Run 4's control.

**4. Errors as values, per operation.** Arm 3 returns
`{ok:true,…} | {ok:false,error}` with a *distinct* error union per operation
(`RenewError` ⊂ `ChangePlanError`), so the compiler enumerates exactly the
failures each call can produce — more precise than Run 4's single union. Arm 1
throws nine error classes; nothing makes a caller handle them.

**5. Every new mechanism earned its place.** `no-naked-primitives` blocked the
architect's first contract (issue #3's first live firing); the green gate
blocked with `route: builder` rather than declaring a false green (#7); the
`run_tests` non-convergence nudge fired `stuck=True` after the builder hit the
same two failures three times, and it was green one run later — against Run
4's 15-minute stall in the same situation. The red gate recorded a textbook
valid red: 95 NotImplemented failures, 0 passes.

**Cost.** Arm 3 took ~33 min against arm 1's ~19 min, but the harness time is
dominated by stalls, not work: the architect's first run was 446s of which
363s were gaps ≥30s (81% dead air), while its second run did 15 messages in
26s. Excluding stalls the pipeline moves at 3–4s per turn.

**Caveat, recorded plainly.** Arm 3 ran across a mid-run harness change: the
test-writer read-zone fix was synced while its orchestrator was stalled, after
its first test-writer had already died on the old zone. The arm is scoreable
— the fix restored intended behaviour rather than adding capability — but it
is not a clean run, and the value-object and test-quality findings should be
read as consistent with Run 4 rather than as independent confirmation.

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

- **#12 the strip-down** — the folded shape is built and pushed; Run 6 is its
  first live test. Still open within it: the review role, the test-checksum
  freeze, and scripting the inner loop.
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
