// red gate (TN-26-001, TEST → BUILD boundary, §"Test-runner gates").
//
//   node red-gate.ts [targetDir]
//
// Runs the target project's vitest suite (JSON reporter, via the shared
// run_tests suite runner) and asserts a VALID red: the suite RUNS, at least
// one test fails, and EVERY failure is a NotImplementedError. Red only proves
// something if someone checks WHY it went red (see TN-26-001 Appendix,
// Böckeler). Wrong-reason red — import errors, config errors, type/runtime
// errors, ordinary assertion failures — is REJECTED, naming the offending
// test. A fully-passing suite at the red phase is ALSO a fail: nothing is
// waiting to be built.
//
// Exit 0 valid red · 1 invalid red (one greppable line each) · 2 misuse
// (target unrunnable / bad invocation). Logs one guard event to the target's
// .pi/guard-log.jsonl.
//
// The suite command is injectable for testing via PI_GATE_TEST_CMD /
// PI_GATE_TEST_ARGS (a JSON array); default is the run_tests invocation
// (`npx vitest run --reporter=json`).

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runTests, type RunTestsOptions, type RunTestsResult } from "./run-tests.ts";
import type { TypecheckOptions } from "./typecheck.ts";
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

/** Classify a run against the red-gate contract. Pure: no I/O, no logging. */
export function classifyRed(run: RunTestsResult): GateResult {
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

async function main(argv: string[]): Promise<number> {
  const cwd = argv[0] ?? process.cwd();
  const run = await runTests(cwd, gateOptionsFromEnv());
  const result = classifyRed(run);
  for (const line of result.lines) console.log(line);
  logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
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
