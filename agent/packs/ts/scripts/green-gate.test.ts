import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { classifyGreen } from "./green-gate.ts";
import type { RunTestsResult } from "./run-tests.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

function vitestJson(cases: { name: string; status: string; message?: string }[]): string {
  return JSON.stringify({
    testResults: [
      {
        status: cases.some((c) => c.status === "failed") ? "failed" : "passed",
        assertionResults: cases.map((c) => ({
          fullName: c.name,
          title: c.name,
          ancestorTitles: [],
          status: c.status,
          failureMessages: c.message ? [c.message] : [],
        })),
      },
    ],
  });
}

function run(partial: Partial<RunTestsResult>): RunTestsResult {
  return { ok: false, total: 0, passed: 0, failed: 0, skipped: 0, results: [], ...partial };
}

// --- pure core: classifyGreen -------------------------------------------------

describe("classifyGreen", () => {
  test("all tests pass → exit 0", () => {
    const r = classifyGreen(
      run({ ok: true, total: 2, passed: 2, results: [{ name: "a", status: "passed" }, { name: "b", status: "passed" }] }),
    );
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines[0]).toMatch(/green-gate: OK — 2 passed, 2 total/);
  });

  test("any failure → exit 1, naming each failing test", () => {
    const r = classifyGreen(
      run({
        total: 2,
        passed: 1,
        failed: 1,
        results: [
          { name: "adds", status: "passed" },
          { name: "subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
        ],
      }),
    );
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/1 failing test of 2/);
    expect(r.lines.join("\n")).toContain("failed: subtracts");
  });

  test("blocked suite → exit 1", () => {
    const r = classifyGreen(run({ blocked: "Error: Cannot find module [path]" }));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/suite did not run/);
  });

  test("no tests ran → exit 1", () => {
    const r = classifyGreen(run({ total: 0 }));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no tests ran/);
  });
});

// --- CLI (fixture-repo) -------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "green-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixtureRepo(prefix: string, runJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "run.json"), runJson);
  return dir;
}

function runGate(dir: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PI_GATE_TEST_CMD: "cat", PI_GATE_TEST_ARGS: JSON.stringify(["run.json"]) },
  });
}

describe("green-gate CLI (fixture repos)", () => {
  test("green target → exit 0 and a logged pass", () => {
    const dir = fixtureRepo(
      "green-ok-",
      vitestJson([{ name: "create order", status: "passed" }, { name: "cancel order", status: "passed" }]),
    );
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/green-gate: OK — 2 passed, 2 total/);
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "green-gate", verdict: "pass" });
  });

  test("failing target → exit 1, names the failure, logs a block", () => {
    const dir = fixtureRepo(
      "green-fail-",
      vitestJson([
        { name: "create order", status: "passed" },
        { name: "cancel order", status: "failed", message: "AssertionError: expected 'open' to be 'cancelled'" },
      ]),
    );
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/1 failing test of 2/);
    expect(r.stdout).toContain("failed: cancel order");
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "green-gate", verdict: "block" });
  });
});
