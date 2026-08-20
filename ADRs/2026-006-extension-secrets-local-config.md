# 2026-006: Extension secrets via gitignored local config files

**Status:** accepted

## Decision

Extensions that need API keys read them from a gitignored JSON file in the
harness root, with the process env as an override. Established pattern via
`web.ts`: `BRAVE_API_KEY` env var wins; otherwise `web-search.json`
(`{"BRAVE_API_KEY": "..."}`) next to `settings.json` is read.

## Why

GUI launchers (Orca) don't inherit shell env, so a key that only
lives in `~/.zshrc` silently goes missing in GUI-launched sessions — web
search was already falling back to Mojeek unnoticed. A file inside the
harness travels with the config home regardless of launch context, and is
already covered by the secrets gitignore hygiene.

## Consequences

- New extensions needing keys follow the same pattern: own gitignored
  `<name>.json`, env var overrides, never logged or committed.
- `web-search.json` is read per call, so adding/changing it takes effect
  without restarting pi.
