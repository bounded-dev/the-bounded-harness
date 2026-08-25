import { describe, expect, test } from "vitest";
import {
  type CommandRunner,
  formatTypecheck,
  parseTscOutput,
  redactAbsolutePaths,
  typecheck,
} from "./typecheck.ts";

function fakeRunner(stdout: string, stderr = "", code: number | null = 0): CommandRunner {
  return async () => ({ stdout, stderr, code });
}

describe("redactAbsolutePaths", () => {
  test("relativizes paths under the project cwd", () => {
    const out = redactAbsolutePaths("/proj/src/a.ts(1,2): error TS2322: bad", "/proj");
    expect(out).toBe("src/a.ts(1,2): error TS2322: bad");
  });

  test("redacts absolute paths outside the cwd to [path]", () => {
    const out = redactAbsolutePaths("/Users/secret/node_modules/x/y.d.ts(3,4): error TS1: no", "/proj");
    expect(out).not.toContain("/Users/secret");
    expect(out).toContain("[path]");
  });

  test("leaves already-relative paths alone", () => {
    expect(redactAbsolutePaths("src/a.ts(1,2): error TS2322: bad", "/proj")).toBe(
      "src/a.ts(1,2): error TS2322: bad",
    );
  });
});

describe("parseTscOutput", () => {
  test("clean pass yields ok with zero errors", () => {
    const r = parseTscOutput("", "", 0, "/proj");
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.diagnostics).toEqual([]);
  });

  test("counts errors and redacts absolute paths in diagnostics", () => {
    const stdout = [
      "/proj/src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
      "/proj/src/b.ts(9,1): error TS2304: Cannot find name 'foo'.",
    ].join("\n");
    const r = parseTscOutput(stdout, "", 2, "/proj");
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(2);
    expect(r.diagnostics).toHaveLength(2);
    expect(r.diagnostics[0]).toBe(
      "src/a.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(r.diagnostics.join("\n")).not.toContain("/proj");
  });
});

describe("typecheck", () => {
  test("passing project", async () => {
    const r = await typecheck("/proj", { run: fakeRunner("", "", 0) });
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
  });

  test("failing project surfaces redacted diagnostics", async () => {
    const stdout = "/proj/src/a.ts(1,2): error TS2322: bad";
    const r = await typecheck("/proj", { run: fakeRunner(stdout, "", 2) });
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(1);
    expect(r.diagnostics[0]).toBe("src/a.ts(1,2): error TS2322: bad");
  });
});

describe("formatTypecheck", () => {
  test("pass message", () => {
    expect(formatTypecheck({ ok: true, errorCount: 0, diagnostics: [] })).toMatch(/pass|no errors|ok/i);
  });

  test("failure lists diagnostics", () => {
    const text = formatTypecheck({
      ok: false,
      errorCount: 1,
      diagnostics: ["src/a.ts(1,2): error TS2322: bad"],
    });
    expect(text).toContain("src/a.ts(1,2): error TS2322: bad");
    expect(text).toMatch(/1 error/i);
  });
});
