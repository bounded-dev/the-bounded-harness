# pi-harness

The user's live pi coding-agent config home (`~/.pi/agent` symlinks here). Global scope only: everything here applies to every project on the machine, and the root stays language-agnostic.

## Language

### Structure

**Harness**:
This repository itself — the global pi configuration, symlinked to `~/.pi/agent`, live the moment it changes.
_Avoid_: config, dotfiles, setup

**Pack**:
A language-specific pi package under `packs/<lang>/` holding on-demand skills and scaffolder scripts — never extensions or root config.
_Avoid_: plugin, module, bundle

**Skill**:
A folder with a `SKILL.md` of on-demand instructions, loaded only when its description matches the task at hand.
_Avoid_: prompt, command, macro

**Extension**:
A TypeScript file in `extensions/` that auto-loads on session start to add tools or behaviour.
_Avoid_: plugin, hook

### Working method

**Subagent roster**:
The deliberately minimal set of subagents in `agents/`: `scout` (read-only), `delegate` (write-capable worker), and `product-expert` — "the PM" (read-only + web, product judgment). No ad-hoc roles.
_Avoid_: agents (unqualified), roles, personas

**PM**:
The `product-expert` subagent — a product-domain expert instantiated for the current repo's domain, consulted during `expand` for independent product judgment.
_Avoid_: product manager agent, product persona

**Canonical commands**:
The script names every project declares — `check`, `test`, `build`, `lint` — which any agent session looks for first.
_Avoid_: scripts (unqualified), tasks

**Orca-managed**:
Files (e.g. `extensions/orca-*.ts`) that Orca rewrites; tracked in git but never hand-edited.

**Technical Note (TN)**:
The single document primitive for project thinking — numbered, statused, kinded, ticket-linked. The working surface where ideas develop before ratification into ADRs. Conventions live per-repo in `docs/tn/README.md`.
_Avoid_: spec doc, design doc, RFC

**Expand**:
The divergent first phase of feature work — research, cross-domain parallels, widened requirements, and experienced pushback — held entirely in conversation until synthesised into a TN by `to-tn`.
_Avoid_: brainstorm, discovery phase

**Trunk-based**:
The git workflow: work happens in worktrees on local branches tracking `main`, and "push" means push to remote `main` unless told otherwise.
_Avoid_: feature-branch workflow, gitflow

**Agent state**:
The per-repo, gitignored `.agent-state/` folder holding temporary agent working files — snapshots, workflow state, scratch. Never committed; every capability that writes transient files puts them here.
_Avoid_: .git/ stash, tmp dirs, hidden tool folders

### Developer stage

**Developer stage**:
The pipeline stage that turns a task into tested code via three write-capable subagents with disjoint authority: architect, test-writer, builder (TN-26-001).
_Avoid_: dev phase, coding step

**Architect**:
The developer-stage subagent that writes the spec and contract — never implementation. Fresh context per task; re-derives structure from the plan rather than transcribing it.
_Avoid_: designer, planner

**Test-writer**:
The developer-stage subagent that writes tests from spec + contract. Always blind to `src/`, including on revision passes.
_Avoid_: tester, QA agent

**Builder**:
The developer-stage subagent that implements to the contract. Blind to test source (no `bash`; sanitized `run_tests` tool); never edits tests or contract files.
_Avoid_: developer (that's the stage), worker, coder

**Plan**:
The orchestrator's per-task document: intent, approach, sequence, risks, scope, and a structural *sketch*. Disposable once the contract exists — it proposes, the architect decides.
_Avoid_: spec, design (those are the architect's)

**Contract**:
The `*.contract.ts` files colocated with a component — exported interfaces, types, and ports; declaration-only by lint; implemented by the sibling module (`foo.contract.ts` → `foo.ts`). The load-bearing artifact both blind agents code against.
_Avoid_: stubs (that's the generated skeleton), interface file, API doc

**Orchestrator**:
The pi session that drives the developer stage — the only party holding `subagent`. It spawns the three blind workers, runs every gate itself (never trusting a worker's word on pass/fail), and routes disputes. In interactive v1 it is the main session.
_Avoid_: coordinator, driver, controller

**Team lead**:
An orchestrator that is itself a subagent — fans out multiple tasks to per-task orchestrators. v2; interactive v1 has no team lead.
_Avoid_: manager agent, supervisor

**Dispute**:
The builder's formal objection to a test (`DISPUTE`) or contract (`CONTRACT-DISPUTE`) — voice without a pen. Routes builder → test-writer → architect → user.
_Avoid_: complaint, override

**Zone**:
A glob-defined region of the repo one role may write to, with a zone lint rule defining what content is legal there.
_Avoid_: folder, boundary

**Scaffolder**:
The machine step that generates the throwing skeleton from a contract (`packs/ts/scripts/scaffold-contract.ts`). Never an agent; drift becomes a compile error, not an assertion.
_Avoid_: generator (unqualified), codegen

**Skeleton**:
The generated sibling implementation (`foo.ts`) whose every export throws `NotImplementedError` (from the shared errors module) until the builder replaces it. The red phase runs against it.
_Avoid_: stub (use for a single throwing member), contract

**Value object**:
A domain type that replaces a primitive at a contract's public boundary — in
TS a branded type (`type Isbn = string & { readonly __brand: "Isbn" }`) or a
string-literal union. Enforced by the `no-naked-primitives` rule inside the
contract-purity gate.
_Avoid_: newtype, wrapper type, DTO

**Naked primitive**:
A `string`/`number` used directly as a type on a contract's exported surface —
the design defect `no-naked-primitives` blocks. A bare alias (`type Isbn =
string`) is equally naked: it is assignable from every other string.
_Avoid_: raw type, stringly-typed (use for the symptom, not the check)

**Gate**:
A deterministic command that passes or fails a phase transition — e.g. contract-purity, red-with-right-reason, green. Orchestrator judgment routes; gates decide pass/fail.
_Avoid_: check (unqualified), lint (that's one gate's mechanism)

**False green**:
A suite that passes while the project does not typecheck. Green requires both, so red-gate and green-gate run `tsc` as well as the suite.
_Avoid_: flaky pass, soft green

**Route**:
The single `route → <role>` line a failing gate prints, naming the furthest-upstream role whose write zone owns the failure. The bounce target is derived from the path gate's own zones, so the named role can always actually make the fix.
_Avoid_: assignee, owner (unqualified)

**Guard log**:
The append-only JSONL at `<project>/.pi/guard-log.jsonl` where every deterministic guard records blocks (drift caught) and passes (guard ran). Always on; `PI_GUARD_LOG=off` opts out.
_Avoid_: audit log, telemetry (unqualified)

### Issue tracking

**Board**:
The GitHub Projects v2 board linked to a repo — one per repo, named after the repo.
_Avoid_: project (unqualified), github project

**Status**:
The board's single-select field an issue sits in (Backlog … Done). Distinct from the issue's GitHub state (open/closed).
_Avoid_: column, state

**Epic**:
A board single-select field grouping issues by theme.
_Avoid_: milestone, label

**Capture**:
Creating an issue fast — title, Status Backlog, no assignee. Everything else waits for triage.
_Avoid_: quick-add, jot

**Triage**:
The deliberate act of moving issues out of Backlog — deciding Status, Epic, and Priority.
_Avoid_: grooming, refinement
