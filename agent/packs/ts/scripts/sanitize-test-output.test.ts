import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SanitizeError, sanitizeMessage, sanitizeTestRun } from "./sanitize-test-output.ts";

// Fixtures are REAL vitest output, captured by running throwaway failing/
// passing suites through `vitest run --reporter=json` (see the fixture headers
// in the module doc). The sentinels are source-derived strings that MUST NOT
// survive sanitization:
//   - SENTINEL_PATH        appears only in file paths inside stack frames
//     (in vitest-failing-run.json)
//   - SENTINEL_SOURCE_LEAK appears in a real code frame's numbered source
//     lines and a console.log line (in vitest-code-frame-message.txt)
const TESTDATA = join(import.meta.dirname, "testdata");
const fixture = (name: string) => readFileSync(join(TESTDATA, name), "utf8");

const FAILING = fixture("vitest-failing-run.json");
const PASSING = fixture("vitest-passing-run.json");
const CODE_FRAME = fixture("vitest-code-frame-message.txt");

const PATH_SENTINEL = "SENTINEL_PATH";
const SOURCE_SENTINEL = "SENTINEL_SOURCE_LEAK";

describe("sanitizeTestRun (real failing run)", () => {
  const results = sanitizeTestRun(FAILING);
  const failures = results.filter((r) => r.status === "failed");

  test("failure names survive", () => {
    const names = results.map((r) => r.name);
    expect(names).toContain("math fails an equality check");
    expect(names).toContain("math fails a deep equal");
    expect(names).toContain("math adds numbers correctly");
  });

  test("assertion expected/received text survives", () => {
    const blob = failures.map((r) => r.message).join("\n");
    expect(blob).toContain("expected 73 to be 999");
    expect(blob).toContain("to deeply equal");
  });

  test("passing tests carry no message", () => {
    const passing = results.filter((r) => r.status === "passed");
    expect(passing.length).toBeGreaterThan(0);
    for (const r of passing) expect(r.message).toBeUndefined();
  });

  test("stack `at`/`❯` lines do not survive", () => {
    const blob = JSON.stringify(results);
    expect(blob).not.toMatch(/\bat\s+\/?\w/);
    expect(blob).not.toContain("❯");
    expect(blob).not.toContain("chunk-artifact"); // vitest runner internals
  });

  test("file paths do not survive (path sentinel is gone)", () => {
    // The sentinel is present in the RAW fixture (inside stack-frame paths)…
    expect(FAILING).toContain(PATH_SENTINEL);
    // …and absent from every sanitized field.
    expect(JSON.stringify(results)).not.toContain(PATH_SENTINEL);
    expect(JSON.stringify(results)).not.toContain(".test.ts");
    expect(JSON.stringify(results)).not.toContain("/var/folders");
  });
});

describe("sanitizeTestRun (real passing run)", () => {
  const results = sanitizeTestRun(PASSING);

  test("all tests pass with clean, message-free results", () => {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.status).toBe("passed");
      expect(r.message).toBeUndefined();
      expect(r.name).not.toBe("");
    }
  });
});

describe("sanitizeMessage (real vitest code-frame block)", () => {
  const cleaned = sanitizeMessage(CODE_FRAME);

  test("keeps the assertion + expected/received diff", () => {
    expect(cleaned).toContain("expected 43 to be 999");
    expect(cleaned).toContain("Expected");
    expect(cleaned).toContain("Received");
    expect(cleaned).toContain("999");
  });

  test("code-frame source + console sentinel do not survive", () => {
    // Present in the raw fixture (code-frame numbered lines + console.log)…
    expect(CODE_FRAME).toContain(SOURCE_SENTINEL);
    // …stripped from the sanitized output.
    expect(cleaned).not.toContain(SOURCE_SENTINEL);
  });

  test("strips code frame, caret, ❯ pointer, and file paths", () => {
    expect(cleaned).not.toContain("❯");
    expect(cleaned).not.toMatch(/^\s*\d+\s*\|/m); // numbered source line
    expect(cleaned).not.toMatch(/^\s*\|/m); // caret / gutter line
    expect(cleaned).not.toContain(".test.ts");
    expect(cleaned).not.toContain("/var/folders");
  });
});

describe("sanitizeMessage (unit)", () => {
  test("redacts absolute, relative, and file:// paths to [path]", () => {
    const msg = [
      "AssertionError: expected 1 to be 2",
      "    at /Users/someone/secret/proj/src/thing.test.ts:12:3",
      "    at file:///Users/someone/node_modules/vitest/dist/x.js:1:1",
      " ❯ ../../secret/src/thing.test.ts:12:3",
    ].join("\n");
    const cleaned = sanitizeMessage(msg);
    expect(cleaned).toBe("AssertionError: expected 1 to be 2");
    expect(cleaned).not.toContain("secret");
    expect(cleaned).not.toContain("someone");
  });

  test("drops console capture blocks", () => {
    const msg = ["AssertionError: expected true to be false", "stdout | some/file.test.ts > t", "leaked debug line"].join("\n");
    const cleaned = sanitizeMessage(msg);
    expect(cleaned).toContain("expected true to be false");
    expect(cleaned).not.toContain("stdout");
  });
});

describe("sanitizeTestRun (input validation)", () => {
  test("rejects non-JSON input", () => {
    expect(() => sanitizeTestRun("not json {")).toThrow(SanitizeError);
  });

  test("rejects JSON without testResults", () => {
    expect(() => sanitizeTestRun('{"foo":1}')).toThrow(SanitizeError);
  });

  test("empty run yields no results", () => {
    expect(sanitizeTestRun('{"testResults":[]}')).toEqual([]);
  });
});
