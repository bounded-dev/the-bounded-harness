import { describe, expect, test } from "vitest";
import { checkSpawnPrecondition, type PhaseEvidence } from "./phase-gate.ts";
import type { LoggedGuardEvent } from "./guard-log.ts";

// WHY THIS EXISTS
//
// Every gate so far checks an ARTIFACT — is this contract pure, is this red the
// right red. Nothing checked the SEQUENCE, so the architect could simply not
// reach a step and no machinery would notice. Across three consecutive dogfood
// attempts on the same prompt it froze the contracts with no `spec.md` every
// single time, and only wrote one afterwards because it happened to.
//
// That matters more than a missing file: the spec is the half of the interface
// types cannot hold — execution order, the exact rounding tie-break, identity
// guarantees. A test-writer handed 38 typed operations and no spec can pin
// signatures and nothing else, which is precisely the class of test the bare
// arm already writes. The harness's whole advantage lives in that document.
//
// So the transition itself becomes deterministic: spawning a worker is a tool
// call, the path gate already sees every tool call, and a spawn whose
// preconditions are unmet is refused. Not "the skill says do this first" —
// there is no way to skip it.

const ev = (guard: string, verdict: LoggedGuardEvent["verdict"], summary = ""): LoggedGuardEvent =>
  ({ ts: "2026-09-02T00:00:00.000Z", guard, verdict, summary }) as LoggedGuardEvent;

/** Evidence for a design that has correctly completed every DESIGN step. */
const READY: PhaseEvidence = {
  contracts: ["src/money.contract.ts"],
  specBytes: 4000,
  events: [
    ev("contract-purity", "pass"),
    ev("scaffold", "pass"),
    ev("checksum-gate", "pass", "wrote manifest (1 contract file)"),
  ],
};

describe("spawning the test-writer", () => {
  test("is allowed once DESIGN is genuinely complete", () => {
    expect(checkSpawnPrecondition("test-writer", READY).allow).toBe(true);
  });

  // The three-for-three failure.
  test("is refused when there is no spec", () => {
    const d = checkSpawnPrecondition("test-writer", { ...READY, specBytes: 0 });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("spec.md");
      // The message must say WHY, or it reads as bureaucracy and gets worked around.
      expect(d.reason).toMatch(/order|round|identity|types cannot/i);
    }
  });

  test("is refused when the spec is a stub rather than a document", () => {
    // An empty-file check is trivially satisfied by `touch spec.md`. The spec
    // carries arithmetic and ordering; a handful of bytes cannot.
    const d = checkSpawnPrecondition("test-writer", { ...READY, specBytes: 40 });
    expect(d.allow).toBe(false);
  });

  test("is refused when no contract exists at all", () => {
    const d = checkSpawnPrecondition("test-writer", { ...READY, contracts: [] });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("contract");
  });

  test("is refused when contract-purity has not passed", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [ev("scaffold", "pass"), ev("checksum-gate", "pass", "wrote manifest")],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("contract_purity");
  });

  test("is refused when the LATEST contract-purity verdict is a block", () => {
    // A pass followed by a block means the contract was revised and broken.
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [...READY.events, ev("contract-purity", "block", "2 problems in 1 file")],
    });
    expect(d.allow).toBe(false);
  });

  test("is refused when the skeletons were never generated", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [ev("contract-purity", "pass"), ev("checksum-gate", "pass", "wrote manifest")],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("scaffold");
  });

  test("is refused when the contract was never frozen", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [ev("contract-purity", "pass"), ev("scaffold", "pass")],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("freeze_contracts");
  });
});

describe("spawning the builder", () => {
  const RED_PASSED: PhaseEvidence = {
    ...READY,
    events: [...READY.events, ev("red-gate", "pass", "38 NotImplemented failures, 0 passes")],
  };

  test("is allowed once the red gate has passed", () => {
    expect(checkSpawnPrecondition("builder", RED_PASSED).allow).toBe(true);
  });

  // Building against tests that were never validated is building blind: a
  // wrong-reason red means the suite is not actually exercising the contract.
  test("is refused before the red gate has passed", () => {
    const d = checkSpawnPrecondition("builder", READY);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("red_gate");
  });

  test("is refused when the latest red-gate verdict is a block", () => {
    const d = checkSpawnPrecondition("builder", {
      ...RED_PASSED,
      events: [...RED_PASSED.events, ev("red-gate", "block", "3 wrong-reason failures")],
    });
    expect(d.allow).toBe(false);
  });

  test("still requires everything the test-writer required", () => {
    expect(checkSpawnPrecondition("builder", { ...RED_PASSED, specBytes: 0 }).allow).toBe(false);
  });
});

describe("spawns the gate does not govern", () => {
  // `scout` is read-only investigation during DESIGN — gating it would forbid
  // the very research the architect needs before it can write a contract.
  test("a read-only helper is never blocked", () => {
    const empty: PhaseEvidence = { contracts: [], specBytes: 0, events: [] };
    expect(checkSpawnPrecondition("scout", empty).allow).toBe(true);
    expect(checkSpawnPrecondition("product-expert", empty).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One spawn per role. Bounces resume; they do not start over.
// ---------------------------------------------------------------------------

// Run 6 used FIVE workers for three roles. Every bounce was a cold respawn, and
// each one re-primed a full context: 1.75M cache-read tokens for the first
// builder, 649k and 603k for two test-writer respawns, 362k for the second
// builder. Roughly 1.6M tokens spent re-teaching agents what they already knew,
// about a quarter of the run's spend.
//
// pi retains completed children and can continue one:
//   { action: "children.list" }                        → run ids + resumable state
//   { action: "resume", id: "<run-id>", message: "…" } → continue that child
//
// So a cold launch of a role that has already run is refused. The architect
// must consult `children.list` first — which is itself a subagent call, so the
// gate can see that it happened. Consulting and then launching cold is allowed:
// that is the legitimate case where the retained child was not resumable. What
// is refused is respawning WITHOUT looking.
//
// Deadlock-free by construction, and it needs no knowledge of pi's internal
// state: the evidence is the architect's own tool calls.

const spawned = (role: string): LoggedGuardEvent =>
  ({
    ts: "2026-09-02T00:00:00.000Z",
    guard: "phase-gate",
    verdict: "pass",
    summary: `commissioned ${role}`,
    detail: { kind: "spawn", target: role },
  }) as LoggedGuardEvent;

const listedChildren = (): LoggedGuardEvent =>
  ({
    ts: "2026-09-02T00:00:00.000Z",
    guard: "phase-gate",
    verdict: "pass",
    summary: "children.list",
    detail: { kind: "children-listed" },
  }) as LoggedGuardEvent;

describe("cold respawn", () => {
  test("the first spawn of a role is allowed", () => {
    expect(checkSpawnPrecondition("test-writer", READY).allow).toBe(true);
  });

  test("a second cold spawn of the same role is refused", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [...READY.events, spawned("test-writer")],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("children.list");
      expect(d.reason).toContain("resume");
    }
  });

  test("consulting children.list first permits a cold spawn", () => {
    // The legitimate fallback: it looked, and the retained child was not
    // resumable. Refusing here would deadlock the loop.
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [...READY.events, spawned("test-writer"), listedChildren()],
    });
    expect(d.allow).toBe(true);
  });

  test("a children.list from BEFORE the last spawn does not count", () => {
    // Otherwise one early listing would license every later respawn.
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [...READY.events, listedChildren(), spawned("test-writer")],
    });
    expect(d.allow).toBe(false);
  });

  test("spawning a DIFFERENT role is unaffected by another role's history", () => {
    const withRed = [
      ...READY.events,
      ev("red-gate", "pass", "38 NotImplemented failures"),
      spawned("test-writer"),
    ];
    expect(checkSpawnPrecondition("builder", { ...READY, events: withRed }).allow).toBe(true);
  });

  test("the refusal names the token cost, so it reads as a reason not a rule", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [...READY.events, spawned("test-writer")],
    });
    if (!d.allow) expect(d.reason).toMatch(/re-?prime|context|token/i);
  });
});
