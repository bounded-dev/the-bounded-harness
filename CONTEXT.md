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
The deliberately minimal set of subagents in `agents/`: `scout` (read-only) and `delegate` (write-capable worker). No ad-hoc roles.
_Avoid_: agents (unqualified), roles, personas

**Canonical commands**:
The script names every project declares — `check`, `test`, `build`, `lint` — which any agent session looks for first.
_Avoid_: scripts (unqualified), tasks

**Orca-managed**:
Files (e.g. `extensions/orca-*.ts`) that Orca rewrites; tracked in git but never hand-edited.

**Trunk-based**:
The git workflow: work happens in worktrees on local branches tracking `main`, and "push" means push to remote `main` unless told otherwise.
_Avoid_: feature-branch workflow, gitflow
