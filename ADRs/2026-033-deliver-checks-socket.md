# 2026-033: `deliverChecks` — a pack-level socket for read-only checks at delivery

**Status:** accepted

## Decision

The **ts pack** defines a third socket, `deliverChecks`, beside its two lint
sockets (TN-26-005, "two-level sockets"). A contribution is a named,
described, **read-only** function from a project root to a pass/block verdict
with the lines a reader needs. `deliver.ts` runs every contributed check as
its last step, after the project's own `npm run check`; a block stops
delivery exactly as deliver's own steps do, and a check that throws is a
block naming the check.

First contributor: ts-web's `theme-check` — every token its generated
component kit styles through is still defined in the project-owned
`src/ui/theme.css`, and every declared foreground/background pair reaches
WCAG AA contrast, in the light scheme and in each `@media` variant
(TN-26-006).

## Why

A pack that ships a reference set into a tree has claims about the delivered
repo that no lint rule can check, because they are about files the **project**
owns rather than code a rule can parse. Without the socket those claims have
only two homes, and both are wrong: hard-wired into `deliver.ts`, which would
put the word "theme" — and eventually "colour", "component", "route" — into
the ts pack's delivery script for a pack it must not know about; or nowhere,
which is where "visual identity is free, within two mechanical fences" quietly
becomes one fence.

**Pack-level, not core.** The core owns no socket that names a delivery pass,
because delivery is a TypeScript-pack script: `npm run check`, a barrel,
ts-morph. The ts pack owns deliver, so the ts pack owns the socket, and the
core learns only that a pack declared one and another pack filled it.

**Born with its consumer.** The step in `deliver.ts` and the socket
declaration land in the same change. That is the socket policy, and it is what
keeps the vocabulary a curated dozen rather than an open registry of
extension points nobody consumes.

**Last, and read-only.** Last, because a check must judge the tree that
actually ships — after the barrel, the stripped conformance blobs and the
wiring delivery itself added, and after the repo has satisfied its own
definition of done. Read-only, because every mutating step is deliver's own: a
contributed check that wrote to the tree would be changing a repo *after* its
`npm run check` passed over it. The consequence is accepted: a red
`npm run check` short-circuits delivery before the contributed checks run, so
their verdicts appear once the repo is green.

## Consequences

Packs gain a delivery-time voice without the ts pack learning their nouns, and
the three sockets now cover the two places a pack's content can bite: the
gates, and the handover. A check is enforced like a gate, so it must be
deterministic and fast — a contribution that needs a network or a build
belongs in the project's own `check`, not here. The registry's owner typing
applies unchanged: contributing to `deliverChecks` without declaring the ts
pack in `dependsOnPacks` does not compile.
