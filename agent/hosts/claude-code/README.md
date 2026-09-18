# Claude Code host adapter

The developer stage's **capability constraints** (ADR 2026-029, Tier B) for
Claude Code: the path gate and the phase gate as a `PreToolUse` hook, the tool
strip as generated `.claude/agents/*.md` `tools:` allowlists, and the role
binding through each agent definition's own `hooks:`. The **artifact gates**
(Tier A) are not here — they are `pi-gates <gate>`, one CLI for every host,
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
| `path-gate-hook.ts` | The `PreToolUse` hook. Reads the call as JSON on stdin; prints a deny decision, an allow that rewrites an allowed `pi-gates …` to `PI_DEV_STAGE_ROLE=<role> pi-gates …`, or nothing. `--role <role>` binds; without it the role comes from `.pi/dev-stage-role`. |
| `tool-map.ts` | Claude Code tool call → pi tool call(s): `Read {file_path}` → `read {path}`, `Agent {subagent_type}` → `subagent {agent}`, and so on. |
| `bash-policy.ts` | What a role may put through Bash: `pi-gates <gate>` for the gates in its `ROLE_TOOLS`, plus `git`, `sleep`, `rm <path>` where the role holds the pi tool. Everything else refused. |
| `render-agents.ts` | Generates `.claude/agents/<role>.md` from `agents/<role>.md`: `tools:` from `ROLE_TOOLS`, `hooks:` binding the role, the pi brief verbatim under a host preamble. |
| `install.ts` | Writes the four agents and merges the ambient hook into `.claude/settings.json`. |

## What it enforces

- **Path gate**, identical to pi's: Read/Edit/Write/MultiEdit/NotebookEdit/
  Glob/Grep are mapped to `read`/`edit`/`write`/`find`/`grep` and judged by
  `decide()` against the role's zones. A blind role cannot read the other
  side's work product; every role's writes are confined to its zone; `.git`
  and `.pi` are protected as in pi.
- **Phase gate** on `Agent`: an `Agent` call with `subagent_type: builder` is
  a `subagent` launch of the builder, judged by `checkSubagentCall()` against
  the project's guard log — no contracts, no spec, no design gate, no spawn.
- **Tool strip**, as `tools:` in the generated agent definitions: a worker
  never sees `Agent`; the reviewer never sees `Write` or `Edit`. Pinned to
  `ROLE_TOOLS` by `render-agents.test.ts`, the way `agent-config-drift.test.ts`
  pins pi's frontmatter.
- **Bash narrowed to the carriers.** The command is read the way a POSIX
  shell reads it and refused if it is more than one plain argv: `;`, `&`,
  `|`, `(`, redirects, `$`, backticks, backslashes, globs, braces, tilde,
  comments, an unterminated quote, an env-assignment prefix. What survives is
  allowed only if it is one of:
  - `pi-gates <gate> …` where `<gate>` (hyphens or underscores) is in the
    role's `ROLE_TOOLS` and is not a file tool — so the builder may run
    `run-tests` and `typecheck`, the architect every gate, the reviewer
    `record-design-review` and `typecheck`; `pi-gates --list|--help` always;
  - `git …` for roles holding `git` (the architect), minus git's known ways of
    running another program (see limits);
  - `sleep <1-120>` for roles holding `sleep` (the architect);
  - `rm <one literal path>` judged as a pi `remove`, so the write zones apply.
  A refusal is one line: `path-gate: <role> may not run '<cmd>': <why> — …`,
  using pi's own `forbiddenWhy` sentence where pi has one. `--role` and
  `--findings-file` are refused anywhere in a `pi-gates` argv: the host
  supplies the role, and findings are passed inline. Gate names are
  hyphenated (`pi-gates red-gate`); the pi spelling (`red_gate`) is accepted.
- **The bound role reaches the gate process.** An allowed `pi-gates …` is
  answered with `permissionDecision: "allow"` and an `updatedInput` whose
  command is `PI_DEV_STAGE_ROLE=<role> <original command>`; the rest of the
  tool input is kept. `sessionRole()` reads that variable before the
  `.pi/dev-stage-role` file, so a gate that scopes its output by role
  (`typecheck`) sees the role the definition bound, whatever file the project
  holds. The policy has already refused every construct that could make the
  prefix anything but an env assignment, and a prefix the model types itself
  is refused. `git`, `sleep` and `rm` are allowed silently — nothing in them
  reads a role.
- **Role binding by which definition loads.** `.claude/agents/<role>.md`
  carries the hook with `--role <role>` in its own `hooks:`; those fire only
  inside that subagent. The model cannot change its role: `.claude/**` is in
  no role's write zone, so the definitions and `settings.json` are unwritable
  from inside a run.
- **Guard log.** Every block, the run-start marker (the architect's first
  call, once — the log is the latch, since each hook run is a fresh process),
  and every hook error land in `<project>/.pi/guard-log.jsonl`, the same file
  and the same event shapes pi writes.
- **Fails open, loudly.** Malformed stdin, an unreadable project, a bug: the
  call is allowed, one line goes to stderr, and an `error` event goes to the
  guard log. A hook that could brick a session would be disabled, and a
  disabled gate is worse than a visible gap.

## What it does not enforce (honest limits)

- **No model tiers.** pi injects each seat's model at spawn from
  `.pi/dev-stage-models.json`; the generated definitions carry no `model:`.
  The phase gate's tier-resolvability check is skipped (no registry snapshot
  ⇒ "cannot tell", never a refusal), exactly as pi behaves without one.
- **Role-scoped views are the CLI's to apply.** The hook hands the bound
  role to the gate process (`PI_DEV_STAGE_ROLE`), and the registry's
  `typecheck` entry resolves `sessionRole(cwd)` when no `--role` is given —
  so the builder's `pi-gates typecheck` is scoped exactly as pi's `typecheck`
  tool is. What the hook still cannot do is see or edit a gate's OUTPUT:
  a gate that prints something role-sensitive without consulting the role
  prints it here too. `run-tests` sanitizes inside the pack script, so that
  view is the same on both hosts.
- **`pi-gates` arguments are not judged.** `pi-gates run-tests ../other`
  runs a gate against another directory and writes to that project's guard
  log. No gate echoes an arbitrary file, so this is not a read channel, but
  it is a way to act outside the project the hook was installed in.
- **git is a denylist.** git is a large program with many ways to run
  another: the policy refuses `-c`, `--config-env`, `--exec-path`, `!`
  alias bodies, `bisect run`, `rebase --exec`, `submodule foreach`,
  `filter-branch`, the `*tool`/GUI subcommands, and every `git config` that
  is not a `--get`/`--list`. A denylist is incomplete by construction. An
  alias or `core.hooksPath` that ALREADY exists in the repository's or the
  user's git config is honoured by `git commit`, and a `pre-commit` hook the
  project ships runs as the project's own tooling. pi's git tool is
  unrestricted by design; the extra rules here exist only because a shell is
  present. Only the architect holds git, and the architect is not a blind
  role — the concern is a gate verdict being manufactured, not a leak.
- **The strip is for subagents.** A directly driven session (the ambient
  hook, role from `.pi/dev-stage-role`) has every Claude Code tool; the hook
  refuses what it maps and ignores what it does not (`WebFetch`,
  `WebSearch`, `TodoWrite`, …). There is no `pi-ticket` counterpart yet that
  launches a bound architect session.
- **The ambient hook and a role file still stack for the file tools.**
  Frontmatter hooks and settings hooks both fire inside a subagent. If the
  ambient hook is installed AND `.pi/dev-stage-role` exists, every Read,
  Edit, Write, Glob, Grep and Agent call in a subagent is judged twice — once
  as the role its definition bound, once as the file's role — and confined to
  the intersection (dogfood Run 6's bug, on this host). The gate CLI is no
  longer affected: the env prefix beats the file for `sessionRole()`, so
  `pi-gates` always runs as the bound role. A bound run should still leave no
  role file in the project; the installer adds the ambient hook so the
  direct-session case works, and this is the cost.
- **Lexical paths, as in pi.** The gate normalises paths without resolving
  symlinks. No role can create one (no `ln`, no shell), so the surface is the
  same as pi's.
- **`pi-gates` is resolved on PATH.** The policy accepts the bare name only,
  and no role's write zone is on a normal PATH, but a PATH that includes a
  project directory would let a role's own `pi-gates` be the one that runs.
- **Claude Code's own permission prompts still apply** after an allow; a deny
  from the hook is final. The hook never widens what Claude Code would ask.

## Install

Requires Node 22.18+ (`node` runs `.ts` directly) and `pi-gates` on PATH
(`pi-harness-init` installs it beside `pi-ticket`).

```sh
node <harness>/hosts/claude-code/install.ts <project>
```

Writes `<project>/.claude/agents/{architect,test-writer,builder,reviewer}.md`
and adds the ambient hook to `<project>/.claude/settings.json`, creating it if
absent and touching nothing else in it. Idempotent; prints one line per file.
It refuses to overwrite an agent file that lacks the
`# generated by pi-harness` marker (exit 1, nothing written), and a
`settings.json` it cannot parse. Re-run it after editing `agents/<role>.md`
or `ROLE_TOOLS`: the rendered files are derived and carry no hand edits.

## Running a ticket

1. Install as above. Delete any `.pi/dev-stage-role` in the project (see
   "one role source at a time").
2. Start Claude Code in the project and commission the architect:
   `Use the architect subagent to take ticket … through the developer stage.`
   The architect's definition loads the `--role architect` hook; its brief is
   pi's, under a preamble that says every gate is `pi-gates <gate>` through
   Bash and how each pi tool is reached here.
3. The architect commissions the reviewer, then (after `pi-gates
   design-gate`) the test-writer and the builder, through `Agent`; each
   child's definition binds its own role. The phase gate refuses a commission
   whose preconditions the guard log does not show.
4. Read `<project>/.pi/guard-log.jsonl` afterwards. Blocks show where the
   gate caught something; `run-start` is the architect's first call; an
   `error` event with `host: claude-code` means a call went ungated and says
   why.

To drive a single role directly instead, write the role name to
`.pi/dev-stage-role` and use plain Claude Code: the ambient hook picks it up,
with the limits above.
