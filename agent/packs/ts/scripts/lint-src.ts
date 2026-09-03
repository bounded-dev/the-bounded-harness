// lint-src gate (TN-26-001, BUILD stage): src/** may not switch the type
// checker off. Thin CLI over an ESLint flat config the gate owns outright.
//
//   node lint-src.ts [targetDir]
//
// Exit 0 clean · 1 problems (one greppable line each) · 2 no files matched
// (silence is not success — a gate that matches nothing is a broken gate).
//
// WHY THIS EXISTS. Dogfood Run 7 shipped a runtime contract violation, and
// the type checker had already caught it: `tsc` correctly typed
// `findInvoiceByOperationId(...)` as `Invoice | undefined`, and the builder
// wrote `!` to make the error go away. The type checker is a harness layer,
// and TypeScript ships exactly four switches that turn it off for one
// expression:
//
//   x!            no-non-null-assertion
//   x as T        consistent-type-assertions (assertionStyle: "never")
//   any           no-explicit-any
//   @ts-*         ban-ts-comment
//
// A model under pressure to reach green takes the cheapest path out, so the
// ban has NO exemption list: @ts-expect-error is banned even WITH a
// description (the plausible-sounding description is exactly what a model
// under pressure produces), and `linterOptions.noInlineConfig` means an
// `eslint-disable` comment cannot reopen any of the four from inside the file
// it is meant to police.
//
// `as const` REMAINS LEGAL, and that is not an exemption we granted:
// assertionStyle "never" exempts const assertions itself (verified against
// @typescript-eslint 8.68 — see lint-src.test.ts). `as const` narrows a
// literal; it never widens a type or silences a check. `satisfies` is legal
// for the same reason — it asks the checker a question instead of overruling
// its answer.
//
// Like contract-purity, this gate owns its ENTIRE flat config
// programmatically and consults no project config file: the target project
// never has an eslint config, so nothing in the target tree can weaken these
// rules. *.contract.ts is out of scope — that is the architect's zone, and
// contract-purity polices it.

import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { realpathSync } from "node:fs";
import { ESLint } from "eslint";
import { formatProblems, toProblems, type Problem } from "./lint-report.ts";
export type { Problem };
import parser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";

const GUARD = "lint-src";

const NOTHING_TO_LINT = /No files matching|are ignored/;

/** What the gate walks when no explicit patterns are given. */
export const DEFAULT_PATTERNS: readonly string[] = ["src/**/*.ts"];

/** Test sources get the same escape-hatch ban — Run 10's test helpers used `!`
 *  freely because only src/** was watched, and a suite that silences the type
 *  checker can assert its way past anything. Size ceilings deliberately do NOT
 *  apply here: a thorough suite legitimately runs long, and a describe block
 *  is one "function" to max-lines-per-function. */
export const TEST_PATTERNS: readonly string[] = ["tests/**/*.ts"];
const SIZE_RULES = new Set(["complexity", "max-lines-per-function", "max-lines", "max-depth"]);

/** Every rule id the src gate enforces — exported so guard-doc-drift.test.ts
 *  can require each one to be named in builder.md. The deterministic-check
 *  principle runs both ways: everything guarded must also be TOLD to the
 *  agent, so it can get it right the first time instead of learning the rule
 *  from a block. */
export const SRC_RULE_IDS: readonly string[] = [
  "complexity",
  "max-lines-per-function",
  "max-lines",
  "max-depth",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/consistent-type-assertions",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/ban-ts-comment",
];

/** The subset enforced on tests/** (size ceilings excluded). */
export const TEST_RULE_IDS: readonly string[] = SRC_RULE_IDS.filter((r) => !SIZE_RULES.has(r));

export function createSrcLinter(cwd?: string): ESLint {
  return new ESLint({
    // The gate owns the whole config: no project eslint config is consulted,
    // so results are identical in every repo.
    overrideConfigFile: true,
    ...(cwd === undefined ? {} : { cwd }),
    overrideConfig: [
      // Global ignore (a config object with only `ignores`): contract files
      // never enter the results at all, so they cannot inflate the file count
      // that decides "did this gate match anything?".
      { ignores: ["**/*.contract.ts"] },
      {
        files: ["**/*.ts"],
        languageOptions: { parser },
        // @typescript-eslint RuleModule and eslint's flat-config Plugin type
        // are structurally incompatible (known upstream friction); runtime fine.
        plugins: { "@typescript-eslint": tsPlugin as unknown as ESLint.Plugin },
        // The file under inspection does not get a vote on whether it is
        // inspected: no eslint-disable, no inline severity override.
        linterOptions: { noInlineConfig: true },
        rules: {
          // --- Size and complexity ceilings -------------------------------
          // Run 10: kimi produced a 483-line single-module implementation and
          // a 148-test monolith; opus, same prompt and gates, produced four
          // focused modules. Decomposition quality tracks the model — but a
          // CEILING is mechanical, and these are core ESLint rules (the
          // complexity half of the CRAP metric; its coverage half is
          // deliberately absent — an assertion-blind coverage signal is the
          // exact lie test-obligations.ts exists to close).
          // Thresholds are ceilings, not targets: generous enough that a
          // correct design never meets them, low enough that a god-module
          // cannot ship. A block's remedy is decomposition, and for a builder
          // that usually means CONTRACT-DISPUTE — the architect owns the
          // module boundaries.
          complexity: ["error", { max: 15 }],
          "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
          "max-lines": ["error", { max: 350, skipBlankLines: true, skipComments: true }],
          "max-depth": ["error", { max: 4 }],
          "@typescript-eslint/no-non-null-assertion": "error",
          // "never" bans both `x as T` and `<T>x`, and exempts `as const`.
          "@typescript-eslint/consistent-type-assertions": [
            "error",
            { assertionStyle: "never" },
          ],
          "@typescript-eslint/no-explicit-any": ["error", { ignoreRestArgs: false }],
          // `true` = always report, so a description buys nothing. ts-check is
          // left alone: it turns checking ON.
          "@typescript-eslint/ban-ts-comment": [
            "error",
            {
              "ts-expect-error": true,
              "ts-ignore": true,
              "ts-nocheck": true,
              "ts-check": false,
            },
          ],
        },
      },
    ],
  });
}

/** Lint one source text as if it lived at `fileName`. Pure: touches no disk. */
export async function lintSrcText(source: string, fileName: string): Promise<Problem[]> {
  const results = await createSrcLinter().lintText(source, { filePath: fileName });
  return toProblems(results);
}

/** One greppable line per problem: path:line:col  rule  message */
export function formatSrcProblems(results: ESLint.LintResult[], cwd: string): string[] {
  return formatProblems(results, cwd);
}

/** Verdict of one lint-src run: the same shape the red/green gates return. */
export interface LintSrcResult {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  /** Greppable output lines (last line is the verdict headline). */
  readonly lines: string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Run the lint-src gate over a target project and return its verdict without
 * printing or exiting. The CLI below is a thin wrapper over this, so there is
 * exactly one implementation of "does this src/ switch the checker off".
 */
export async function lintSrc(
  cwd: string,
  patterns: readonly string[] = DEFAULT_PATTERNS,
): Promise<LintSrcResult> {
  const result = await classify(cwd, [...patterns]);
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: result.detail,
  });
  return result;
}

/**
 * The tests/** variant: same escape-hatch rules, size ceilings filtered out,
 * `tests/generated/**` excluded (machine-written; the generator is trusted the
 * way the scaffolder is). Run inside the red gate, so an offending helper is
 * the test-writer's to fix at the moment fixing is cheap.
 */
export async function lintTests(cwd: string): Promise<LintSrcResult> {
  const base = await classify(cwd, [...TEST_PATTERNS], { dropSizeRules: true });
  const result = base.code === 2
    ? // No test files yet is a legitimate state mid-loop, not a broken gate.
      { ...base, code: 0 as const, verdict: "pass" as const, summary: "no test files yet", lines: [`${GUARD}: no test files yet`] }
    : base;
  logGuardEvent(cwd, { guard: "lint-tests", verdict: result.verdict, summary: result.summary, detail: result.detail });
  return result;
}

async function classify(cwd: string, patterns: string[], options: { dropSizeRules?: boolean } = {}): Promise<LintSrcResult> {
  // ESLint throws its own wording when a pattern matches nothing — two
  // wordings, in fact: "No files matching …" when the glob found nothing at
  // all, and "All files matched … are ignored" when src/ holds only contract
  // files. Both mean the same thing here; normalize to the gate's message.
  const noMatch = (): LintSrcResult => {
    const summary = `no files matched [${patterns.join(", ")}]`;
    return {
      code: 2,
      verdict: "error",
      summary,
      lines: [`${GUARD}: ${summary} — a gate that matches nothing is a broken gate`],
      detail: { patterns },
    };
  };

  let results: ESLint.LintResult[];
  try {
    results = await createSrcLinter(cwd).lintFiles(patterns);
  } catch (e) {
    if (e instanceof Error && NOTHING_TO_LINT.test(e.message)) return noMatch();
    throw e;
  }
  const fileCount = results.length;
  if (fileCount === 0) return noMatch();

  if (options.dropSizeRules) {
    for (const r of results) {
      r.messages = r.messages.filter((m) => m.ruleId === null || !SIZE_RULES.has(m.ruleId));
    }
  }
  if (options.dropSizeRules) {
    // Machine-written laws are excluded the way scaffolded skeletons are:
    // the generator, not the test-writer, answers for them.
    results = results.filter((r) => !/tests[\/\\]generated[\/\\]/.test(r.filePath));
  }
  const lines = formatSrcProblems(results, cwd);
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  if (lines.length > 0) {
    const summary = `${lines.length} problem${lines.length === 1 ? "" : "s"} in ${files}`;
    return {
      code: 1,
      verdict: "block",
      summary,
      lines: [...lines, `${GUARD}: ${summary}`],
      detail: { problems: toProblems(results) },
    };
  }
  const summary = `OK (${files})`;
  return { code: 0, verdict: "pass", summary, lines: [`${GUARD}: ${summary}`], detail: {} };
}

async function main(argv: string[]): Promise<number> {
  const result = await lintSrc(argv[0] ?? process.cwd());
  for (const line of result.lines) {
    if (result.code === 2) console.error(line);
    else console.log(line);
  }
  return result.code;
}

// Symlink-safe main check: the harness is reached via the ~/.pi/agent symlink,
// so argv[1] (symlink path) and import.meta.url (realpath) differ — compare realpaths.
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
      console.error(`${GUARD}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
