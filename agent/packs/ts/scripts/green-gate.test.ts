import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { classifyGreen } from "./green-gate.ts";
import type { RunTestsResult } from "./run-tests.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

function vitestJson(cases: { name: string; status: string; message?: string }[]): string {
  return JSON.stringify({
    testResults: [
      {
        status: cases.some((c) => c.status === "failed") ? "failed" : "passed",
        assertionResults: cases.map((c) => ({
          fullName: c.name,
          title: c.name,
          ancestorTitles: [],
          status: c.status,
          failureMessages: c.message ? [c.message] : [],
        })),
      },
    ],
  });
}

function run(partial: Partial<RunTestsResult>): RunTestsResult {
  return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial };
}

/** A clean typecheck — the precondition every pre-#7 green implicitly assumed. */
const TYPE_CLEAN: TypecheckResult = { ok: true, errorCount: 0, diagnostics: [] };

function tsc(...diagnostics: string[]): TypecheckResult {
  return { ok: false, errorCount: diagnostics.length, diagnostics };
}

const TEST_TYPE_ERR = "tests/reading-list.test.ts(12,5): error TS2532: Object is possibly 'undefined'.";
const SRC_TYPE_ERR = "src/reading-list/reading-list.ts(4,3): error TS2345: Argument of type 'string'…";
const CONTRACT_TYPE_ERR = "src/reading-list/reading-list.contract.ts(9,1): error TS2304: Cannot find name 'Isbn'.";

// --- pure core: classifyGreen -------------------------------------------------

describe("classifyGreen", () => {
  test("all tests pass → exit 0", () => {
    const r = classifyGreen(
      run({ ok: true, total: 2, passed: 2, results: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }] }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines[0]).toMatch(/green-gate: OK — 2 passed, 2 total/);
  });

  test("any failure → exit 1, naming each failing test", () => {
    const r = classifyGreen(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "adds", status: "passed" },
          { name: "subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/1 failing test of 2/);
    expect(r.lines.join("\n")).toContain("failed: subtracts");
  });

  test("blocked suite → exit 1", () => {
    const r = classifyGreen(run({ blocked: "Error: Cannot find module [path]" }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite did not run/);
  });

  test("no tests ran → exit 1", () => {
    const r = classifyGreen(run({ total: 0 }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no tests ran/);
  });
});

// --- #7: green requires a type-clean project, not just a passing suite --------
// Dogfood Run 3 shipped "GREEN (22/22)" with two tsc errors in the test file.
// Green means both, and the gate must say which role can fix what it found.

const passing = (n: number): Partial<RunTestsResult> => ({
  ok: true,
  total: n,
  passed: n,
  results: Array.from({ length: n }, (_, i) => ({ name: `t${i}`, status: "passed" as const })),
});

describe("classifyGreen + typecheck (#7)", () => {
  test("passing suite with type errors is NOT green", () => {
    const r = classifyGreen(run(passing(22)), tsc(TEST_TYPE_ERR));
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines[0]).toMatch(/green-gate: FAIL — 1 type error/);
    expect(r.lines[0]).toMatch(/suite passes/);
  });

  test("type errors confined to tests\/** route to the test-writer", () => {
    const r = classifyGreen(run(passing(22)), tsc(TEST_TYPE_ERR, TEST_TYPE_ERR));
    expect(r.lines).toContain("green-gate: route → test-writer");
    expect(r.lines.join("\n")).toContain("  test-writer (2):");
    expect(r.lines.join("\n")).toContain(TEST_TYPE_ERR);
    expect(r.detail).toMatchObject({ route: "test-writer", typeErrors: 2 });
  });

  test("type errors in src/** route to the builder", () => {
    const r = classifyGreen(run(passing(3)), tsc(SRC_TYPE_ERR));
    expect(r.lines).toContain("green-gate: route → builder");
  });

  test("failing tests plus upstream type errors route upstream, and report both", () => {
    const r = classifyGreen(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "adds", status: "passed" },
          { name: "subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
      tsc(CONTRACT_TYPE_ERR),
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/1 failing test of 2/);
    expect(r.lines.join("\n")).toContain("failed: subtracts");
    expect(r.lines.join("\n")).toContain("  typecheck: 1 type error");
    expect(r.lines).toContain("green-gate: route → architect");
  });

  test("failing tests with a type-clean project still route to the builder", () => {
    const r = classifyGreen(
      run({ total: 1, failed: 1, results: [{ name: "x", status: "failed", message: "AssertionError" }] }),
      TYPE_CLEAN,
    );
    expect(r.lines).toContain("green-gate: route → builder");
  });

  test("a blocked suite routes to the test-writer (dispute protocol BLOCKED)", () => {
    const r = classifyGreen(run({ blocked: "Error: Cannot find module [path]" }), TYPE_CLEAN);
    expect(r.lines).toContain("green-gate: route → test-writer");
  });

  test("green states that the project is type-clean, so the claim is auditable", () => {
    const r = classifyGreen(run(passing(22)), TYPE_CLEAN);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/22 passed, 22 total, typecheck clean/);
    expect(r.detail).toMatchObject({ typeErrors: 0 });
  });
});

// --- CLI (fixture-repo) -------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "green-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixtureRepo(prefix: string, runJson: string, tscOutput = ""): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "run.json"), runJson);
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  return dir;
}

function runGate(dir: string, typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_GATE_TEST_CMD: "cat",
      PI_GATE_TEST_ARGS: JSON.stringify(["run.json"]),
      // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
      PI_GATE_TSC_CMD: "sh",
      PI_GATE_TSC_ARGS: JSON.stringify(["-c", `cat tsc.txt; exit ${typeErrors ? 2 : 0}`]),
    },
  });
}

describe("green-gate CLI (fixture repos)", () => {
  test("green target → exit 0 and a logged pass", () => {
    const dir = fixtureRepo(
      "green-ok-",
      vitestJson([{ name: "create order", status: "passed" }, { name: "cancel order", status: "passed" }]),
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/green-gate: OK — 2 passed, 2 total/);
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "green-gate", verdict: "pass" });
  });

  test("failing target → exit 1, names the failure, logs a block", () => {
    const dir = fixtureRepo(
      "green-fail-",
      vitestJson([
        { name: "create order", status: "passed" },
        { name: "cancel order", status: "failed", message: "AssertionError: expected 'open' to be 'cancelled'" },
      ]),
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/1 failing test of 2/);
    expect(r.stdout).toContain("failed: cancel order");
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "green-gate", verdict: "block" });
  });

  test("passing suite + test-file type errors → exit 1, routed, logged as a block (#7)", () => {
    const dir = fixtureRepo(
      "green-falsegreen-",
      vitestJson([{ name: "adds a book", status: "passed" }, { name: "lists books", status: "passed" }]),
      `${TEST_TYPE_ERR}\nFound 1 error in tests/reading-list.test.ts:12\n`,
    );
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/green-gate: FAIL — 1 type error/);
    expect(r.stdout).toContain("green-gate: route → test-writer");
    expect(readGuardLog(dir)[0]).toMatchObject({
      guard: "green-gate",
      verdict: "block",
      detail: { route: "test-writer", typeErrors: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// The escape hatch: a test that keeps failing may itself be the defect
// ---------------------------------------------------------------------------

// Dogfood Run 6 deadlocked here. The last failing test read `invoices[1]` where
// it needed `invoices[2]` — it had copied the index from a sibling test with no
// renewal step, so the array was one shorter. The implementation was correct.
//
// Every component behaved exactly as specified, and the loop still could not
// escape: the green gate routed by its rule (a failing test means the code is
// wrong), the architect obeyed the route as the skill instructs, and the
// builder cannot fix a test it is blind to. It respawned the builder and hit
// the identical failure.
//
// The rule is right in the common case and unrecoverable in this one, and
// nothing could tell the two apart. So the FIRST block routes to the builder as
// before, and a REPEAT of the same failing set routes to the test-writer. Same
// reasoning as the run_tests non-convergence nudge: repetition is the evidence,
// and no model judgement is involved.

import { routeAfterRepeat } from "./green-gate.ts";

describe("repeated identical failures reroute to the test-writer", () => {
  const A = ["changePlan proration after renewal"];
  const B = ["cancel is idempotent"];

  test("a first failure routes to the builder", () => {
    expect(routeAfterRepeat(A, [])).toBe("builder");
  });

  test("a different failure than last time still routes to the builder", () => {
    expect(routeAfterRepeat(A, [B])).toBe("builder");
  });

  test("the same failing set twice routes to the test-writer", () => {
    expect(routeAfterRepeat(A, [A])).toBe("test-writer");
  });

  test("order within the failing set does not matter", () => {
    expect(routeAfterRepeat(["a", "b"], [["b", "a"]])).toBe("test-writer");
  });

  test("an intervening different failure resets the evidence", () => {
    // Progress happened, so the builder is not stuck against the same wall.
    expect(routeAfterRepeat(A, [A, B])).toBe("builder");
  });

  test("an empty failing set never reroutes", () => {
    expect(routeAfterRepeat([], [[]])).toBe("builder");
  });
});
