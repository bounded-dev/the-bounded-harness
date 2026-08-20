# 2026-014: Layer by activation scope, not directory taxonomy

**Status:** accepted (amends 2026-013)

## Decision

The harness does not grow a deep pack taxonomy (language → framework → app
type). Layers are expressed by **activation scope**, following the
conventions the agent-harness ecosystem has standardized on:

- **Always-on app-type constraints** (hexagonal layout, validated routes,
  value-object primitives) live in the **project template** and are
  vendored into each project's `AGENTS.md` + lint/architecture config —
  nearest-file-wins is the AGENTS.md standard; deterministic enforcement is
  code, not prose.
- **Task-scoped procedures** (scaffold a screen/route/service, release,
  migrate) live in **flat packs** as description-triggered skills, per the
  Agent Skills standard (flat, self-contained skill packages;
  `description` is the activation mechanism).
- **Pack names and skill names are flat with domain prefixes**
  (`packs/ts`, maybe later `packs/ts-react`; skills like
  `ts-new-value-object`) — skill names allow hyphens only, so hierarchy
  cannot live in names.
- **New app type = template first.** A stack earns a `packs/<stack>` entry
  only when it accumulates reusable procedures shared across projects.
- **Self-contained beats DRY across packs.** No cross-pack relative-path
  references (`../../ts/...`) — they break when a pack splits out
  (2026-013). Duplicate the few lines instead.

## Why

- The Agent Skills standard (which pi implements) makes skills flat and
  self-contained with description-based activation; Cursor's rules — the
  most worked-out layering model — layer by activation mode
  (alwaysApply / globs / agent-requested / manual), not taxonomy.
  Directory depth is the wrong axis; *when does this fire* is the right one.
- App-type rules loaded globally would be context noise in sessions for
  other app types; scoped to the project (or vendored into it) they are
  always exactly where they apply.
- Glob-triggered rules have no pi equivalent — and deterministic lint /
  architecture tests are strictly better enforcement for the rules that
  would have used them.

## Consequences

- `packs/ts/README.md` placement table is the working reference; amend it
  as packs appear.
- When a second app type appears, the first artifact is its template
  (structure + vendored constraints + canonical commands), not a new pack.
