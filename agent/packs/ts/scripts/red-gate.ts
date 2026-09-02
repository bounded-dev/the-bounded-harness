// red gate (TN-26-001, TEST → BUILD boundary, §"Test-runner gates").
//
//   node red-gate.ts [targetDir]
//
// Runs the target project's vitest suite (JSON reporter, via the shared
// run_tests suite runner) AND `tsc --noEmit`, and asserts a VALID red: the
// project TYPECHECKS, the suite RUNS, at least
// one test fails, and EVERY failure is a NotImplementedError. Red only proves
// something if someone checks WHY it went red (see TN-26-001 Appendix,
// Böckeler). Wrong-reason red — import errors, config errors, type/runtime
// errors, ordinary assertion failures — is REJECTED, naming the offending
// test. A fully-passing suite at the red phase is ALSO a fail: nothing is
// waiting to be built.
//
// RED ALSO REQUIRES A TYPE-CLEAN PROJECT (issue #7). In Run 3 two type errors
// in a test file survived the whole TEST phase and only surfaced after a
// (false) green — by which point the only role that could fix them, the
// test-writer, had long been handed off. tests/** type errors are the
// test-writer's to fix and this is the last gate where that is cheap, so
// catch them here and print one greppable `route → <role>` line.
//
// Exit 0 valid red · 1 invalid red (one greppable line each) · 2 misuse
// (target unrunnable / bad invocation). Logs one guard event to the target's
// .pi/guard-log.jsonl.
//
// The suite and tsc commands are injectable for testing via PI_GATE_TEST_CMD /
// PI_GATE_TEST_ARGS and PI_GATE_TSC_CMD / PI_GATE_TSC_ARGS (JSON arrays);
// defaults are `npx vitest run --reporter=json` and `npx tsc --noEmit`.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runTests, type RunTestsOptions, type RunTestsResult } from "./run-tests.ts";
import { typecheck, type TypecheckOptions, type TypecheckResult } from "./typecheck.ts";
import { mostUpstream, routeTypecheck, typecheckLines } from "./typecheck-routing.ts";
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";

const GUARD = "red-gate";

// Name-based detection: the scaffolder's skeletons throw NotImplementedError
// (shared errors module), so a valid-red failure message starts with that
// class name. The sanitizer keeps the error-name line while dropping stacks,
// code frames, and paths, so the name survives to here.
const NOT_IMPLEMENTED = /(^|\n)\s*NotImplementedError\b/;

export function isNotImplementedFailure(message: string | undefined): boolean {
  return message !== undefined && NOT_IMPLEMENTED.test(message);
}

export interface GateResult {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  /** Greppable output lines (first line is the verdict headline). */
  readonly lines: string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

function firstLine(message: string | undefined): string {
  return message && message.trim() !== "" ? message.split("\n")[0] : "(no failure message)";
}

/** The suite half of the red verdict. Pure: no I/O, no logging. */
function classifySuite(run: RunTestsResult): GateResult {
  // The suite could not even produce a report (import/config error, crash):
  // that is a wrong-reason red — the suite is broken, not pending.
  if (run.blocked !== undefined) {
    return {
      code: 1,
      verdict: "block",
      summary: "wrong-reason red: suite did not run",
      lines: [
        "red-gate: FAIL — suite did not run; red must fail BECAUSE NotImplemented, not because the suite is broken",
        ...run.blocked.split("\n").map((l) => `  ${l}`),
      ],
      detail: { reason: "blocked", blocked: run.blocked },
    };
  }
  // No tests executed: a red phase needs failing tests.
  if (run.total === 0) {
    return {
      code: 1,
      verdict: "block",
      summary: "no tests ran",
      lines: ["red-gate: FAIL — no tests ran; a red phase needs failing tests (silence is not success)"],
      detail: { reason: "no-tests" },
    };
  }
  // Fully passing at red is a fail: nothing is waiting to be built.
  if (run.failed === 0) {
    return {
      code: 1,
      verdict: "block",
      summary: "suite fully passes at red phase",
      lines: [
        `red-gate: FAIL — suite fully passes (${run.passed}/${run.total}); red phase expects NotImplemented failures`,
      ],
      detail: { reason: "fully-green", passed: run.passed, total: run.total },
    };
  }
  // Every failure must be a NotImplementedError.
  const offenders = run.results.filter((r) => r.status === "failed" && !isNotImplementedFailure(r.message));
  if (offenders.length > 0) {
    return {
      code: 1,
      verdict: "block",
      summary: `${offenders.length} wrong-reason failure${offenders.length === 1 ? "" : "s"}`,
      lines: [
        `red-gate: FAIL — ${offenders.length} failure${offenders.length === 1 ? "" : "s"} not caused by NotImplementedError (wrong-reason red)`,
        ...offenders.map((o) => `  wrong-reason: ${o.name} — ${firstLine(o.message)}`),
      ],
      detail: {
        reason: "wrong-reason",
        offenders: offenders.map((o) => ({ name: o.name, message: firstLine(o.message) })),
      },
    };
  }
  return {
    code: 0,
    verdict: "pass",
    summary: `RED OK (${run.failed} NotImplemented failure${run.failed === 1 ? "" : "s"}, ${run.passed} passed)`,
    lines: [
      `red-gate: OK — ${run.failed} NotImplemented failure${run.failed === 1 ? "" : "s"}, ${run.passed} passed, ${run.total} total`,
    ],
    detail: { failed: run.failed, passed: run.passed, total: run.total },
  };
}

/**
 * Classify a run against the red-gate contract. Pure: no I/O, no logging.
 * A valid red requires BOTH a right-reason red suite and a type-clean
 * project (#7). Every red-phase failure is the test-writer's to fix unless a
 * type error points further upstream (a broken contract is the architect's).
 */
export function classifyRed(run: RunTestsResult, tsc: TypecheckResult): GateResult {
  const suite = classifySuite(run);
  const types = routeTypecheck(tsc.diagnostics);

  if (types.errorCount === 0) {
    return suite.code === 0
      ? { ...suite, lines: [`${suite.lines[0]}, typecheck clean`, ...suite.lines.slice(1)] }
      : { ...suite, lines: [...suite.lines, "red-gate: route → test-writer"], detail: { ...suite.detail, route: "test-writer" } };
  }

  const plural = types.errorCount === 1 ? "" : "s";
  const headline =
    suite.code === 0
      ? [`red-gate: FAIL — ${types.errorCount} type error${plural}; red is valid but the project is not type-clean`]
      : suite.lines;
  // The test-writer owns anything wrong at TEST; a type error may point further up.
  const route = mostUpstream(["test-writer", ...types.owners]);
  const summary = suite.code === 0 ? `${types.errorCount} type error${plural}` : `${suite.summary} + ${types.errorCount} type error${plural}`;

  return {
    code: 1,
    verdict: "block",
    summary: `${summary} (route: ${route})`,
    lines: [...headline, ...typecheckLines(types), `red-gate: route → ${route}`],
    detail: {
      ...(suite.code === 0 ? { reason: "type-errors" } : suite.detail),
      typeErrors: types.errorCount,
      route,
      typeErrorOwners: types.owners,
    },
  };
}

// --- CLI ------------------------------------------------------------------------

/** Test seam: override the suite command without spawning real vitest. */
export function gateOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RunTestsOptions {
  const command = env["PI_GATE_TEST_CMD"];
  if (!command) return {};
  const args = JSON.parse(env["PI_GATE_TEST_ARGS"] ?? "[]") as string[];
  return { command, args };
}

/** The same seam for the gates' typecheck run (both red and green typecheck). */
export function gateTypecheckOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TypecheckOptions {
  const command = env["PI_GATE_TSC_CMD"];
  if (!command) return {};
  const args = JSON.parse(env["PI_GATE_TSC_ARGS"] ?? "[]") as string[];
  return { command, args };
}

/** What a pristine red-gate project is built from. */
export interface RedGateSources {
  /** Project-relative *.contract.ts paths. */
  readonly contracts: readonly string[];
  /** Project-relative test file paths. */
  readonly testFiles: readonly string[];
  /** Project-relative config the suite needs (package.json, tsconfig.json, …). */
  readonly configFiles: readonly string[];
  /** Implementation files that already exist. Never copied; listed only so the
   *  plan can be asserted to exclude them. */
  readonly implementationFiles?: readonly string[];
}

export interface RedGateProjectPlan {
  /** Files copied verbatim into the pristine project. */
  readonly copy: readonly string[];
  /** Contracts to re-scaffold there, producing the throwing skeletons. */
  readonly regenerate: readonly string[];
}

/**
 * Plan a pristine project in which the red gate is valid regardless of what the
 * builder has done to the real `src/`.
 *
 * The red gate asserts every failure is NotImplementedError, which is only
 * measurable against an UNIMPLEMENTED skeleton — and that is the sole reason
 * BUILD had to wait for TEST. Once the builder writes code the window shuts
 * forever.
 *
 * But that is an artifact of running against the live tree. `scaffold` is
 * deterministic and the contracts are checksum-frozen, so the skeleton can be
 * reproduced at will. Copy the contracts, the tests and the config into a temp
 * project, regenerate the skeletons there, and run: the verdict holds no matter
 * what exists in the real src/. That lets the test-writer and the builder work
 * in parallel, turning the critical path from sum() into max().
 *
 * Blindness is untouched — regenerating a skeleton needs the contracts, never
 * the tests.
 */
export function redGateProjectPlan(sources: RedGateSources): RedGateProjectPlan {
  if (sources.contracts.length === 0) {
    throw new Error("red-gate: no contracts to regenerate — nothing to run the tests against");
  }
  if (sources.testFiles.length === 0) {
    throw new Error("red-gate: no tests found — a red is a positive claim, and silence is not one");
  }
  // Implementation files are deliberately absent: copying one is precisely the
  // bug this avoids, since it would let a partial implementation turn
  // NotImplemented failures into ordinary assertion failures.
  return {
    copy: [...sources.contracts, ...sources.testFiles, ...sources.configFiles],
    regenerate: [...sources.contracts],
  };
}

/** Run the red gate and return its verdict without printing or exiting.
 *  The `red_gate` tool and the CLI below are both thin wrappers over this, so
 *  there is exactly one implementation of "is this a valid red". */
export async function runRedGate(cwd: string): Promise<GateResult> {
  const [run, tsc] = await Promise.all([
    runTests(cwd, gateOptionsFromEnv()),
    typecheck(cwd, gateTypecheckOptionsFromEnv()),
  ]);
  const result = classifyRed(run, tsc);
  logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
  return result;
}

async function main(argv: string[]): Promise<number> {
  const result = await runRedGate(argv[0] ?? process.cwd());
  for (const line of result.lines) console.log(line);
  return result.code;
}

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`red-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
