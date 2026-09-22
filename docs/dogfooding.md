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

Read the guard log (`<project>/.bounded/guard-log.jsonl`) after each run: `block`
verdicts are drift the guards caught; `pass` verdicts prove a guard ran.

**Every run's write-up answers three questions from that log, not from
impressions:**

1. **Where did a deterministic gate correct the run?** List every `block`
   that changed the agent's course, with timestamp and what followed. The
   canonical shape, from the first Claude Code harness run: `design-gate
   BLOCK — design-review missing` with everything else green, followed 17s
   later by `commissioned reviewer` — the gate forced the review into
   existence. A pass proves a guard ran; a block that redirected the agent
   is the product earning its keep.
2. **What did the model probe?** Deliberate boundary tests (that same run:
   a test-writer write to `/nonexistent-probe-path`, refused) are evidence
   the walls are load-bearing, not decorative. Record them.
3. **Was anything circumvented?** Anything that should have blocked and
   didn't, tracked adapter config touched mid-run (`.claude/`, the role
   binding, the hook), or a write on disk in a zone with no matching guard
   line. None observed to date; the first one found is a bug issue with the
   log excerpt attached, not a passing note.

## Running one

```bash
bounded dogfood-reset          # rebuilds both arms from the default prompt
bounded dogfood-reset --design-model <pattern> --worker-model <pattern>
```

The two model flags set the harnessed arm's tiers — the judgment seats
(architect, reviewer) and the production seats (test-writer, builder) — by
writing `.bounded/dev-stage-models.json` (ADR 2026-022). Both are printed on every
reset, set or not, so a run's models are never a guess afterwards.

Then walk into each and paste `PROMPT.md`:

- `~/dev/bounded-harness-dogfood-bare` — the control. Claude Code, ordinary tools.
- `~/dev/bounded-harness-dogfood-harnessed` — pi. Gated as the architect
  automatically via `.bounded/dev-stage-role`; there is no launcher to remember.

Two directories, one `main` branch each, no worktrees. **Runs are disposable**
— `bounded dogfood-reset` wipes both and starts over, so copy anything worth keeping
before re-running. Past runs (1–5) live as branches in
`~/dev/bounded-harness-dogfood-archive`.

`bounded dogfood-reset` writes the operational `AGENTS.md` block from a single string
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

One file per run (or per grouped experiment) in [`dogfood/runs/`](dogfood/runs/),
moved there verbatim on 2026-09-22. Each run file stays append-only; a new run
gets a new file and a row here.

| Run | Title |
| --- | --- |
| 1 | [Run 1 — Sonnet · reading-list](dogfood/runs/run-01-sonnet-reading-list.md) |
| 2 | [Run 2 — Haiku · reading-list](dogfood/runs/run-02-haiku-reading-list.md) |
| 3 | [Run 3 — Haiku · reading-list (full pipeline)](dogfood/runs/run-03-haiku-reading-list-full-pipeline.md) |
| 4 | [Run 4 — Sonnet · billing · harness vs no harness](dogfood/runs/run-04-billing-harness-vs-no-harness.md) |
| 5 | [Run 5 — Sonnet · billing · bare vs harness](dogfood/runs/run-05-billing-bare-vs-harness.md) |
| 6 | [Run 6 — Sonnet · billing · bare vs folded harness](dogfood/runs/run-06-billing-bare-vs-folded-harness.md) |
| 10–12 | [The six-cell experiment (mechanism vs guidance)](dogfood/runs/runs-10-12-the-six-cell-experiment.md) |
| 13–14 | [The composite gate, then the first reviewer](dogfood/runs/runs-13-14-composite-gate-first-reviewer.md) |
| 15 | [The first parallel pair, and the deepest inspection yet](dogfood/runs/run-15-the-first-parallel-pair.md) |
| 16–19 | [The r15 wave lands, a real app arrives, first headless deliveries](dogfood/runs/runs-16-19-the-r15-wave-lands.md) |
| 20 | [Re-confirmation, and a resume under an external limit](dogfood/runs/run-20-reconfirmation-and-a-resume.md) |
| 21 | [The first change run](dogfood/runs/run-21-the-first-change-run.md) |
| 22 | [The first stack run — a tRPC service over the delivered core](dogfood/runs/run-22-the-first-stack-run.md) |
| 23 | [The reference set validated — three tickets, one structure](dogfood/runs/run-23-the-reference-set-validated.md) |
| 24 | [The first web-frontend run](dogfood/runs/run-24-the-first-web-frontend-run.md) |
| 25 | [The first Claude Code harness run](dogfood/runs/run-25-the-first-claude-code-harness-run.md) |
| 26 | [Two accidentally-bare arms — the loader bug run](dogfood/runs/run-26-two-accidentally-bare-arms.md) |
| 27 | [opus/sonnet vs kimi, both harnessed — the gates hold under a weak worker](dogfood/runs/run-27-opus-vs-kimi-both-harnessed.md) |
