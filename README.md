# pi-harness

An open-source coding-agent harness, built in the open and used daily. The
**`agent/` subdirectory** is the live config home — `~/.pi/agent` symlinks to
it, so everything in there is in effect for every [pi](https://pi.dev) session
on the machine, the moment it changes. Claude Code shares the global
instruction file only: `~/.claude/CLAUDE.md` symlinks to `agent/AGENTS.md`. The
repo root is the project around that: decisions ([`ADRs/`](ADRs/)), the domain
glossary (`CONTEXT.md`), and technical notes (`docs/tn/`). Where this is all
going is [`docs/VISION.md`](docs/VISION.md): the harness, not the codebase, is
the part you own.

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
- **Extensions.** `agent/extensions/*.ts` auto-load on session start: a web
  search/fetch tool, and Orca-managed status hooks. `npm run check` in
  `agent/` typechecks the hand-written ones; CI enforces it.
  Tool-managed files (like Orca's `orca-*.ts`) are **untracked** runtime
  state — tools that want into the config home install their own files
  (ADR 2026-006).
- **Packs.** Language-specific capability lives in `packs/<lang>/` as
  on-demand skills and scaffolder scripts — never extensions, never root
  config (ADR 2026-007). `packs/ts` is the first and the substantial one: the
  contract-authoring skill, the zone lint rules, the scaffolder, and every gate
  script the developer stage runs.

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
[issue #13](https://github.com/bounded-dev/pi-harness/issues/13).

## Bootstrap a new machine

```bash
git clone git@github.com:bounded-dev/pi-harness.git
ln -s "$PWD/pi-harness/agent" ~/.pi/agent   # create ~/.pi first if needed
ln -s "$PWD/pi-harness/agent/AGENTS.md" ~/.claude/CLAUDE.md   # Claude Code
ln -s ~/.pi/agent/scripts/pi-ticket /usr/local/bin/pi-ticket   # the gated launcher, anywhere on PATH
pi update --extensions                      # install packages from settings.json
cd pi-harness/agent && npm ci && npm run check
```

Then log in (`pi` → `/login`) to recreate `auth.json`, and add the Brave
Search API key as `web-search.json` (`{"BRAVE_API_KEY": "..."}`) in `agent/`
(ADR 2026-002). A `BRAVE_API_KEY` env var overrides the file.

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
