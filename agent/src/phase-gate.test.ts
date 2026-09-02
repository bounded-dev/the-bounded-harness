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
