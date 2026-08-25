---
name: ts-contract-authoring
description: Author a component contract (`*.contract.ts`) for the developer-stage pipeline (TN-26-001) — declaration-only typed surface, ports for side effects, then gate + scaffold. Use when writing or revising a component's contract/spec, or when acting as the architect role.
---

# TS contract authoring

A contract is the component's **typed public surface**: types, interfaces and
ambient (`declare`) declarations — the shape the test-writer tests against and
the builder implements. Contracts are written by the architect; skeletons are
**machine-generated** from them; the contract file itself is never edited by
the builder.

## Layout and naming (fixed rules)

- Contract: `src/<component>/<component>.contract.ts` — colocated with the component.
- The scaffolder derives the implementation path: `foo.contract.ts` → sibling `foo.ts`. Never create the sibling by hand.
- Spec lives in `spec.md`; one component per loop iteration.

## Declaration-only vocabulary

Allowed:

- `export interface …`, `export type …` (exported or local)
- `export declare function name(…): T;` — overloads fine
- `export declare const NAME: T;` — explicit type required (prefer functions;
  a `declare const` throws at import time during the red phase)
- `export declare class Name { … }` — bodiless members
- `import type …`, `export type … from` — the module graph is type-only

Banned (the gate rejects these — read the error message, it tells you where
the code belongs):

- function bodies, arrow functions, any value binding (`const x = …`)
- runtime classes/enums/namespaces — **enums become string-literal unions**:
  `export type Status = "open" | "paid";`
- value imports (`import { Pool } from "pg"`) — concrete infra never appears
  in a contract; side effects sit behind **ports** (interfaces) instead
- `export =`, default-exported values, `any`, `as` casts

## Rules of thumb

- **Every type used by the public surface must be exported.** The scaffolder
  fails on a referenced-but-unexported type — that's your cue to export it.
- **Value objects over primitives** at the boundary: prefer branded types
  (`type OrderId = string & { readonly __brand: "OrderId" }`) over naked
  `string`/`number` on DTO-like interfaces.
- **Explicit types live here.** This is the framework level: annotate
  everything. Implementations will infer from these declarations.
- Side effects (time, IO, network, randomness) are **ports**: an interface in
  the contract, injected into the component; the test-writer fakes them.

## Worked example

```ts
// src/orders/orders.contract.ts
import type { Money } from "../shared/money.contract.js";

export type OrderId = string & { readonly __brand: "OrderId" };

export interface Order {
  id: OrderId;
  total: Money;
}

export type NewOrder = Omit<Order, "id">;

export interface OrderStore {
  save(order: Order): Promise<void>; // port — the impl injects a real store
}

export declare function createOrder(input: NewOrder): Order;
export declare function findOrder(id: OrderId): Order | undefined;
```

## After writing: gate, then scaffold

Run the deterministic checks yourself before handing off; both fail with
greppable one-line reasons, and iteration is expected:

```bash
node "$PI_HARNESS/agent/packs/ts/scripts/contract-purity.ts" "src/**/*.contract.ts"
node "$PI_HARNESS/agent/packs/ts/scripts/scaffold-contract.ts" src/orders/orders.contract.ts
```

(`$PI_HARNESS` = the harness repo root; use the absolute path if unset.)

`contract-purity` exit codes: 0 clean · 1 problems listed · 2 no files matched
(treat 2 as an error — the gate must see the files). The scaffolder writes the
skeleton and auto-creates `src/shared/errors.ts` if missing. Then typecheck:

```bash
npx tsc --noEmit
```

A contract that lints clean, scaffolds, and typechecks is ready for the
test-writer.
