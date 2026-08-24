# pi-harness

My personal [pi](https://pi.dev) coding-agent harness. The **`agent/`
subdirectory** is the live pi config home — `~/.pi/agent` symlinks to it, so
everything in there is in effect for every pi session on this machine, the
moment it changes. The repo root is the project around that: decisions
([`ADRs/`](ADRs/)), the domain glossary (`CONTEXT.md`), and technical notes
(`docs/tn/`).

## How it works

- **Instructions.** `agent/AGENTS.md` is injected into every session. The
  root `AGENTS.md` holds harness-maintenance rules and only loads when
  working on this repo.
- **Subagents.** A deliberately minimal roster in `agent/agents/`: `scout`
  (read-only), `delegate` (worker), `product-expert` ("the PM"). New roles
  are added reluctantly, when a workflow actually needs them (ADR 2026-003).
- **Skills.** Working-method skills in `agent/skills/`: the idea-to-doc flow
  (`expand` → `grill-me` → `to-tn`), `issue-tracking`, `product-expert`, plus
  third-party skills like `flight-status` **vendored** into the repo and
  synced by hand — a sibling-repo pointer can't survive the `~/.pi/agent`
  symlink (ADR 2026-012).
- **Extensions.** `agent/extensions/*.ts` auto-load on session start: a web
  search/fetch tool, and Orca-managed status hooks (`orca-*.ts` — tracked but
  never hand-edited). `npm run check` in `agent/` typechecks the hand-written
  ones; CI enforces it.
- **Packs.** Language-specific capability lives in `packs/<lang>/` as
  on-demand skills and scaffolder scripts — never extensions, never root
  config (ADR 2026-007). `packs/ts` is the first, currently near-empty.

Packages are pinned via `pi install` (recorded in `agent/settings.json`),
secrets and session state stay uncommitted, and work happens in worktrees on
local branches tracking `main`.

## Where it's at

Working today: the global config above — subagent roster, working-method
skills, web tooling, the issue-tracking + board workflow, and the harness
self-check. No language packs or project tooling of substance yet.

**In flight — the developer stage:** a pipeline that turns a task into tested
code using three subagents that can't step on each other: an **architect**
writes the spec and type contract (never code), a **test-writer** writes
tests from that contract (never sees the implementation), and a **builder**
writes the implementation (never sees the tests). A pi session orchestrates
them, and every hand-off is guarded by something mechanical — tool
allowlists, a path-gate extension, lint rules per zone, red/green test
gates — so the design can't quietly drift. The point: an agent that writes
both the tests and the code grades its own exam; here, no agent can. Design:
[TN-26-001](docs/tn/TN-26-001-developer-stage-pipeline.md),
[ADR 2026-013](ADRs/2026-013-developer-stage-pipeline.md),
[issue #1](https://github.com/bounded-dev/pi-harness/issues/1).

## Bootstrap a new machine

```bash
git clone git@github.com:bounded-dev/pi-harness.git
ln -s "$PWD/pi-harness/agent" ~/.pi/agent   # create ~/.pi first if needed
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
