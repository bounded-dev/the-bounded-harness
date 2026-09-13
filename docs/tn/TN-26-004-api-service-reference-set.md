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
parsers, test through the server-side caller), and the one place that
expertise ran out, the architect erased the router's type (`AnyRouter`) and
no gate objected. This note designs the fix as a **reference set**: when a
ticket says "expose this to the frontend" — never naming a framework — the
harness rolls out the *same* service structure every time, deterministically,
serialization included.

## Premise: the ticket names a capability; the harness binds the stack

Users say "the web team needs to call this", not "tRPC v11". Stack choice is
harness policy, not ticket content — the same move as vitest being *the* test
runner. One blessed RPC stack for TypeScript (tRPC today), one blessed schema
engine (zod), both pack-pinned, recorded in an ADR. Three layers make the
binding stick:

1. **Guidance** — a pack skill triggered by capability language ("expose over
   an API / HTTP / RPC / to a frontend / typed client"), naming the house
   stack and the reference structure. Best-effort: a model may fail to load
   it.
2. **Availability** — the pack owns what is installed. Target projects forbid
   adding dependencies, so the only reachable stacks *are* the blessed ones,
   pinned and installed by the harness (the ts-morph pattern in `deliver`:
   pin, install, verify, block on failure). Deterministic even when the skill
   never loads.
3. **Enforcement** — lint rules that apply unconditionally whenever the stack
   is present in the tree, not conditional on anyone having read anything.

**Intake strips the "how" before anything else reads the ticket.** This is
general, not GraphQL-specific: every spec arriving from a user or a parent
agent is reworked into pure requirement language — *what* must be possible,
for *whom*, under *what* rules — and any embedded implementation choice
("over GraphQL", "as a REST endpoint", "using library X") is stripped at the
door. The architect's spec records what was stripped, so the removal is a
visible act rather than a silent one. Two outcomes follow:

- **The common case: the "how" was incidental.** "Expose the data to the
  frontend over GraphQL" becomes "the frontend needs typed access to the
  data"; the house stack binds as policy and nothing leaks — the delivered
  interface is the reference one, whatever word the ticket used.
- **The rare case: the "how" is a real constraint** ("must plug into the
  company's existing GraphQL gateway"). That is a product decision wearing a
  technology sentence, and the developer stage already routes those: it
  reaches the user (TN-26-001 dispute protocol) instead of being either
  obeyed or dropped.

Enforcement backstops the intake rule mechanically: no non-blessed framework
is installed or installable, and the `blessed-stacks-only` import lint blocks
the leak even if a stripped "how" survives into someone's head. A non-house
stack ships only after a human changes the policy, never because a ticket
mentioned one.

## CQRS at the boundary: every payload is a command or a query

The wire shape is fixed: **every mutation takes exactly one command value
object; every query takes exactly one query value object.** No positional
scalars, no anonymous option bags.

- Commands and queries are value objects like any other — nominal classes,
  private constructor, `static parse` (ADR 2026-015) — named
  `<Verb><Noun>Command` / `<Noun>Query`, declared in their own contract file
  (`src/api/commands.contract.ts`, ADR 2026-026 applies unchanged).
- **Their fields reuse the domain's existing value objects.** A command is
  composition, not re-declaration: `IngestReportCommand` holds a
  `BuildingId`, a `Period`, an `Availability` — never a second definition of
  what a valid building id is. The existing `no-naked-primitives` rule
  already polices the field types; a new shape rule polices the pairing
  (below).
- Outputs are read models: plain readonly DTO types over value objects,
  declared in the api contract. Whether mutations may return read models or
  only acknowledgements is an open question below — r22 returned the full
  status from ingest, and that stays legal until decided.

This gives the boundary one identity per request: the procedure's input type
IS the command, the command IS a value object, and the value object IS the
validator.

## Zod is the engine inside every value object — never a second identity

Refinement of the r22-era stance. Run 22 banned zod because a standalone
schema beside a value object is a dual identity (ADR 2026-023). The precise
rule is narrower: **the value object remains the single public identity; zod
is its internal parsing engine.**

- Every value object's `static parse` is implemented over a zod schema —
  hand-rolled `typeof`-chain validation is the defect, not the schema
  library. Commands compose the schemas of the domain value objects they
  carry, which is exactly the reuse the composition needs.
- The schema never crosses a public surface: no zod type (`ZodType`,
  `z.infer`, a schema constant) on any contract's exported surface. The
  contract declares `parse(raw: unknown): T | undefined` exactly as today;
  that zod sits behind it is invisible to every consumer.
- zod joins the pack-pinned dependency set (installed like ts-morph and
  @trpc/server; version is pack policy).
- The generated value-object law suites are unchanged in role and get
  stronger in reach: hostile-input laws and the wire round-trip law now
  exercise a zod-backed parse the same way they exercised a hand-rolled one.

## Serialization: a law, not a per-run design

Rich domain values do not survive JSON, so the wire form is a property of the
value object itself:

- Every value object exposes `toJSON()` returning exactly the raw shape its
  own `parse` accepts. `JSON.stringify` then serializes nested commands and
  read models natively, and the **round-trip law** `parse(toJSON(v)) ≡ v` is
  generated into the law suite for every value object reachable from an api
  contract — machine-written red/green evidence, identical every run.
- Command parse composes field parses, so one malformed leaf fails the whole
  command with the field path named — which feeds the error taxonomy below.

## The error taxonomy: fixed table, generated probes

Pack-owned, total, closed: malformed payload (command/query parse failure) →
`BAD_REQUEST` naming the field path; unknown resource → `NOT_FOUND`; violated
domain invariant on a well-formed payload → `UNPROCESSABLE_CONTENT`;
everything else → `INTERNAL_SERVER_ERROR` carrying nothing. Alongside the
table, a **generated API law suite**: for every declared procedure, generated
tests feed a top-level non-object, an unknown enum name, and a missing
required field, asserting the mapped code. Run 22's two confessed coverage
holes (non-object body, unknown threshold-set name) are exactly the tests
this generator writes; that class of hole becomes structural, not findable.

## What is gated — the deterministic core

Everything below is a lint rule at contract-purity or a generated test —
enforcement, not advice:

| gate | layer | refuses |
|---|---|---|
| `no-erased-router` | purity lint | `AnyRouter`-style type erasure on a contract surface; message names the re-export-inferred-type pattern (ADR 2026-026 route) |
| `command-query-payloads` | purity lint | an api procedure whose input is not exactly one `*Command` (mutation) / `*Query` (query) value object |
| `no-naked-primitives` (existing) | purity lint | primitive fields inside commands, queries, read models |
| `zod-backed-parse` | zone lint on VO implementations | a value object `parse` with hand-rolled structural validation instead of a zod schema |
| `no-schema-on-surface` | purity lint | any zod type or schema constant exported from a contract |
| `blessed-stacks-only` | zone lint on `src/**` | imports of non-allowlisted API/schema frameworks (graphql, express, fastify, ajv, …) |
| round-trip law | generated test | a value object whose wire form does not parse back to an equal value |
| API hostile probes | generated test | a procedure that maps malformed input to anything but `BAD_REQUEST`, or leaks internals on unexpected failure |
| stack pin | deliver step | a tree whose installed @trpc/server or zod differs from the pack pin, or is missing |

Not gateable, and named as such: whether the *exposure design* is right
(which operations, their granularity) — that stays architect judgment plus
the reviewer's challenge, and the CQRS shape rule at least guarantees the
reviewer reads it in one fixed vocabulary.

## What stays agent, what becomes machine

| concern | today (r22) | reference set |
|---|---|---|
| stack choice | prompt named it | pack policy; contrary tickets challenged, escalated |
| exposure design | architect, freestyle | architect, as commands/queries in one contract |
| payload shape | per-run invention | one command/query VO per procedure, lint-enforced |
| validation engine | hand-rolled parse | zod inside every VO, lint-enforced |
| router typing | erased (`AnyRouter`) | re-exported inferred type; lint-blocked otherwise |
| serialization | undesigned (review blocker) | `toJSON` wire form + generated round-trip law |
| error taxonomy | spec'd per run | fixed table + generated hostile probes |
| framework versions | driver installed ad hoc | pack-pinned, installed and verified |

## Validation

Re-run Run 22's task with (a) the prompt stripped of all smuggled expertise,
(b) the capability phrased without naming any framework, and (c) a variant
ticket that explicitly asks for GraphQL. Pass = identical structure lands
twice, the GraphQL request is challenged and escalated rather than built, no
type erasure, generated laws green, and the review round-trip is spent on the
domain rather than the wire.

## Open questions

- May mutations return read models (r22 did; CQRS purism says acknowledge
  only)? Pick once, gate the shape if gateable.
- Migration: existing value objects (cockpit arm, three delivered runs) are
  hand-rolled — does `zod-backed-parse` apply to new VOs only, or does the
  first service run on a tree migrate its domain VOs (a change run of its
  own)?
- How far `zod-backed-parse` can see: lint can verify a schema is present
  and referenced by `parse`; it cannot verify the schema is *right* — the
  generated hostile laws carry that half. Is the pairing sufficient?
- Detection fallback when the skill misses: is lint-on-presence enough, or
  should the developer-stage skill route "this ticket is an exposure"
  explicitly?
- The React half stays out of scope: this set keeps the router's type intact
  for a typed client; nothing yet says how a frontend consumes it under the
  pipeline.
