# Developing and reviewing the harness

Issue #15 establishes independent review for non-trivial changes to the
harness itself. Changes to behavior, enforcement, architecture or contributor
policy qualify. Typographical fixes can use the driver's review alone.
This agreement is not an automated merge gate.

## Before landing

1. Identify the issue, acceptance criteria, starting revision and owned paths.
   Parallel writers own separate paths; shared interfaces settle before their
   consumers change. Use the issue-tracking skill for issue and board updates.
2. Implement in a worktree. Read `docs/VISION.md`, root instructions and any
   instructions beneath the affected directory. Record architectural decisions
   as concise ADRs. Keep runtime state and review scratch in `.agent-state/`.
3. Run relevant checks. For executable harness changes, run `npm run check`
   from `agent/`; it includes typechecking and the test suite. Add focused
   regression coverage for changed behavior and failure paths. Pure prose
   changes require checking references and claims against the implementation.
4. Commission a fresh read-only `scout`, or another contributor who did not
   author the change, on the final diff and surrounding code. Include the issue,
   acceptance criteria, base revision, changed paths and validation results.
   A delegate who authored a separate ticket can review this ticket if they
   have not contributed its implementation. Use read-only tools for the pass.
5. Resolve each finding with a correction or a reason grounded in evidence.
   Re-run affected checks after corrections. Obtain another independent pass
   on substantive revisions; do not present an earlier review as covering
   later behavior. Unresolved correctness or enforcement defects prevent
   landing; advisory preferences can be declined with reasons.
6. Record the review and checks with the change before landing under the
   repository's trunk workflow. Local completion alone does not mean merged
   or Done. Follow the issue-tracking skill for the actual status transition.

## What the independent reader checks

- **Behavior:** does the change satisfy the issue, including invalid inputs,
  stale evidence, compatibility and failure paths? Do tests establish the
  requirement independently of the chosen implementation?
- **Extension boundaries:** core mechanisms name no technology; new sockets
  have consumers and ADRs; pack contributions use declared dependency edges.
  A project omitting a pack receives none of its behavior. Check code and
  data contributions, generated output and both host adapters where affected.
- **Enforcement:** refusal paths remain closed, role and path boundaries hold,
  and evidence cannot be reused across a changed design or test suite.
  Separate guarantees actually enforced from instructions that ask cooperation.
- **Documentation:** changed guards appear in the appropriate role briefs;
  command help, skills, ADRs and current-state claims agree with code. Preserve
  historical experiment results as historical evidence.
- **Repository rules:** no secrets or runtime state, no project-specific global
  configuration, no hand-edited package installation state, and no incidental
  changes to another delegate's work.

Return findings with severity, file/location, concrete failure scenario and
suggested remedy. An empty finding list is valid; state the review scope and
remaining uncertainty. A review does not prove domain correctness.

The minimum review record is:

```text
Issue and acceptance criteria:
Base revision and reviewed revision (or saved diff fingerprint):
Reviewer and reviewed paths:
Findings and resolutions:
Checks, results and limitations:
Changes since review and any follow-up review:
```

Keep working records in `.agent-state/`; include this evidence in the final
handoff or, when publication is authorized, the issue or PR. Do not put
machine paths, transcripts containing credentials, or private run state in
tracked documents.

## First self-hosting experiment — planned, not executed

Test whether the developer stage can produce a useful harness component with
less corrective work than a briefed delegate. Start with a bounded pure
component, such as validating contribution manifests, with malformed input,
unknown fields and incompatible versions specified explicitly. Choose an
unimplemented slice after the current composition work settles; do not rebuild
an already completed ticket merely to label it self-hosted.

The harness repository as a whole is not currently arranged as a delivered
contract-based component. Its source is under `agent/`, while the stage's
scaffolding and delivery operate on a target's `src/`, `tests/`, contracts and
package scripts. Running delivery on the harness root is not the first trial.

1. Pin the harness revision and record the candidate issue, API boundary,
   dependency assumptions and common acceptance scenarios. Prepare two
   isolated target projects from the same baseline outside the live config
   home, with identical dependencies and only the required packs. Agree the
   model tiers, time and spend limits before launching paid sessions.
2. In the stage arm, launch `bounded ticket` in the target and use the existing
   developer-stage skill: architect-owned specification/contracts, independent
   design challenge, frozen design, blind test-writer and builder, shadow red,
   green, mutation measurement, sign-off and delivery. Verify the role loader
   and guard events actually enforce the boundaries. Do not claim that a
   generic delegate running gate commands has the same isolation.
3. In the comparison arm, give a briefed delegate the same requirements,
   dependencies and acceptance scenarios. Do not expose either arm's output
   to the other. Record the actual models and tools used; differing model
   assignments limit conclusions about the workflow itself.
4. Inspect both outputs against the same withheld acceptance checks, including
   invalid-input and integration cases. Record elapsed time, token/cost data
   where available, gate findings, manual interventions, defects and corrective
   edits. An independent reader evaluates both outputs and reports limitations.
5. Integrate the selected component into an isolated harness worktree, run
   `agent/`'s canonical check, and obtain the independent review above. Report
   adapter and integration work done outside the stage separately. Only that
   component has been developed through the stage; the whole repository has not.
6. For a subsequent change trial, preserve the delivered target's `.bounded/`
   state and use `bounded change-run` before a new architect session. Restart
   against a pinned harness revision rather than replacing loaded modules
   mid-session. A fresh clone without the manifest needs the adoption work in
   issue #14; do not bypass that gap by manufacturing passing gate evidence.

Record the result under `docs/dogfood/runs/` and link it from the experiment
index only after execution. A failed or interrupted trial is evidence too:
capture the boundary that blocked it and the remaining work. One component
trial cannot establish a general quality or cost advantage.
