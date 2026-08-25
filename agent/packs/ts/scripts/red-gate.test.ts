import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { classifyRed, isNotImplementedFailure } from "./red-gate.ts";
import type { RunTestsResult } from "./run-tests.ts";
import type { TypecheckResult } from "./typecheck.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

// --- vitest-JSON fixture builders --------------------------------------------

interface Case {
  name: string;
  status: string;
  message?: string;
}

/** Minimal `vitest --reporter=json` document with one test file. */
function vitestJson(cases: Case[]): string {
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

/** A vitest doc where a whole file failed to collect (import error): no
 *  per-test assertions, a file-level failure message. */
function importErrorJson(message: string): string {
  return JSON.stringify({
    testResults: [{ status: "failed", assertionResults: [], message }],
  });
}

const NI = "NotImplementedError: NotImplemented: create\n    at /tmp/proj/src/orders.ts:5:11";

// --- pure core: classifyRed ---------------------------------------------------

function run(partial: Partial<RunTestsResult>): RunTestsResult {
  return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial };
}

/** A clean typecheck: the TEST phase's other precondition (#7). */
const TYPE_CLEAN: TypecheckResult = { ok: true, errorCount: 0, diagnostics: [] };

function tsc(...diagnostics: string[]): TypecheckResult {
  return { ok: false, errorCount: diagnostics.length, diagnostics };
}

const TEST_TYPE_ERR = "tests/orders.test.ts(12,5): error TS2532: Object is possibly 'undefined'.";
const CONTRACT_TYPE_ERR = "src/orders/orders.contract.ts(9,1): error TS2304: Cannot find name 'Isbn'.";

describe("isNotImplementedFailure", () => {
  test("matches a NotImplementedError message by name", () => {
    expect(isNotImplementedFailure("NotImplementedError: NotImplemented: foo")).toBe(true);
  });
  test("rejects an ordinary assertion failure", () => {
    expect(isNotImplementedFailure("AssertionError: expected 1 to be 2")).toBe(false);
    expect(isNotImplementedFailure(undefined)).toBe(false);
  });
});

describe("classifyRed", () => {
  test("valid red: every failure is NotImplemented → exit 0", () => {
    const r = classifyRed(
      run({
        total: 2,
        failed: 2,
        results: [
          { name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" },
          { name: "b", status: "failed", message: "NotImplementedError: NotImplemented: b" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines[0]).toMatch(/red-gate: OK — 2 NotImplemented failures/);
  });

  test("valid red tolerates some passing tests alongside NotImplemented failures", () => {
    const r = classifyRed(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "a", status: "passed" },
          { name: "b", status: "failed", message: "NotImplementedError: NotImplemented: b" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
  });

  test("wrong-reason red: an ordinary assertion failure → exit 1, named", () => {
    const r = classifyRed(
      run({
        total: 2,
        failed: 2,
        results: [
          { name: "impl pending", status: "failed", message: "NotImplementedError: NotImplemented: a" },
          { name: "math is wrong", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/wrong-reason red/);
    expect(r.lines.join("\n")).toContain("wrong-reason: math is wrong — AssertionError: expected 1 to be 2");
    expect(r.lines.join("\n")).not.toContain("impl pending");
  });

  test("blocked suite (import/config error) → exit 1", () => {
    const r = classifyRed(run({ blocked: "Error: Cannot find module [path]" }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite did not run/);
  });

  test("fully-passing suite at red phase → exit 1", () => {
    const r = classifyRed(
      run({ total: 2, passed: 2, results: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }] }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite fully passes/);
  });

  test("no tests ran → exit 1", () => {
    const r = classifyRed(run({ total: 0 }), TYPE_CLEAN);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no tests ran/);
  });

  // --- #7: catch test-file type errors at TEST, not at the false green -------
  // Run 3's two tsc errors sat in tests/** through the whole BUILD phase; the
  // builder is blind to tests/** and can never fix them. Reject red here.

  test("a valid red with type errors is still rejected", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" }],
      }),
      tsc(TEST_TYPE_ERR),
    );
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines[0]).toMatch(/red-gate: FAIL — 1 type error/);
    expect(r.lines[0]).toMatch(/red is valid but the project is not type-clean/);
    expect(r.lines).toContain("red-gate: route → test-writer");
    expect(r.detail).toMatchObject({ route: "test-writer", typeErrors: 1 });
  });

  test("a contract type error at TEST routes upstream to the architect", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" }],
      }),
      tsc(CONTRACT_TYPE_ERR, TEST_TYPE_ERR),
    );
    expect(r.lines).toContain("red-gate: route → architect");
    expect(r.lines.join("\n")).toContain("  typecheck: 2 type errors");
  });

  test("a wrong-reason red reports both problems and routes to the test-writer", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "math", status: "failed", message: "AssertionError: expected 1 to be 2" }],
      }),
      tsc(TEST_TYPE_ERR),
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/wrong-reason red/);
    expect(r.lines.join("\n")).toContain("  typecheck: 1 type error");
    expect(r.lines).toContain("red-gate: route → test-writer");
  });

  test("valid red on a type-clean project says so, so the pass is auditable", () => {
    const r = classifyRed(
      run({
        total: 1,
        failed: 1,
        results: [{ name: "a", status: "failed", message: "NotImplementedError: NotImplemented: a" }],
      }),
      TYPE_CLEAN,
    );
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/typecheck clean/);
  });
});

// --- CLI (fixture-repo): real subprocess, real exit codes, real guard log -----

const SCRIPT = join(import.meta.dirname, "red-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A target project whose "test suite" is `cat run.json` (canned vitest JSON),
 *  wired via the PI_GATE_TEST_CMD seam so no real vitest install is needed. */
function fixtureRepo(prefix: string, runJson: string, file = "run.json", tscOutput = ""): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(join(dir, file), runJson);
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  return dir;
}

function runGate(dir: string, file = "run.json", typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_GATE_TEST_CMD: "cat",
      PI_GATE_TEST_ARGS: JSON.stringify([file]),
      // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
      PI_GATE_TSC_CMD: "sh",
      PI_GATE_TSC_ARGS: JSON.stringify(["-c", `cat tsc.txt; exit ${typeErrors ? 2 : 0}`]),
    },
  });
}

describe("red-gate CLI (fixture repos)", () => {
  test("NotImplemented-red target → exit 0 and a logged pass", () => {
    const dir = fixtureRepo("red-ni-", vitestJson([{ name: "create order", status: "failed", message: NI }]));
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/red-gate: OK — 1 NotImplemented failure/);
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "red-gate", verdict: "pass" });
  });

  test("wrong-reason red (import error) → exit 1 and a logged block", () => {
    const dir = fixtureRepo(
      "red-import-",
      importErrorJson("Error: Cannot find module './missing' imported from /tmp/proj/tests/orders.test.ts"),
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/wrong-reason red/);
    const ev = readGuardLog(dir)[0];
    expect(ev).toMatchObject({ guard: "red-gate", verdict: "block" });
    expect(ev.summary).toMatch(/wrong-reason/);
  });

  test("fully-green target at red phase → exit 1", () => {
    const dir = fixtureRepo("red-green-", vitestJson([{ name: "already done", status: "passed" }]));
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/suite fully passes/);
  });

  test("unparseable suite output (BLOCKED) → exit 1", () => {
    const dir = fixtureRepo("red-blocked-", "not a vitest json report", "garbage.json");
    const r = runGate(dir, "garbage.json");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/suite did not run/);
  });

  test("valid red but type-dirty → exit 1, routed, logged as a block (#7)", () => {
    const dir = fixtureRepo(
      "red-typedirty-",
      vitestJson([{ name: "create order", status: "failed", message: NI }]),
      "run.json",
      `${TEST_TYPE_ERR}\nFound 1 error in tests/orders.test.ts:12\n`,
    );
    const r = runGate(dir, "run.json", true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/red-gate: FAIL — 1 type error/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
    expect(readGuardLog(dir)[0]).toMatchObject({
      guard: "red-gate",
      verdict: "block",
      detail: { route: "test-writer", typeErrors: 1 },
    });
  });
});
