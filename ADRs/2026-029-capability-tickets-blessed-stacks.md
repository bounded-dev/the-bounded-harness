# 2026-029: Tickets name capability; the harness binds the stack; intake strips the how

**Status:** accepted

## Decision

Incoming specs — from users and parent agents alike — are **capability
statements**. Intake reworks every spec into pure "what is required" language
and strips any embedded implementation choice ("over GraphQL", "as REST",
"using library X"); the architect's spec records what was stripped, so the
removal is visible. A stripped "how" that turns out to be a genuine
constraint (an existing gateway to integrate with) is a product decision and
routes to the user (TN-26-001 dispute protocol) — never silently obeyed,
never silently dropped.

The stack that satisfies a capability is **harness policy**, one blessed
choice per capability per language, pack-pinned — as vitest is *the* TS test
runner: today, tRPC for "typed access for a frontend" and zod as the schema
engine (ADR 2026-031). Three layers bind it: a pack skill triggered by
capability language (guidance, best-effort); availability — targets cannot
add dependencies and the pack pins and installs the blessed stack, so no
other is reachable; and the `blessed-stacks-only` import lint, which blocks
non-allowlisted frameworks unconditionally.

## Why

Run 22 delivered a tRPC service only because the *prompt* named the stack
and carried the expertise — knowledge that must live in the harness, since
real tickets will not carry it. And a ticket that names a stack must not
leak one in: "expose over GraphQL" is a product sentence wearing a
technology decision, and honoring the word rather than the need would let
any ticket author overrule recorded policy by phrasing.

## Consequences

The reference structure (TN-26-004) lands identically whatever words the
ticket used. Stack changes happen exactly one way: a human changes the
policy. Guidance can fail without the binding failing — the dependency
allowlist and import lint hold even when no skill loaded.
