# Claude Code host adapter

The developer stage's **capability constraints** (ADR 2026-034, Tier B) for
Claude Code: the path gate and the phase gate as a `PreToolUse` hook, the tool
strip as generated `.claude/agents/*.md` `tools:` allowlists, and the role
binding through each agent definition's own `hooks:`. The **artifact gates**
(Tier A) are not here — they are `bounded-gates <gate>`, one CLI for every host,
and this adapter only decides who may run which of them.

Everything here is thin wiring over the same pure cores the pi extensions
use: `decide()` (`src/path-policy.ts`), `checkSubagentCall()`
(`src/phase-gate.ts`), `sessionRole()` (`src/path-gate.ts`). There is no second
rule set. Where Claude Code differs from pi — it has no way to register a named
tool, so the gates are reached through Bash — the difference is one derived
list (`bash-policy.ts`) and one mapping (`PI_TO_CLAUDE_TOOLS` in
`render-agents.ts`), both pinned to `ROLE_TOOLS` by drift tests.

**Status: verified by fixture.** There is no Claude Code runtime in this
repository's test environment. Every behaviour below is asserted by spawning
the hook and the installer against fixture payloads copied from the Claude
Code hook documentation. The first live run is a dogfood entry, not a claim
this README makes.

## Files

| file | what |
|---|---|
| `path-gate-hook.ts` | The `PreToolUse` hook. Reads the call as JSON on stdin; prints a deny decision, an allow that rewrites an allowed `bounded-gates …` to `BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=<role> bounded-gates …`, or nothing. `--role <role>` binds; without it the role comes from `.pi/dev-stage-role`. |
| `tool-map.ts` | Claude Code tool call → pi tool call(s): `Read {file_path}` → `read {path}`, `Agent {subagent_type}` → `subagent {agent}`, and so on. |
| `bash-policy.ts` | What a role may put through Bash: `bounded-gates <gate>` for the gates in its `ROLE_TOOLS`, plus `git`, `sleep`, `rm <path>` where the role holds the pi tool. Everything else refused. |
| `render-agents.ts` | Generates `.claude/agents/<role>.md` from `agents/<role>.md`: `tools:` from `ROLE_TOOLS`, `hooks:` binding the role, the pi brief verbatim under a host preamble. |
| `install.ts` | Writes the four agents, links the `developer-stage` skill into `.claude/skills/`, and merges the ambient hook into `.claude/settings.json`. |

## What it enforces

- **Path gate**, identical to pi's: Read/Edit/Write/MultiEdit/NotebookEdit/
  Glob/Grep are mapped to `read`/`edit`/`write`/`find`/`grep` and judged by
  `decide()` against the role's zones. A blind role cannot read the other
  side's work product; every role's writes are confined to its zone; `.git`
  and `.pi` are protected as in pi.
- **Phase gate** on `Agent`: an `Agent` call with `subagent_type: builder` is
  a `subagent` launch of the builder, judged by `checkSubagentCall()` against
  the project's guard log — no contracts, no spec, no design gate, no spawn.
  Before that, the `subagent_type` itself is judged: only the four generated
  definitions carry a tool strip and a bound hook, so a commission of
  anything else — `general-purpose`, `Explore`, a user's own agent, pi's
  `delegate`, or no `subagent_type` at all — is refused as an unbound
  subagent, in the phase gate's own words, and logged as its
  `spawn-refused` block. Without this, `Agent {subagent_type:
  "general-purpose"}` would be a full-toolset, hook-free proxy for the
  architect, which is exactly what pi's `delegate` refusal prevents.
- **Tool strip**, as `tools:` in the generated agent definitions: a worker
  never sees `Agent`; the reviewer never sees `Write` or `Edit`. Pinned to
  `ROLE_TOOLS` by `render-agents.test.ts`, the way `agent-config-drift.test.ts`
  pins pi's frontmatter.
- **Bash narrowed to the carriers.** The command is read the way a POSIX
  shell reads it and refused if it is more than one plain argv: `;`, `&`,
  `|`, `(`, redirects, `$`, backticks, backslashes, globs, braces, tilde,
  comments, an unterminated quote, an env-assignment prefix. What survives is
  allowed only if it is one of:
  - `bounded-gates <gate> …` where `<gate>` (hyphens or underscores) is in the
    role's `ROLE_TOOLS` and is not a file tool — so the builder may run
    `run-tests` and `typecheck`, the architect every gate, the reviewer
    `record-design-review` and `typecheck`; `bounded-gates --list|--help` always;
  - `git …` for roles holding `git` (the architect), minus git's known ways of
    running another program (see limits). The subcommand is the first word
    after the four global options the policy passes (`--no-pager`, `-P`,
    `--no-optional-locks`, `--literal-pathspecs`); any other leading option
    is refused by name, because a global that takes a value (`-C <dir>`,
    `--git-dir <dir>`) would put its value where the subcommand is read and
    slip `config core.hooksPath …` or `bisect run …` past the checks;
  - `sleep <1-120>` for roles holding `sleep` (the architect);
  - `rm <one literal path>` judged as a pi `remove`, so the write zones apply.
  A refusal is one line: `path-gate: <role> may not run '<cmd>': <why> — …`,
  using pi's own `forbiddenWhy` sentence where pi has one. `--role` and
  `--findings-file` are refused anywhere in a `bounded-gates` argv: the host
  supplies the role, and findings are passed inline. Gate names are
  hyphenated (`bounded-gates red-gate`); the pi spelling (`red_gate`) is accepted.
- **The bound role and the host reach the gate process.** An allowed
  `bounded-gates …` is answered with `permissionDecision: "allow"` and an
  `updatedInput` whose command is `BOUNDED_HOST=claude-code BOUNDED_DEV_STAGE_ROLE=<role>
  <original command>`; the rest of the tool input is kept. `sessionRole()`
  reads the role variable before the `.pi/dev-stage-role` file, so a gate
  that scopes its output by role (`typecheck`) sees the role the definition
  bound, whatever file the project holds; and the CLI records `host
  claude-code` in the guard log rather than `host none`, which is what a
  `bounded-gates` with no `BOUNDED_HOST` records. The policy has already refused every
  construct that could make the prefix anything but an env assignment, and a
  prefix the model types itself — either variable — is refused. `git`,
  `sleep` and `rm` are allowed silently — nothing in them reads a role.
- **Role binding by which definition loads.** `.claude/agents/<role>.md`
  carries the hook with `--role <role>` in its own `hooks:`; those fire only
  inside that subagent. The model cannot change its role: `.claude/**` is in
  no role's write zone, so the definitions and `settings.json` are unwritable
  from inside a run.
- **Guard log.** Every block, the run-start marker (the architect's first
  call, once — the log is the latch, since each hook run is a fresh process),
  and every hook error land in `<project>/.pi/guard-log.jsonl`, the same file
  and the same event shapes pi writes.
- **Fails open for reads, closed for writes — loudly either way.** Malformed
  stdin, an unreadable project, a bug: one line goes to stderr and an `error`
  event goes to the guard log. Then, if the payload named a tool that
  mutates (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Agent`,
  `Task`), the call is denied with a reason that says the hook errored; a
  read, or a payload too broken to name a tool, is allowed. A hook that
  could brick a session would be disabled, and a disabled gate is worse
  than a visible gap — but a gate that waves a write through on its own
  error is not a gate.

## What it does not enforce (honest limits)

- **No model tiers.** pi injects each seat's model at spawn from
  `.pi/dev-stage-models.json`; the generated definitions carry no `model:`.
  The phase gate's tier-resolvability check is skipped (no registry snapshot
  ⇒ "cannot tell", never a refusal), exactly as pi behaves without one.
- **Role-scoped views are the CLI's to apply.** The hook hands the bound
  role to the gate process (`BOUNDED_DEV_STAGE_ROLE`), and the registry's
  `typecheck` entry resolves `sessionRole(cwd)` when no `--role` is given —
  so the builder's `bounded-gates typecheck` is scoped exactly as pi's `typecheck`
  tool is. What the hook still cannot do is see or edit a gate's OUTPUT:
  a gate that prints something role-sensitive without consulting the role
  prints it here too. `run-tests` sanitizes inside the pack script, so that
  view is the same on both hosts.
- **`bounded-gates` arguments are not judged.** `bounded-gates run-tests ../other`
  runs a gate against another directory and writes to that project's guard
  log. No gate echoes an arbitrary file, so this is not a read channel, but
  it is a way to act outside the project the hook was installed in.
- **git is a denylist.** git is a large program with many ways to run
  another: the policy refuses `-c`, `--config-env`, `--exec-path`, `!`
  alias bodies, `bisect run`, `rebase --exec`, `submodule foreach`,
  `filter-branch`, the `*tool`/GUI subcommands, every `git config` that
  is not a `--get`/`--list`, and every global option before the subcommand
  except `--no-pager`, `-P`, `--no-optional-locks` and `--literal-pathspecs`
  (so `git -C . config core.hooksPath …` cannot hide its subcommand behind
  `-C`). A denylist is incomplete by construction. An
  alias or `core.hooksPath` that ALREADY exists in the repository's or the
  user's git config is honoured by `git commit`, and a `pre-commit` hook the
  project ships runs as the project's own tooling. pi's git tool is
  unrestricted by design; the extra rules here exist only because a shell is
  present. Only the architect holds git, and the architect is not a blind
  role — the concern is a gate verdict being manufactured, not a leak.
- **The strip is for subagents.** A directly driven session (the ambient
  hook, role from `.pi/dev-stage-role`) has every Claude Code tool; the hook
  refuses what it maps and ignores what it does not (`WebFetch`,
  `WebSearch`, `TodoWrite`, …). There is no `bounded-ticket` counterpart yet that
  launches a bound architect session.
- **The ambient hook and a role file still stack for the file tools.**
  Frontmatter hooks and settings hooks both fire inside a subagent. If the
  ambient hook is installed AND `.pi/dev-stage-role` exists, every Read,
  Edit, Write, Glob, Grep and Agent call in a subagent is judged twice — once
  as the role its definition bound, once as the file's role — and confined to
  the intersection (dogfood Run 6's bug, on this host). The gate CLI is no
  longer affected: the env prefix beats the file for `sessionRole()`, so
  `bounded-gates` always runs as the bound role. **Mitigation, unverified live:**
  if a subagent's `PreToolUse` payload carries the subagent's identity
  (`agent_type` or `agent_id` — the SubagentStart payload does; whether
  PreToolUse does is not documented and has not been observed), the ambient
  hook stands down for that call: allow, nothing logged, and the
  definition's own bound hook is the only judge. A bound hook never stands
  down. If PreToolUse carries neither field, the stack is exactly as
  described above, and a bound run should leave no role file in the
  project; the installer adds the ambient hook so the direct-session case
  works, and this is the cost.
- **Lexical paths, as in pi.** The gate normalises paths without resolving
  symlinks. No role can create one (no `ln`, no shell), so the surface is the
  same as pi's.
- **`bounded-gates` is resolved on PATH.** The policy accepts the bare name only,
  and no role's write zone is on a normal PATH, but a PATH that includes a
  project directory would let a role's own `bounded-gates` be the one that runs.
- **`bounded-gates` is auto-approved by design; everything else keeps Claude
  Code's own prompts.** An explicit `permissionDecision: "allow"` bypasses
  Claude Code's permission prompt, and an allowed `bounded-gates …` is answered
  that way on purpose: the policy has already proved the argv is one plain
  command naming a gate the role holds, and the rewrite is the only way to
  hand it the role. Every other allow — `git`, `sleep`, `rm`, the file
  tools, anything unmapped — is silent (no output), so Claude Code's own
  prompts stay in place for it. A deny from the hook is final.

## Install

Requires Node 22.18+ (`node` runs `.ts` directly) and `bounded-gates` on PATH
(`bounded-init` installs it beside `bounded-ticket`).

```sh
node <harness>/hosts/claude-code/install.ts <project>
```

Writes `<project>/.claude/agents/{architect,test-writer,builder,reviewer}.md`,
links `<harness>/skills/developer-stage` at
`<project>/.claude/skills/developer-stage` (the architect's brief opens by
loading that skill, and Claude Code reads skills from the project's
`.claude/skills/`, not from `~/.pi/agent/skills`), and adds the ambient hook
to `<project>/.claude/settings.json`, creating it if absent and touching
nothing else in it. Idempotent; prints one line per file: `wrote`,
`unchanged`, `linked <path> -> <target>`, or — where the platform refuses a
symlink — `copied <path> (symlink refused: …)`, in which case the copy
carries a `.bounded-harness-generated` marker file and must be re-installed after
the skill changes. It refuses to overwrite an agent file that lacks the
`# generated by bounded-harness` marker, a real `.claude/skills/developer-stage`
directory that is not a symlink and lacks that marker file (someone's own
skill), and a `settings.json` it cannot parse — exit 1, nothing written.
Re-run it after editing `agents/<role>.md` or `ROLE_TOOLS`: the rendered
files are derived and carry no hand edits.

The installer writes an **absolute harness path** into `settings.json`, into
each agent file's `hooks:` command, and into the skill symlink. `.claude/` in
a pipeline project is therefore generated per machine and belongs in that
project's `.gitignore`, next to `.pi/`; a clone re-runs the installer.

## Running a ticket

**The end-to-end flow is UNVERIFIED.** Each piece is asserted by fixture;
nobody has yet taken a ticket through the developer stage on Claude Code.
Two obstacles are known before the first attempt:

- **Claude Code subagents cannot spawn subagents.** The architect's job is
  to commission the reviewer, the test-writer and the builder through
  `Agent`, so the architect cannot be a subagent itself — it has to be the
  main session: the ambient hook from `.claude/settings.json` with
  `.pi/dev-stage-role` saying `architect`. That session holds every Claude
  Code tool (no strip; the hook refuses what it maps and ignores the rest).
- **Then the stack applies to the workers.** With the ambient hook installed
  AND that role file present, every worker the architect commissions is
  judged by two hooks — its own definition's (`--role builder`) and the
  ambient one (the file's `architect`) — and confined to the intersection,
  unless the worker's PreToolUse payload carries `agent_type` or `agent_id`,
  in which case the ambient hook stands down (see "honest limits": this is
  the unverified mitigation).

With that understood:

1. Install as above. Write `architect` to `<project>/.pi/dev-stage-role`.
2. Start Claude Code in the project as the architect: load the
   `developer-stage` skill (installed under `.claude/skills/`) and give it
   the ticket. Every gate is `bounded-gates <gate>` through Bash; the hook
   rewrites an allowed one to run as the architect on this host.
3. The architect commissions the reviewer, then (after `bounded-gates
   design-gate`) the test-writer and the builder, through `Agent` with
   `subagent_type` naming the role; each child's definition binds its own
   role. The phase gate refuses a commission whose preconditions the guard
   log does not show, and refuses any `subagent_type` that is not a pipeline
   role.
4. Read `<project>/.pi/guard-log.jsonl` afterwards. Blocks show where the
   gate caught something; `run-start` is the architect's first call; an
   `error` event with `host: claude-code` says a hook run failed and whether
   the call was refused or allowed. Delete the role file when the run is
   over.

To drive a single worker role directly instead, write that role's name to
`.pi/dev-stage-role` and use plain Claude Code: the ambient hook picks it up,
with the limits above.
