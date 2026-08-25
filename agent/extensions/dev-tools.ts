/**
 * Developer-stage custom tools (TN-26-001, §"Custom tools" #3).
 *
 * Registers the two blind-safe build tools the builder subagent gets in place
 * of `bash`:
 *
 *   run_tests(cwd?)  — runs the project's vitest suite with the JSON reporter
 *                      and returns ONLY sanitized results (failure names +
 *                      assertion diffs; no code frames, stacks, paths, or
 *                      console). Sanitization is the already-built
 *                      sanitizeTestRun; this tool only spawns + shapes.
 *   typecheck(cwd?)  — runs `tsc --noEmit` and returns pass/fail + diagnostics
 *                      with absolute machine paths redacted.
 *
 * Registration approach: a plain auto-loaded extension (extensions/*.ts) that
 * calls `pi.registerTool()` for each. The logic lives in testable pack modules
 * (packs/ts/scripts/{run-tests,typecheck}.ts); this file is the thin pi-facing
 * wiring + guard-log boundary. The builder agent's frontmatter tool allowlist
 * (`read, write, edit, run_tests, typecheck`) is what actually restricts these
 * to the builder; a normal session simply never calls them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { formatRunTests, runTests } from "../packs/ts/scripts/run-tests.ts";
import { formatTypecheck, typecheck } from "../packs/ts/scripts/typecheck.ts";
import { logGuardEvent } from "../src/guard-log.ts";

const PARAMS = Type.Object({
  cwd: Type.Optional(
    Type.String({
      description: "Project directory to run in (absolute, or relative to the session cwd). Defaults to the session cwd.",
    }),
  ),
});

/** Resolve the target cwd against the session cwd. */
function targetCwd(sessionCwd: string, param?: string): string {
  if (!param) return sessionCwd;
  return isAbsolute(param) ? param : resolve(sessionCwd, param);
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Run the project's vitest suite and return sanitized results: failing test names and assertion diffs only. Code frames, stack traces, file paths, and console output are stripped — you cannot see test source, only outcomes.",
    promptSnippet: "Run the test suite and see sanitized pass/fail results (no test source).",
    promptGuidelines: [
      "Use run_tests to check whether your implementation satisfies the suite; it never reveals test source.",
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const result = await runTests(cwd);
      if (signal?.aborted) return { content: [{ type: "text", text: "run_tests: cancelled" }], details: {} };
      logGuardEvent(cwd, {
        guard: "run_tests",
        verdict: result.blocked !== undefined ? "error" : result.failed === 0 ? "pass" : "block",
        summary: result.blocked !== undefined
          ? "suite could not run"
          : `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`,
      });
      return {
        content: [{ type: "text", text: formatRunTests(result) }],
        details: {
          ok: result.ok,
          total: result.total,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
          blocked: result.blocked !== undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "typecheck",
    label: "Typecheck",
    description:
      "Run `tsc --noEmit` on the project and return pass/fail plus type-error diagnostics. Absolute machine paths are redacted; in-project source locations are kept.",
    promptSnippet: "Type-check the project with tsc --noEmit (paths redacted).",
    promptGuidelines: [
      "Use typecheck to confirm your implementation compiles before relying on run_tests.",
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const result = await typecheck(cwd);
      if (signal?.aborted) return { content: [{ type: "text", text: "typecheck: cancelled" }], details: {} };
      logGuardEvent(cwd, {
        guard: "typecheck",
        verdict: result.ok ? "pass" : "block",
        summary: result.ok ? "no type errors" : `${result.errorCount} error${result.errorCount === 1 ? "" : "s"}`,
      });
      return {
        content: [{ type: "text", text: formatTypecheck(result) }],
        details: { ok: result.ok, errorCount: result.errorCount },
      };
    },
  });
}
