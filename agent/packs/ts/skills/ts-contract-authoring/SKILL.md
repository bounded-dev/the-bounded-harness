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

## Operations must exist at runtime

**An `export interface` is a TYPE. It vanishes at compile time.** So a contract
whose operations are only methods on an exported interface declares nothing to
implement: neither the test-writer nor the builder can obtain the thing to call
it. The scaffolder blocks this, because every gate before it — declaration-only,
value objects, typecheck, checksum — passes happily on a contract that cannot
be built.

Every operation needs a value export. Either declare each one:

```ts
export declare function renew(subscription: Subscription, input: RenewInput): ChargeOutcome;
```

or keep the interface as the shape and declare a factory that returns it:

```ts
export interface SubscriptionBilling { renew(…): ChargeOutcome; /* … */ }
export declare function createSubscriptionBilling(deps: Deps): SubscriptionBilling;
```

Either is fine. What is not fine is collapsing several operations into one
entry point to satisfy the rule — the fix is to make what you designed
callable, not to shrink it.

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
- **naked `string`/`number` on the public surface** — see "Value objects"
  below; the gate names the exact declaration to write instead

## Rules of thumb

- **Every type used by the public surface must be exported.** The scaffolder
  fails on a referenced-but-unexported type — that's your cue to export it.
- **Value objects over primitives** at the boundary — **enforced**, not
  advice: `contract-purity` runs `no-naked-primitives`, which blocks a naked
  `string`/`number` anywhere on the exported surface (interface members, port
  method parameters and returns, `declare function` signatures,
  `declare const`, array/tuple/`Set`/`Record`-value elements).

  ### The canonical shape is a nominal class

  A private brand, a private constructor, a static `parse` taking `unknown`.
  Write this unless you have a reason not to:

  ```ts
  export declare class Currency {
    private readonly __brand: "Currency";
    private constructor();
    readonly code: string;
    static parse(raw: unknown): Currency | undefined;
    equals(other: Currency): boolean;
  }
  ```

  Every part is load-bearing, and every claim below is a `tsc` error rather
  than a convention — verified against the dogfood tsconfig:

  | Part | What it refuses | Error |
  |---|---|---|
  | `private readonly __brand` | a structurally identical impostor, and any other value object of the same shape | TS2739 — "separate declarations of a private property" |
  | `private constructor` | `new Currency("usd")`, i.e. construction that skipped validation | TS2673 |
  | `static parse(raw: unknown)` | nothing — it is the single door in, and `unknown` lets it face parsed JSON directly | — |
  | `Currency \| undefined` | using the result without handling failure | TS2322 |
  | `readonly code` | mutation after construction | TS2540 |

  **The brand does the work, not the private constructor.** A private
  constructor stops `new`; it does not stop
  `const c: Currency = { code: "USD" }`, because instances stay structurally
  typed. It is the private *field* that flips TypeScript into nominal
  comparison. Drop the brand and you have a DTO in a value object's clothes.

  **Public `readonly` fields, never a private field plus a getter.** A
  parameter property — `private constructor(readonly code: string) {}` — is
  already nominal, already immutable, already compile-time enforced. A getter
  earns its place only for a *derived* value.

  **Other constructors are welcome.** `static of(minorUnits: number, currency:
  Currency)` for when the parts are already value objects. `parse` is the one
  that must exist, because it is the boundary; the rest are convenience.

  **Behaviour lives on the class** — `equals`, `plus`, `toString`. That is the
  whole reason to prefer it over a brand: an alias can only be passed around,
  a class can be asked things.

  This shape passes `contract_purity` as written: `declare class` bodies are
  exempt from `no-naked-primitives`, because a class is already nominal and
  its `parse` must accept the raw primitive.

  **It is also why `src/**` bans every type-system escape hatch.** A branded
  alias could only be built with `return raw as Isbn`, so casts had to be
  tolerated. A class is built with `new Currency(raw)`, and a composite parser
  narrows with `in` rather than casting, so a correct implementation needs no
  `as`, no `!`, and no `@ts-expect-error` anywhere. There is no exemption list
  to reason toward — see "Escape hatches" below.

  ### Branded aliases are banned — the class is the only form

  ```ts
  export type Isbn = string & { readonly __brand: "Isbn" };   // BLOCKED
  export type Id = string & { readonly __brand?: "Id" };      // BLOCKED
  export type Isbn = string;                                  // BLOCKED
  ```

  `contract-purity` runs `no-branded-aliases`, and the reasons are Run 9's:
  the **optional** brand is a costume — every bare string is assignable, and
  because no class exists, no law suite is generated and the boundaries
  obligation never fires, so a question mark disarms the whole coverage
  machinery. The **required** brand is incoherent under the escape-hatch ban:
  `raw as Isbn` is its only constructor and `as` is blocked in `src/` with no
  exemption list, so the contract would demand what the builder cannot legally
  write. The class has a real constructor; it is the only value-object shape
  that needs no escape hatch.

  Don't hand-write either form — the one typo that matters is invisible (a
  brand string that doesn't match the type name silently gives you two
  unrelated types). Generate the class:

  ```bash
  node "$SCRIPTS/new-value-object.ts" src/reading-list/book.contract.ts \
      Isbn BookTitle AuthorName PagesRead=number
  ```

  Base defaults to `string`; the generated class carries it as
  `readonly value: <base>` — a placeholder name, because only you know it is
  really `code` or `digits`. Re-running is a no-op, and an existing alias,
  bare or branded, is upgraded to the class in place rather than duplicated.
  (Expect `tsc` to complain at the use sites after an upgrade: a class is not
  assignable from a raw string, so each complaint is a place the primitive was
  leaking, named for you.)

  Then do the two things the generator will not: retype the members that
  triggered the violation, and replace `state what makes it valid` in each doc
  comment with the actual rule. Both are design calls, not the tool's.

  ### Known gap: the implementation side is unchecked

  `value-object-shape` runs at `contract_purity`, on contracts only. It is NOT
  run over `src/**`, and that is a deliberate limit rather than an oversight:
  in a contract an exported class is a value object, but an implementation
  legitimately exports classes that are not — the scaffolder's own generated
  `shared/errors.ts` exports `NotImplementedError`, and a rule that blocks
  every project on its own generated code is a rule that gets switched off.

  The cost is real and worth knowing: `scaffold-contract.ts` excludes nominal
  classes from the generated `__conformance` object, because a nominal class
  cannot be checked with a `typeof` comparison. So nothing stops a builder
  quietly dropping the private constructor or the brand — the tests would still
  pass. What catches it today is that the tests typecheck against the
  implementation, so a changed signature surfaces there. A shape check that knew
  which src classes the contract declares would close this properly.

  ### Boundaries: what to commission from the test-writer

  The generated law suite (`tests/generated/**`) covers what is true of *every*
  value object — that `parse` refuses `null`, `[]`, `42`, `""`, a `Date`, a
  `Symbol`; that equality is by value and not by reference; that parsing is
  deterministic. It is machine-generated from the contract by the pack's
  `value-object-laws.ts`, and
  `tests/generated/**` is write-denied for every role — the test-writer
  included — for the same reason the skeletons are: an edit to a generated file
  is a claim the next regeneration silently discards. It cannot cover the one
  thing that matters most: an input of
  the **right base type and the wrong value**. `"usd"` is a string. Only
  someone thinking about currencies knows it must fail.

  So the test-writer's brief must ask, per value object, for a
  `describe("<Name> — boundaries")` block containing at least one accepted
  literal and **at least two distinct rejected literals**.

  **Two is the floor, not the target.** Two forces a second axis — wrong case
  *and* wrong length — where one invites a token gesture. Ask for one per
  axis the rule actually has: `Currency` has case, length and character class,
  so four rejections are honest and two is the bare minimum. A value object
  whose rule has more axes than your block has rejections is under-tested, and
  no gate can tell you that — only the rule can, which is why the rule has to
  be written down (below).

  For the test-writer to choose these deliberately rather than guess, the rule
  must be visible to it: it reads `spec.md` and the contract, nothing else.
  Give every value object a doc comment stating what makes it valid — and **two
  `@accepts` tags with distinct valid examples**:

  ```ts
  /** ISO-4217 alphabetic code: exactly three uppercase letters.
   * @accepts "USD"
   * @accepts "EUR"
   */
  export declare class Currency { … }
  ```

  The generated law suite needs one example to run its equality and
  determinism laws and a second, different one to run "equals discriminates".
  With one tag that law is emitted as a skip; Run 8 shipped with 9 skipped law
  tests for exactly this reason. Two tags costs you ten seconds at design time
  and buys a law per value object.

  Without it the test-writer invents a rule, the builder invents a different
  one, and they agree only by luck — the same failure as an unstated
  precondition order.

  **The parse boundary is the way out.** A raw primitive has to become a value
  object somewhere, so a signature that *returns* a value object declared in
  this contract may take naked primitives:

  ```ts
  export declare function parseIsbn(raw: string): Isbn | undefined;
  ```

  That is the rule's only escape hatch, and it improves the design instead of
  suppressing the complaint: every primitive in the component funnels through
  one named, testable function. The value object must be declared in the same
  contract as its parser — a brand and its only legal constructor belong
  together.

  What the rule deliberately leaves alone, so you can predict it: string-literal
  and template-literal unions (already value objects); `boolean`; `void` /
  `never` / `unknown`; type parameters and their constraints; type arguments of
  types it does not see through (`Result<string, E>`, `Brand<string, "Isbn">`);
  index-signature and `Record`/`Map` **key** positions; `declare class` bodies
  (a class is already nominal); anything not exported.
- **Encode cardinality in the type** where the requirement has one. No rule
  can infer this, so it is on you: "one or more authors" is
  `readonly [AuthorName, ...AuthorName[]]`, not `AuthorName[]` — an array
  silently permits empty, and a requirement no type carries is a requirement
  nothing checks.
- **Explicit types live here.** This is the framework level: annotate
  everything. Implementations will infer from these declarations.
- **Design for testability before you scaffold.** The test-writer works
  through this contract and nothing else — no implementation, nothing past
  the interface. Before running `scaffold-contract.ts`, check every exported
  operation against these; a failure means revise the contract, not the
  tests:
  1. **Single purpose** — one reason to exist, one behaviour to name.
  2. **Pure where possible** — output determined solely by input: no hidden
     state, no mutation of an argument, no reliance on module-level or global
     state.
  3. **Side effects are ports, not ambient calls** — time, IO, network,
     randomness, persistence each declared as an interface here and
     injected; never reached directly (`Date.now()`, a bare `fetch`, a
     module-level singleton).
  4. **Callable through the contract alone** — if testing an operation would
     need anything the interface doesn't expose, that's a design defect in
     the contract, not a gap in the tests.

## Escape hatches

The type checker is a harness layer, and `!`, `as`, `any` and `@ts-expect-error`
are the four ways to switch it off for one expression. Run 7 shipped a runtime
contract violation for exactly this reason: `tsc` rejected
`findInvoiceByOperationId(...)` as `Invoice | undefined`, and the builder wrote
`!` rather than handle the case. The gate had the bug and was overruled.

So `src/**` bans all four, with no exemption list:

- `@typescript-eslint/no-non-null-assertion`
- `@typescript-eslint/consistent-type-assertions` (`assertionStyle: "never"`)
- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/ban-ts-comment`
- `linterOptions.noInlineConfig: true` — so an `eslint-disable` comment cannot
  reopen any of them

The canonical value-object shape is what makes a blanket ban livable: with a
real constructor behind `parse`, a correct implementation needs none of the
four. If you find yourself reaching for one, the contract is usually wrong —
raise a `CONTRACT-DISPUTE` instead of asserting your way past it.

**There is no lint config in the target project to weaken.** `contract-purity`
builds its ESLint config programmatically and runs with
`overrideConfigFile: true`, so it consults no project config at all; the `src`
lint gate does the same. A worker cannot relax a rule by editing a file,
because there is no file — and an `eslint-disable` comment cannot either, because
`noInlineConfig` is part of the config it cannot reach.

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

The tools ship next to this skill, under `packs/ts/scripts/` — resolve them
from **this skill file's own directory** (shown in your session context):
`<skill-dir>/../../scripts/`. Run the deterministic checks yourself before
handing off; both fail with greppable one-line reasons, and iteration is
expected (the messages are instructions — read them):

```bash
SCRIPTS="<skill-dir>/../../scripts"   # e.g. .../packs/ts/scripts
node "$SCRIPTS/contract-purity.ts" "src/**/*.contract.ts"
node "$SCRIPTS/new-value-object.ts" src/orders/orders.contract.ts OrderId  # as the gate asks
node "$SCRIPTS/scaffold-contract.ts" src/orders/orders.contract.ts   # once per contract
npx tsc --noEmit
```

`contract-purity` exit codes: 0 clean · 1 problems listed · 2 no files matched
(treat 2 as an error — the gate must see the files). The scaffolder writes the
skeleton and auto-creates `src/shared/errors.ts` if missing.

A contract that lints clean, scaffolds, and typechecks is ready for the
test-writer.

## The guard log

Every gate and the scaffolder append to `.pi/guard-log.jsonl` in the project —
blocks (where a guard caught drift) and passes (proof it ran). Don't edit it;
it's the after-the-fact record of where determinism did its job.
