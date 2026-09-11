import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { createContractLinter, formatProblems, lintContractSource } from "./contract-purity.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

// --- programmatic core --------------------------------------------------------

describe("lintContractSource", () => {
  test("a clean contract produces no problems", async () => {
    // The value object (OrderId) lives in its own contract file and is imported
    // from the implementation module — a value object may not share a file with
    // the operations over it (value-objects-own-contract, ADR 2026-026).
    const problems = await lintContractSource(
      'import type { OrderId } from "./order-id.js";\n' +
        "export interface Order { readonly id: OrderId }\n" +
        "export declare function create(o: Order): void;",
      "orders.contract.ts",
    );
    expect(problems).toEqual([]);
  });

  test("a function body is reported with the plugin rule id and position", async () => {
    const problems = await lintContractSource(
      "export function f() { return 1; }",
      "x.contract.ts",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].ruleId).toBe("pi-harness-ts/declaration-only");
    expect(problems[0].line).toBe(1);
  });

  test("non-contract files are out of scope (the gate only lints *.contract.ts)", async () => {
    const problems = await lintContractSource("export const x: number = 1;", "x.ts");
    expect(problems).toEqual([]);
  });

  // The gate enforces design quality, not just well-formedness (issue #3).
  // Fixtures are the real dogfood contracts: docs/dogfooding.md runs 1-3.
  test("naked primitives on the public surface are reported by the gate", async () => {
    const problems = await lintContractSource(
      "export interface Book { isbn: string; authors: string[] }\n" +
        "export interface ProgressEvent { pagesRead: number }",
      "book.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toEqual([
      "pi-harness-ts/no-naked-primitives",
      "pi-harness-ts/no-naked-primitives",
      "pi-harness-ts/no-naked-primitives",
    ]);
    expect(problems[0].message).toMatch(/'isbn' is declared as 'string'/);
    expect(problems[1].message).toMatch(/'authors' is a collection of naked 'string'/);
    expect(problems[2].message).toMatch(/'pagesRead' is declared as 'number'/);
  });

  // Issue #10's real miss: the alias is not a primitive, so it slid past both
  // value-object rules — no class, so nothing downstream fired either.
  test("a bare alias to a built-in object type is reported by the gate", async () => {
    const problems = await lintContractSource(
      "export type CalendarDate = Date;\n",
      "billing.contract.ts",
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["pi-harness-ts/no-naked-primitives"]);
    expect(problems[0].message).toMatch(/aliases a built-in object type/);
    expect(problems[0].message).toMatch(/mutable/);
  });

  test("the value-object version of the same contract is clean", async () => {
    // The naked primitives are replaced by value objects, which — per
    // value-objects-own-contract (ADR 2026-026) — live in their own contract
    // file and are imported here from the implementation module.
    const problems = await lintContractSource(
      'import type { Isbn, AuthorName, PagesRead } from "./values.js";\n' +
        "export interface Book { readonly isbn: Isbn; readonly authors: readonly [AuthorName, ...AuthorName[]] }\n" +
        "export interface ProgressEvent { readonly pagesRead: PagesRead }\n" +
        "export interface ReadingListStore { save(book: Book): Promise<void>; load(): Promise<readonly Book[]> }",
      "book.contract.ts",
    );
    expect(problems).toEqual([]);
  });
});

describe("formatProblems (one greppable line per problem)", () => {
  test("path:line:col, rule, message", async () => {
    const results = await createContractLinter().lintText("export const x = 1;", {
      filePath: "src/orders/orders.contract.ts",
    });
    // lintText resolves the virtual path against the process cwd
    const lines = formatProblems(results, process.cwd());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^src\/orders\/orders\.contract\.ts:1:14\s+pi-harness-ts\/declaration-only\s+Contract files are declaration-only/,
    );
  });
});

// --- CLI (the gate as a command) ------------------------------------------------

const SCRIPT = join(import.meta.dirname, "contract-purity.ts");
// A value-object-only contract: clean, and it does not co-locate the value
// object with an interface/operation that references it (value-objects-own-contract).
const GOOD_CONTRACT =
  '/** Px: a valid value. */\nexport declare class Px {\n  private readonly __brand: "Px";\n  private constructor();\n  readonly value: number;\n  static parse(raw: unknown): Px | undefined;\n}\n';
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

describe("contract-purity CLI", () => {
  test("exit 0 with an OK summary for clean contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-ok-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "good.contract.ts"), GOOD_CONTRACT);
    const r = runCli(dir, ["**/*.contract.ts"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contract-purity: OK \(1 file\)/);
    // …and the pass is logged (a silent log must never masquerade as a clean run)
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" });
  });

  test("exit 1 with greppable problem lines for impure contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-bad-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "bad.contract.ts"), "import { Pool } from 'pg';\n");
    const r = runCli(dir, ["**/*.contract.ts"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /bad\.contract\.ts:1:1\s+pi-harness-ts\/declaration-only\s+.*'pg' is imported as a value/,
    );
    expect(r.stdout).toMatch(/contract-purity: 1 problem/);
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "contract-purity", verdict: "block" });
    const problems = events[0].detail?.["problems"] as { ruleId: string; message: string }[];
    expect(problems[0].ruleId).toBe("pi-harness-ts/declaration-only");
    expect(problems[0].message).toMatch(/'pg' is imported as a value/);
  });

  test("runs when invoked through a symlink (the ~/.pi/agent case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-symlink-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "good.contract.ts"), GOOD_CONTRACT);
    const link = join(dir, "contract-purity.link.ts");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link, "**/*.contract.ts"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contract-purity: OK/);
  });

  test("exit 2 when no contract files match (silence is not success)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-none-"));
    tmpDirs.push(dir);
    const r = runCli(dir, ["src/**/*.contract.ts"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/contract-purity: no files matched/);
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "contract-purity", verdict: "error" });
  });

  // The architect's scratch zone (Fix 4): the default gate scope is
  // src/**/*.contract.ts, so a probe in the top-level scratch/ is never linted —
  // even an impure one. The zone overlaps no gate that globs the project.
  test("the default src scope never scans the scratch zone, impure or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "purity-scratch-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "scratch"), { recursive: true });
    writeFileSync(join(dir, "scratch", "probe.contract.ts"), "import { Pool } from 'pg';\n");
    const r = runCli(dir, ["src/**/*.contract.ts"]);
    expect(r.status).toBe(2); // no files matched — scratch is outside src/**
    expect(r.stderr).toMatch(/contract-purity: no files matched/);
  });
});
