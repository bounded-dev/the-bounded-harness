# Handover — pi-harness developer stage, after dogfood Run 6

Written 2026-09-02. State: `main` at `2d2268b`, 598 tests green, live checkout
synced. Read `docs/dogfooding.md` (Run 6 section) and issue #12 first — this
file is the *method*, those are the *evidence*.

## Where the project actually stands

The developer stage works end to end. Run 6 reached green: 83 tests, 7
contracts, 25 exported functions, type-clean, on the third attempt. The two
voided attempts were both harness bugs of ours, not model failures.

**The honest state of the evidence** — this matters more than the feature list:

- **Proven and repeatable:** the deterministic gates, and value objects at the
  boundary (3 consecutive runs, decisive every time).
- **Weakened this run:** the tautological-invariant finding, which was the
  single strongest argument for blindness. Two bare arms wrote one in Runs 4
  and 5; Run 6's bare arm did not. It is now 2 of 3, and the write-up says so.
- **Newly measured:** the spec's unique contribution is **execution order**.
  83 tests written with no spec still covered replay and arithmetic well and
  contained *zero* precondition-ordering tests.
- **Still unproven:** the architect as a source of design quality. ADR 2026-014
  stands — taste did not survive a model change, procedure did.

Do not overstate the case for the harness in future write-ups. The most useful
thing this project produces is *measurements that can go against it*.

## The method that has worked

**1. Fix what is factually wrong before adding advice.** The single largest
design improvement all day came from correcting "one component contract" to "as
many files as the design needs" — the glossary, the glob, the scaffolder and
the manifest all said plural. One god-interface became 7 focused contracts,
same prompt, same model. No design guidance achieved anything comparable.

**2. Enforce with mechanism, never with prose.** Every rule that held was a
gate. Every rule that was only written down was skipped — the spec 4 times out
of 4, the "don't read your skill from ~/.pi" instruction every single run. When
you catch yourself writing "the skill should tell it to…", ask what would
refuse it instead.

**3. Guidance, when unavoidable, is a checklist anchored to a gate call.** Per
ADR 2026-014: give it a trigger ("before you run `freeze_contracts`…"), a stop
condition, and greppable phrases so its fingerprint can be looked for in the
output later.

**4. Silent failure is the enemy.** Every void run today was silent: a `: ` in
YAML deleted a skill from every session; a contract with no runtime exports
passed four gates; case-sensitive globs refused `SPEC.md`. Nothing errored.
When a mechanism can fail invisibly, it gets a test — `skill-frontmatter.test.ts`
exists for exactly this reason.

**5. Verify agents' work independently.** Both subagents used today did good
work and one found a subtler root cause than briefed. Both were still checked
against a live repro before their commits landed.

## Mistakes to avoid repeating

- **I twice declared an outcome from an intermediate state** — inferred a
  missing builder from an absent `_meta.json` (it just hadn't been written yet),
  and called a deadlock permanent while the architect was still working. It
  recovered. *List the directory; don't infer from an absent file.*
- **A unit test that passes can still prove nothing.** The first bound-role fix
  passed all six of its tests and changed nothing live, because the flag was in
  module scope and the two extensions load through different module registries.
  For anything crossing a process or extension boundary, the check is a live
  spawn, not a unit test.
- **Backticks in a `git commit -m "…"` string execute as command substitution.**
  Use `git commit -F -` with a quoted heredoc.
- **`.gitignore` silently swallowed `agent/bin/`.** `git add -A` reported
  success and the file stayed untracked. Check `git check-ignore` when a new
  file "doesn't appear".

## Working agreements

- Test-first. `npm run check` stays green. Work in the worktree.
- "Push" = `git push origin <branch>:main`, then in
  `/Users/paul.grimshaw/dev/pi-harness`: stash → `merge --ff-only origin/main`
  → stash pop. The user keeps uncommitted work there (AGENTS.md, README,
  settings.json) — never clobber it.
- **Never push while a dogfood arm is running.** It resolves gates through
  `~/.pi/agent` → the live checkout. This contaminated Run 4.
- Pack-internal imports use `.ts` extensions. Never run bare `vitest`.
- Commit messages: what was wrong, why it mattered, what the evidence was.

## Running a dogfood arm

```bash
dogfood-reset                 # both arms; --bare / --harnessed for one
cd ~/dev/pi-harness-dogfood-bare        # Claude Code, paste PROMPT.md
cd ~/dev/pi-harness-dogfood-harnessed   # pi --model sonnet, paste PROMPT.md
```

Three directories, forever. `~/dev/pi-harness-dogfood-archive` holds every past
run as a branch. **Pin the model explicitly** — the default is
`kimi-k2p7-code` and it voided an attempt. Commit an arm's output before
resetting; arms are told not to commit, so a reset destroys the previous run.

## What is built but not finished

1. **`redGateProjectPlan` is not wired.** The plan and its tests are in
   `red-gate.ts`; `runRedGate` still runs against the live tree. Wiring it is
   what actually unlocks the test-writer and builder working in parallel
   (~10 min of a 30 min run). **This is the highest-value next task.**
2. **The role-file route still shows `bash`** to the model — blocked on call,
   about one wasted turn. Only a launch flag can strip it, so `pi-ticket` stays
   the stricter route. Decide whether to make it the default.
3. **The skill still says "do not improvise a target"** while Run 6 only
   escaped its deadlock *because* the architect ignored that. The green-gate
   reroute now handles the known case; the instruction should acknowledge that
   the architect may override a route it can see is wrong.

## Open questions, unchanged in priority

1. **Where does design quality come from?** Not the role, not the instructions.
   The reviewer is still the bet, and still unbuilt. If it fails too, the honest
   answer may be that quality comes from the model and should be bought.
2. **Integration.** Everything proven is one component in one worktree. Parallel
   workers merging back is untested.
3. **The review role's shape.** Natural form is the adversary: sees everything,
   tries to break the suite without touching the implementation.
