<!--
The TN-26-004 validation prompt (first used at Run 23): a change-request
ticket for a service layer, written the way a real ticket arrives — it NAMES
GRAPHQL, and it carries zero harness expertise. What is under test is the
whole reference set: intake must strip the "how" (ADR 2026-032, the phase
gate refuses a spec naming graphql outside its Intake section), the blessed
stack must bind as policy (ADR 2026-029 — no GraphQL interface may leak),
the scaffolder must ship the service runtime, the payloads must land as
command/query value objects with zod inside (ADR 2026-030/031), and the
write must acknowledge without returning data.

Compare against Run 22, whose prompt hand-fed the stack and the conventions:
if the reference set works, THIS prompt — the ignorant one — must land the
same structure.

Used VERBATIM so validation runs stay comparable. Do not edit without
starting a new prompt file under a new name.
-->

The ingest and rating core in this repository is live at the pilot
buildings. The web team is now building the facility-manager dashboard and
needs to call the core from outside this process.

## Change request: expose the core to the dashboard over GraphQL

1. The dashboard must be able to **submit a building's period report** — the
   same report the core ingests today, with the same guarantee: re-submitting
   the same building and period replaces the earlier report entirely, never
   appends, never double-counts.

2. The dashboard must be able to **fetch the stored status** for a building
   and period — the rated meters, the inspection queue, the overall verdict,
   exactly what the core already produces.

3. A lookup for a building and period nobody has ingested must fail in a way
   the dashboard can distinguish from an error and show to the user.

4. A malformed submission must be rejected with something the dashboard can
   act on, and must never partially apply.

Do not change what the core computes; its existing behaviour and tests must
survive untouched unless a genuine seam is missing. `npm run check` must
pass when you are done.
