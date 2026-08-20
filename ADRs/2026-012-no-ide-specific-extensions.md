# 2026-012: No IDE/terminal-specific integrations in the harness

**Status:** accepted (supersedes 2026-007)

## Decision

The harness contains no extensions or settings tied to a specific IDE or
terminal. The Zentty guarded loader (`extensions/zentty.ts`) is removed —
Zentty is uninstalled. The lone exception is `extensions/orca-*.ts`, which
Orca writes and manages itself (ADR 2026-010); that code is owned by the
tool, not by this repo.

## Why

A global, every-project harness shouldn't carry integrations for one
editor/terminal: they rot when the tool is uninstalled, they couple the
harness to a choice that can change, and they violate the "stock pi + this
repo" litmus test's spirit (2026-001). If a terminal integration is wanted
again, it belongs to that tool writing into the harness (the Orca pattern),
not hand-maintained harness code reaching into an app bundle.

## Consequences

- `settings.json` portability now holds trivially: no machine- or
  tool-specific paths anywhere in tracked config.
- Zentty users on old commits: the loader is gone; nothing to migrate.
- Future IDE/terminal capabilities enter the harness only via the tool's
  own managed files, or not at all.
