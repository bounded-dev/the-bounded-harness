---
number: TN-26-004
title: The API-service reference set — one deterministic way to put a component on the wire
kind: design
status: draft
issue: (successor to #14 / Run 22 findings; dedicated ticket pending)
---

# The API-service reference set

Run 22 proved the pipeline can deliver a tRPC service — and proved it by
cheating twice. The prompt carried hand-written expertise (reuse the domain's
parsers, no second schema, test through the server-side caller), and the one
place that expertise ran out, the architect erased the router's type
(`AnyRouter`) and no gate objected. This note designs the fix as a **reference
set**: when a ticket says "expose this to the frontend" — never naming a
framework — the harness rolls out the *same* service structure every time,
deterministically, serialization included.

## Premise: the ticket names a capability; the harness binds the stack

Users will say "the web team needs to call this", not "tRPC v11". So stack
choice is harness policy, not ticket content — the same move as vitest being
*the* test runner. One blessed RPC stack for TypeScript (tRPC today), pinned
at one version by the pack, recorded in an ADR. Three layers make the binding
stick without anyone naming it:

1. **Guidance** — a pack skill whose trigger is capability language ("expose
   over an API / HTTP / RPC / to a frontend / typed client"), which names the
   house stack and the reference structure. Best-effort: a model may fail to
   load it.
2. **Availability** — the pack owns what is installed. Target projects forbid
   adding dependencies, so the only reachable RPC stack *is* the blessed one,
   pinned and installed by the harness (the ts-morph pattern in `deliver`:
   pin, install, verify, block on failure). Deterministic even when the skill
   never loads.
3. **Enforcement** — lint rules that apply unconditionally whenever the stack
   is present in the tree (dependency detected, or an api contract exists) —
   not conditional on anyone having read anything.

## The reference structure, fixed

Identical in every run — file names, type names, procedure conventions:

- `src/api/api.contract.ts` — the **exposure declaration**, agent-authored,
  small, reviewable: which operations are exposed, each as `query` or
  `mutation`, under what name, with what wire input/output types. This is the
  one genuine design act; everything else follows from it.
- `src/api/api.ts` — the router implementation (builder-written to the
  contract, as any component).
- The router's *type* is never hand-declared and never erased: the contract
  re-exports the implementation's inferred type (`export type ApiRouter =
  typeof …` via the sanctioned import-from-implementation route, ADR
  2026-026). New purity rule **`no-erased-router`**: a type-erased framework
  type (`AnyRouter` et al.) on a contract's public surface is a block, with
  the re-export pattern named in the message. This closes Run 22's shipped
  compromise at the gate layer, where the reviewer's advisory concern could
  not.
- Ports reach the router through context; the service constructs nothing
  ambient. Tests go through the server-side caller; no socket. (Both were
  prompt-smuggled in r22; both become skill + lint where lintable.)

## Serialization: a law, not a per-run design

The hard question every service run re-derives is the wire boundary: rich
domain values do not survive JSON. The reference answer makes it a property
of the value objects themselves:

- Every value object already has `static parse(raw: unknown)`. The set adds
  the symmetric half: a **wire form** — `toJSON()` returning exactly the raw
  shape its own `parse` accepts. `JSON.stringify` then serializes nested
  structures natively, and the **round-trip law** `parse(toJSON(v)) ≡ v`
  makes correctness testable.
- The scaffolder already generates law suites for value objects (hostile
  inputs). Extend it: any value object reachable from an api contract gets
  the round-trip law generated into the suite. Serialization correctness
  becomes machine-generated red/green evidence, identical every run — never
  something a test-writer remembers.
- One identity holds (ADR 2026-023): no second schema library. The wire
  parser *is* the domain parser; anything else is a dual identity for the
  same value.

## The error taxonomy: fixed table, generated probes

Pack-owned, total, closed: malformed input → `BAD_REQUEST` naming the field
path; unknown resource → `NOT_FOUND`; violated domain invariant →
`UNPROCESSABLE_CONTENT`; everything else → `INTERNAL_SERVER_ERROR` carrying
nothing. The taxonomy is skill guidance for the architect and — the sharper
half — a **generated API law suite**: for every declared procedure, generated
tests feed a top-level non-object, an unknown enum name, a missing required
field, and assert the mapped code. Run 22's two confessed coverage holes
(non-object body, unknown threshold-set name) are exactly the tests this
generator would have written; they stop being findable holes and become
structural.

## What stays agent, what becomes machine

| concern | today (r22) | reference set |
|---|---|---|
| stack choice | prompt named it | pack policy; ticket names capability |
| exposure design | architect, freestyle | architect, in one small api contract |
| router typing | erased (`AnyRouter`) | re-exported inferred type; lint-blocked otherwise |
| wire validation | prompt-instructed | domain parse, lint-checked; no second schema |
| serialization | undesigned (blocker in review) | `toJSON` wire form + generated round-trip law |
| error taxonomy | spec'd per run | fixed table + generated hostile probes |
| framework version | driver installed ad hoc | pack-pinned, installed and verified like ts-morph |

The builder keeps its whole job: skeletons stay ordinary throwing skeletons,
and the generated laws only *test*. v2 may generate the structural parsers
for composite wire types from the api contract (ts-morph walks contracts
already); v1 leaves the parser to the builder with the generated hostile
suite keeping it honest.

## Validation

Re-run Run 22's task with (a) the prompt stripped of all smuggled expertise
and (b) the capability phrased without naming the framework. Pass = same
structure lands, no type erasure, generated laws green, review round-trip
spent on the domain rather than on the wire boundary.

## Open questions

- Where detection lives when the skill misses: should the developer-stage
  skill itself route "this ticket is an exposure" to the api pattern, or is
  lint-on-presence enough?
- `UNPROCESSABLE_CONTENT` vs `BAD_REQUEST` for invariant violations
  (misordered threshold set — r22 mapped it somewhere; pick once, for every
  service ever).
- Composite wire types: how far v1 trusts the builder's hand-written
  structural parser before v2 generates it.
- Does the exposure declaration warrant its own zone-lint shape rule
  (declaration-only is covered; "only re-exports and procedure declarations"
  may want one)?
- The React half is out of scope here on purpose: this set makes the typed
  client *possible* (the router type survives to the contract); nothing yet
  says how a frontend component consumes it under the pipeline.
