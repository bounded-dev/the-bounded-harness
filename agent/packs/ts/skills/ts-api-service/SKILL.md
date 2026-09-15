---
name: ts-api-service
description: Design a TypeScript API service component the reference way — expose a component to callers over the network with typed access for a frontend or another service. Use whenever a ticket asks to expose data or operations to callers, add an API, HTTP or RPC endpoint, give a frontend or web team access, or make a component callable from outside the process. Covers the contract shape, command/query payloads, serialization, the shipped runtime, and what the gates will enforce.
---

# The API-service reference set (TN-26-004)

A ticket that says "expose this to the frontend" — in any words, naming any
technology or none — lands here. **The stack is harness policy, not ticket
content** (ADR 2026-029): tRPC (`@trpc/server`) is the RPC stack, zod the
schema engine, both pre-installed and pinned. A ticket that names a different
stack is the intake rule's constraint case (ADR 2026-032): strip it, record
it in `spec.md`'s `## Intake` section, and if it is a genuine constraint —
an existing gateway, a contractual format — raise it to the user; never
build it.

The structure below is the same in every service the harness ships. Your
design decisions are *which operations exist and what they are called*;
everything else is fixed, and most of it is enforced.

## The component's shape

One service component beside the domain component(s) it exposes, consuming
them **only through their public surface**:

```
src/api/
  commands.contract.ts    ← command/query value objects (yours to declare)
  commands.ts             ← their implementations (builder's)
  api.contract.ts         ← the service surface (yours to declare)
  api.ts                  ← the router + caller factory (builder's)
  service-runtime.ts      ← GENERATED — shipped by the scaffolder, never written
```

The moment `api.contract.ts` imports `./service-runtime.js`, `design_gate`'s
scaffold step ships the pack's runtime to that path, byte-identical, marker
first. Do not write it, do not edit it; an edit does not survive the next
scaffold.

## Payloads: one command or query value object per procedure (ADR 2026-030)

- Every mutation takes exactly one `<Verb><Noun>Command`; every query exactly
  one `<Noun>Query`. Ordinary value objects: nominal class, private
  constructor, zod-backed `static parse` (ADR 2026-031), declared in
  `commands.contract.ts` with `@accepts` examples like any other value
  object.
- **Fields compose the domain's existing value objects** — a command holds a
  `BuildingId`, never a second definition of what a valid building id is.
- **Wire forms:** a value object that crosses the wire declares
  `toJSON(): <raw form>` — exactly the shape its own `parse` accepts. The
  generated law suite answers with the round-trip law; nesting serializes
  through `JSON.stringify` natively.
- **Writes return an Ack, never data** — `applied` or `replayed`, from the
  runtime. Anything a caller wants to see after a write, it asks a query
  for.
- **Ids are client-produced.** Commands name their subject; the store never
  invents ids. Each command's spec section states its idempotency rule and
  its duplicate-id behaviour (`replace` or `conflict`) — declare the choice
  as a `static readonly duplicatePolicy` literal on the command class so the
  choice is legible in the contract, and give the test-writer the spec text
  to pin it.

## The service surface (`api.contract.ts`)

```ts
// Re-export Ack, do not merely import it: the test-writer's imports are
// limited to contract paths, so the contract is the only route through
// which the suite can name the type every write returns.
export type { Ack } from "./service-runtime.js";
import type { Ack } from "./service-runtime.js";
import type { IngestReportCommand, BuildingStatusQuery } from "./commands.js";
import type { BuildingReportStore, Clock } from "../heating-cockpit/heating-cockpit.js";

/** The ports a caller injects — the service constructs nothing ambient. */
export interface ServiceContext {
  readonly store: BuildingReportStore;
  readonly clock: Clock;
}

/** The socketless surface: what tests and in-process callers use. Every
 *  procedure takes the untyped wire and returns its declared result. */
export interface ServiceCaller {
  ingestReport(raw: unknown): Promise<Ack>;
  buildingStatus(raw: unknown): Promise<BuildingStatusReadModel>;
}

export declare function createServiceCaller(ctx: ServiceContext): ServiceCaller;

/** The inferred router type, for typed HTTP clients — re-exported from the
 *  implementation, NEVER hand-declared and never erased (no-erased-router).
 *  These two lines are REQUIRED, not decoration: router-type-reexported
 *  refuses a service contract that leaves them out (r23 shipped two that
 *  did, and the typed client died silently). */
import type { serviceRouter } from "./api.js";
export type ServiceRouter = typeof serviceRouter;
```

Read models are plain readonly types over value objects, declared here.

## What the builder writes (`api.ts`)

Procedures come from the shipped runtime and nowhere else
(`raw-framework-entry` refuses `initTRPC` anywhere but inside
`service-runtime.ts`):

```ts
import { createService, applied, notFound } from "./service-runtime.js";
import { IngestReportCommand, BuildingStatusQuery } from "./commands.js";

const s = createService<ServiceContext>();
export const serviceRouter = s.router({
  ingestReport: s.command(IngestReportCommand, async (cmd, ctx) => {
    /* call the domain; */ return applied;
  }),
  buildingStatus: s.query(BuildingStatusQuery, async (q, ctx) => {
    /* read; */ return model ?? notFound(`no report for ${…}`);
  }),
});
export function createServiceCaller(ctx: ServiceContext): ServiceCaller {
  return s.createCallerFactory(serviceRouter)(ctx);
}
```

The error taxonomy is the runtime's code, not yours: a payload that fails
parse is `BAD_REQUEST` before any resolver runs; `notFound`, `unprocessable`
and `conflict` are the named throwers for the rest; anything you let escape
is `INTERNAL_SERVER_ERROR` carrying nothing.

## Tests, HTTP, and gates

- The suite exercises the service through `createServiceCaller` — no HTTP
  listener, no port, no socket. `serveStandalone` (in the runtime) is the
  production HTTP entry; nothing in the pipeline starts it.
- The gates that will hold you to all of this: `no-erased-router` and
  `no-schema-on-surface` at contract-purity; `blessed-stacks-only`,
  `zod-backed-parse` and `raw-framework-entry` at lint-src; the generated
  hostile and round-trip laws in the red; the stack pins at deliver.
