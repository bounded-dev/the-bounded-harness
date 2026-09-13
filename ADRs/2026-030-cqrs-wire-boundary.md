# 2026-030: CQRS at the wire — command/query value objects, writes return no data, ids are client-produced

**Status:** accepted

## Decision

Every API endpoint's payload is exactly one value object: a
`<Verb><Noun>Command` for a mutation, a `<Noun>Query` for a query — nominal
classes with `static parse` (ADR 2026-015), declared in their own contract
file (ADR 2026-026), their fields **composed from the domain's existing
value objects**, never re-declared (ADR 2026-023). No positional scalars, no
anonymous option bags.

**Writes never return data.** A mutation's output is an acknowledgement
carrying no domain state; anything a caller wants to see after a write, it
asks a query for. Enforced by the `writes-return-ack` purity rule.

**Ids are client-produced.** The caller mints entity ids and sends them in
the command; the system never relies on store-generated ids.

## Why

One payload = one identity = one validator: the procedure's input type IS
the command, the command IS a value object, and the value object IS the
parser — the same one-identity discipline the rest of the harness enforces,
extended to the wire. Writes that return read models fuse the two sides
CQRS exists to separate, and made r22's mutation the widest surface in the
design. Client-minted ids are what make commands replayable and idempotency
expressible at the boundary: the command names its subject instead of asking
the store to invent one.

## Consequences

Reviewers read every exposure in one fixed vocabulary. The payload shape,
the ack-only rule, and primitive-free fields are all lintable at
contract-purity; the hostile-input behaviour of every command is covered by
generated law suites (TN-26-004). r22's delivered `ingestReport` (returns
the full building status) becomes non-conforming and is brought into line by
the first pack-era change run. Open, tracked in TN-26-004: the exact ack
shape, command-level dedupe ids, and conflict-vs-replace semantics for a
reused client-minted id.
