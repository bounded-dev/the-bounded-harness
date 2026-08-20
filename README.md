# pi-harness

My personal [pi](https://pi.dev) coding agent harness. This directory **is** my
pi config home: `~/.pi/agent` is a symlink to it.

## Layout

| Path           | Tracked? | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| `settings.json` | yes     | Model prefs, theme, and the `packages` manifest  |
| `extensions/`  | yes      | Custom tools (web search/fetch, orca status, …)  |
| `auth.json`    | **no**   | Provider credentials                             |
| `sessions/`    | no       | Session transcripts                              |
| `npm/`, `git/` | no       | Packages installed by `pi install` (restorable)  |

## Bootstrap a new machine

```bash
git clone <this-repo> ~/dev/pi-harness
ln -s ~/dev/pi-harness ~/.pi/agent   # create ~/.pi first if needed
pi update --extensions               # install packages listed in settings.json
```

Then log in (`pi` → `/login`) to recreate `auth.json`.

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
