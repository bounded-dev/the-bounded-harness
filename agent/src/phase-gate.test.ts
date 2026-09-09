import { describe, expect, test } from "vitest";
import {
  checkSpawnPrecondition,
  checkSubagentCall,
  detectMultiSpawn,
  type PhaseEvidence,
} from "./phase-gate.ts";
import { PIPELINE_ROLES } from "./path-gate.ts";
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

const spawned = (role: string): LoggedGuardEvent =>
  ({
    ts: "2026-09-02T00:00:00.000Z",
    guard: "phase-gate",
    verdict: "pass",
    summary: `commissioned ${role}`,
    detail: { kind: "spawn", target: role },
  }) as LoggedGuardEvent;

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
    // The remedy names the composite, not a retired `scaffold` tool — but it
    // still says which STEP is missing, because that is what was skipped.
    if (!d.allow) expect(d.reason).toContain("design_gate");
    if (!d.allow) expect(d.reason).toContain("scaffold step");
  });

  test("is refused when the contract was never frozen", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [ev("contract-purity", "pass"), ev("scaffold", "pass")],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("design_gate");
    if (!d.allow) expect(d.reason).toContain("freeze step");
  });
});

// The builder waits on the FREEZE, not on the red (ADR 2026-021).
//
// red_gate proves red in a shadow project it rebuilds itself — contracts,
// regenerated skeletons, a copy of the tests tree — so it never reads the live
// `src/` and a builder working at the same time cannot contaminate the proof.
// green_gate then requires the standing red to match the current tests-tree
// hash, so a red that no longer describes the suite is void whether or not the
// builder waited for it. Serializing the two workers was buying an ordering the
// hashes already guarantee, and it cost a whole phase of wall clock.
describe("spawning the builder", () => {
  test("is allowed immediately after the freeze, with no red anywhere in the log", () => {
    expect(READY.events.some((e) => e.guard === "red-gate")).toBe(false);
    expect(checkSpawnPrecondition("builder", READY).allow).toBe(true);
  });

  test("is not held back by a red that FAILED", () => {
    // The red belongs to the tests, and the tests are the test-writer's problem
    // to fix; it says nothing about whether the implementation may start.
    const d = checkSpawnPrecondition("builder", {
      ...READY,
      events: [...READY.events, ev("red-gate", "block", "3 wrong-reason failures")],
    });
    expect(d.allow).toBe(true);
  });

  test("no refusal mentions the red gate any more", () => {
    for (const evidence of [READY, { ...READY, specBytes: 0 }, { ...READY, contracts: [] }]) {
      const d = checkSpawnPrecondition("builder", evidence);
      if (!d.allow) expect(d.reason).not.toMatch(/red_gate|red gate/);
    }
  });

  test("still requires everything the test-writer required", () => {
    expect(checkSpawnPrecondition("builder", { ...READY, specBytes: 0 }).allow).toBe(false);
    expect(checkSpawnPrecondition("builder", { ...READY, contracts: [] }).allow).toBe(false);
    expect(
      checkSpawnPrecondition("builder", { ...READY, events: [ev("contract-purity", "pass")] }).allow,
    ).toBe(false);
  });
});

describe("the two workers run in parallel", () => {
  test("both are commissionable from the same evidence, in either order", () => {
    expect(checkSpawnPrecondition("test-writer", READY).allow).toBe(true);
    expect(checkSpawnPrecondition("builder", READY).allow).toBe(true);
  });

  test("commissioning one does not gate the other", () => {
    const afterTestWriter: PhaseEvidence = {
      ...READY,
      events: [...READY.events, spawned("test-writer")],
    };
    expect(checkSpawnPrecondition("builder", afterTestWriter).allow).toBe(true);

    const afterBuilder: PhaseEvidence = { ...READY, events: [...READY.events, spawned("builder")] };
    expect(checkSpawnPrecondition("test-writer", afterBuilder).allow).toBe(true);
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
    const events = [...READY.events, spawned("test-writer")];
    expect(checkSpawnPrecondition("builder", { ...READY, events }).allow).toBe(true);
  });

  test("the refusal names the token cost, so it reads as a reason not a rule", () => {
    const d = checkSpawnPrecondition("test-writer", {
      ...READY,
      events: [...READY.events, spawned("test-writer")],
    });
    if (!d.allow) expect(d.reason).toMatch(/re-?prime|context|token/i);
  });
});

// ---------------------------------------------------------------------------
// The spawn FORM: multi-spawn scripts, and the unbound writer.
// ---------------------------------------------------------------------------
//
// Runs r13 and r14, twice each: the architect wrapped both workers in a
// pi-subagents `workflowScript` (`runs.all([...])`). The gate saw one subagent
// call carrying a string, found no `agent` field, and let it through — so the
// builder ran with nothing above checked and no model tier injected. Twice more
// it reached for `delegate`, the general write-capable worker, which carries no
// role binding and therefore no write zone.
//
// Both are refused by SHAPE. That is the only check available here: a gate
// cannot follow a script it never watches run, and it cannot bind a role to a
// child it never sees named.

const EMPTY: PhaseEvidence = { contracts: [], specBytes: 0, events: [] };

describe("detectMultiSpawn (pure)", () => {
  test("a plain one-child spawn is not a multi-spawn form", () => {
    expect(detectMultiSpawn({ agent: "test-writer", task: "write the tests" })).toBeUndefined();
  });

  test("finds the roles a workflowScript names", () => {
    const form = detectMultiSpawn({
      workflowScript:
        'return runs.all([{key:"t", agent:"test-writer", task:"…"}, {key:"b", agent:"builder", task:"…"}])',
    });
    expect(form).toEqual({ field: "workflowScript", roles: ["test-writer", "builder"] });
  });

  test("finds the roles a parallel item array names", () => {
    const form = detectMultiSpawn({
      parallel: [{ agent: "builder", task: "implement" }, { agent: "scout", task: "look" }],
    });
    expect(form).toEqual({ field: "parallel", roles: ["builder"] });
  });

  test("finds the roles a chain item array names", () => {
    const form = detectMultiSpawn({ chain: [{ agent: "architect", task: "design" }] });
    expect(form).toEqual({ field: "chain", roles: ["architect"] });
  });

  test("a fan-out of non-pipeline agents names no role", () => {
    const form = detectMultiSpawn({
      workflowScript: 'return runs.all([{key:"a", agent:"scout"}, {key:"b", agent:"product-expert"}])',
    });
    expect(form).toEqual({ field: "workflowScript", roles: [] });
  });

  test("matching is on word boundaries, so a longer word is not a role", () => {
    const form = detectMultiSpawn({ workflowScript: 'runs.all([{agent:"rebuilders"}])' });
    expect(form?.roles).toEqual([]);
  });

  test("an empty script or empty array is not a spawn at all", () => {
    expect(detectMultiSpawn({ workflowScript: "   " })).toBeUndefined();
    expect(detectMultiSpawn({ parallel: [] })).toBeUndefined();
  });

  // The names must be the same list the path gate binds roles from, or the
  // refusal would miss exactly the role that has no gate wired for it.
  test("the role names are the pipeline roles", () => {
    for (const role of PIPELINE_ROLES) {
      expect(detectMultiSpawn({ workflowScript: `agent:"${role}"` })?.roles).toEqual([role]);
    }
  });
});

describe("a multi-spawn form naming a pipeline role is refused", () => {
  const script = {
    workflowScript:
      'return runs.all([{key:"tw", agent:"test-writer", task:"…"}, {key:"b", agent:"builder", task:"…"}])',
  };

  test("before the freeze", () => {
    const v = checkSubagentCall(script, EMPTY);
    expect(v.kind).toBe("block");
  });

  // The point of the rule: it is not a phase check that a later phase satisfies.
  test("and after the freeze, when every precondition is met", () => {
    const v = checkSubagentCall(script, READY);
    expect(v.kind).toBe("block");
  });

  test("the refusal names the form, the roles, and the plain form to use instead", () => {
    const v = checkSubagentCall(script, READY);
    if (v.kind !== "block") throw new Error("expected a block");
    expect(v.reason).toContain("workflowScript");
    expect(v.reason).toContain("test-writer");
    expect(v.reason).toContain("builder");
    expect(v.reason).toMatch(/one at a time|one call per role/);
  });

  // Both reasons have to be in the message: an architect told only "not here"
  // learns a rule, and an architect told WHY learns the shape of the system.
  test("the refusal says the gate cannot see inside, and the tier cannot reach in", () => {
    const v = checkSubagentCall(script, READY);
    if (v.kind !== "block") throw new Error("expected a block");
    expect(v.reason).toMatch(/precondition per child/);
    expect(v.reason).toMatch(/model-tier|model tier/);
  });

  test("a chain or parallel array naming a role is refused the same way", () => {
    for (const input of [
      { chain: [{ agent: "architect" }, { agent: "builder" }] },
      { parallel: [{ agent: "test-writer" }] },
    ]) {
      expect(checkSubagentCall(input, READY).kind).toBe("block");
    }
  });
});

describe("a multi-spawn form naming no pipeline role passes, and is recorded", () => {
  test("legit background fan-out is allowed", () => {
    const v = checkSubagentCall(
      { workflowScript: 'return runs.all([{key:"a", agent:"scout", task:"survey"}])' },
      READY,
    );
    expect(v.kind).toBe("allow-multi");
    if (v.kind === "allow-multi") expect(v.form.field).toBe("workflowScript");
  });

  test("it is allowed before the freeze too — it is not a pipeline transition", () => {
    expect(checkSubagentCall({ workflowScript: 'runs.run("a", {agent:"scout"})' }, EMPTY).kind).toBe(
      "allow-multi",
    );
  });
});

describe("delegate: no unbound writer inside the pipeline", () => {
  test("is refused however complete the design is", () => {
    for (const evidence of [EMPTY, READY]) {
      const v = checkSubagentCall({ agent: "delegate", task: "tidy up" }, evidence);
      expect(v.kind).toBe("block");
    }
  });

  test("the refusal says why, and routes the work to the role that owns it", () => {
    const v = checkSubagentCall({ agent: "delegate", task: "tidy up" }, READY);
    if (v.kind !== "block") throw new Error("expected a block");
    expect(v.reason).toContain("delegate holds no role binding");
    expect(v.reason).toContain("design_gate");
    expect(v.reason).toContain("builder");
    expect(v.reason).toContain("test-writer");
  });

  test("the read-only helpers stay commissionable", () => {
    for (const agent of ["scout", "product-expert"]) {
      expect(checkSubagentCall({ agent }, EMPTY)).toEqual({ kind: "allow", target: agent });
    }
  });

  test("the reviewer stays freely commissionable — it reads the design before the freeze", () => {
    expect(checkSubagentCall({ agent: "reviewer" }, EMPTY)).toEqual({
      kind: "allow",
      target: "reviewer",
    });
  });
});

describe("checkSubagentCall: the non-launch actions", () => {
  test("children.list is recorded, not judged", () => {
    expect(checkSubagentCall({ action: "children.list" }, EMPTY)).toEqual({
      kind: "children-listed",
    });
  });

  // A blocked architect must still be able to inspect and steer what it started.
  test.each(["status", "resume", "steer", "interrupt", "wait"])("%s passes through", (action) => {
    expect(checkSubagentCall({ action, id: "run-1" }, EMPTY)).toEqual({ kind: "ignore" });
  });

  test("a launch that names no agent is nothing to decide about", () => {
    expect(checkSubagentCall({ action: "launch" }, EMPTY)).toEqual({ kind: "ignore" });
  });

  test("a worker launch still carries its preconditions", () => {
    expect(checkSubagentCall({ agent: "builder", task: "…" }, EMPTY).kind).toBe("block");
    expect(checkSubagentCall({ agent: "builder", task: "…" }, READY)).toEqual({
      kind: "allow",
      target: "builder",
    });
  });
});
