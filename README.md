# pi-harness

My personal [pi](https://pi.dev) coding agent harness. This directory **is** my
pi config home: `~/.pi/agent` is a symlink to it.

## Layout

| Path           | Tracked? | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| `settings.json` | yes     | Model prefs, theme, and the (pinned) `packages` manifest — portable, no machine-specific paths |
| `extensions/`  | yes      | Custom tools (web search/fetch, orca status, …) — no IDE/terminal-specific integrations (ADR 2026-006) |
| `agents/`      | yes      | Subagent roster: `scout` (read-only), `delegate` (worker), `product-expert` / "the PM" (read-only + web) — ADR 2026-003 |
| `skills/`      | yes      | Working-method skills: `expand`, `grill-me`, `grilling`, `domain-modeling`, `to-tn`, `product-expert` (auto-discovered global location) — ADRs 2026-008/009 |
| `packs/`       | yes      | Language packs (pi packages, local-path loaded) — `packs/ts` (ADR 2026-007) |
| `prompts/`     | yes      | Prompt templates (`/name` snippets), if added    |
| `ADRs/`        | yes      | Decision records (scheme in `ADRs/README.md`)    |
| `package.json` / `package-lock.json` / `tsconfig.json` | yes | Harness self-check tooling (`npm run check`) — ADR 2026-005 |
| `.github/`     | yes      | CI: typecheck on push/PR                         |
| `auth.json`    | **no**   | Provider credentials                             |
| `web-search.json` | **no** | Brave Search API key for `web.ts` — ADR 2026-002 |
| `sessions/`    | no       | Session transcripts                              |
| `bin/`         | no       | Vendored arm64 `rg`/`fd` (macOS-only, machine-local; not restored by bootstrap) |
| `npm/`, `git/` | no       | Packages installed by `pi install` (restorable)  |
| `.worktrees/`  | no       | Git worktrees of this repo                       |

`extensions/orca-*.ts` are managed by Orca (marked
`// @orca-managed-pi-extension`): tracked, but never hand-edit them —
commit Orca's rewrites promptly (ADR 2026-006). They are excluded from the
typecheck.

## Bootstrap a new machine

Clone this repo and [`bounded-dev/skills`](https://github.com/bounded-dev/skills)
as sister directories under any shared parent — `settings.json` references the
skills repo as `../bounded-dev/skills`, so the two must sit alongside each
other (the parent dir's name doesn't matter):

```bash
cd <parent-dir>
git clone git@github.com:bounded-dev/pi-harness.git
git clone git@github.com:bounded-dev/skills.git bounded-dev/skills
ln -s "$PWD/pi-harness" ~/.pi/agent   # create ~/.pi first if needed
pi update --extensions               # install packages listed in settings.json
npm ci && npm run check              # self-check tooling (typechecks extensions/)
```

Then log in (`pi` → `/login`) to recreate `auth.json`, and add the Brave
Search API key as `web-search.json` (`{"BRAVE_API_KEY": "..."}`) in this
directory (ADR 2026-002). A `BRAVE_API_KEY` env var overrides the file; the
file is what GUI-launched sessions (Orca) reliably see.

**Known caveat:** the `../bounded-dev/skills` pointer assumes pi resolves it
against the repo's real path. Since `~/.pi/agent` is a symlink, if pi ever
resolved relative to the symlink instead, the skills repo wouldn't be found.
If `flight-status` (or any bounded skill) goes missing in a session, check
this first.

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
