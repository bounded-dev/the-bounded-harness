import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  classifyRed,
  collectRedGateSources,
  isNotImplementedFailure,
  materializePristineProject,
  redGateProjectPlan,
} from "./red-gate.ts";
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

const CONTRACT = `export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly code: string;
  static parse(raw: unknown): Currency | undefined;
}
`;

// --- CLI (fixture-repo): real subprocess, real exit codes, real guard log -----

const SCRIPT = join(import.meta.dirname, "red-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A target project whose "test suite" is `cat run.json` (canned vitest JSON),
 *  wired via the PI_GATE_TEST_CMD seam so no real vitest install is needed.
 *
 *  The repo also carries a real contract and a real test file, because the gate
 *  now builds a PRISTINE project before running anything and a project with no
 *  contracts (or no tests) cannot produce a valid red at all. The canned files
 *  are addressed absolutely, since the suite runs in the pristine copy rather
 *  than here. */
function fixtureRepo(prefix: string, runJson: string, file = "run.json", tscOutput = ""): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(join(dir, file), runJson);
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "src", "money", "money.contract.ts"), "export declare function create(): void;\n");
  writeFileSync(join(dir, "tests", "money.test.ts"), "// canned\n");
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  return dir;
}

function runGate(dir: string, file = "run.json", typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_GATE_TEST_CMD: "cat",
      PI_GATE_TEST_ARGS: JSON.stringify([join(dir, file)]),
      // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
      PI_GATE_TSC_CMD: "sh",
      PI_GATE_TSC_ARGS: JSON.stringify(["-c", `cat ${join(dir, "tsc.txt")}; exit ${typeErrors ? 2 : 0}`]),
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

// ---------------------------------------------------------------------------
// Red against a regenerated skeleton — so the builder need not wait
// ---------------------------------------------------------------------------

// The red gate asserts every failure is NotImplementedError, which is only
// measurable against an UNIMPLEMENTED skeleton. That is the sole reason BUILD
// had to wait for the red gate: once the builder writes code, the window shuts.
//
// But that constraint is an artifact of running the gate against the LIVE tree.
// `scaffold` is deterministic and the contracts are checksum-frozen, so the
// pristine skeleton can be reproduced at any moment. Run the suite against a
// regenerated copy and the verdict is valid no matter what the builder has done
// to the real src/ — which lets the test-writer and builder work in parallel and
// turns the critical path from sum() into max().
//
// Blindness is untouched: regenerating a skeleton needs the contracts, never
// the tests.

describe("redGateProjectPlan", () => {
  test("takes the tests and contracts, and regenerates the implementation", () => {
    const plan = redGateProjectPlan({
      contracts: ["src/money.contract.ts", "src/plan.contract.ts"],
      testFiles: ["tests/money.test.ts"],
      configFiles: ["package.json", "tsconfig.json"],
    });
    // Copied verbatim: the contracts are the shared interface, the tests are
    // what we are validating, and the config decides how they run.
    expect(plan.copy).toContain("src/money.contract.ts");
    expect(plan.copy).toContain("tests/money.test.ts");
    expect(plan.copy).toContain("package.json");
    expect(plan.copy).toContain("tsconfig.json");
    // Regenerated, never copied — copying it is exactly the bug this avoids.
    expect(plan.regenerate).toEqual(["src/money.contract.ts", "src/plan.contract.ts"]);
  });

  test("never copies implementation files", () => {
    const plan = redGateProjectPlan({
      contracts: ["src/money.contract.ts"],
      testFiles: ["tests/money.test.ts"],
      configFiles: ["package.json"],
      // A builder working in parallel has already written these.
      implementationFiles: ["src/money.ts", "src/subscription.ts", "src/shared/errors.ts"],
    });
    expect(plan.copy).not.toContain("src/money.ts");
    expect(plan.copy).not.toContain("src/subscription.ts");
    // The shared errors module is machine-generated by the scaffolder too.
    expect(plan.copy).not.toContain("src/shared/errors.ts");
  });

  test("a project with no tests cannot produce a valid red", () => {
    expect(() =>
      redGateProjectPlan({ contracts: ["src/x.contract.ts"], testFiles: [], configFiles: [] }),
    ).toThrow(/no tests/i);
  });

  test("a project with no contracts cannot regenerate anything", () => {
    expect(() =>
      redGateProjectPlan({ contracts: [], testFiles: ["tests/x.test.ts"], configFiles: [] }),
    ).toThrow(/no contract/i);
  });
});

// --- The pristine project (the plan, materialized) --------------------------------
//
// The point of these: the red verdict must not depend on what the builder has
// done to the live src/. Everything below builds a tree in which the builder has
// ALREADY written a full implementation, and asserts the gate's project is
// untouched by it.

function liveTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-red-live-"));
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  mkdirSync(join(dir, "tests", "generated"), { recursive: true });
  writeFileSync(join(dir, "src", "money", "money.contract.ts"), CONTRACT);
  // The builder, working in parallel, has already finished.
  writeFileSync(join(dir, "src", "money", "money.ts"), "export class Currency { static parse() { return undefined; } }\n");
  writeFileSync(join(dir, "src", "shared", "errors.ts".replace("errors.ts", "")) + "errors.ts", "// stale\n");
  writeFileSync(join(dir, "tests", "money.test.ts"), "// test\n");
  writeFileSync(join(dir, "tests", "generated", "money.laws.test.ts"), "// generated laws\n");
  writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  return dir;
}

describe("collectRedGateSources", () => {
  const dir = liveTree();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("separates contracts from the implementation the builder wrote", () => {
    const sources = collectRedGateSources(dir);
    expect(sources.contracts).toEqual(["src/money/money.contract.ts"]);
    expect(sources.implementationFiles).toContain("src/money/money.ts");
    expect(sources.implementationFiles).not.toContain("src/money/money.contract.ts");
  });

  test("takes the generated law suite as well as the hand-written tests", () => {
    const sources = collectRedGateSources(dir);
    expect(sources.testFiles).toContain("tests/money.test.ts");
    expect(sources.testFiles).toContain("tests/generated/money.laws.test.ts");
  });

  test("takes only the config files that exist", () => {
    const sources = collectRedGateSources(dir);
    expect(sources.configFiles).toEqual(["package.json", "tsconfig.json"]);
  });
});

describe("materializePristineProject", () => {
  const live = liveTree();
  const pristine = materializePristineProject(live, redGateProjectPlan(collectRedGateSources(live)));
  afterAll(() => {
    rmSync(live, { recursive: true, force: true });
    rmSync(pristine, { recursive: true, force: true });
  });

  test("regenerates the skeleton instead of copying the implementation", () => {
    const skeleton = readFileSync(join(pristine, "src", "money", "money.ts"), "utf8");
    expect(skeleton).toContain("GENERATED from money.contract.ts");
    expect(skeleton).toContain('throw new NotImplementedError("Currency.parse")');
    // The builder's real implementation must not have reached the copy: it is
    // what turns NotImplemented failures into ordinary assertion failures.
    expect(skeleton).not.toContain("static parse() { return undefined; }");
  });

  test("regenerates the shared errors module rather than trusting the live one", () => {
    const errors = readFileSync(join(pristine, "src", "shared", "errors.ts"), "utf8");
    expect(errors).toContain("class NotImplementedError");
    expect(errors).not.toContain("stale");
  });

  test("carries the tests and the config across verbatim", () => {
    expect(readFileSync(join(pristine, "tests", "money.test.ts"), "utf8")).toContain("// test");
    expect(readFileSync(join(pristine, "tests", "generated", "money.laws.test.ts"), "utf8")).toContain("laws");
    expect(existsSync(join(pristine, "package.json"))).toBe(true);
    expect(existsSync(join(pristine, "tsconfig.json"))).toBe(true);
  });

  test("leaves the live tree alone", () => {
    // The gate must never write into the project it is judging.
    expect(readFileSync(join(live, "src", "money", "money.ts"), "utf8")).toContain("static parse() { return undefined; }");
  });
});

// --- Obligations: a valid red that covers nothing ---------------------------------
//
// Dogfood Run 7's suite was a right-reason red, type-clean, 32 tests — and it
// never called 9 of the contract's 15 exports. Both checks below would have
// blocked it, at the one moment when fixing it costs the test-writer 30 seconds.

function obligationsRepo(prefix: string, testSource: string, failures: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, "run.json"),
    vitestJson(failures.map((f, i) => ({ name: `t${i}`, status: "failed", message: `NotImplementedError: ${f}` }))),
  );
  writeFileSync(join(dir, "tsc.txt"), "");
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "src", "money", "money.contract.ts"),
    CONTRACT + "\nexport declare function formatMoney(c: Currency): string;\n",
  );
  writeFileSync(join(dir, "tests", "money.test.ts"), testSource);
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  return dir;
}

const BOUNDARIES_BLOCK = `import { describe, it, expect } from "vitest";
import { Currency } from "../src/money/money.js";
describe("Currency ${"\u2014"} boundaries", () => {
  it("accepts a well-formed code", () => { expect(Currency.parse("USD")).toBeDefined(); });
  it("rejects lowercase", () => { expect(Currency.parse("usd")).toBeUndefined(); });
  it("rejects two letters", () => { expect(Currency.parse("US")).toBeUndefined(); });
});
`;

describe("red-gate CLI: obligations", () => {
  test("an export no failure names is an export no test called", () => {
    // Currency is reached through its member; formatMoney is never called.
    // (Reachability is per EXPORT: a member throw discharges its owner.)
    const dir = obligationsRepo("red-unreached-", BOUNDARIES_BLOCK, ["Currency.parse"]);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/the red is valid but incomplete/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("a value object with no boundaries block blocks the red", () => {
    const dir = obligationsRepo("red-noboundaries-", "// nothing\n", ["Currency.parse", "formatMoney"]);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Currency/);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("one rejection is not two — the floor is two distinct wrong-value literals", () => {
    const oneRejection = BOUNDARIES_BLOCK.replace(
      '  it("rejects two letters", () => { expect(Currency.parse("US")).toBeUndefined(); });\n',
      "",
    );
    const dir = obligationsRepo("red-onereject-", oneRejection, ["Currency.parse", "formatMoney"]);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("red-gate: route → test-writer");
  });

  test("everything reached and the boundaries discharged → the red stands", () => {
    const dir = obligationsRepo("red-obliged-", BOUNDARIES_BLOCK, ["Currency.parse", "formatMoney"]);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/red-gate: OK/);
  });
});
