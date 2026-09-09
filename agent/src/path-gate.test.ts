import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { logGuardEvent, readGuardLog } from "./guard-log.ts";
import { asRole, evaluatePathGate, PIPELINE_ROLES } from "./path-gate.ts";

// TN-26-001 Phase 2: the path-gate's testable core — event + role + cwd →
// {block,reason} | undefined, including the guard-log side effect on a block.
// Wiring over the already-tested decide(); we assert the DECISION and the LOG.

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "path-gate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("asRole — only the pipeline roles are recognized", () => {
  test.each(PIPELINE_ROLES)("accepts %s", (role) => {
    expect(asRole(role)).toBe(role);
  });
  test.each([undefined, null, "", "orchestrator", "ARCHITECT", "delegate", 42, {}])(
    "rejects %s → undefined (gate inactive)",
    (value) => {
      expect(asRole(value)).toBeUndefined();
    },
  );
});

describe("gate is inactive without a pipeline role (normal/orchestrator sessions)", () => {
  test.each([undefined, null, "", "orchestrator", "delegate"])(
    "role %s → undefined and writes no log",
    (role) => {
      const cwd = tmp();
      const result = evaluatePathGate({
        role,
        toolName: "write",
        input: { path: "anywhere.ts" },
        cwd,
      });
      expect(result).toBeUndefined();
      expect(readGuardLog(cwd)).toEqual([]);
    },
  );
});

// Representative allowed + blocked call per role. `allowed` must pass through
// (undefined, no log); `blocked` must return a reason AND leave one path-gate
// block entry in the target project's guard log.
type Case = {
  role: (typeof PIPELINE_ROLES)[number];
  allowed: { tool: string; path: string };
  blocked: { tool: string; path: string };
};

const CASES: Case[] = [
  {
    role: "architect",
    allowed: { tool: "write", path: "src/orders/orders.contract.ts" },
    blocked: { tool: "write", path: "src/orders/orders.ts" }, // implementation, not contract
  },
  {
    role: "test-writer",
    allowed: { tool: "write", path: "tests/orders.test.ts" },
    blocked: { tool: "read", path: "src/orders/orders.ts" }, // blind to src/
  },
  {
    role: "builder",
    allowed: { tool: "write", path: "src/orders/orders.ts" },
    blocked: { tool: "read", path: "tests/orders.test.ts" }, // blind to tests/
  },
  {
    role: "reviewer",
    allowed: { tool: "read", path: "src/orders/orders.contract.ts" }, // the design under review
    blocked: { tool: "write", path: "spec.md" }, // not even the file it is reviewing
  },
];

describe.each(CASES)("$role", ({ role, allowed, blocked }) => {
  test(`allows ${allowed.tool} ${allowed.path} → undefined, no log`, () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role,
      toolName: allowed.tool,
      input: { path: allowed.path },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(readGuardLog(cwd)).toEqual([]);
  });

  test(`blocks ${blocked.tool} ${blocked.path} → reason + path-gate log entry`, () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role,
      toolName: blocked.tool,
      input: { path: blocked.path },
      cwd,
    });
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("path-gate");
    expect(result!.reason).toContain(role);

    const events = readGuardLog(cwd);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.guard).toBe("path-gate");
    expect(event.verdict).toBe("block");
    expect(event.summary).toBe(result!.reason);
    expect(event.detail).toMatchObject({
      role,
      tool: blocked.tool,
      path: blocked.path,
    });
  });
});

describe("forbidden tools (bash/subagent) block for a pipeline role and are logged", () => {
  test("builder may not use bash", () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role: "builder",
      toolName: "bash",
      input: { command: "ls tests/" },
      cwd,
    });
    expect(result?.block).toBe(true);
    const events = readGuardLog(cwd);
    expect(events).toHaveLength(1);
    expect(events[0].guard).toBe("path-gate");
    expect(events[0].detail).toMatchObject({ role: "builder", tool: "bash" });
  });
});

describe("ungated tools pass through untouched", () => {
  test("a non-path, non-forbidden tool → undefined, no log", () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "web_search",
      input: { query: "anything" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(readGuardLog(cwd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Commissioning: the wiring around checkSubagentCall.
// ---------------------------------------------------------------------------
//
// The decision lives in phase-gate.ts and is tested there. What is tested here
// is the half a pure core may not do: writing what happened to the target
// project's guard log, so a run that jammed — or one that quietly fanned out —
// is inspectable afterwards.

/** Evidence of a completed design, written into the project the gate reads. */
function readyProject(): string {
  const cwd = tmp();
  writeFileSync(join(cwd, "spec.md"), "x".repeat(4000));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "money.contract.ts"), "export type Money = number;\n");
  for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
    logGuardEvent(cwd, { guard, verdict: "pass", summary: "step passed" });
  }
  return cwd;
}

const phaseEvents = (cwd: string) => readGuardLog(cwd).filter((e) => e.guard === "phase-gate");

describe("commissioning a worker", () => {
  test("the builder is allowed straight after the freeze, with no red, and is recorded", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "builder", task: "implement the contract" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "pass",
      summary: "commissioned builder",
      detail: { kind: "spawn", target: "builder" },
    });
  });

  test("both workers may be live at once", () => {
    const cwd = readyProject();
    for (const agent of ["test-writer", "builder"]) {
      expect(
        evaluatePathGate({ role: "architect", toolName: "subagent", input: { agent }, cwd }),
      ).toBeUndefined();
    }
    expect(phaseEvents(cwd).map((e) => e.summary)).toEqual([
      "commissioned test-writer",
      "commissioned builder",
    ]);
  });

  test("an unmet precondition blocks and is logged as a phase-gate refusal", () => {
    const cwd = tmp(); // nothing designed at all
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "test-writer" },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", role: "architect", target: "test-writer" },
    });
  });
});

describe("multi-spawn forms", () => {
  test("a workflowScript naming a worker is blocked and logged with the form", () => {
    const cwd = readyProject(); // fully designed: the refusal is about the SHAPE
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: {
        workflowScript:
          'return runs.all([{key:"tw", agent:"test-writer"}, {key:"b", agent:"builder"}])',
      },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(result!.reason).toContain("workflowScript");
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", form: "workflowScript", roles: ["test-writer", "builder"] },
    });
  });

  test("a fan-out of non-pipeline agents passes through and logs one pass", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { workflowScript: 'return runs.all([{key:"a", agent:"scout", task:"survey"}])' },
      cwd,
    });
    expect(result).toBeUndefined();
    const events = phaseEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verdict: "pass",
      summary: "workflowScript fan-out (no pipeline role)",
      detail: { kind: "fan-out", role: "architect", form: "workflowScript" },
    });
  });
});

describe("delegate is refused inside the pipeline only", () => {
  test("a bound role may not spawn it", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "subagent",
      input: { agent: "delegate", task: "clean up the generated files" },
      cwd,
    });
    expect(result?.block).toBe(true);
    expect(result!.reason).toContain("delegate holds no role binding");
    expect(phaseEvents(cwd).at(-1)).toMatchObject({
      verdict: "block",
      detail: { kind: "spawn-refused", target: "delegate" },
    });
  });

  test("an unbound session spawns it freely — the gate is inactive there", () => {
    const cwd = readyProject();
    const result = evaluatePathGate({
      role: undefined,
      toolName: "subagent",
      input: { agent: "delegate", task: "clean up the generated files" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(phaseEvents(cwd)).toEqual([]);
  });
});
