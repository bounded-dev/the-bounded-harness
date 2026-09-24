# 2026-045: Ticket-numbered Technical Notes in target projects

**Status:** accepted

## Decision

Target projects use a flat `docs/tn/` collection. A ticket may have one TN,
named `TN-<issue-number>.md`; a TN requires an existing ticket. The note keeps
its identity as it moves from exploration to agreed design. Its front matter
names the issue, lifecycle status, and contract paths owned by that ticket.
The TypeScript design gates use the active ticket's TN and owned contracts for
review, freeze, drift checks, and handoff. A ticket publishing a design for a
dependent ticket needs a frozen TN. Other tickets need no TN unless they use
the design stage. Existing projects without the TN convention retain their
root `spec.md` behavior until they adopt it.

## Why

Issue state, assignment, and cross-team coordination work in the issue tracker.
The reasoning and contracts need a reviewable Git revision. Issue numbers give
TN identity without reservations or a folder hierarchy that follows a product
structure likely to change. Explicit ownership prevents unrelated ticket
contracts from entering one freeze.

## Consequences

The active issue number is supplied to the stage as `BOUNDED_TICKET`; missing
or conflicting ownership blocks ticket design gates. A changed TN or owned
contract needs a new freeze and handoff. Superseded notes retain links to their
successors. Migrating this harness's existing year-numbered TNs and deciding
whether ADRs move under `docs/` are tracked separately.
