---
number: TN-26-005
title: Pack composition — sockets in the core, contributions from packs
kind: design
status: draft
issue: (pending)
---

# Pack composition

The harness will be huge: many packs, and at **project initiation** the
harness is composed into the simplest form that project needs. Most packs
sit installed but uncomposed for any given project, so the architecture rule
is:

**The core owns mechanisms (sockets); packs own content (contributions).
Nothing in the core names a technology, and no pack depends on another
implicitly — only declared pack→pack dependencies exist (ts-api depends on
ts; nothing depends on ts-api by accident).**

## The socket kinds (all already exist as mechanisms)

| socket (core) | contribution (pack) | example today |
|---|---|---|
| phase gate's spec noun-check | denylist entries | tRPC pack contributes graphql, apollo, ajv, … |
| contract-purity / lint-src gates | ESLint rules | `no-erased-router`, `zod-backed-parse` (correctly pack-homed already) |
| scaffolder sync | emitted artifacts keyed on contract content | `service-runtime.ts` shipped on import |
| law generator | generated test families | round-trip law on `toJSON` |
| deliver | dependency pins keyed on tree content | zod / @trpc/server pins |
| skill loading | skills with ask-shaped triggers | `ts-api-service` |

## The violation this note fixes

The spec tech-noun denylist was hard-coded in `agent/src/phase-gate.ts` —
core code naming graphql and fastify. It moves to a **pack contribution
file** (`packs/<pack>/contrib.json`), and the core merges the contributions
of installed packs at evidence-gathering time. A project composed without
the ts pack gets no TS-flavoured nouns; the mechanism (Intake section +
nouns-outside-Intake refusal, ADR 2026-032) stays core and content-free.

## Rules going forward

- A pack adds capability **only** through the sockets above; a pack that
  needs a new socket kind proposes it as core work first (its own ADR).
- Cross-pack references in core guidance (the developer-stage skill naming
  `ts-api-service`) are tolerated while packs are few; the composed form of
  this is skills contributed with routing triggers, so the core skill names
  no pack. Revisit when a second language pack exists.
- Composition-at-initiation (choosing which installed packs a project
  composes, and materializing only their pins/skills/rules) is future work —
  today every installed pack is active. The contribution mechanism is
  designed so that switch is a filter over contributions, not a rewrite.

## Open questions

- The contribution manifest's schema and versioning (one `contrib.json` per
  pack today; typed and validated when a second pack lands).
- Whether ESLint rule *registration* should also flow through contrib.json
  (today the ts pack's gates import the ts plugin directly — legal, since
  gate and plugin are the same pack).
- Project-initiation UX: where the "compose these packs" record lives
  (`.pi/settings.json` is the natural home).
