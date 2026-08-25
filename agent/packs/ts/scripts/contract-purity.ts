// contract-purity gate (TN-26-001, DESIGN stage): *.contract.ts files must be
// declaration-only. Thin CLI over ESLint + the pi-harness-ts plugin
// (declaration-only rule). The orchestrator runs this; the architect never
// lints its own work.
//
//   node contract-purity.ts ["src/**/*.contract.ts" ...]
//
// Exit 0 clean · 1 problems (one greppable line each) · 2 no files matched
// (silence is not success — a gate that matches nothing is a broken gate).

import { pathToFileURL } from "node:url";
import { relative } from "node:path";
import { ESLint } from "eslint";
import parser from "@typescript-eslint/parser";
import plugin from "../eslint/index.ts";
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent } from "../../../src/guard-log.ts";

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
        rules: { "pi-harness-ts/declaration-only": "error" },
      },
    ],
  });
}

export interface Problem {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
}

export async function lintContractSource(source: string, fileName: string): Promise<Problem[]> {
  const results = await createContractLinter().lintText(source, { filePath: fileName });
  return toProblems(results);
}

function toProblems(results: ESLint.LintResult[]): Problem[] {
  return results.flatMap((r) =>
    r.messages
      .filter((m) => m.severity === 2)
      .map((m) => ({
        filePath: r.filePath,
        line: m.line,
        column: m.column,
        ruleId: m.ruleId ?? "<parse>",
        message: m.message,
      })),
  );
}

/** One greppable line per problem: path:line:col  rule  message */
export function formatProblems(results: ESLint.LintResult[], cwd: string): string[] {
  return toProblems(results).map(
    (p) => `${relative(cwd, p.filePath)}:${p.line}:${p.column}  ${p.ruleId}  ${p.message}`,
  );
}

async function main(argv: string[]): Promise<number> {
  const patterns = argv.length > 0 ? argv : ["src/**/*.contract.ts"];
  const linter = createContractLinter();
  // ESLint throws its own wording when a pattern matches nothing; normalize
  // to the gate's stable message.
  let results: ESLint.LintResult[];
  try {
    results = await linter.lintFiles(patterns);
  } catch (e) {
    if (e instanceof Error && /No files matching/.test(e.message)) {
      console.error(`contract-purity: no files matched [${patterns.join(", ")}] — a gate that matches nothing is a broken gate`);
      logGuardEvent(process.cwd(), {
        guard: "contract-purity",
        verdict: "error",
        summary: `no files matched [${patterns.join(", ")}]`,
      });
      return 2;
    }
    throw e;
  }
  const fileCount = results.length;
  if (fileCount === 0) {
    console.error(`contract-purity: no files matched [${patterns.join(", ")}] — a gate that matches nothing is a broken gate`);
    logGuardEvent(process.cwd(), {
      guard: "contract-purity",
      verdict: "error",
      summary: `no files matched [${patterns.join(", ")}]`,
    });
    return 2;
  }
  const lines = formatProblems(results, process.cwd());
  for (const line of lines) console.log(line);
  if (lines.length > 0) {
    console.log(`contract-purity: ${lines.length} problem${lines.length === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`);
    logGuardEvent(process.cwd(), {
      guard: "contract-purity",
      verdict: "block",
      summary: `${lines.length} problem${lines.length === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`,
      detail: { problems: toProblems(results) },
    });
    return 1;
  }
  console.log(`contract-purity: OK (${fileCount} file${fileCount === 1 ? "" : "s"})`);
  logGuardEvent(process.cwd(), {
    guard: "contract-purity",
    verdict: "pass",
    summary: `OK (${fileCount} file${fileCount === 1 ? "" : "s"})`,
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`contract-purity: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
