---
name: ts-web-app
description: Design a TypeScript web frontend the reference way — build a screen, page, dashboard or form that a person looks at in a browser. Use whenever a ticket asks for a UI, a screen, a view, a dashboard, a form, a button, something a user sees or clicks, or asks to show or display data to people. Covers the Feature-Sliced layers and their laws, the one door to the service, spec discipline for blind UI testing, and what the gates enforce.
---

# The web-frontend reference set (TN-26-006)

A ticket that says "facility managers need to see building status" — in any
words, naming any technology or none — lands here. **The stack is harness
policy, not ticket content** (ADR 2026-029): React, Vite, TanStack Query,
`@trpc/client`, Tailwind and a vendored shadcn-style kit, all pack-pinned. A
ticket naming Vue, Next.js, MUI or styled-components is the intake rule's
constraint case (ADR 2026-032): strip it, record it in `spec.md`'s `## Intake`
section, and if it is a genuine constraint — an existing design system, a
platform mandate — raise it to the user; never build it.

The structure below is the same in every frontend the harness ships. Your
design decisions are *which screens exist, what they show, and what a person
can do on them*; everything else is fixed, and most of it is enforced.

## Structure comes from the generator, never from you

```
node packs/ts-web/scripts/new-web-app.ts .
```

It emits `index.html`, `vite.config.ts`, `src/ui/app.css`, `src/ui/main.tsx`,
the component kit, and the layer directories — every file marker-generated and
pack-owned. Re-run it whenever the tree changes shape; it byte-compares, writes
only what differs, and **blocks without writing anything** if a pack-owned path
holds a file it did not write.

Do not hand-write any of those files, and do not restyle a component: the kit
is generated, and the whole restyling surface is the `@theme` token block in
`app.css`. A variant the tokens cannot express is a pack change, not a local
edit.

Two things the generator deliberately does NOT emit:

- **`src/ui/app.tsx`** — that is yours to declare as `src/ui/app.contract.ts`,
  after which `design_gate`'s scaffold step writes its `.tsx` skeleton and the
  builder implements it. `main.tsx` already mounts `<App />`.
- **`src/ui/shared/api/client.tsx`** — the typed client lands only once a
  contract in the tree re-exports `ServiceRouter`. Build the service first (the
  `ts-api-service` skill), re-run the generator, and the door appears wired.

## The layers, and the two laws

```
src/ui/
  shared/     ui (the generated kit) · lib (cn) · api (the ONE door)
  entities/   READ side — display components + query hooks, one slice per entity
  features/   WRITE side — forms/actions + command hooks, one slice per interaction
  pages/      routes composing the above
```

`widgets` is reserved: the lints place it between features and pages, but
nothing emits it — add the directory only when a composite block genuinely
exists. `processes` is gone; FSD deprecated it itself.

**Law 1 — imports flow strictly downward.** `shared < entities < features <
widgets < pages`. A module may import its own layer or a lower one, never a
higher one. If a component needs something from above, take it as a prop.
Enforced by `pi-harness-ts-web/fsd-downward-imports`, type-only imports
included.

**Law 2 — each slice has one front door.** A cross-slice import targets the
slice root (`../building`), never a file inside it
(`../building/model/query.js`). Inside your own slice, reach for anything.
Enforced by `pi-harness-ts-web/fsd-slice-public-api`.

Together they are the reason the layers stay a structure rather than becoming a
diagram: both defects compile, both run, and neither is visible in review until
the tree is already tangled.

## CQRS, laid over the layers (ADR 2026-030)

The wire is already split into commands and queries, and the layers line up
with it exactly. Keep them lined up:

- **`entities/` are queries.** One slice per domain entity: its read-model
  display components and a `useBuildingStatus()`-shaped hook wrapping the
  service's query. Read models arrive as value objects and are rendered to
  primitives at the leaf.
- **`features/` are commands.** One slice per *user interaction*, named for the
  interaction and not for the entity: `submit-report`, not `report`. Holds the
  form, the validation, and a `useSubmitReport()`-shaped hook wrapping the
  service's command. **A write returns an Ack, never data** — whatever the
  screen should show afterwards, it asks a query for, which in practice means
  invalidating the entity's query key.

A feature may import an entity. An entity may never import a feature — that is
Law 1, and it is also just the read side not depending on the write side.

## The one door

Everything network lives under `src/ui/shared/api/`, and
`pi-harness-ts-web/client-one-door` refuses a runtime `@trpc/*` or `@tanstack/*`
import anywhere else (`import type` is fine everywhere).

```ts
// src/ui/entities/building/model/query.ts
import { useQuery } from "...";            // ← BLOCKED. Not here.
```

```ts
// src/ui/entities/building/model/query.ts — the correct shape
import { useServiceClient } from "../../../shared/api/client.js";

export function useBuildingStatus(id: BuildingId): BuildingStatusResult {
  const client = useServiceClient();
  /* wrap the client call in the query hook the door re-exports */
}
```

One client, one URL, one `QueryClient`. A second client is a second URL to get
wrong; a second `QueryClient` splits the cache and *nothing fails* — half the
app quietly stops seeing the other half's writes. Reading the client from
context is also what makes a component testable: render it under a provider
holding a fake and it knows no difference.

## Spec discipline: write for a test-writer who cannot see the screen

**This is the part that decides whether the run works.** The test-writer never
sees `src/`, never sees a rendered pixel, and cannot judge whether a layout
"looks right". It writes tests against *observable behaviour*: the roles,
accessible names, labels and visible text a user would use to operate the
screen. So a spec section that says "shows building status nicely" is a section
it cannot test, and it will invent something.

State what is on the screen and what changes:

> **Inspection queue count.** The dashboard shows a heading "Inspection queue"
> and, beneath it, the number of buildings with at least one excluded meter.
> With none, it shows the text "No inspections due" and no number. Submitting a
> report for a building whose meter is excluded increases the count by one
> without a page reload.

Every noun in that paragraph is findable: a heading by role and name, a number
by its visible text, a state by the text that replaces it. Compare with "the
queue count updates when relevant" — same intent, nothing to assert.

Practical rules:

- **Name every control by what a user reads**, not by a CSS class or a test id:
  the button "Submit report", the field labelled "Meter reading".
- **Say what the empty, loading and error states show.** They are three
  separate screens and the spec owes all three; a test-writer given only the
  happy path writes only the happy path.
- **Say what a write causes**, in user-visible terms ("the row disappears from
  the queue"), never in cache terms.
- The kit helps: `Label` renders a real `<label>` (so `htmlFor` makes
  `getByLabelText` work), `CardTitle` renders a heading, `Button` renders a
  button. Use them and the accessible names exist for free.

**Visual quality has no gate and never will.** Layout, spacing, hierarchy and
taste are carried by the reviewer and by sign-off. Do not mistake a green suite
for a good screen.

## What the gates enforce

- **contract-purity**: the full rule set, with ONE ratified exemption —
  contracts under `src/ui/shared/ui/` are exempt from `no-naked-primitives`,
  `value-object-shape` and `value-object-documented`, because a Button's
  `label: string` is a string. Everywhere else — including `entities/` and
  `features/` — value objects stand. Moving a domain type into `shared/ui` to
  duck a block does not work: Law 1 refuses the import that made it useful.
- **lint-src** over `.ts` *and* `.tsx`: the four escape hatches
  (`no-non-null-assertion`, `consistent-type-assertions`, `no-explicit-any`,
  `ban-ts-comment`) are banned in components exactly as in domain code —
  `props as any` is the same lie about the same type checker — plus
  `fsd-downward-imports`, `fsd-slice-public-api`, `client-one-door` and
  `blessed-stacks-only`.
- **The scaffolder** emits a `.tsx` skeleton for any contract whose exported
  surface returns a React element, so a component contract produces a file the
  builder can put JSX in.
- **`new-web-app`** blocks if the layout has been hand-edited.
