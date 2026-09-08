# 2026-020: The design is read before it is frozen

**Status:** accepted

## Decision

A read-only `reviewer` role reads `spec.md` and every `*.contract.ts` as the
two blind consumers will have to, and records what it found with
`record_design_review`. The record is checksum-bound: it carries a sha256 per
file, computed by checksum-gate's own hashers over checksum-gate's own file
discovery, so "the bytes the reviewer read" and "the bytes the freeze records"
are one question asked twice rather than two implementations that can disagree.

`design_gate` gains a `design-review` step between the typecheck and the
freeze: it requires the latest recorded review to match the current bytes
exactly — same file set, same hashes — and otherwise refuses to freeze, saying
which of the two it is (never reviewed, or reviewed then edited, naming the
files that moved) and routing to the architect. Latest is by append order, the
same rule green-gate uses for the red it requires.

**Findings are advisory.** The gate decides existence and freshness, which a
machine can decide; the architect settles content, which it cannot. A blocker
does not fail the gate — the passing line prints the blocker count so an
unsettled one stays visible in the transcript.

## Why

Run r13 measured the bill for discovering a contract defect late: ~30–38
minutes per defect, arriving as type errors once the test-writer was already
building on the frozen contract, and every one of them legible in the contract
before a single test existed. The only pre-freeze quality signal was
"commission the test-writer and see what explodes", which works and costs a
phase.

ADR 2026-014 says why this is a role with a checklist and a recording tool
rather than an instruction to be careful: a persona does not hold, and prose
executes unreliably. So the review is a checklist the reviewer walks, a tool
that records the answer including "I found nothing", and a deterministic
freshness lock — the only three parts a machine can keep honest.

## Consequences

Re-review after every design edit is enforced by construction: any change to
the spec or a contract changes a hash, and the step blocks. That is the
intended cost — a revised contract is an unreviewed contract — and it is paid
in one subagent call, not a phase.

The reviewer decides nothing. It holds no write zone, no gate tool, and no
verdict; "gate" stays false of it, and an architect that could record its own
review would be doing the first reading again rather than a second one, so
`record_design_review` is the reviewer's alone.

The post-red suite-adversary variant of the same idea — a reviewer over the
tests once the red stands — remains open in issue #13.
