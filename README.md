# The Bounded Harness

An open-source, **agent-agnostic** coding-agent harness — CLI-based,
extremely deterministic, and opinionated — built in the open and used daily.
The bet ([`docs/VISION.md`](docs/VISION.md)): the model is a component you
rent, and so is the agent framework driving it; **the harness is the part
you own.** Any capable agent framework straps in through a thin host
adapter; today that is [pi](https://pi.dev) — the reference host — and
Claude Code, with more hook-capable frameworks to follow
([TN-26-007](docs/tn/TN-26-007-agent-agnostic-harness.md)).

Today the harness runs in **developer mode**: the **`agent/` subdirectory**
is the live config home, symlinked straight into the frameworks —
`~/.pi/agent` points at it, so everything in there is in effect for every pi
session the moment it changes, and Claude Code shares the instruction file
(`~/.claude/CLAUDE.md` → `agent/AGENTS.md`). The symlink setup is a
stopgap, not the architecture: the destination is the harness shipped as a
packaged extension per framework, with a proper install. The repo root is
the project around the config home: decisions ([`ADRs/`](ADRs/)), the
domain glossary (`CONTEXT.md`), and technical notes (`docs/tn/`).

## How it works

- **Instructions.** `agent/AGENTS.md` is injected into every session — pi and
  Claude Code both. It holds response rules only; nothing about the harness
  itself. Harness-maintenance rules live in the root `AGENTS.md`, which only
  loads when working on this repo.
- **Subagents.** A deliberately minimal general roster in `agent/agents/`:
  `scout` (read-only), `delegate` (worker), `product-expert` ("the PM"). New
  roles are added reluctantly, when a workflow actually needs them
  (ADR 2026-003). The developer-stage roles — `architect`, `test-writer`,
  `builder`, `reviewer` — live alongside them and are bound to write zones
  rather than trusted.
- **Skills.** Working-method skills in `agent/skills/`: the idea-to-doc flow
  (`expand` → `grill-me` → `to-tn`), `issue-tracking`, `product-expert`, the
  `developer-stage` pipeline below, plus third-party skills like
  `flight-status` **vendored** into the repo and synced by hand — a
  sibling-repo pointer can't survive the `~/.pi/agent` symlink (ADR 2026-012).
- **Extensions.** The pi adapter, `agent/hosts/pi/extensions/*.ts`,
  auto-loads on pi session start: a web search/fetch tool and the harness's
  capability constraints for the pi host. `npm run check` in `agent/`
  typechecks it; CI enforces it. `agent/extensions/` is the drop zone where
  external tools install their own **untracked** files — runtime state,
  never hand-edited (ADR 2026-006).
- **Packs.** Language-specific capability lives in `packs/<lang>/` as
  on-demand skills and scaffolder scripts — never extensions, never root
  config (ADR 2026-007). `packs/ts` is the first and the substantial one: the
  contract-authoring skill, the zone lint rules, the scaffolder, and every gate
  script the developer stage runs.

- **Hosts.** The harness's logic never depends on which agent framework
  loads it; only a thin **host adapter** does (ADR 2026-034). Every
  *artifact gate* — purity, design, drift, red, green, sign-off, deliver,
  mutation score, typecheck, the test run — is one CLI,
  `bounded gates <gate> [dir] [--json]`, callable from any agent, from CI,
  or by hand; the pi gate tools read the same registry. The *capability
  constraints* — tool strip, path gate, phase gate, scoped worker views —
  need host cooperation and live per host under `agent/hosts/<host>/`:
  `hosts/pi/` (extensions) and `hosts/claude-code/` (a `PreToolUse` hook
  plus generated agent definitions). `bounded init` assembles only the chosen
  host's project-local adapter. The project commits its selected harness and
  composition under `.bounded/`; run evidence there stays ignored. No host
  owns the shared gate logic.
  The bar for a supported host is
  **deterministic enforcement** — tools removed rather than refused, writes
  blocked rather than discouraged — and a run's guard log says which host it
  ran under and what that host enforced, so a gates-only transcript is never
  mistaken for a blind one.

Packages are pinned via `pi install` (recorded in `agent/settings.json`),
secrets and session state stay uncommitted, and work happens in worktrees on
local branches tracking `main`.

## Where it's at

Working today: the global config above — subagent roster, working-method
skills, web tooling, the issue-tracking + board workflow, and the harness
self-check — plus the TypeScript pack and the developer-stage pipeline it
serves.

**In flight — the developer stage:** a pipeline that turns a ticket into
tested code through roles that can't step on each other. An **architect**
owns the ticket: it writes the spec and type contract, commissions the work,
runs every gate, and arbitrates — but it writes no tests and no
implementation. A **test-writer** writes tests from the contract and never
sees the implementation; a **builder** writes the implementation and never
sees the tests. A **reviewer** reads the spec and the contract before they are
frozen — as those two will have to — and records what it found, holding no pen
to change any of it. The two blind workers run in **parallel**: the red gate
proves its verdict in a shadow project rebuilt from the contracts and the
tests, so it never waits on — or is spoiled by — whatever is in `src/`. Every
hand-off is guarded by something mechanical: forbidden tools removed from the
toolset rather than refused, a path-gate extension, lint rules per zone, a
composite design gate that will not freeze an unreviewed design, and red/green
gates that also typecheck and bind a green to the red that covered these very
tests.

The point: an agent that writes both the tests and the code grades its own
exam. Two bare runs on two different days independently wrote the same
invariant test that *cannot fail*; no run with the separation did. That
finding is what the rest of the machinery is in service of.

Design: [TN-26-001](docs/tn/TN-26-001-developer-stage-pipeline.md),
[ADR 2026-013](ADRs/2026-013-developer-stage-pipeline.md), evidence in
[docs/dogfooding.md](docs/dogfooding.md), current plan in
[issue #13](https://github.com/bounded-dev/the-bounded-harness/issues/13).

## Start a new project

The CLI is packaged locally but not yet published. To install this preview:

```bash
git clone git@github.com:bounded-dev/the-bounded-harness.git
cd the-bounded-harness/agent
npm ci
npm run publish:local
bounded --version
```

Contributors can run `npm run publish:local` from the `agent/` directory of
whichever harness worktree they want to install. It builds a tarball and
installs that snapshot into npm's global prefix, independent of the worktree.
Run it again after changes you want other projects to use. The command checks
that `bounded` on PATH resolves to the installed build, so an older link cannot
silently win. `bounded --version` reports the source commit and whether the
build contained uncommitted harness changes. A running agent session may need
restarting to load newly installed project hooks. Check `bounded --version`
inside the agent session too: a different shell can have a different PATH.
Already initialized projects carry their own harness snapshot and need a
future `bounded update` flow to receive newer harness code.

Open an empty directory (or one containing
only `.git/`). Tell your current pi or Claude Code agent to initialize Bounded
there. The agent runs `bounded init`, discusses the proposed capabilities
with you, then runs the command with an explicit host, selected capabilities
and reviewed plan digest. Bare `bounded init` only prints the available
choices; it does not wait for terminal input or write files. Use `bounded
init --interactive` to answer the questions directly in a terminal.

Initialization copies the selected harness and host adapter into the source
project. The project commits its Bounded manifest and selected capabilities;
run evidence is ignored. After cloning elsewhere, run `npm run bounded:setup`
to install both sets of pinned dependencies, then trust/restart the chosen
agent host so it loads the project adapter. Run the local gates with
`bash .bounded/harness/scripts/bounded gates --list`. See
[the initialization design](docs/tn/TN-26-010-project-local-init.md) for
scope and checks. An existing project is refused before any files are written.

## Bootstrap a new machine (developer mode)

This is the stopgap install — symlinks into the frameworks' config homes,
until the harness ships as packaged per-framework extensions.

```bash
git clone git@github.com:bounded-dev/the-bounded-harness.git
cd the-bounded-harness && agent/scripts/bounded dev-bootstrap
```

`bounded dev-bootstrap` does the rest, and is idempotent — re-run it after a pull.
It symlinks `~/.pi/agent` to `agent/` (the live pi config home) and
`~/.claude/CLAUDE.md` to `agent/AGENTS.md`, puts the one command `bounded`
on PATH (everything else is a subcommand: `bounded gates`, `bounded
ticket`, `bounded change-run`, `bounded dogfood-reset`), then runs `npm ci`
and the harness's own test suite. It never overwrites a real file — only
its own symlinks.

Then log in (`pi` → `/login`) to recreate `auth.json`, and add the Brave
Search API key as `web-search.json` (`{"BRAVE_API_KEY": "..."}`) in `agent/`
(ADR 2026-002). A `BRAVE_API_KEY` env var overrides the file.

To drive a ticket from **Claude Code** instead of pi, install the host
adapter into the project: `node ~/.pi/agent/hosts/claude-code/install.ts
<project>` writes the four role definitions to `<project>/.claude/agents/`
and the ambient path-gate hook to `<project>/.claude/settings.json`. See
[`agent/hosts/claude-code/README.md`](agent/hosts/claude-code/README.md) for
what it enforces, what it does not, and its honest limits.

## Conventions

- **Global = harness.** Everything here applies to every project; only add
  things safe to have everywhere. Project-specific capability belongs in that
  project's committed `.pi/settings.json`.
- **Canonical project commands.** Projects declare `check` / `test` /
  `build` / `lint`; any session looks for these first (ADR 2026-007).
- **Third-party reference clones** live in a `third-party/` sister directory
  (`<owner>/<repo>`, e.g. `third-party/mattpocock/skills`, ADR 2026-008) —
  read-only, never loaded or edited.
- **Decisions** are recorded as ADRs in [`ADRs/`](ADRs/) (scheme documented
  there); design thinking happens in TNs (`docs/tn/`) via the
  expand → grill-me → to-tn flow.
