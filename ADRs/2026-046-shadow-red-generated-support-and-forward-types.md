# 2026-046: Rebuild generated support in red shadows; verify forward types live

**Status:** accepted

## Decision

The red gate reconstructs contract-triggered support files from the pack's
canonical source while building its shadow project. It never copies a live
business implementation. A contract may import a type from a value exported
only by its sibling implementation. When the regenerated skeleton lacks that
export, the gate accepts only that exact missing-export diagnostic, only for a
type-only import of a value the live sibling exports, and only if the complete
live project typechecks. Every other shadow diagnostic still blocks red.

## Why

The CRM run's contract imported the shipped service runtime and inferred a
router type from the implementation. The shadow omitted the runtime and the
router value, so it blocked a suite whose tests otherwise failed for
NotImplemented. The runtime is deterministic pack output. The inferred router
type cannot be honestly synthesized from a throwing skeleton.

## Consequences

Red remains independent of the builder for ordinary contracts. A contract
that borrows an implementation-only type must wait for a type-clean live tree
before red can pass. This is explicit coupling, not a permissive `any` stand-in
or a blanket suppression: the shadow suite still runs against only throwing
skeletons, and an import, test, or implementation error still blocks the gate.
