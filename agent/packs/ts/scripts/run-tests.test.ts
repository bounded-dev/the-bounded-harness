import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type CommandRunner,
  extractReporterJson,
  formatRunTests,
  runTests,
  summarizeResults,
} from "./run-tests.ts";

// Reuse the sanitizer's REAL vitest fixtures (captured via
// `vitest run --reporter=json`). See sanitize-test-output.test.ts for the
// sentinel conventions: SENTINEL_PATH lives only in stack-frame paths.
const TESTDATA = join(import.meta.dirname, "testdata");
const fixture = (name: string) => readFileSync(join(TESTDATA, name), "utf8");
const FAILING = fixture("vitest-failing-run.json");
const PASSING = fixture("vitest-passing-run.json");

/** A CommandRunner that ignores its inputs and returns canned output. */
function fakeRunner(stdout: string, stderr = "", code: number | null = 0): CommandRunner {
  return async () => ({ stdout, stderr, code });
}

describe("extractReporterJson", () => {
  test("returns clean JSON unchanged", () => {
    expect(extractReporterJson('{"testResults":[]}')).toBe('{"testResults":[]}');
  });

  test("strips leading/trailing non-JSON noise around the report object", () => {
    const noisy = `stderr chatter\n{"testResults":[]}\nDone in 1.2s`;
    expect(extractReporterJson(noisy)).toBe('{"testResults":[]}');
  });
});

describe("runTests (failing suite)", () => {
  test("reports counts and marks the run not-ok", async () => {
    const r = await runTests("/proj", { run: fakeRunner(FAILING, "", 1) });
    expect(r.ok).toBe(false);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.passed).toBeGreaterThan(0);
    expect(r.total).toBe(r.results.length);
    expect(r.blocked).toBeUndefined();
  });

  test("surfaces failure names and assertion diffs, no source leaks", async () => {
    const r = await runTests("/proj", { run: fakeRunner(FAILING, "", 1) });
    const blob = JSON.stringify(r.results);
    expect(r.results.map((x) => x.name)).toContain("math fails an equality check");
    expect(blob).toContain("expected 73 to be 999");
    // Sanitization holds end-to-end: no paths, stacks, or code frames survive.
    expect(FAILING).toContain("SENTINEL_PATH");
    expect(blob).not.toContain("SENTINEL_PATH");
    expect(blob).not.toContain(".test.ts");
    expect(blob).not.toContain("❯");
  });
});

describe("runTests (passing suite)", () => {
  test("marks the run ok with no failures", async () => {
    const r = await runTests("/proj", { run: fakeRunner(PASSING, "", 0) });
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(r.total);
    for (const x of r.results) expect(x.message).toBeUndefined();
  });
});

describe("runTests (suite could not run)", () => {
  test("returns a sanitized BLOCKED result when output is not vitest JSON", async () => {
    const stderr = "Error: Cannot find config at /Users/secret/proj/vitest.config.ts";
    const r = await runTests("/proj", { run: fakeRunner("garbage not json", stderr, 1) });
    expect(r.ok).toBe(false);
    expect(r.results).toEqual([]);
    expect(r.blocked).toBeDefined();
    // Paths in stderr are redacted before surfacing.
    expect(r.blocked).not.toContain("/Users/secret");
    expect(r.blocked).toContain("[path]");
  });
});

describe("summarizeResults", () => {
  test("counts by status bucket", () => {
    const s = summarizeResults([
      { name: "a", status: "passed" },
      { name: "b", status: "failed", message: "boom" },
      { name: "c", status: "skipped" },
      { name: "d", status: "todo" },
    ]);
    expect(s).toEqual({ total: 4, passed: 1, failed: 1, skipped: 2 });
  });
});

describe("formatRunTests", () => {
  test("failing run lists each failure with its message", async () => {
    const r = await runTests("/proj", { run: fakeRunner(FAILING, "", 1) });
    const text = formatRunTests(r);
    expect(text).toMatch(/failed/);
    expect(text).toContain("math fails an equality check");
    expect(text).toContain("expected 73 to be 999");
  });

  test("blocked run explains the suite could not run", async () => {
    const r = await runTests("/proj", { run: fakeRunner("nope", "boom", 1) });
    const text = formatRunTests(r);
    expect(text.toLowerCase()).toContain("could not");
  });
});
