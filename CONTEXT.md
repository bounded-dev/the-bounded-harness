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
