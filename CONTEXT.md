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
