# 2026-017: Green requires a red for the current contracts, mechanically

**Status:** accepted

## Decision

`green_gate` refuses unless the guard log holds a `red_gate` pass AFTER the
most recent contract freeze. A checksum verify (no drift) does not void the
red; a re-freeze does. Companion decision: red-gate reachability is measured
by call sites in test sources (AST), with failure names as corroboration only.

## Why

Run 10: a contract was revised mid-loop, re-frozen, red never re-established;
green ran and passed 148/148 — with the sign-off honestly recording that the
red could not pass. Without a red, nothing proves the suite CAN fail, which
is the pipeline's entire epistemic product. The ordering lived in the skill
as prose and prose executed unreliably, as it always has here. On its first
live day the guard turned the same violation into a 7-second self-correction.
The reachability redefinition exists because failure-name evidence is
structurally unavailable for any export whose inputs come from other exports
(Run 9 jammed five bounces deep on that impossibility).
