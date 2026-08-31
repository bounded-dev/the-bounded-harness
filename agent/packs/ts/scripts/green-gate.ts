// green gate (TN-26-001, BUILD verdict, §"Test-runner gates").
//
//   node green-gate.ts [targetDir]
//
// Runs the target project's vitest suite (JSON reporter, via the shared
// run_tests suite runner) AND `tsc --noEmit`, and asserts GREEN from the
// ORCHESTRATOR's own run — never the builder's say-so (TN-26-001 §"Roles and
// flow": "green is asserted from the orchestrator's own run"). The suite must
// run and every test must pass; any failure fails the gate, naming each
// failing test. A suite that could not run (BLOCKED) or executed no tests is a
// fail: green is a positive claim, and silence is not success.
//
// GREEN ALSO REQUIRES A TYPE-CLEAN PROJECT (issue #7). Dogfood Run 3 declared
// "GREEN (22/22)" while tsc still had two errors in the test file: tests pass
// at RUNTIME while the project does not compile, and the builder could not
// have fixed it anyway (blind to tests/**, and the path gate refuses the
// edit). So the gate typechecks too and, on failure, prints ONE route line
// naming the furthest-upstream role that may repair what it found — a
// tests/**-only failure bounces to the test-writer.
//
// Exit 0 green · 1 not green (one greppable line each) · 2 misuse (target
// unrunnable / bad invocation). Logs one guard event to the target's
// .pi/guard-log.jsonl.
//
// The suite and tsc commands are injectable for testing via PI_GATE_TEST_CMD /
// PI_GATE_TEST_ARGS and PI_GATE_TSC_CMD / PI_GATE_TSC_ARGS (JSON arrays).

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runTests, type RunTestsResult } from "./run-tests.ts";
import { gateOptionsFromEnv, gateTypecheckOptionsFromEnv, type GateResult } from "./red-gate.ts";
import { typecheck, type TypecheckResult } from "./typecheck.ts";
import { mostUpstream, routeTypecheck, typecheckLines, type FixOwner } from "./typecheck-routing.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";

const GUARD = "green-gate";

/** The suite half of the verdict: what went wrong, and who owns it. */
interface SuiteVerdict {
  readonly summary: string;
  readonly lines: string[];
  readonly detail: Readonly<Record<string, unknown>>;
  /** The role a bounce would go to for this failure alone. */
  readonly owner: FixOwner;
}

function suiteVerdict(run: RunTestsResult): SuiteVerdict | null {
  if (run.blocked !== undefined) {
    return {
      summary: "suite did not run",
      lines: [
        "green-gate: FAIL — suite did not run; green must be proven by a real passing run",
        ...run.blocked.split("\n").map((l) => `  ${l}`),
      ],
      detail: { reason: "blocked", blocked: run.blocked },
      // Dispute protocol: BLOCKED (the suite can't run) bounces to the test-writer.
      owner: "test-writer",
    };
  }
  if (run.total === 0) {
    return {
      summary: "no tests ran",
      lines: ["green-gate: FAIL — no tests ran; green is a positive claim (silence is not success)"],
      detail: { reason: "no-tests" },
      owner: "test-writer",
    };
  }
  if (run.failed > 0) {
    const failures = run.results.filter((r) => r.status === "failed");
    return {
      summary: `${run.failed} failing test${run.failed === 1 ? "" : "s"}`,
      lines: [
        `green-gate: FAIL — ${run.failed} failing test${run.failed === 1 ? "" : "s"} of ${run.total}`,
        ...failures.map((f) => `  failed: ${f.name}`),
      ],
      detail: { reason: "failures", failed: run.failed, total: run.total, names: failures.map((f) => f.name) },
      // At BUILD, making a frozen suite pass is the builder's job.
      owner: "builder",
    };
  }
  return null;
}

/**
 * Classify a run against the green-gate contract. Pure: no I/O, no logging.
 * Green requires BOTH a fully passing suite and a type-clean project (#7).
 */
export function classifyGreen(run: RunTestsResult, tsc: TypecheckResult): GateResult {
  const suite = suiteVerdict(run);
  const types = routeTypecheck(tsc.diagnostics);

  if (suite === null && types.errorCount === 0) {
    return {
      code: 0,
      verdict: "pass",
      summary: `GREEN (${run.passed}/${run.total} passed, typecheck clean)`,
      lines: [
        `green-gate: OK — ${run.passed} passed, ${run.total} total${run.skipped > 0 ? `, ${run.skipped} skipped` : ""}, typecheck clean`,
      ],
      detail: { passed: run.passed, total: run.total, skipped: run.skipped, typeErrors: 0 },
    };
  }

  // A type error is reported even when the suite is fine — that is exactly the
  // Run 3 false green — and the headline says so, so the log is unambiguous.
  const headline =
    suite?.lines ??
    [
      `green-gate: FAIL — ${types.errorCount} type error${types.errorCount === 1 ? "" : "s"}; the suite passes (${run.passed}/${run.total}) but the project is not type-clean`,
    ];
  const route = mostUpstream([...(suite ? [suite.owner] : []), ...types.owners]);
  const summary = [suite?.summary, types.errorCount > 0 ? `${types.errorCount} type error${types.errorCount === 1 ? "" : "s"}` : undefined]
    .filter((s) => s !== undefined)
    .join(" + ");

  return {
    code: 1,
    verdict: "block",
    summary: `${summary} (route: ${route})`,
    lines: [...headline, ...typecheckLines(types), `green-gate: route → ${route}`],
    detail: {
      ...(suite?.detail ?? { reason: "type-errors", passed: run.passed, total: run.total }),
      typeErrors: types.errorCount,
      route,
      typeErrorOwners: types.owners,
    },
  };
}

// --- CLI ------------------------------------------------------------------------

/**
 * Run the green gate and return its verdict without printing or exiting.
 *
 * The architect holds no `bash`, so it reaches this gate through the
 * `green_gate` tool rather than a shell. Both routes MUST run the same gate —
 * "the orchestrator runs every gate itself and never trusts a worker's word"
 * is worth nothing if the tool is a second, drifting implementation. So the
 * CLI below is a thin wrapper over this function, and so is the tool.
 */
export async function runGreenGate(cwd: string): Promise<GateResult> {
  const [run, tsc] = await Promise.all([
    runTests(cwd, gateOptionsFromEnv()),
    typecheck(cwd, gateTypecheckOptionsFromEnv()),
  ]);
  const result = classifyGreen(run, tsc);
  logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
  return result;
}

async function main(argv: string[]): Promise<number> {
  const result = await runGreenGate(argv[0] ?? process.cwd());
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
      console.error(`green-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
