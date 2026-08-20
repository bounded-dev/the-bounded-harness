# pi-harness

My personal [pi](https://pi.dev) coding agent harness. This directory **is** my
pi config home: `~/.pi/agent` is a symlink to it.

## Layout

| Path           | Tracked? | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| `settings.json` | yes     | Model prefs, theme, and the `packages` manifest  |
| `extensions/`  | yes      | Custom tools (web search/fetch, orca status, …)  |
| `agents/`      | yes      | Custom subagent definitions (pi-subagents; builtins disabled) |
| `skills/`      | yes      | Harness-only skills (auto-discovered global location) |
| `prompts/`     | yes      | Prompt templates (`/name` snippets), if added    |
| `ADRs/`        | yes      | Decision records (scheme in `ADRs/README.md`)    |
| `package.json` | yes      | pi package manifest                              |
| `auth.json`    | **no**   | Provider credentials                             |
| `sessions/`    | no       | Session transcripts                              |
| `npm/`, `git/` | no       | Packages installed by `pi install` (restorable)  |

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
```

Then log in (`pi` → `/login`) to recreate `auth.json`, and re-add
`BRAVE_API_KEY` to the shell env (ADR 2026-002).

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
  `pi install npm:<pkg>` (writes here automatically), never by editing `npm/`
  by hand.

## Decisions

Recorded as ADRs in [`ADRs/`](ADRs/) (scheme documented there).
