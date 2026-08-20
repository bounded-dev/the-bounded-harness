# 2026-002: Custom web extension

**Status:** accepted

## Decision

Keep the custom `extensions/web.ts` (`web_search` + `web_fetch`) instead of the
off-the-shelf `npm:pi-web-access` package.

## Why

- Zero dependencies, fully auditable, no third-party code running with system
  access (`pi-web-access` is 7 MB with 8 dependencies).
- Covers current needs: search + URL fetch.

## Consequences

- We maintain the Mojeek HTML-scrape fallback ourselves.
- No GitHub cloning, PDF extraction, or video understanding — revisit if those
  become needs.
- `BRAVE_API_KEY` is set in `~/.zshrc`, so the Brave Search API backend is
  active; Mojeek is only the key-free fallback. New machines need the key
  re-added to the shell env.
