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
import { lstatSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { formatRunTests, runTests,
  failureNames,
  repeatedFailureNudge,
} from "../packs/ts/scripts/run-tests.ts";
import { formatTypecheck, typecheck } from "../packs/ts/scripts/typecheck.ts";
import { logGuardEvent, readGuardLog } from "../src/guard-log.ts";

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

/** Failing-test-name sets from this project's prior run_tests events, oldest→newest. */
function priorFailureSets(cwd: string): string[][] {
  try {
    return readGuardLog(cwd)
      .filter((e) => e.guard === "run_tests")
      .map((e) => {
        const names = (e.detail as { names?: unknown } | undefined)?.names;
        return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
      });
  } catch {
    return []; // an unreadable log must never break the builder's only channel
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "remove",
    label: "Remove File",
    description:
      "Delete one file. Subject to the same write zones as write/edit — you can only remove files you could have written. Directories are refused.",
    promptSnippet: "Delete a file inside your write zones.",
    parameters: Type.Object({
      path: Type.String({ description: "File to delete (relative to the project root, or absolute)." }),
      cwd: Type.Optional(Type.String({ description: "Project root override." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // The path gate has already vetoed out-of-zone paths before this runs;
      // what remains is mechanics. Deleting a directory is refused because no
      // role's job ever requires it — a recursive delete is a blast radius, not
      // a capability.
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const target = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
      let st;
      try {
        st = lstatSync(target);
      } catch {
        return { content: [{ type: "text" as const, text: `remove: '${params.path}' does not exist (nothing to do)` }], details: { ok: true, existed: false } };
      }
      if (st.isDirectory()) {
        return { content: [{ type: "text" as const, text: `remove: '${params.path}' is a directory — remove refuses directories; delete files one by one` }], details: { ok: false } };
      }
      rmSync(target);
      logGuardEvent(cwd, { guard: "remove", verdict: "pass", summary: `removed ${params.path}`, detail: { path: params.path } });
      return { content: [{ type: "text" as const, text: `remove: deleted ${params.path}` }], details: { ok: true, existed: true } };
    },
  });

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
      const names = failureNames(result);
      // The guard log is the only run history that survives between tool calls,
      // and it is already written on every run — so convergence is measured
      // from the same audit trail the orchestrator reads (dogfood Run 4).
      const nudge = repeatedFailureNudge(priorFailureSets(cwd), names);
      logGuardEvent(cwd, {
        guard: "run_tests",
        verdict: result.blocked !== undefined ? "error" : result.failed === 0 ? "pass" : "block",
        summary: result.blocked !== undefined
          ? "suite could not run"
          : `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`,
        detail: { names, ...(nudge !== undefined ? { stuck: true } : {}) },
      });
      const text = nudge === undefined ? formatRunTests(result) : `${formatRunTests(result)}\n\n${nudge}`;
      return {
        content: [{ type: "text", text }],
        details: {
          ok: result.ok,
          total: result.total,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
          blocked: result.blocked !== undefined,
          stuck: nudge !== undefined,
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
