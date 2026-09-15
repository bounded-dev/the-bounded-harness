---
number: TN-26-006
title: The web-frontend reference set — FSD layers, shadcn, and the typed client
kind: design
status: draft
issue: (pending)
---

# The web-frontend reference set

The path to a full web-app MVP runs through the one part the harness has
never built: the frontend. This note plans the `ts-web` pack — the second
real pack (TN-26-005 composition applies: its own `contrib.json`, a declared
dependency on the ts pack, nothing implicit) — and the dogfood ladder that
proves it.

## Ratified at the 2026-09-14 grill

- **Blessed web stack:** React, Vite, TanStack Query, `@trpc/client`,
  Tailwind, shadcn/ui — exact-pinned by the pack (ADR 2026-029 applies).
- **shadcn components are pack-owned in v1**: vendored by the generator with
  generated markers, never hand-edited; restyling happens through the
  Tailwind token layer. Revisit if a real project needs a variant tokens
  cannot express.
- **Scoped primitives relaxation:** contracts under the generic UI layer are
  exempt from `no-naked-primitives` (a Button's `label: string` is
  legitimate); everywhere else the rule stands, so domain data crosses into
  feature components as value objects and is rendered to primitives at the
  leaf.
- **`check` grows a production build** (`vite build`) at delivery only — the
  inner red/green loop stays fast.

## Structure: Feature-Sliced Design, pruned to four layers

FSD is the enforceable form of the dumb-vs-domain-aware split — its core law
(imports flow strictly downward; each slice exposes a public API through its
index) is lint material, its vocabulary is in every model's training data,
and its layer split aligns with the wire's CQRS (ADR 2026-030): `entities`
own read models and queries, `features` own commands and forms.

```
src/ui/
  shared/     ui (shadcn kit, generated) · api (the ONE door: trpc client + query client)
  entities/   read side — display components + query hooks per domain entity
  features/   write side — forms/actions + command hooks per user interaction
  pages/      routes composing the above
```

`widgets` is reserved (lints know the name; the generator does not emit it);
`processes` is dropped (deprecated by FSD itself). Enforced, all as pack
lint rules: downward-only imports; slice-public-API imports only; `@trpc/*`
and TanStack Query legal only inside `shared/api`; no domain imports in
`shared`; styling libraries other than Tailwind refused
(`blessed-stacks-only` grows the nouns via contrib.json: vue, angular,
svelte, mui, chakra, styled-components, emotion, bootstrap, …).

## The build, in slices

**A — plumbing.** A1: TSX through every gate (lint globs, scaffolder emits
`.tsx` throwing skeletons for component-declaring contracts, JSX tsconfig,
red/green untouched). A2: the router-type re-export becomes a purity rule —
both r23 services legally omitted it, and the typed client depends on it.

**B — the `ts-web` pack.** B1: generator emits the FSD skeleton, Vite,
Tailwind, `main.tsx`, all marker-generated; `contrib.json` carries the
pack's nouns and pins. B2: the directional lints and the primitives
relaxation. B3: shadcn vendoring through the generator. B4: the `ts-web-app`
skill (guidance last) and the ask-shaped routing line.

**C — app assembly.** `npm run dev` = Vite + the service's HTTP entry,
proxy wiring; deliver pins web deps keyed on tree content; dogfood arms
scaffold them from birth; first genuine use of composition-at-initiation
(TN-26-005).

**D — the dogfood ladder.**
- **r24**: props-driven UI ticket, no API ("a screen that renders building
  status") — proves TSX, layering lints, shadcn, and blind UI testing in
  isolation.
- **r25**: change run wiring it to the service — typed client end to end,
  hooks discipline; `BAD_REQUEST` field-path detail lands here, where forms
  make it a user need.
- **r26**: the capstone — empty arm, one-sentence ticket ("facility
  managers need a dashboard to submit reports and see status"), full stack,
  headless, `npm run dev` works; plus an adversarial variant naming a
  banned framework.

## Named risks

- **Blind UI testing is the experiment.** The test-writer keys on roles,
  labels and observable behaviour, so specs must state them ("shows the
  inspection queue count when any meter is excluded") — spec discipline the
  skill must teach; r24 exists to find out how the worker copes.
- **Visual quality has no gate and never will** — reviewer and sign-off
  carry it; the MVP is the first run where that gap is load-bearing.
- Suite runtime grows (jsdom); watch red/green wall time.
- Layer misplacement is expected early — the lints make it a bounce, not a
  debate; watch the friction counters for rules that need better messages.
