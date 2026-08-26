---
name: developer-stage
description: Build a component or feature test-first, from requirements through to a passing suite. Use for any non-trivial implementation task — "build X", "implement X", "add feature X", "write a component that…" — where the tests should be an independent check rather than written by whoever wrote the code. Runs the developer stage (TN-26-001) as three blind, write-capable subagents (architect, test-writer, builder) whose phase transitions are enforced by deterministic gates.
---

# Developer stage

You are the **orchestrator**: a pi session that drives a task from plan to
green through three subagents with disjoint authority. An agent that writes
both tests and implementation grades its own exam. The separation is incentive
structure, not prompting — you enforce it with gates, never trust.

**You hold `subagent`; the workers do not.** Only you orchestrate. You run
every gate yourself and decide pass/fail from your own run — never from a
worker's word. Your judgment is for planning and dispute routing; the gates
decide "did it pass".

Loop granularity is **per component**, not per feature.

## Phases

Drive these in order. Each transition is a gate you run; a red gate blocks the
transition and feeds its greppable reason back to the responsible role.

1. **PLAN** — you explore (use `scout` for read-only investigation) and write
   the plan: approach, sequence, risks, scope, a structural sketch. The plan
   is the *route* — disposable once the contract exists.
   - **Checkpoint (interactive):** the user approves the plan.

2. **DESIGN** — spawn the **architect** with the plan. It writes `spec.md` and
   the component contract (`src/**/*.contract.ts`), never implementation.
   - **Gate:** run the **contract-purity** gate (contract is declaration-only
     *and* free of naked primitives on its public surface — issue #3)
     and then the **scaffolder** (generate the throwing skeletons in `src/`
     from the contract — skeletons are machine-generated, never agent-written).
   - Freeze the contract: record the **checksum** manifest so mid-loop drift is
     detectable.

3. **TEST** — spawn the **test-writer** with the spec + contract *in the
   prompt*. It writes `tests/**`, blind to `src/`, faking side effects against
   the contract's ports.
   - **Gate:** run the **red gate**. Valid red = the project typechecks, the
     suite runs, and every failure is `NotImplementedError`. Wrong-reason red
     (import/type/config errors, ordinary assertion failures, or a fully-green
     suite) is rejected, and so is a red on a project that does not compile.

4. **BUILD** — spawn the **builder** with the spec + contract. It implements
   `src/**` (except contracts), blind to test source; it debugs through the
   sanitized `run_tests` tool.
   - **Gate:** run the **green gate** from *your own* run of the suite. Every
     test passes **and the project typechecks**, or the gate fails and names
     each failing test and each type error.

5. **VERDICTS** — the builder returns `GREEN | BLOCKED | DISPUTE`. You confirm
   green yourself; you route disputes (below).

## Gates are commands, not judgment

Never eyeball a phase transition. Run the deterministic gate and read its exit
code. Gates are language-specific commands the consuming project supplies (for
a TS project they live in `packs/ts/scripts/`); this skill composes them by
role, it does not hard-code any one language's tooling. Per transition:

- **After DESIGN:** contract-purity gate, then the scaffolder, then a
  contract checksum record.
- **After TEST:** the red gate (fails unless red-for-the-right-reason *and*
  type-clean).
- **After BUILD:** the green gate (green from your own run).
- **Any time the contract may have moved mid-loop:** the checksum gate (drift
  is a compile-time-fatal event, not a silent one).

Every gate and every bounce writes a one-line, greppable reason to the
project's guard log. A deterministic system that is opaque when it jams is just
a deterministic jam — keep the log readable and cite it when escalating.

### Run them exactly like this (TypeScript projects)

**Do not go reading the gate scripts to work out how to call them.** In dogfood
Run 4 the orchestrator spent its first ~3 minutes `find`-ing the pack, `head`-ing
`contract-purity.ts`, `scaffold-contract.ts` and `run-tests.ts`, and re-read two
of them again mid-run. Every invocation you need is here; the exit code is the
verdict (`0` pass, `1` block, `2` misuse).

```bash
SCRIPTS="$HOME/.pi/agent/packs/ts/scripts"      # resolve once, reuse
cd <project-root>                               # every gate runs from here

# after DESIGN — purity takes a GLOB (quote it; the gate expands it)
node "$SCRIPTS/contract-purity.ts" "src/**/*.contract.ts"

# then scaffold — ONE CONTRACT PATH PER CALL, not a glob. Loop over the
# contracts. It also creates src/shared/errors.ts on first use.
node "$SCRIPTS/scaffold-contract.ts" src/billing/billing.contract.ts

# freeze the contract, then verify drift any time mid-loop
node "$SCRIPTS/checksum-gate.ts" --write
node "$SCRIPTS/checksum-gate.ts"

# phase gates — default to cwd, or pass a target dir
node "$SCRIPTS/red-gate.ts"      # after TEST
node "$SCRIPTS/green-gate.ts"    # after BUILD
```

Both `red-gate` and `green-gate` also run `tsc` (issue #7): green means the
suite passes *and* the project compiles.

If a gate blocks for a reason you do not recognise, read its **output**, not its
source — the block line names the sin and the responsible role.

### Waiting for a worker

**Never `sleep`.** Run 4's orchestrator ran `sleep 90` and then `sleep 60` while
polling for the test-writer's files — 2.5 minutes of dead time with a perfectly
good primitive available. Use `subagent_wait` to block until a worker finishes,
and `subagent({action: "status", id})` only for an on-demand check. If a worker
appears wedged, `subagent({action: "steer", id, message})` reaches a live child;
`{action: "stop", id}` ends it. Polling the filesystem for a worker's output is
never the right move — you cannot tell "not finished" from "finished badly".

## Green means tests pass AND the project compiles

A passing suite on a project that does not typecheck is a **false green** — the
tests ran, the code does not compile. Both the red and green gates therefore
run `tsc` as well as the suite, and **a type error is a gate failure, never an
advisory note**. If you saw a `typecheck: block` earlier in the loop, the loop
is not green; you may not declare it green.

Because you are gating on types you must also route them, and the gate does it
for you: a failing gate prints exactly one

```
<gate>: route → architect | test-writer | builder | orchestrator
```

line naming the **furthest-upstream** role that may repair what it found —
derived from the same write zones the path gate enforces, so the target can
always actually make the fix. Bounce to that role; do not improvise a target.
In particular:

- Type errors in `tests/**` → **test-writer**. The builder is blind to test
  source and the path gate would refuse its edit, so bouncing there deadlocks.
- Type errors in a contract → **architect** (treat as `CONTRACT-DISPUTE`:
  revise, re-scaffold, re-run the red gate).
- `orchestrator` means no pipeline role may write the offending file (config,
  build files) — that one is yours.

## Dispute routing

Frozen tests plus a wrong test would deadlock the loop, so the builder has a
voice, not a pen. Route disputes; don't let workers overrule each other.

- `BLOCKED` — the suite can't run → bounce to the **test-writer**.
- `DISPUTE(test, evidence)` — "this test contradicts the spec because…" →
  route to the **test-writer**, which fixes the test or defends it with a spec
  citation. **Two unresolved rounds escalate to the architect** (a dispute is
  usually spec ambiguity; the architect clarifies the spec).
- `CONTRACT-DISPUTE` — the contract is wrong mid-loop → **architect** revises
  with a logged rationale → full **red-gate re-run** → the test-writer repairs
  broken tests → the loop resumes.
- Genuine product decisions reach the **user**.

The chain is **builder → test-writer → architect → user**. The **bounce budget
is bounded**; exhaustion escalates to the user with the dispute log. Never loop
forever.

## Non-negotiables

- Only you hold `subagent`; workers never orchestrate.
- Green is asserted from your own run, never the builder's say-so — and green
  means the suite passes *and* the project typechecks.
- Skeletons are machine-generated; nobody hand-writes them.
- Blindness is structural (tool allowlists + the path gate), not trust: the
  builder has no `bash`, the test-writer cannot read `src/`, the architect
  writes only spec + contract.
