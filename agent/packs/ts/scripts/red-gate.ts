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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  boundaryRemedyLines,
  calledNames,
  checkBoundaryBlocks,
  declaredExports,
  reachedNames,
  readContracts,
  readHandWrittenTests,
  readAllTests,
  unreachedExports,
  unreachedRemedyLines,
  valueObjectClasses,
} from "./test-obligations.ts";
import {
  ERRORS_MODULE_SOURCE,
  errorsModuleFor,
  scaffoldContract,
  skeletonPathFor,
} from "./scaffold-contract.ts";
import { runTests, type RunTestsOptions, type RunTestsResult } from "./run-tests.ts";
import { lintTests } from "./lint-src.ts";
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
    // A FILE-level failure whose message mentions NotImplemented reads as a
    // contradiction — "the right error is the wrong reason?" — and it cost
    // Run 8's architect 25 minutes and five bounces against the wrong
    // hypothesis. It is not a contradiction: the throw happened during
    // import/collection, before any test ran. A skeleton call at the top
    // level of a test file (building fixtures outside `test()`) throws while
    // vitest is still collecting, so no test ever gets to fail for the right
    // reason. The gate is correct to block; the message must say WHY.
    const collectionFailures = offenders.filter(
      (o) => o.name === "(test file)" && o.message !== undefined && /NotImplemented/.test(o.message),
    );
    return {
      code: 1,
      verdict: "block",
      summary: `${offenders.length} wrong-reason failure${offenders.length === 1 ? "" : "s"}`,
      lines: [
        `red-gate: FAIL — ${offenders.length} failure${offenders.length === 1 ? "" : "s"} not caused by NotImplementedError (wrong-reason red)`,
        ...offenders.map((o) => `  wrong-reason: ${o.name} — ${firstLine(o.message)}`),
        ...(collectionFailures.length > 0
          ? [
              "red-gate: a NotImplemented thrown by '(test file)' happened during IMPORT/COLLECTION, not in a test:",
              "  something calls a skeleton export at the top level of a test file (e.g. building a",
              "  fixture with Currency.parse(...) outside test()). Move every such call inside a",
              "  test() or a beforeEach — the file must be importable while nothing is implemented.",
            ]
          : []),
      ],
      detail: {
        reason: "wrong-reason",
        offenders: offenders.map((o) => ({ name: o.name, message: firstLine(o.message) })),
        ...(collectionFailures.length > 0 ? { collectionFailures: collectionFailures.length } : {}),
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

// --- Building the pristine project ----------------------------------------------

const CONFIG_CANDIDATES = [
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
] as const;

/** Project-relative paths, POSIX separators, of every *.ts under `dir`. */
function walkTs(root: string, dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(root, full, out);
    else if (entry.name.endsWith(".ts")) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** What a pristine project is built from, read off the live tree. Contracts and
 *  tests are found the same way the rest of the pack finds them; implementation
 *  files are listed only so the plan can be asserted to exclude them. */
export function collectRedGateSources(cwd: string): RedGateSources {
  const src = walkTs(cwd, join(cwd, "src"));
  return {
    contracts: src.filter((f) => f.endsWith(".contract.ts")),
    testFiles: walkTs(cwd, join(cwd, "tests")),
    configFiles: CONFIG_CANDIDATES.filter((f) => existsSync(join(cwd, f))),
    implementationFiles: src.filter((f) => !f.endsWith(".contract.ts")),
  };
}

/**
 * Materialize a plan into a throwaway directory and return its path.
 *
 * `node_modules` is symlinked rather than copied: the suite needs vitest and
 * typescript, and a copy would cost more than the gate saves.
 *
 * The skeletons are REGENERATED here, never copied — that is the whole point.
 * `scaffold` is deterministic and the contracts are checksum-frozen, so the
 * unimplemented skeleton can be reproduced at any moment, which is what makes
 * the verdict independent of whatever the builder has done to the real src/.
 */
export function materializePristineProject(cwd: string, plan: RedGateProjectPlan): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-red-gate-"));

  for (const rel of plan.copy) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(cwd, rel), to);
  }

  const modules = join(cwd, "node_modules");
  if (existsSync(modules)) {
    try {
      symlinkSync(modules, join(dir, "node_modules"), "dir");
    } catch {
      // A missing symlink is not fatal on its own — the suite will fail to run
      // and classifySuite reports that as a wrong-reason red, which is true.
    }
  }

  for (const rel of plan.regenerate) {
    const source = readFileSync(join(cwd, rel), "utf8");
    const skeleton = join(dir, skeletonPathFor(rel));
    mkdirSync(dirname(skeleton), { recursive: true });
    writeFileSync(skeleton, scaffoldContract(source, rel), "utf8");

    const errors = join(dir, errorsModuleFor(rel) + ".ts");
    if (!existsSync(errors)) {
      mkdirSync(dirname(errors), { recursive: true });
      writeFileSync(errors, ERRORS_MODULE_SOURCE, "utf8");
    }
  }

  return dir;
}

/**
 * The two obligations a red must ALSO discharge, checked only once the red is
 * otherwise valid.
 *
 * Dogfood Run 7 is why both exist. Its suite was a right-reason red, type-clean,
 * 32 tests — and it never called 9 of the contract's 15 exports. Every value
 * object parser went untested through a red gate and a green gate, because the
 * gates asked whether the failures were the right KIND and never whether they
 * covered the SURFACE. The measurement was already in hand: the scaffolder
 * writes the export's own name into each NotImplementedError, and the gate was
 * throwing that name away.
 *
 *   · REACHABILITY is exact and free — set difference over data already parsed.
 *     An export no failure names is an export no test called.
 *   · BOUNDARIES is a fingerprint, not a measurement. It eliminates OMISSION —
 *     nine parsers, zero assertions, no intent involved — and not evasion; a
 *     lazy pair of rejections satisfies it. Claim no more for it than that.
 *
 * Both are the test-writer's to fix, and this is the last gate where fixing
 * them is cheap.
 */
function withObligations(cwd: string, base: GateResult, run: RunTestsResult): GateResult {
  let contracts, tests;
  try {
    contracts = readContracts(cwd);
    tests = readHandWrittenTests(cwd);
  } catch {
    return base; // an unreadable tree must never turn a valid red into a block
  }

  // Call sites in the test sources are the PRIMARY reachability evidence;
  // red-phase failure names only corroborate. An export whose inputs come from
  // other exports can never surface in a red failure — every test dies at the
  // first skeleton call — and Run 9 jammed five bounces deep on exactly that.
  const reached = new Set([
    ...reachedNames(run.results.filter((r) => r.status === "failed").map((r) => r.message)),
    ...calledNames(readAllTests(cwd)),
  ]);
  const unreached = unreachedExports(declaredExports(contracts), reached);
  const boundaries = checkBoundaryBlocks(valueObjectClasses(contracts), tests);
  if (unreached.length === 0 && boundaries.length === 0) return base;

  const counts = [
    unreached.length > 0 ? `${unreached.length} unreached export${unreached.length === 1 ? "" : "s"}` : undefined,
    boundaries.length > 0 ? `${boundaries.length} boundaries gap${boundaries.length === 1 ? "" : "s"}` : undefined,
  ].filter((c) => c !== undefined);

  return {
    code: 1,
    verdict: "block",
    summary: `${counts.join(" + ")} (route: test-writer)`,
    lines: [
      `red-gate: FAIL — the red is valid but incomplete: ${counts.join(", ")}`,
      ...(unreached.length > 0 ? unreachedRemedyLines(unreached) : []),
      ...boundaries.flatMap((v) => boundaryRemedyLines(v)),
      "red-gate: route → test-writer",
    ],
    detail: {
      reason: "obligations",
      unreached: unreached.map((u) => u.name),
      boundaries: boundaries.map((v) => ({ className: v.className, kind: v.kind })),
      route: "test-writer",
    },
  };
}

/** Run the red gate and return its verdict without printing or exiting.
 *  The `red_gate` tool and the CLI below are both thin wrappers over this, so
 *  there is exactly one implementation of "is this a valid red".
 *
 *  The suite runs against a PRISTINE regenerated copy of the project, not the
 *  live tree. A valid red asserts every failure is NotImplementedError, which
 *  is only measurable against an unimplemented skeleton — running against the
 *  live tree is what forced BUILD to wait for TEST, because the window shut the
 *  moment the builder wrote anything. Against a regenerated copy the verdict
 *  holds regardless, so the test-writer and the builder can run concurrently.
 *
 *  Blindness is untouched: regenerating a skeleton needs the contracts, never
 *  the tests. */
export async function runRedGate(cwd: string): Promise<GateResult> {
  let dir: string;
  let plan: RedGateProjectPlan;
  try {
    plan = redGateProjectPlan(collectRedGateSources(cwd));
    dir = materializePristineProject(cwd, plan);
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    const result: GateResult = {
      code: 2,
      verdict: "error",
      summary,
      lines: [`red-gate: ERROR — ${summary}`],
      detail: { reason: "pristine-project" },
    };
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary, detail: result.detail });
    return result;
  }

  try {
    const [run, tsc, testLint] = await Promise.all([
      runTests(dir, gateOptionsFromEnv()),
      typecheck(dir, gateTypecheckOptionsFromEnv()),
      // Escape hatches in TEST sources: a suite that silences the type
      // checker can assert its way past anything, and Run 10's helpers used
      // `!` freely because only src/** was watched. Checked here because this
      // is the last gate where the fix is cheap and the test-writer is live.
      lintTests(cwd),
    ]);
    let base = classifyRed(run, tsc);
    if (base.code === 0 && testLint.code === 1) {
      base = {
        code: 1,
        verdict: "block",
        summary: `${testLint.summary} in tests (route: test-writer)`,
        lines: [
          `red-gate: FAIL — the red is valid but the test sources switch the type checker off (${testLint.summary})`,
          ...testLint.lines.slice(0, -1),
          "red-gate: a non-null assertion, cast, any or ts-comment in a test helper undermines every assertion built on it",
          "red-gate: route → test-writer",
        ],
        detail: { reason: "test-escape-hatches", ...testLint.detail, route: "test-writer" },
      };
    }
    // Obligations are only meaningful once the red itself is valid: against a
    // broken suite "nothing reached parseCurrency" is noise, not a finding.
    const result = base.code === 0 ? withObligations(cwd, base, run) : base;
    logGuardEvent(cwd, {
      guard: GUARD,
      verdict: result.verdict,
      summary: result.summary,
      detail: { ...result.detail, pristine: true, contracts: plan.regenerate.length },
    });
    return result;
  } finally {
    // PI_GATE_KEEP_PRISTINE leaves the directory behind: when a red is invalid
    // for a reason the output does not explain, the project it ran against is
    // the first thing worth looking at.
    if (!process.env["PI_GATE_KEEP_PRISTINE"]) rmSync(dir, { recursive: true, force: true });
  }
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
