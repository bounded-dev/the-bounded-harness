# pi-harness

My personal [pi](https://pi.dev) coding agent harness. The **`agent/`
subdirectory** is my pi config home: `~/.pi/agent` is a symlink to it. The repo
root is the harness *project* (docs, ADRs, CI); `agent/` is the pi config
*home* (ADR 2026-011).

## In flight: the developer stage

The current build is a pipeline that turns a task into tested code using
three subagents that can't step on each other: an **architect** writes the
spec and type contract (never code), a **test-writer** writes tests from that
contract (never sees the implementation), and a **builder** writes the
implementation (never sees the tests). A pi session orchestrates them, and
every hand-off is guarded by something mechanical — tool allowlists, a
path-gate extension, lint rules per zone, and red/green test gates — so the
design can't quietly drift. The point: an agent that writes both the tests
and the code grades its own exam; here, no agent can. Design:
[TN-26-001](docs/tn/TN-26-001-developer-stage-pipeline.md),
[ADR 2026-013](ADRs/2026-013-developer-stage-pipeline.md),
[issue #1](https://github.com/bounded-dev/pi-harness/issues/1).

## Layout

**Repo root — the harness project (loaded only when working on pi-harness):**

| Path           | Tracked? | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| `AGENTS.md`    | yes      | Harness-maintenance rules — *not* injected into other projects |
| `README.md`    | yes      | This file                                        |
| `ADRs/`        | yes      | Decision records (scheme in `ADRs/README.md`)    |
| `CONTEXT.md`   | yes      | Harness domain glossary                          |
| `.github/`     | yes      | CI: typecheck on push/PR (runs in `agent/`)      |
| `.worktrees/`  | no       | Git worktrees of this repo                       |

**`agent/` — the pi config home (`~/.pi/agent`, global, every project):**

| Path           | Tracked? | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| `AGENTS.md`    | yes      | Global default instructions — injected into every session |
| `settings.json` | yes     | Model prefs, theme, and the (pinned) `packages` manifest — portable, no machine-specific paths |
| `extensions/`  | yes      | Custom tools (web search/fetch, orca status, …) — no IDE/terminal-specific integrations (ADR 2026-006) |
| `agents/`      | yes      | Subagent roster: `scout` (read-only), `delegate` (worker), `product-expert` / "the PM" (read-only + web) — ADR 2026-003 |
| `skills/`      | yes      | Working-method skills: `expand`, `grill-me`, `grilling`, `domain-modeling`, `to-tn`, `product-expert` (auto-discovered global location) — ADRs 2026-008/009 |
| `packs/`       | yes      | Language packs (pi packages, local-path loaded) — `packs/ts` (ADR 2026-007) |
| `package.json` / `package-lock.json` / `tsconfig.json` | yes | Harness self-check tooling (`npm run check`) — ADR 2026-005 |
| `auth.json`    | **no**   | Provider credentials                             |
| `web-search.json` | **no** | Brave Search API key for `web.ts` — ADR 2026-002 |
| `sessions/`    | no       | Session transcripts                              |
| `bin/`         | no       | Vendored arm64 `rg`/`fd` (macOS-only, machine-local; not restored by bootstrap) |
| `npm/`, `git/` | no       | Packages installed by `pi install` (restorable)  |

`extensions/orca-*.ts` are managed by Orca (marked
`// @orca-managed-pi-extension`): tracked, but never hand-edit them —
commit Orca's rewrites promptly (ADR 2026-006). They are excluded from the
typecheck.

## Bootstrap a new machine

```bash
cd <parent-dir>
git clone git@github.com:bounded-dev/pi-harness.git
ln -s "$PWD/pi-harness/agent" ~/.pi/agent   # create ~/.pi first if needed
pi update --extensions                     # install packages listed in settings.json
cd pi-harness/agent && npm ci && npm run check   # self-check tooling
```

Then log in (`pi` → `/login`) to recreate `auth.json`, and add the Brave
Search API key as `web-search.json` (`{"BRAVE_API_KEY": "..."}`) in this
directory (ADR 2026-002). A `BRAVE_API_KEY` env var overrides the file; the
file is what GUI-launched sessions (Orca) reliably see.

**Vendored skills:** skills from [`bounded-dev/skills`](https://github.com/bounded-dev/skills)
(e.g. `flight-status`) are **copied** into `agent/skills/`, not referenced as a
package. pi resolves local package paths lexically against the `~/.pi/agent`
symlink (not its real target), so a relative `../` pointer to a sister repo
can't be found — vendoring sidesteps that. Keep the copies in sync with
upstream by hand.

## Conventions

- **Global = harness.** Everything here applies to every project. Only add
  things that are safe to have everywhere.
- **Project dependencies don't live here.** If a project *needs* a capability,
  it declares it in its own committed `.pi/settings.json`. See "Layer 2" below.
- `settings.json` is the manifest for third-party packages; add them with
  `pi install npm:<pkg>@<version>` (writes here automatically), never by
  editing `npm/` by hand. Packages are pinned and updated deliberately
  (ADR 2026-006).
- **Canonical project commands (Layer 2).** Projects declare `check`,
  `test`, `build`, `lint`; any session in any project looks for these
  names first (ADR 2026-007). The harness itself stays language-agnostic —
  TS specifics live in the project template and its skills.
- **Third-party reference clones** live in a `third-party/` sister
  directory (`<owner>/<repo>`, e.g. `third-party/mattpocock/skills` —
  upstream for the grill-me skills, ADR 2026-008). Reference only: read
  them, never load them as packages or edit them.

## Decisions

Recorded as ADRs in [`ADRs/`](ADRs/) (scheme documented there).
