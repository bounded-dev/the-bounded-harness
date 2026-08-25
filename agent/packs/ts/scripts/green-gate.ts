// green gate (TN-26-001, BUILD verdict, §"Test-runner gates").
//
//   node green-gate.ts [targetDir]
//
// Runs the target project's vitest suite (JSON reporter, via the shared
// run_tests suite runner) and asserts GREEN from the ORCHESTRATOR's own run —
// never the builder's say-so (TN-26-001 §"Roles and flow": "green is asserted
// from the orchestrator's own run"). The suite must run and every test must
// pass; any failure fails the gate, naming each failing test. A suite that
// could not run (BLOCKED) or executed no tests is a fail: green is a positive
// claim, and silence is not success.
//
// Exit 0 green · 1 not green (one greppable line each) · 2 misuse (target
// unrunnable / bad invocation). Logs one guard event to the target's
// .pi/guard-log.jsonl.
//
// The suite command is injectable for testing via PI_GATE_TEST_CMD /
// PI_GATE_TEST_ARGS (a JSON array); default is the run_tests invocation.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runTests, type RunTestsResult } from "./run-tests.ts";
import { gateOptionsFromEnv, type GateResult } from "./red-gate.ts";
import { logGuardEvent } from "../../../src/guard-log.ts";

const GUARD = "green-gate";

/** Classify a run against the green-gate contract. Pure: no I/O, no logging. */
export function classifyGreen(run: RunTestsResult): GateResult {
  if (run.blocked !== undefined) {
    return {
      code: 1,
      verdict: "block",
      summary: "suite did not run",
      lines: [
        "green-gate: FAIL — suite did not run; green must be proven by a real passing run",
        ...run.blocked.split("\n").map((l) => `  ${l}`),
      ],
      detail: { reason: "blocked", blocked: run.blocked },
    };
  }
  if (run.total === 0) {
    return {
      code: 1,
      verdict: "block",
      summary: "no tests ran",
      lines: ["green-gate: FAIL — no tests ran; green is a positive claim (silence is not success)"],
      detail: { reason: "no-tests" },
    };
  }
  if (run.failed > 0) {
    const failures = run.results.filter((r) => r.status === "failed");
    return {
      code: 1,
      verdict: "block",
      summary: `${run.failed} failing test${run.failed === 1 ? "" : "s"}`,
      lines: [
        `green-gate: FAIL — ${run.failed} failing test${run.failed === 1 ? "" : "s"} of ${run.total}`,
        ...failures.map((f) => `  failed: ${f.name}`),
      ],
      detail: { reason: "failures", failed: run.failed, total: run.total, names: failures.map((f) => f.name) },
    };
  }
  return {
    code: 0,
    verdict: "pass",
    summary: `GREEN (${run.passed}/${run.total} passed)`,
    lines: [
      `green-gate: OK — ${run.passed} passed, ${run.total} total${run.skipped > 0 ? `, ${run.skipped} skipped` : ""}`,
    ],
    detail: { passed: run.passed, total: run.total, skipped: run.skipped },
  };
}

// --- CLI ------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const cwd = argv[0] ?? process.cwd();
  const run = await runTests(cwd, gateOptionsFromEnv());
  const result = classifyGreen(run);
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
      console.error(`green-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
