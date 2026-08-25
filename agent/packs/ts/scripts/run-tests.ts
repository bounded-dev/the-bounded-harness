// run_tests custom tool core (TN-26-001, §"Custom tools" #3).
//
// The builder subagent is blind to test SOURCE but must see failure output to
// debug. run_tests runs the project's vitest suite with the JSON reporter and
// pipes stdout through the ALREADY-BUILT sanitizer (sanitizeTestRun) — the
// only thing that ever reaches the builder is the sanitizer's whitelist:
// test name, status, and a source-scrubbed assertion diff. Same suite binary
// as the orchestrator's gates (vitest), different reporter.
//
// This module owns spawning + shaping; sanitization is NOT reimplemented here.
// The command runner is injectable so the logic is unit-testable against the
// sanitizer's real captured fixtures without spawning vitest.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  SanitizeError,
  type SanitizedResult,
  sanitizeMessage,
  sanitizeTestRun,
} from "./sanitize-test-output.ts";

/** Captured output of one command invocation. */
export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Runs a command in `cwd` and resolves with its captured output (never
 *  rejects on a non-zero exit — a failing suite is expected). */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandOutput>;

export interface RunTestsOptions {
  /** Override the command runner (tests inject a fake). */
  readonly run?: CommandRunner;
  /** Override the vitest invocation. Default: `npx vitest run --reporter=json`. */
  readonly command?: string;
  readonly args?: string[];
}

/** Per-status tally over the sanitized results. */
export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** skipped + todo + pending — anything that didn't execute to a verdict. */
  readonly skipped: number;
}

export interface RunTestsResult extends RunSummary {
  /** True when the suite ran AND no test failed. */
  readonly ok: boolean;
  /** Sanitized per-test outcomes, in reporter order. */
  readonly results: SanitizedResult[];
  /** Present ONLY when vitest produced no parseable JSON report (BLOCKED): a
   *  sanitized (path-scrubbed) explanation drawn from stderr/stdout. */
  readonly blocked?: string;
}

const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = ["vitest", "run", "--reporter=json"];

/** Default runner: spawn, capture stdout/stderr, resolve on close. */
const spawnRunner: CommandRunner = (command, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

/**
 * Extract the reporter's JSON object from captured stdout. Vitest's JSON
 * reporter emits one top-level object; other runners/plugins occasionally
 * bracket it with log noise, so slice from the first `{` to the last `}`.
 */
export function extractReporterJson(stdout: string): string {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stdout.trim();
  return stdout.slice(start, end + 1);
}

const isSkip = (status: string) =>
  status === "skipped" || status === "todo" || status === "pending";

export function summarizeResults(results: readonly SanitizedResult[]): RunSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "passed") passed++;
    else if (r.status === "failed") failed++;
    else if (isSkip(r.status)) skipped++;
  }
  return { total: results.length, passed, failed, skipped };
}

/**
 * Run the project's vitest suite (JSON reporter) in `cwd` and return the
 * sanitized, blind-safe view. Never throws for an ordinary failing suite;
 * an unparseable run is reported via {@link RunTestsResult.blocked}.
 */
export async function runTests(cwd: string, options: RunTestsOptions = {}): Promise<RunTestsResult> {
  const run = options.run ?? spawnRunner;
  const command = options.command ?? DEFAULT_COMMAND;
  const args = options.args ?? DEFAULT_ARGS;

  const { stdout, stderr, code } = await run(command, args, cwd);

  let results: SanitizedResult[];
  try {
    results = sanitizeTestRun(extractReporterJson(stdout));
  } catch (e) {
    if (e instanceof SanitizeError) {
      // The suite could not even produce a report (config/import error, crash).
      // Surface a sanitized, path-free explanation — never the raw stderr.
      const raw = stderr.trim() !== "" ? stderr : stdout;
      const blocked = sanitizeMessage(raw) || `vitest exited with code ${code ?? "null"} and no JSON report`;
      return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], blocked };
    }
    throw e;
  }

  const summary = summarizeResults(results);
  return { ok: summary.failed === 0, ...summary, results };
}

/** Human-readable, blind-safe rendering of a run for the tool's text output. */
export function formatRunTests(result: RunTestsResult): string {
  if (result.blocked !== undefined) {
    return `run_tests: suite could not run (BLOCKED):\n\n${result.blocked}`;
  }
  const head = `Tests: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.total} total)`;
  if (result.failed === 0) return head;
  const failures = result.results
    .filter((r) => r.status === "failed")
    .map((r) => {
      const body = r.message ? "\n" + r.message.replace(/^/gm, "    ") : "";
      return `✗ ${r.name}${body}`;
    })
    .join("\n\n");
  return `${head}\n\n${failures}`;
}

// --- CLI ------------------------------------------------------------------------

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
  runTests(process.argv[2] ?? process.cwd()).then(
    (result) => {
      console.log(formatRunTests(result));
      process.exit(result.ok ? 0 : 1);
    },
    (e: unknown) => {
      console.error(`run_tests: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
