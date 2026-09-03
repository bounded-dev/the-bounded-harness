import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { createSrcLinter, lintSrc, lintSrcText, formatSrcProblems } from "./lint-src.ts";
import { scaffoldContract } from "./scaffold-contract.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

const SRC = "src/orders/orders.ts";

async function rules(source: string, fileName = SRC): Promise<string[]> {
  return (await lintSrcText(source, fileName)).map((p) => p.ruleId);
}

// --- the four escape hatches --------------------------------------------------

describe("lintSrcText bans every way to switch the type checker off", () => {
  test("a clean implementation produces no problems", async () => {
    expect(
      await rules(
        "import type { Order } from './orders.contract.js';\n" +
          "export function total(o: Order): number { return o.total; }\n",
      ),
    ).toEqual([]);
  });

  // Dogfood Run 7: tsc correctly typed findInvoiceByOperationId as
  // `Invoice | undefined` and the builder wrote `!` to make it go away.
  test("a non-null assertion is reported", async () => {
    const problems = await lintSrcText(
      "declare const find: (id: string) => string | undefined;\n" +
        "export const x: string = find('a')!;\n",
      SRC,
    );
    expect(problems.map((p) => p.ruleId)).toEqual(["@typescript-eslint/no-non-null-assertion"]);
    expect(problems[0].line).toBe(2);
  });

  test("an `as` assertion is reported", async () => {
    expect(await rules("export const x = JSON.parse('{}') as { a: number };\n")).toEqual([
      "@typescript-eslint/consistent-type-assertions",
    ]);
  });

  test("an angle-bracket assertion is reported", async () => {
    expect(await rules("export const x = <number>(<unknown>1);\n")).toEqual([
      "@typescript-eslint/consistent-type-assertions",
      "@typescript-eslint/consistent-type-assertions",
    ]);
  });

  // VERIFIED against @typescript-eslint 8.68: assertionStyle "never" exempts
  // const assertions by design. `as const` narrows — it never widens a type or
  // silences a check — so it must stay legal, and this test pins that.
  test("`as const` stays legal", async () => {
    expect(await rules("export const modes = ['a', 'b'] as const;\n")).toEqual([]);
  });

  test("`satisfies` stays legal (it checks, it does not assert)", async () => {
    expect(await rules("export const p = { x: 1 } satisfies { x: number };\n")).toEqual([]);
  });

  test("`any` is reported, including in rest args", async () => {
    expect(await rules("export function f(...args: any[]): any { return args; }\n")).toEqual([
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/no-explicit-any",
    ]);
  });

  test("@ts-expect-error is reported even WITH a description (no exemption list)", async () => {
    expect(
      await rules("// @ts-expect-error the contract is wrong, honestly\nexport const x: number = 'a';\n"),
    ).toEqual(["@typescript-eslint/ban-ts-comment"]);
  });

  test("@ts-ignore is reported", async () => {
    expect(await rules("// @ts-ignore\nexport const x: number = 'a';\n")).toEqual([
      "@typescript-eslint/ban-ts-comment",
    ]);
  });

  test("@ts-nocheck is reported", async () => {
    expect(await rules("// @ts-nocheck\nexport const x: number = 'a';\n")).toEqual([
      "@typescript-eslint/ban-ts-comment",
    ]);
  });
});

describe("the ban cannot be reopened from inside the file", () => {
  test("eslint-disable-next-line does not silence a rule (noInlineConfig)", async () => {
    expect(
      await rules(
        "declare const find: (id: string) => string | undefined;\n" +
          "// eslint-disable-next-line @typescript-eslint/no-non-null-assertion\n" +
          "export const x: string = find('a')!;\n",
      ),
    ).toEqual(["@typescript-eslint/no-non-null-assertion"]);
  });

  test("a file-wide /* eslint-disable */ does not silence a rule", async () => {
    expect(await rules("/* eslint-disable */\nexport const x: any = 1;\n")).toEqual([
      "@typescript-eslint/no-explicit-any",
    ]);
  });

  test("a rule cannot be downgraded to a warning from inside the file", async () => {
    expect(
      await rules('/* eslint @typescript-eslint/no-explicit-any: "off" */\nexport const x: any = 1;\n'),
    ).toEqual(["@typescript-eslint/no-explicit-any"]);
  });
});

describe("scope", () => {
  test("*.contract.ts is out of scope (the architect's zone, policed elsewhere)", async () => {
    expect(await rules("export declare const x: any;\n", "src/orders/orders.contract.ts")).toEqual([]);
  });
});

// --- the generated red-phase skeletons must survive the gate ------------------

describe("scaffolder skeletons lint clean", () => {
  const dataDir = join(import.meta.dirname, "testdata");
  for (const name of ["functions", "queue", "types", "values"]) {
    test(`${name}.contract.ts → skeleton has no escape hatches`, async () => {
      const contractPath = join(dataDir, `${name}.contract.ts`);
      const skeleton = scaffoldContract(readFileSync(contractPath, "utf8"), `src/${name}.contract.ts`);
      const problems = await lintSrcText(skeleton, `src/${name}.ts`);
      // Loud on purpose: a skeleton that trips this gate is a SCAFFOLDER bug.
      expect(problems.map((p) => `${p.ruleId}: ${p.message}`)).toEqual([]);
    });
  }
});

// --- formatting ---------------------------------------------------------------

describe("formatSrcProblems (one greppable line per problem)", () => {
  test("path:line:col, rule, message", async () => {
    const results = await createSrcLinter().lintText("export const x: any = 1;\n", {
      filePath: "src/orders/orders.ts",
    });
    const lines = formatSrcProblems(results, process.cwd());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^src\/orders\/orders\.ts:1:17\s+@typescript-eslint\/no-explicit-any\s+Unexpected any/,
    );
  });
});

// --- the gate over a project tree ---------------------------------------------

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("lintSrc", () => {
  test("exit 0 / pass on a clean src tree, and the pass is logged", async () => {
    const dir = project("lint-src-ok-", {
      "src/orders/orders.contract.ts": "export declare const x: number;\n",
      "src/orders/orders.ts": "export const x = 1;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.summary).toBe("OK (1 file)");
    expect(result.lines).toEqual(["lint-src: OK (1 file)"]);
    expect(readGuardLog(dir)).toMatchObject([{ guard: "lint-src", verdict: "pass" }]);
  });

  test("exit 1 / block with greppable lines and the problems in the log detail", async () => {
    const dir = project("lint-src-bad-", {
      "src/orders/orders.ts": "export const x: any = 1;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(1);
    expect(result.verdict).toBe("block");
    expect(result.summary).toBe("1 problem in 1 file");
    expect(result.lines[0]).toMatch(
      /^src\/orders\/orders\.ts:1:17\s+@typescript-eslint\/no-explicit-any\s+/,
    );
    expect(result.lines.at(-1)).toBe("lint-src: 1 problem in 1 file");
    const events = readGuardLog(dir);
    expect(events).toMatchObject([{ guard: "lint-src", verdict: "block" }]);
    const problems = events[0].detail?.["problems"] as { ruleId: string }[];
    expect(problems.map((p) => p.ruleId)).toEqual(["@typescript-eslint/no-explicit-any"]);
  });

  test("exit 2 / error when nothing matched — silence is not success", async () => {
    const dir = project("lint-src-none-", { "README.md": "no src here\n" });
    const result = await lintSrc(dir);
    expect(result.code).toBe(2);
    expect(result.verdict).toBe("error");
    expect(result.lines[0]).toMatch(/lint-src: no files matched/);
    expect(readGuardLog(dir)).toMatchObject([{ guard: "lint-src", verdict: "error" }]);
  });

  test("a tree of contracts alone matches nothing (contracts are not implementation)", async () => {
    const dir = project("lint-src-contracts-", {
      "src/orders/orders.contract.ts": "export declare const x: number;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(2);
  });

  test("files outside src/ are not linted", async () => {
    const dir = project("lint-src-outside-", {
      "src/orders/orders.ts": "export const x = 1;\n",
      "tests/orders.test.ts": "export const y: any = 1;\n",
      "scripts/build.ts": "export const z: any = 1;\n",
    });
    const result = await lintSrc(dir);
    expect(result.code).toBe(0);
  });
});

// --- CLI ----------------------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "lint-src.ts");

describe("lint-src CLI", () => {
  test("exit 0 with an OK summary", () => {
    const dir = project("lint-src-cli-ok-", { "src/a.ts": "export const x = 1;\n" });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/lint-src: OK \(1 file\)/);
  });

  test("exit 1 and prints the offending line", () => {
    const dir = project("lint-src-cli-bad-", {
      "src/a.ts": "declare const f: () => string | undefined;\nexport const x: string = f()!;\n",
    });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/src\/a\.ts:2:26\s+@typescript-eslint\/no-non-null-assertion/);
  });

  test("exit 2 to stderr when nothing matched", () => {
    const dir = project("lint-src-cli-none-", { "README.md": "\n" });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lint-src: no files matched/);
  });

  test("takes the target directory as an argument", () => {
    const dir = project("lint-src-cli-arg-", { "src/a.ts": "export const x: any = 1;\n" });
    const r = spawnSync(process.execPath, [SCRIPT, dir], { cwd: tmpdir(), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/src\/a\.ts:1:17\s+@typescript-eslint\/no-explicit-any/);
  });

  test("runs when invoked through a symlink (the ~/.pi/agent case)", () => {
    const dir = project("lint-src-cli-link-", { "src/a.ts": "export const x = 1;\n" });
    const link = join(dir, "lint-src.link.ts");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/lint-src: OK/);
  });
});
