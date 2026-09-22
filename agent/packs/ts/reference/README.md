# Reference component — copy the shape, not the content

This is one complete, gate-passing component in a **neutral domain** — an
append-only log of temperature readings. It exists so an agent starting a build
can read a worked example of the shapes the gates enforce, instead of
reconstructing them from prose rules. **Transfer the structure; do not carry the
domain across.** Your ticket is not about temperatures.

It is **gate-verified in CI**: `packs/ts/scripts/reference-component.test.ts`
builds this component through the real gates on every `npm run check`, so the
example can never drift from the rules it teaches — a gate that changed would
either update this component or turn its own suite red (TN-26-008).

## What each file shows

- **`src/readings/reading-id.contract.ts`, `celsius.contract.ts`** — the
  canonical value object: a nominal `declare class` with a private `__brand`, a
  private constructor, `static parse(raw: unknown): T | undefined`, and a doc
  comment stating the validity rule with **two `@accepts` examples**. This is the
  shape that replaces the branded-alias reach (`type Id = string & {…}`), which
  is banned. One value object per file — that is `value-objects-own-contract`.
- **`src/readings/readings.contract.ts`** — the operations, in their **own**
  file, reaching each value object through its *implementation* module
  (`./reading-id.js`, never `./reading-id.contract.js`). Naked `string`/`number`
  never appear on the surface; the value objects carry the meaning.
- **`src/readings/*.ts`** — the delivered implementation. Each `parse` delegates
  to a **zod** schema (`zod-backed-parse`), the class re-exports its contract's
  types (`export type * from "./x.contract.js"`), and nothing uses `as`, `!`,
  `any` or `@ts-expect-error`.
- **`tests/reading-id.test.ts`, `celsius.test.ts`** — the **boundaries** block
  the red gate's obligations check demands: `describe("<Name> — boundaries")`
  (the separator is an em dash, U+2014) with an accepted literal and at least two
  distinct *wrong-value* rejections of the value object's own base type. Wrong
  *type* inputs (`null`, `42`, `[]`) are already owned by the generated laws, so
  they do not count.
- **`tests/readings.test.ts`** — the operation tests: the **idempotency / replay**
  pattern (recording a reading whose id is already present returns the identical
  log), a no-mutation check, and the **cross-cutting invariant** (ids stay
  unique across the log).
- **`tests/generated/*.laws.test.ts`** — machine-generated value-object laws
  (`value-object-laws.ts`). Never hand-edited; regenerated from the contract, and
  the CI driver holds them to exactly what the generator emits today.
- **`src/readings/spec.md`** — the half of the interface types cannot hold:
  ordering, identity, the exact bounds, the invariants.

## The gates this passes, and where CI runs them

`contract-purity`, `surface-check`, the red gate's boundary/reachability
obligations, `value-object-laws` (as a golden), the **red** gate (valid red
against a regenerated skeleton), the **green** gate (suite + typecheck + surface
+ escape-hatch + skeleton checks), and **mutation** (no survivors). All are wired
into `reference-component.test.ts`.
