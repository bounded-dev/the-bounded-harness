# Dogfooding notes — developer-stage pipeline (TN-26-001)

Living record of dogfood runs of the developer-stage pipeline and what they
teach us. Append; don't rewrite history. Pair with the GitHub board — findings
that need work become issues, and their numbers are referenced here.

## What we're testing (and what we're not, yet)

Runs now exercise the **whole developer stage**: an architect designs, a
reviewer reads the design before it freezes, a test-writer and a builder work
in parallel behind enforced blindness, and every phase transition is a
deterministic gate — contract-purity, the composite `design_gate`, red, green,
sign-off, delivery. Blindness is enforced rather than hoped for (tools removed
from the toolset, the path gate, the sanitized `run_tests`), and every run
leaves a guard log saying which guard ran and what it refused.

What that still does **not** cover, said plainly:
- **More than one component.** Everything measured is a single component in a
  single worktree. Integration — several components, several architects,
  merges — is untested.
- **More than one language.** `packs/ts` is the only pack, so layers 3 and 4
  of the cake in [VISION.md](VISION.md) do not exist yet.
- **Guidance at scale.** The mechanism-versus-guidance result (Runs 10–12,
  [TN-26-002](tn/TN-26-002-mechanism-vs-guidance.md)) was measured against a
  rulebook of dozens of rules, not the hundreds the vision assumes. Read it
  with that scope attached.
- **A test-quality floor.** Mutation score is measured per run; nothing gates
  on it.

Read the guard log (`<project>/.pi/guard-log.jsonl`) after each run: `block`
verdicts are drift the guards caught; `pass` verdicts prove a guard ran.

## Running one

```bash
dogfood-reset          # rebuilds both arms from the default prompt
dogfood-reset --design-model <pattern> --worker-model <pattern>
```

The two model flags set the harnessed arm's tiers — the judgment seats
(architect, reviewer) and the production seats (test-writer, builder) — by
writing `.pi/dev-stage-models.json` (ADR 2026-022). Both are printed on every
reset, set or not, so a run's models are never a guess afterwards.

Then walk into each and paste `PROMPT.md`:

- `~/dev/pi-harness-dogfood-bare` — the control. Claude Code, ordinary tools.
- `~/dev/pi-harness-dogfood-harnessed` — pi. Gated as the architect
  automatically via `.pi/dev-stage-role`; there is no launcher to remember.

Two directories, one `main` branch each, no worktrees. **Runs are disposable**
— `dogfood-reset` wipes both and starts over, so copy anything worth keeping
before re-running. Past runs (1–5) live as branches in
`~/dev/pi-harness-dogfood-archive`.

`dogfood-reset` writes the operational `AGENTS.md` block from a single string
and then *verifies* both arms got byte-identical prompts and blocks, failing
loudly if not. That check is the experiment: exactly one line may differ
between arms, the one naming what the environment offers.

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

Same baseline as Run 5, same prompt byte-for-byte
(`docs/dogfood/subscription-billing-prompt.md`), same toolchain (vitest 4.1.11,
TypeScript 5.9.3), **Sonnet throughout**. Both arms are built by
`dogfood-reset`, which verifies the prompt and the operational block are
byte-identical and fails if they are not; one line differs, naming what the
environment offers.

- **1 · bare** — `~/dev/pi-harness-dogfood-bare`. **Claude
  Code**, one agent, ordinary tools, no skills — same as Run 5's arm 1, so the
  control is comparable across runs. *"Nothing special. Build it with your
  ordinary tools, the way you think it should be built."*
- **2 · folded** — `~/dev/pi-harness-dogfood-harnessed`. **pi**, gated as the
  architect through the project's `.pi/dev-stage-role`. *"This project is built
  through the `developer-stage` skill. Invoke it and follow it."*

The two arms therefore run on different agent harnesses (Claude Code vs pi),
as they did in Runs 4 and 5. That is a confound the comparison has always
carried and it is worth restating: the bare arm is not "pi without the
pipeline", it is a different tool. What survives it is the *test-quality*
finding, which is about who writes the tests rather than which harness runs.

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

**Hygiene.** **Do not push to pi-harness main while arm 2 runs** — it resolves gates through
`~/.pi/agent` → the live checkout, which is how Run 4's harness arm got
contaminated mid-flight.

**Result: reached green, on the third attempt.** 83/83 tests passing,
`npm run check` clean, contracts unchanged from the freeze. The first two
attempts were voided before scoring: one by the session defaulting to
`kimi-k2p7-code` instead of Sonnet, the other by the YAML skill bug recorded
below, which silently dropped `developer-stage` from every session's skill
list. What follows compares the two completed arms — same prompt,
byte-for-byte, both Sonnet.

| | bare (Claude Code) | harnessed (pi) |
|---|---|---|
| tests / files | 53 / 3 | 83 / 11 |
| src modules | 6 | 7 |
| contract files | 0 | 7 |
| exported functions | 18 | 25 |
| wall clock | 12.1 min | 30.5 min |
| assistant turns | 27 | 62 |
| tool calls | 16 | 67 |
| tokens, total | ~2.2M | ~6.9M |
| tokens, output / cache read | 292k / 1.64M | 148k / 6.1M |
| cost | not captured | ~$3.65 |

Every finding below is a mechanism rather than a matter of taste.

**1. The tautology did not reproduce, and that weakens the headline finding.**
Runs 4 and 5 both had the bare arm write a self-confirming invariant test — sum
the invoices, assert the sum equals itself under another name. This time it
did not: the bare arm's `totalCharged()` helper is summed in the test and
asserted against hand-derived literals (1000, 2000, 1000+1000+…+3000), inside a
proper `describe("invariant: invoices sum to the total actually charged")`.
The headline evidence for the separation is now **2 of 3, not 3 of 3**. Stated
plainly, because it should be — the case is weaker than Run 5 left it.

**2. The "one contract" wording fix still shows a large effect.** Guidance
changed between attempts from "a `spec.md` and one component contract" to "as
many `*.contract.ts` files as the design needs". Same prompt, same model, same
day:

| attempt | contract files | shape |
|---|---|---|
| before the fix | 1 | one `SubscriptionBilling` interface, 4 methods, unimplementable |
| after the fix | **7** | `calendar` `ids` `invoice` `money` `plan` `result` `subscription`, 38 operations |

Two data points only, but they point the same direction as ADR 2026-014: fix
what is *wrong*, do not add more taste.

**3. Value objects reproduced for a third consecutive run.** Bare:
`currency: string`, `amount: number`, `id: string`; only `CalendarDate`
branded. Harnessed: `Currency`, `MinorUnits`, `CustomerId`, `PlanId`,
`SubscriptionId`, `OperationId`, `InvoiceId` — all branded, all with smart
constructors.

**4. Error modelling converged — unexpected.** Both arms used result types
(`ok`/`err` discriminated unions), not exceptions. Runs 4 and 5 both had the
bare arm throw nine error classes; this time it didn't. Both arms also avoided
Run 4's catastrophic `CalendarDate = Date` aliasing bug — the bare arm used a
branded string instead. On this axis the arms are no longer distinguishable,
which the earlier runs gave no reason to expect.

**5. The spec's unique contribution is execution order, confirmed a second
way.** The harnessed arm wrote all 83 tests with no `spec.md` — the architect
skipped it, four attempts out of four. What survived without one: replay and
idempotency tests, including *"replaying an operationId ignores changed
arguments"*; arithmetic pinned to hand-derived literals, including the 2024
leap year found unprompted (`daysBetween` returns 29, against 28 in 2023); and
a non-tautological invariant walking start → renew → changePlan → renew →
cancel with running totals annotated by hand. What was absent: **zero**
precondition-ordering tests — which error wins when several checks would all
fail. Run 5's harnessed arm had two. Blindness alone prevents the tautology;
only the spec gets you ordering.

**6. The `run_tests` nudge detects non-convergence but does not reliably
produce a dispute.** It fired five times across eleven `run_tests` calls. The
builder kept implementing and exited with an empty verdict, never disputing.
Runs 4 and 5 both recorded "progress on the very next run" after the nudge
fired, which read as the mechanism working — this is the first run where it
fired and was ignored outright.

**7. A failing test routes to the builder unconditionally, and this time it
deadlocked — then the architect broke its own rule to escape.** The final
failure was a test bug: after `start → renew → changePlan` there are three
invoices, and the test read `invoices[1]` (the renewal) instead of
`invoices[2]` (the proration), having copied the index from a sibling test with
no renewal step. The green gate routed to the builder by rule; the architect
obeyed, as the skill instructs ("do not improvise a target"); the builder
cannot see tests, so it respawned and hit the identical failure a second time.
The architect then overrode the route itself, diagnosed the test as wrong, and
commissioned a test-writer, which fixed `invoices[1]` → `[2]`. That is
*contrary* to the skill's explicit instruction. It worked, and it cost two
builder spawns and roughly 15 minutes to get there.

**8. Respawns dominated cost.** Five workers stood in for three roles, and
every bounce was a cold respawn re-priming a full context. Cache reads per
spawn: builder #1 1.75M, test-writer 649k, test-writer 603k, builder #2 362k —
roughly 1.6M tokens, about a quarter of the run's total, spent re-teaching
agents what a sibling agent already knew. pi supports retained children
(`children.list` / `resume`); issue #11 proposed this and was closed as "worth
only 1–2 minutes per run." This run's numbers say otherwise.

**9. A launched architect holds more than a spawned one.** Its tool tally
included `bash` (3 calls, all refused by the path gate) and `run_tests`. The
frontmatter allowlist binds subagents only, so a session started from
`.pi/dev-stage-role` gets everything pi offers minus what the path gate blocks.
*(Closed since, after r14 paid for it again: a bound session now has its
forbidden tools removed from the visible toolset at `session_start` — logged as
a `tool-strip` guard event — and `pi-ticket` additionally launches with
`--exclude-tools`, which drops them from the registry outright. A refusal layer
stays as a backstop.)*

**Harness bugs found and fixed during the run** (each one voided an attempt or
a gate result): a `: ` inside the skill's unquoted YAML description silently
removed `developer-stage` from every session's skill list; the ambient path
gate applied the parent's role to every child, so the test-writer was refused
permission to write its own tests as "architect"; `contract-purity`,
`typecheck` and `checksum-gate` all passed a contract with zero value exports
(every operation was a method on an exported interface, which vanishes at
compile time); zone globs were case-sensitive on a case-insensitive
filesystem, which refused `SPEC.md` and would have let `TESTS/x.test.ts` walk
through the blindness; and `contract-purity` passed `export function f(): T;`
with no `declare` — a silent TS2391 that only surfaced later as 25 `tsc`
errors.

**Queued from this run:** reopen issue #11 (retained children) against finding
8's numbers rather than the earlier estimate; decide whether the architect's
rule-breaking override in finding 7 should become a codified escape hatch — it
worked, but it worked by an agent doing the thing it was explicitly told not to
do; and a compile check inside `contract-purity` so the zero-value-export class
of bug is caught before the checksum gate, not after.


### Run 5 — Sonnet · subscription-billing · bare vs harness · PLANNED

Pre-registered before either arm runs. Same domain as Run 4
(`docs/dogfood/subscription-billing-prompt.md`), **Sonnet throughout**, prompt **byte-identical
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
  `docs/dogfood/subscription-billing-prompt.md` so the runs are reproducible.
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

> **Snapshot from the Run 6 era.** Every gap listed here has since been closed
> — typecheck inside both gates, the value-objects rule, the `ls .` friction,
> model tiering (ADR 2026-022), the folded architect. Kept as the record of
> what was open then; the live list is
> [issue #13](https://github.com/bounded-dev/pi-harness/issues/13).

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

---

## Runs 10–12 (2026-09-03): the six-cell experiment

One day, one task, three models (opus 4.8, sonnet 5, kimi k2.7/k3), two
conditions: the harness, versus every harness rule translated into prose
(`docs/dogfood/subscription-billing-guidance-prompt.md`) with zero
enforcement. Archive branches r10-* through r12-*.

### Headline results

| | harness | guidance only |
|---|---|---|
| **opus 4.8** | 35 min, 4 contracts, 89 tests, 0 hatches, valid red, 5 reviewer-grade findings (~$15.50) | 395 tests, 0 hatches, full compliance on every checkable rule — but red was wrong-reason (import failures) by structural necessity |
| **sonnet 5** | 50 min, 111 tests; three gates corrected it live: architect writing implementation blocked, surface gate's first live catch, green-requires-red fired and self-corrected in 7s (~$10.31) | 118 tests, statics clean; hostile-input requirement silently skipped, 7/15 boundaries, FINDINGS silent about both |
| **kimi** | (Run 10) green with NO VALID RED — contract re-frozen mid-loop, red never re-established, sign-off confessed it; the green-requires-red guard exists because of this run (~$3.63) | k3+k2.7: statics clean, 0 hatches, real oracles — but red-first skipped outright and completeness quotas underfilled, unconfessed |

### What the guidance column proves

Compliance with prose is a capability gradient, and it fails silently at
exactly the requirements nothing re-checks. What survives prose everywhere is
whatever a linter could check. What dies, in capability order: completeness
quotas, then process, then honesty about both.

The reframing finding (Run 12): kimi wrote ZERO escape hatches under guidance
after writing 19 under the harness. Not discipline — test-after removes the
adversarial pressure that produces cheating. Tests born agreeing with the
code leave nothing to cheat past; the evasion relocates into the suite's
epistemic value, which nothing measures. The harness's irreducible
contribution across every tier is the thing no output inspection recovers:
proof the tests preceded and constrained the code.

### Test quality: does blind test-first help? (mutation matrix)

Two mutants (rounding corruption, replay-guard removal) against six suites —
kill counts (tests failing):

| model | blind+harness | guidance |
|---|---|---|
| opus | 7 / 3 (89T) | 4 / 11 (395T) |
| sonnet | 1 / 4 (111T) | 1 / 5 (118T) |
| kimi | 2 / 2 (87T, r8) | 2 / 3 (253T, k27) · 3 / 4 (127T, k3) |

Every suite killed every mutant. Kill-power tracks the model, not the
methodology — even kimi's tests-after-code suites are non-tautological,
because the guidance prompt puts a rich spec in context. The tautology
disease (bare Runs 4/5) is test-after with the CODE as the only oracle, not
test-after per se.

Where blindness shows unique, replicated value, invisible to mutation:
precedence-ordering tests (3 in blind-opus, 0 in all five other suites —
including opus-guidance whose prompt demanded precedence explicitly; Run 6's
finding replicated); adversarial pressure that flushes defects during the run
(disputes, hatch-writing caught by gates); and evidence that exists without
post-hoc labor. Caveat: two mutants, one domain — a mutation-score gate would
make this a standing measurement.

### Gates validated live this day

green-requires-red (7-second self-correction on sonnet, day one), surface
check (first catch: sonnet builder's undeclared public), collection-time red
hint (25 min → 84 s on opus), size ceilings, test-source escape-hatch lint,
boundaries + reachability obligations, sign-off (kimi honestly confessing an
invalid red), deliver (every arm hand-off ready). Guidance-only arms were
run via `PI_CODING_AGENT_DIR=~/.pi-vanilla/agent` — a config dir holding only
auth/model symlinks, no extensions, no skills.

---

## Runs 13–14: the composite gate, then the first reviewer

Run between the composite design gate landing (2026-09-07) and the mechanism
wave it and its successor motivated (2026-09-09). Two pairs, harness arm only —
these runs were testing new mechanism rather than re-measuring the
harness-versus-guidance contrast. Same task and the same two
models throughout (sonnet 5, kimi). **r13** is the first pair to run the
composite `design_gate` (ADR 2026-019). **r14** is the first pair with a
`reviewer` reading the design before the freeze (ADR 2026-020). Archive
branches `r13-sonnet-harness`, `r13-kimi-harness`,
`r14-sonnet-harness-aborted`, `r14-kimi-harness`.

Every number below is read from the run's own guard log, through the timing
block `deliver` prints.

### Where the minutes went

| | r13 (composite gate) | r14 (+ reviewer) |
|---|---|---|
| **sonnet** | 64 min end to end — design 45, tests 8, build 10, wrap 1; 3 sign-off findings | **aborted** ~52 min in, before any red: a design reviewed in 14 min, then a suite that would not run |
| **kimi** | 98 min — design 52, build 44; red established out of order; sign-off empty | **GREEN 106/106 in 67 min** — design 41:47 including NINE review cycles; build 44 → 9; 38 unrouted blocks [†]; 1 sign-off finding |

[†] **Read under the later split (r15).** "Unrouted blocks" was one counter
covering two different things, and most of these 38 were the second: workers
compiling and running their own suites and seeing red, which is the job. The
counter has since been split — `friction:` counts refusals only, `iteration:`
counts worker red-loops — and the honest reading of this row is "mostly
iteration". The number is left as it was printed.

### What the reviewer bought

**1. Defect discovery moved to where it is cheap.** r13 priced late discovery:
a contract defect surfacing as type errors once the test-writer was already
building on the frozen contract cost 30–38 minutes each, and every one of them
was legible in the contract before a single test existed. In r14 the same class
of defect surfaced pre-freeze, at minutes per review cycle. kimi is the clean
demonstration: **its build phase fell from 44 minutes to 9**, and the reason is
legible in the log — the reviewed contract survived contact with the builder
instead of being re-litigated mid-loop. The design phase absorbed the time
instead (41:47 of a 67-minute run), which is the trade the reviewer exists to
make.

**2. The freshness lock fired live and forced an honest re-review.** The gate
refuses to freeze a design whose bytes have moved since the review that covered
it. It blocked in-run, named the files that had moved, and the architect
commissioned the reviewer again rather than freezing. This is the ADR 2026-014
pattern holding once more: the *existence and freshness* of a review is
mechanism, its content is judgment, and only the first half survives being
merely written down.

**3. Nine review cycles is the failure mode of an advisory role.** kimi spent
nine on a gate that had never asked for more than freshness — advisory findings
polished until they ran out. An advisory role with no stopping condition will
absorb whatever time is available, so the condition is now written into the
architect's brief and ADR 2026-020: **zero blockers means freeze now**; concerns
and notes are settled by the architect's decision, in writing at `sign_off` if
they survive; a re-review is owed only when bytes changed.

**4. An 18-second re-review is a question, not a result.** One re-review in r14
returned in 18 seconds. Nothing checks that a review was *read* — the gate
checks that one exists and covers the current bytes — so whether that was a
fast read or a stamp is **unverified**, and it is the obvious next thing to
measure. A review whose cost approaches zero is a review whose signal is
unmeasured.

### What these runs forced into the harness

Each of these landed after the runs, motivated by them:

- **Red moved into a shadow project.** Both kimi arms died the same way: the
  builder had already implemented the contract when red was called, so no
  failure could be a `NotImplementedError` any more, and the only route back to
  red was **re-freezing the contracts to wipe `src/`**. The red gate now
  rebuilds `.pi/shadow-red` from the contracts, the tests and the config and
  proves red there, so a valid red is establishable at any moment — which is
  also what makes the two workers parallel rather than sequential. Green is
  bound to that red in both directions: the contract manifest, and a hash of
  the `tests/` tree, so a test edited after the red voids it (ADR 2026-017).
- **Spawn control by shape.** Twice across the two pairs the architect wrapped
  both workers in a `workflowScript`, and the gate — seeing one `subagent` call
  carrying a string — let it through with no precondition checked. Twice more
  it spawned `delegate`, the general write-capable worker, which carries no role
  binding and therefore no zone. Both forms are now refused by shape
  (ADR 2026-021): a gate cannot follow a script it never watches run, nor bind
  a role to a child it never sees named.
- **Forbidden tools removed rather than refused.** Both r14 arms spent whole
  turns on tools their role does not hold — refused, but still visible, so the
  model kept planning around them. Bound sessions now lose them from the
  toolset at `session_start`.
- **The scaffolder became a sync.** r14's architect deleted a scratch contract
  and its generated skeleton and law suite stayed behind, in write zones the
  architect does not hold: ~10 minutes and two failed `delegate` spawns for two
  files nobody wrote. Deleting the contract is now the whole gesture — the next
  `design_gate` prunes what the vanished contract generated, marker-gated, and
  a blocked run prunes nothing.
- **The re-freeze checks the review first.** r14 paid a full purity + scaffold
  + typecheck pass, repeatedly, only to be told at step four to go and
  commission the reviewer.
- **Friction became a printed number.** kimi's r14 arm ended with **38 unrouted
  blocks** and no single line in the run said so. Every delivery timing block
  now ends with a `friction:` line, counted by guard and printed even at zero.
  Bounces have a budget; friction has a target, and the target is 0.

  *Amended after r15.* "Unrouted blocks" turned out to be two things in one
  counter, and calling all of them friction made the headline lie: r15's kimi
  arm printed `31 unrouted blocks (typecheck 13, run_tests 8, git 4, …)`, which
  reads as a harness at war with its own workers, while the transcript showed
  21 of them were workers seeing their own red and exactly ONE call in the whole
  run was refused. The counter is now split by guard name — `friction:` for
  refusals (the call did not happen; target 0, printed even at zero) and
  `iteration:` for worker red-loops (`typecheck`, `run_tests`, `lint-*`; the
  call happened and told the truth; no target, printed only when non-zero).
  `git` counts as iteration too: a non-zero `git log` on a path that never
  existed is a search that missed, not a refusal.

### Caveats

Two arms per pair, one task, one domain: these are mechanism tests, not a
quality comparison, and nothing here re-measures the harness against guidance.
The sonnet r14 arm never reached a red, so it contributes evidence about the
design phase and nothing about the rest. And the r13/r14 timing splits were
produced by the phase-duration telemetry landed the same week — read them as
this instrument's first live readings.

---

## Run 15 (2026-09-09): the first parallel pair, and the deepest inspection yet

The first pair to run everything the r13/r14 wave built — parallel workers,
the shadow red, the stripped toolset, two model tiers — and the first pair
inspected line by line afterwards rather than graded from its timing block.
Both arms are harnessed; this is a mechanism run, not a harness-versus-guidance
comparison. Archive branches `r15-anthropic-harness`, `r15-kimi-harness`.

| | opus-5:high design / sonnet-5:medium workers | kimi-k3:high design / k2p7:medium workers |
|---|---|---|
| **Result** | **GREEN 180/180** in ~49 effective minutes | **GREEN 161/161** in ~69 effective minutes (76 live) |
| **Mutation score** (measured after the fact) | 95% | 80% |
| **Logged block** | design 55m27s, tests 8m38s, build 5m43s, wrap 1m10s; total 1h10m58s | design 1h19m55s, tests 5m35s, build 5m28s, wrap 1m44s; total 1h32m41s |
| **Unrouted blocks** | 4 (path-gate 2, lint-src 1, run_tests 1) | 31 (typecheck 13, run_tests 8, git 4, …) |
| **Sign-off findings** | 6, 0 blockers | 4, 0 blockers |

**Parallelism worked, and it is the one result to keep.** Both arms commissioned
the two workers in one turn and gated each as it returned. The opus arm revised
a contract *while the builder was building*, and it cost one `red_gate` call and
zero builder downtime — the shadow red is what makes that true. Note that the
timing blocks above cannot show the concurrency: the phases are defined
contiguously (TESTS runs freeze → first red, BUILD runs first red → first
green), so they never overlap in the analysis even when the workers do. The
`workers (tests ∥ build)` row exists for the day a boundary definition lets it
fire; on these logs it correctly did not.

**The logged design spans are wrong, and that is a finding.** Both arms lost
about fourteen minutes to a provider outage between the session opening and the
prompt landing, and DESIGN silently ate it: 55m and 80m logged for phases that
really took ~33m and ~58m. Neither log carries a run-start marker; the marker
was built because of this.

### What the deep inspection found

Twelve things, in rough order of how much they cost:

1. **Both delivered repos failed their own `npm run check`.** `deliver` added a
   `ts-morph` devDependency for the shipped surface checker and nothing ever
   installed it, so the first thing a colleague typed died on
   `ERR_MODULE_NOT_FOUND`. Nothing in the pipeline had ever run the project's
   own canonical command — `green_gate` runs its own tsc and its own vitest,
   which is not the same statement.
2. **The brand-identity impasse: ~44 of the kimi arm's 76 live minutes.** A
   contract reached a value object through another contract's
   `values.contract.js`, so the operations were declared over the ambient
   `declare class Money` while the only legal constructor — `Money.parse` in
   the implementation — returns a different, nominally distinct type. The
   shadow red came back with 41 `separate declarations of a private property
   '__brand'` errors over a value no test could build by any legal route. The
   architect eventually invented eight `parse*` boundary functions and re-froze
   mid-loop, and signed off recording "red-phase typecheck is unsatisfiable".
3. **That re-freeze then clobbered two finished implementations.** The scaffold
   step overwrote real code in both arms. One survived on a lucky `git add -A`;
   the other rebuilt 28 minutes of work.
4. **`typecheck` leaked past the blindness, and shaped shipped code.** The tool
   returned raw project-wide diagnostics to every caller, so it was a hole in
   the wall `run_tests` and the path gate build — and it leaked in both
   directions. The builder read `tests/billing.test.ts(5,3): … declares
   'CalendarDate' locally, but it is not exported`, reasoned that the tests must
   want a re-export, and added one; that shipped. The test-writer read the
   builder's in-progress implementation the same way ("the current
   `src/billing/billing.ts` is stale…").
5. **A surface-check false positive cost 4m19 and three worker bounces.** The
   check demanded a runtime export for a type-only contract export — an
   interface has no value to export, so it was an impossible instruction.
6. **The wedged reviewer, and `design_gate` used as a clock.** pi flags a child
   as needing attention after 60 seconds with no observed activity, and the flag
   does not clear on inspection: every later `subagent_wait` returned in
   milliseconds saying "attention required". The architect tried `all: true`,
   tried waiting again, and then reasoned — in its own words — "since I don't
   have a sleep mechanism, I'll use `design_gate` as my actual check since it's
   cheap and logged". Five full purity + scaffold + typecheck passes over
   unchanged bytes, each recorded in the guard log as a real design event. The
   reviewer was working fine the whole time.
7. **The sticky attention flag is an upstream pi bug**, and it is what made (6)
   look like the only option available.
8. **Provider outages, ~14 minutes per arm**, charged to DESIGN by a clock that
   started when the session opened rather than when the run did.
9. **Two composition defects shipped green — P2 and P9 in the inspection.** The
   sharpest: a monthly spend cap that a downgrade followed by an upgrade
   defeats, billing a 3000 month against a 1065 cap, with every individual step
   correct against its own clause. Nothing that reads operations one at a time
   can see it. A sibling defect crossed an enum instead of an operation pair —
   a plan change from a monthly interval to a yearly one prorated a year's price
   across a month — and a hole in a conflict payload shipped the same way. All
   of them were legible in the design, and the reviewer's checklist read every
   operation individually.
10. **The mutation survivors mapped onto the prompt's own headline rules.** Not
    obscure corners: the survivors sat on parse-and-guard logic the task
    description had called out by name, which is the useful property — a
    survivor is a specific claim that a shipped line can change with the suite
    still green.
11. **The dispute protocol had its first clean win.** A builder raised a
    dispute with spec evidence, the architect read both sides and settled it,
    and the loop continued. It has existed since v1; this is the first run where
    it did its job with nothing else going wrong around it.
12. **Sign-off confessions keep rising.** The kimi arm's sign-off findings ran
    0 (r13) → 1 (r14) → 4 (r15); the opus arm recorded 6. The gate has always
    accepted an empty list; what changed is that architects are using it.

### The fix wave this produced

Everything below landed after the pair, each motivated by a numbered finding
above:

- **One class identity per value object, and a scaffolder that cannot clobber**
  (ADR 2026-023, findings 2 and 3). A contract may not import types from — or
  re-export types from — another contract; it imports that contract's
  implementation module, which re-exports every type the contract declares. The
  scaffolder refuses anything else at scaffold time with the exact replacement
  import in the message. And the scaffold step writes a skeleton only where the
  target is absent or is itself generated: a file with real content is skipped
  loudly, never overwritten, so revising a contract mid-loop is now cheap.
- **`deliver` installs what it pins, and then asks the repo** (finding 1). The
  `ts-morph` pin is installed and verified, and a failed install is a block.
  The last step runs the target's own `npm run check` and blocks if it is red.
  The added dependency is deliberate and sanctioned: one checker copied verbatim
  from the pack beats an untested twin written to avoid an import.
- **`typecheck` is scoped by role** (finding 4). Workers and the reviewer see
  their own zone and the shared interface — contracts, `spec.md`, config — in
  full; everything else collapses to a count plus the owning role, with no path,
  line or symbol name, and visible lines are scrubbed of foreign path tokens.
  The verdict stays honest in the one shape that matters: "clean in your zone"
  is never rendered as "OK".
- **Surface-check accepts type-only satisfaction** (finding 5). A type-only
  contract export is satisfied type-only; only value declarations are asked for
  a runtime export.
- **`sleep`, and a rule about clocks** (findings 6 and 7). The architect gains a
  `sleep` tool (1–120s), and both its brief and the developer-stage skill now
  say plainly: wait with `subagent_wait`, then `sleep` — never fire a gate to
  pass the time.
- **`mutation_score`, advisory** (finding 10). The architect measures the suite
  before `sign_off` and carries every survivor into its findings. No threshold
  is enforced; the first job is to learn what real runs score.
- **The run starts at the first gated call** (finding 8). The path gate logs a
  `run-start` event at the first gated tool call of a session, and the timing
  block measures from there and names the time it started.
- **Friction and iteration are two counters** (see the r14 amendment above).
  Refusals keep the target of zero; worker red-loops print as the normal work
  they are. Overlapping workers render as one `workers (tests ∥ build)` row.
- **The reviewer's checklist grew three items** (finding 9): compose every
  operation pair, cross every enum-valued field, and run `typecheck` first —
  a tree that does not compile is a blocker, not something to review around.
  r15's cycle-4 reviewer recorded "no findings" while its own typecheck showed
  14 errors caused by the design under review.

### Caveats

Two arms, one task, one domain, both harnessed: mechanism evidence, not a
quality comparison. The mutation scores were measured after the fact by the
tool the run motivated, not during it, so they are a property of the delivered
suites rather than a reading either architect ever saw. And the timing blocks
above are the raw logged ones — the run-start marker that would correct them
did not exist yet.
