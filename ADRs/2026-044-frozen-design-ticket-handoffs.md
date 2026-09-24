# 2026-044: Frozen design releases dependent tickets

**Status:** accepted

## Decision

A ticket dependency may be released by the producing architect's reviewed
design freeze, before implementation finishes. The producer commits that
design and a pack-specific publisher checks its local gate evidence. It emits
a receipt bound to a Git revision and hashes of the files the pack names.
Stack-neutral handoff machinery compares the receipt with that revision and
with the producer's current ref before consumer start and integration. A
changed, added, or removed handed-off file requires a new freeze and consumer
acceptance. The team lead coordinates dependencies and integration but never
authors the shared design.

The first slice supports separate gate roots. The current developer stage's
single root spec and project-wide contract scan do not permit independent
ticket freezes within one gate root; general same-project fan-out remains a
separate problem.

## Why

The design gate already creates a checked point before implementation. Reusing
it lets dependent implementation overlap without trusting an informal
interface. The guard log and manifest are ignored run state, so a portable
revision-bound receipt is needed across worktrees. Packs know what constitutes
a valid design; the core only knows revisions and bytes.

## Consequences

The TypeScript pack is the first publisher. Other packs may add publishers
without teaching the core their artifact names. Receipts are evidence, not
permission to skip each ticket's own gates or combined integration checks.
