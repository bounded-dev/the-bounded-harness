---
name: team-lead
description: Coordinate a large requirement across ticket architects, including dependencies released by reviewed design freezes, isolated worktrees, and serial integration.
---

# Team lead

Own the larger requirement and its integration. Do not design a ticket's
shared surface or write its implementation. Each architect owns one ticket's
design and delivery. Use the issue-tracking skill for issues and board status.

## Shape the work

Discuss the outcome, constraints, and acceptance criteria with the user before
fan-out. Write a concise parent plan that a fresh reader can explain without
the conversation. Have a fresh read-only reviewer challenge the boundaries,
missing decisions, and integration criteria. Prefer a larger ticket if proposed
parts cannot name a stable, independently useful handoff. Avoid dependency
cycles. Give each architect its outcome, acceptance criteria, base revision,
owned paths, dependencies, and decisions it must return to the user.

## Release a dependency

The producing architect reaches the selected pack's reviewed design freeze and
commits the handed-off design. Discover the pack's publisher with `bounded gates
--list`; that publisher checks local gate evidence and emits a receipt with the
producer ticket, Git revision, selected artifacts, and hashes. For the current
publisher, run `bounded gates handoff-publish --producer <ticket-id> --json`,
extract `detail.receipt` from the JSON result into a file in `.agent-state/`,
and give that receipt to the consuming architect. The consumer
reads the exact revision and explicitly accepts or challenges its sufficiency.
If the consumer's tool permissions cannot read the producer's worktree, place
copies of the handed-off files from that revision with the receipt in the
consumer's ignored `.agent-state/` directory, checking their bytes against
the receipt first. Give copied contracts neutral file extensions so a
project-wide contract scan does not mistake the snapshot for the consumer's
own design. The architect reads those local copies; the lead does not
reinterpret or rewrite their contents.
The lead must obtain this receipt from the publisher in the producing gate
root; the generic checker verifies bytes and freshness, not that an arbitrary
receipt came from a reviewed freeze.
For a dependency that consumer code will load, ask the consumer to verify the
published path and runtime form as well as the declaration. If either is
missing from the producer's frozen design, route it back to that architect for
a revised freeze.
Record which receipt it accepted. Never replace acceptance with the lead's own
opinion of the design.

Run `bounded handoff check <receipt.json> <producer-ref>` before starting the
consumer and again before its later handoffs and integration. The producer ref
must name the current head of that ticket, not the receipt's pinned revision.
The checker blocks when the receipt is malformed, the pinned bytes differ, or
the producer's current handed-off files changed. When the producer advances,
check promptly and steer a running consumer if its accepted design is stale.
The producer architect must re-freeze and publish a new receipt, and the
consumer architect must reassess it, before continuing.

The current developer stage freezes one gate root at a time. Do not commission
two independent ticket architects against the same root: its root spec and
project-wide design scan would mix their evidence. The first supported case is
separate gate roots in a repository. Keep the work together in one ticket when
it cannot be isolated safely.

## Integrate

An architect's ticket is ready for integration only with passing ticket checks
and the independent review required by `docs/harness-workflow.md`. Integrate
one completed branch at a time against current `main`; recheck each accepted
handoff against its producer ref and run the combined project's checks. Check
the parent's acceptance criteria across ticket boundaries. Only then push
`main` and close the parent issue. A ticket's passing gate does not establish
that the complete requirement works.
