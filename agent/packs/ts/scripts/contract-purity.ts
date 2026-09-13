// contract-purity gate (TN-26-001, DESIGN stage): *.contract.ts files must be
// declaration-only AND express the domain in value objects. Thin CLI over
// ESLint + the pi-harness-ts plugin (declaration-only + no-naked-primitives).
// The orchestrator runs this; the architect never lints its own work.
//
// The two rules answer different questions: declaration-only asks "is this a
// well-formed contract?", no-naked-primitives asks "does it say anything?"
// (issue #3 — dogfood runs where a weaker model shipped `isbn: string` past a
// gate that only checked well-formedness).
//
//   node contract-purity.ts ["src/**/*.contract.ts" ...]
//
// Exit 0 clean · 1 problems (one greppable line each) · 2 no files matched
// (silence is not success — a gate that matches nothing is a broken gate).

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { ESLint } from "eslint";
import parser from "@typescript-eslint/parser";
import plugin from "../eslint/index.ts";
import { formatProblems, toProblems, type Problem } from "./lint-report.ts";
export { formatProblems, type Problem };
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent } from "../../../src/guard-log.ts";

/** Every rule id the contract gate enforces — exported for guard-doc-drift. */
export const CONTRACT_RULE_IDS: readonly string[] = [
  "pi-harness-ts/declaration-only",
  "pi-harness-ts/no-naked-primitives",
  "pi-harness-ts/no-branded-aliases",
  "pi-harness-ts/value-object-shape",
  "pi-harness-ts/value-object-documented",
  "pi-harness-ts/value-objects-own-contract",
  "pi-harness-ts/no-cross-contract-type-import",
  "pi-harness-ts/no-erased-router",
  "pi-harness-ts/no-schema-on-surface",
];

export function createContractLinter(): ESLint {
  return new ESLint({
    // The gate owns the whole config: no project eslint config is consulted,
    // so results are identical in every repo.
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.contract.ts"],
        languageOptions: { parser },
        // @typescript-eslint RuleModule and eslint's flat-config Plugin type
        // are structurally incompatible (known upstream friction); runtime fine.
        plugins: { "pi-harness-ts": plugin as unknown as ESLint.Plugin },
        rules: {
          "pi-harness-ts/declaration-only": "error",
          "pi-harness-ts/no-naked-primitives": "error",
          // Run 9: a branded ALIAS with an optional brand passed every gate
          // and enforced nothing; the required form cannot be built without a
          // cast the src lint bans. Classes only.
          "pi-harness-ts/no-branded-aliases": "error",
          // The value object rules. no-naked-primitives says a primitive may
          // not cross the boundary; these two say what must be there instead,
          // and that its validity rule is written down where the test-writer
          // (which reads only spec.md and the contract) can see it.
          "pi-harness-ts/value-object-shape": "error",
          "pi-harness-ts/value-object-documented": "error",
          // A value object and the operations over it may not share a contract
          // file: the value object becomes a runtime class in its skeleton, and
          // a same-file reference to it binds a second '__brand' identity that
          // does not compile (the same-file twin of ADR 2026-023, dogfood
          // r18/r19). Value objects get their own '*.contract.ts'; operations
          // import them from the implementation module (ADR 2026-026).
          "pi-harness-ts/value-objects-own-contract": "error",
          // The cross-FILE twin of value-objects-own-contract: a contract may
          // not import or re-export types from another '*.contract.ts' — reach
          // the sibling component through its implementation module, which
          // re-exports every type its own contract declares. Together the two
          // rules put the whole "one identity per value object" concern (ADR
          // 2026-023) at contract-purity; the scaffolder keeps the same refusal
          // as a backstop (ADR 2026-027).
          "pi-harness-ts/no-cross-contract-type-import": "error",
          // The API-service reference set (TN-26-004). A type-erased framework
          // type on a contract surface throws away the typed client (dogfood
          // r22's `ServiceRouter = AnyRouter`); the inferred router type is
          // re-exported from the implementation module instead (ADR 2026-030).
          "pi-harness-ts/no-erased-router": "error",
          // zod is the engine inside a value object, never a public identity:
          // nothing from zod may appear in a contract (ADR 2026-031).
          "pi-harness-ts/no-schema-on-surface": "error",
        },
      },
    ],
  });
}

export async function lintContractSource(source: string, fileName: string): Promise<Problem[]> {
  const results = await createContractLinter().lintText(source, { filePath: fileName });
  return toProblems(results);
}

/** One greppable line per problem: path:line:col  rule  message */

/** Verdict of one contract-purity run: exit code plus the lines the CLI prints. */
export interface PurityRun {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * Run the contract-purity gate and return its verdict without printing.
 *
 * The architect reaches this through the `contract_purity` tool rather than a
 * shell, and the CLI reaches it through `main`. One implementation, two
 * callers — a gate that differs by how it was invoked is not a gate.
 */
export async function runContractPurity(
  cwd: string,
  patterns: readonly string[] = ["src/**/*.contract.ts"],
): Promise<PurityRun> {
  return await gate(cwd, [...patterns]);
}

async function main(argv: string[]): Promise<number> {
  const result = await gate(process.cwd(), argv.length > 0 ? argv : ["src/**/*.contract.ts"]);
  for (const line of result.lines) {
    if (result.code === 2) console.error(line);
    else console.log(line);
  }
  return result.code;
}

async function gate(cwd: string, patterns: string[]): Promise<PurityRun> {
  const linter = createContractLinter();
  // ESLint throws its own wording when a pattern matches nothing; normalize
  // to the gate's stable message.
  const noMatch = (): PurityRun => {
    const summary = `no files matched [${patterns.join(", ")}]`;
    logGuardEvent(cwd, { guard: "contract-purity", verdict: "error", summary });
    return {
      code: 2,
      lines: [`contract-purity: ${summary} — a gate that matches nothing is a broken gate`],
    };
  };

  let results: ESLint.LintResult[];
  try {
    results = await linter.lintFiles(patterns);
  } catch (e) {
    if (e instanceof Error && /No files matching/.test(e.message)) return noMatch();
    throw e;
  }
  const fileCount = results.length;
  if (fileCount === 0) return noMatch();

  const problems = formatProblems(results, cwd);
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  if (problems.length > 0) {
    const summary = `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files}`;
    logGuardEvent(cwd, {
      guard: "contract-purity",
      verdict: "block",
      summary,
      detail: { problems: toProblems(results) },
    });
    return { code: 1, lines: [...problems, `contract-purity: ${summary}`] };
  }
  const summary = `OK (${files})`;
  logGuardEvent(cwd, { guard: "contract-purity", verdict: "pass", summary });
  return { code: 0, lines: [`contract-purity: ${summary}`] };
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
      console.error(`contract-purity: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
