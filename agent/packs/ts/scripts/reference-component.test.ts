// The gate-verified reference component (TN-26-008).
//
// packs/ts/reference/ is a complete, copyable worked example in a neutral domain
// (an append-only log of temperature readings). Its whole value is that it is
// built through the REAL gates on every `npm run check`: an example the gates
// keep green can never demonstrate a shape the gates would reject, so the
// example and the enforcement cannot drift. This file is that wiring.
//
// The cheap, read-only checks (purity, surface, the red gate's coverage
// obligations, the generated-laws golden) run in-process against the committed
// reference. The three that need a running project — the red gate, the green
// gate and mutation — run against a throwaway copy with node_modules symlinked
// from the harness, exactly as the other gate-CLI tests build their fixtures.
//
// If a gate legitimately cannot apply to a static reference, that is stated
// rather than worked around: there is none here — the reference is a real
// project, so every gate applies to it as it would to any dogfood arm.

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { lintContractSource } from "./contract-purity.ts";
import { checkProjectSurfaces } from "./surface-check.ts";
import {
  calledNames,
  checkBoundaryBlocks,
  declaredExports,
  readAllTests,
  readContracts,
  readHandWrittenTests,
  unreachedExports,
  valueObjectClasses,
} from "./test-obligations.ts";
import { lawsPathFor, valueObjectLawsSource } from "./value-object-laws.ts";
import { runMutationScore, type SuiteOutcome, type SuiteRunner } from "./mutation-score.ts";

const REFERENCE_DIR = join(import.meta.dirname, "..", "reference");
const HARNESS_MODULES = join(import.meta.dirname, "..", "..", "..", "node_modules");
const REAL_VITEST = join(HARNESS_MODULES, ".bin", "vitest");
const REAL_TSC = join(HARNESS_MODULES, ".bin", "tsc");

/** The project's suite as the gates run it: vitest, JSON reporter, and the
 *  `.bounded/**` exclusion the harness always carries (red leaves a shadow
 *  project there whose copied tests would otherwise be collected). */
const SUITE_ARGS = ["run", "--reporter=json", "--exclude=**/.bounded/**"];

const VALUE_OBJECT_CONTRACTS = [
  "src/readings/reading-id.contract.ts",
  "src/readings/celsius.contract.ts",
] as const;
const ALL_CONTRACTS = [...VALUE_OBJECT_CONTRACTS, "src/readings/readings.contract.ts"] as const;

// --- in-process checks against the committed reference (read-only) ------------

describe("the reference passes contract-purity", () => {
  for (const rel of ALL_CONTRACTS) {
    test(rel, async () => {
      const problems = await lintContractSource(readFileSync(join(REFERENCE_DIR, rel), "utf8"), rel);
      expect(problems).toEqual([]);
    });
  }
});

test("the reference passes surface-check", () => {
  const run = checkProjectSurfaces(REFERENCE_DIR);
  expect(run.lines.join("\n")).toMatch(/surface-check: OK/);
  expect(run.code).toBe(0);
});

test("the reference discharges the red gate's coverage obligations", () => {
  const contracts = readContracts(REFERENCE_DIR);
  // Boundaries: every value object has its `<Name> — boundaries` block with an
  // accepted literal and at least two distinct base-typed rejections.
  const boundaries = checkBoundaryBlocks(valueObjectClasses(contracts), readHandWrittenTests(REFERENCE_DIR));
  expect(boundaries).toEqual([]);
  // Reachability: every declared value export is called by some test.
  const reached = new Set(calledNames(readAllTests(REFERENCE_DIR)));
  const unreached = unreachedExports(declaredExports(contracts), reached);
  expect(unreached).toEqual([]);
});

test("the committed generated laws are exactly what the generator emits today", () => {
  for (const rel of VALUE_OBJECT_CONTRACTS) {
    const regenerated = valueObjectLawsSource(readFileSync(join(REFERENCE_DIR, rel), "utf8"), rel);
    const committed = readFileSync(join(REFERENCE_DIR, lawsPathFor(rel)), "utf8");
    expect(committed, `${lawsPathFor(rel)} is stale — re-run value-object-laws.ts`).toBe(regenerated);
  }
});

// --- the running-project gates against a throwaway copy -----------------------

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh, isolated copy of the reference with node_modules symlinked from the
 *  harness — the same fixture shape red-gate.test.ts and the others use. The
 *  gates write into `.bounded/` and mutation edits src/ in place, so each heavy
 *  test gets its own copy rather than dirtying the committed tree. */
function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-reference-"));
  tmpDirs.push(dir);
  cpSync(REFERENCE_DIR, dir, {
    recursive: true,
    filter: (src) => !/[\\/](?:node_modules|\.bounded|\.vite|\.git)(?:[\\/]|$)/.test(src),
  });
  symlinkSync(HARNESS_MODULES, join(dir, "node_modules"), "dir");
  return dir;
}

function runGate(script: string, dir: string) {
  return spawnSync(process.execPath, [join(import.meta.dirname, script), dir], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNDED_GATE_TEST_CMD: REAL_VITEST,
      BOUNDED_GATE_TEST_ARGS: JSON.stringify(SUITE_ARGS),
      BOUNDED_GATE_TSC_CMD: REAL_TSC,
      BOUNDED_GATE_TSC_ARGS: JSON.stringify(["--noEmit", "--pretty", "false"]),
    },
  });
}

describe("the reference is built through the real red and green gates", () => {
  test(
    "red gate → a valid red against a regenerated skeleton; green gate → delivered",
    () => {
      const dir = freshCopy();

      // Red runs against a shadow project it regenerates from the contracts and
      // tests: every failure is a NotImplementedError, the project typechecks,
      // and the coverage obligations are discharged.
      const red = runGate("red-gate.ts", dir);
      expect(red.stdout + red.stderr).toMatch(/red-gate: OK/);
      expect(red.status).toBe(0);

      // Green runs against the delivered implementation in the same tree, so it
      // reads the red pass red just logged: suite green, typecheck clean,
      // surface matches, no escape hatches, no surviving skeleton.
      const green = runGate("green-gate.ts", dir);
      expect(green.stdout + green.stderr).toMatch(/green-gate: OK/);
      expect(green.status).toBe(0);
    },
    120_000,
  );
});

test(
  "the reference's suite kills every mutant (no survivors)",
  async () => {
    const dir = freshCopy();
    const runSuite: SuiteRunner = async (cwd, timeoutMs): Promise<SuiteOutcome> => {
      const r = spawnSync(REAL_VITEST, SUITE_ARGS, { cwd, encoding: "utf8", timeout: timeoutMs, env: process.env });
      return r.status === 0 ? { ok: true, note: "green" } : { ok: false, note: `exit ${r.status ?? "signal"}` };
    };
    const result = await runMutationScore(dir, { runSuite });
    expect(result.code).toBe(0);
    expect(result.sites).toBeGreaterThan(0);
    expect(result.survived, result.lines.join("\n")).toBe(0);
  },
  120_000,
);
