// design gate (issue #13): the DESIGN phase as ONE call with ONE verdict.
//
//   node design-gate.ts [targetDir] [pattern ...]
//
// purity → scaffold → typecheck → freeze, in that order, stopping at the first
// failure. Every step is the SAME `run*` function the individual gates and the
// CLI already call — this file sequences and reports, and reimplements no
// check. A composite that re-checked anything would be a second, drifting
// implementation of a gate, which is the one thing the gate tools exist to
// avoid.
//
// Why a composite at all. The four steps were four architect tool calls with a
// mandatory order, and the order lived in prose. Across dogfood runs that cost
// 3–6 minutes per ticket of round-trips, plus the ordering fumbles prose always
// eventually produces: freezing before scaffolding, scaffolding a contract that
// never passed purity, typechecking nothing because the skeletons were not
// generated yet. A sequence with one entry point cannot be run out of order.
//
// The inner runners keep logging their own guard events — "contract-purity",
// "scaffold", "checksum-gate" — because the phase gate derives the DESIGN
// ordering from exactly those names. This gate adds ONE composite event,
// "design-gate", carrying every step's outcome and wall-clock duration.
//
// Exit 0 pass · 1 block · 2 misuse (a step could not run at all). Logs to the
// target's .pi/guard-log.jsonl.
//
// NOTE: the purity step's globs resolve from the PROCESS cwd (ESLint's own
// default, shared with the `contract_purity` tool) — run this in the project
// directory, which is what both the tool and the CLI do.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runContractPurity } from "./contract-purity.ts";
import { runScaffold } from "./scaffold-contract.ts";
import { runChecksumGate } from "./checksum-gate.ts";
import { gateTypecheckOptionsFromEnv } from "./red-gate.ts";
import { formatTypecheck, typecheck } from "./typecheck.ts";
import { routeTypecheck, typecheckLines } from "./typecheck-routing.ts";
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";

const GUARD = "design-gate";

/** The four steps, in the only order they are legal in. */
export const DESIGN_STEPS = ["contract-purity", "scaffold", "typecheck", "freeze"] as const;

export type DesignStep = (typeof DESIGN_STEPS)[number];

export interface StepOutcome {
  readonly step: DesignStep;
  readonly code: number;
  /** The step's own output, verbatim from its runner. */
  readonly lines: readonly string[];
  /** Wall clock for this step, milliseconds. */
  readonly ms: number;
}

export interface DesignGateResult {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  readonly lines: readonly string[];
  /** Only the steps that actually ran: the sequence stops at the first failure. */
  readonly steps: readonly StepOutcome[];
  readonly detail: Readonly<Record<string, unknown>>;
}

/** One decimal second — enough to see which step is costing the round-trip. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function stepVerdict(code: number): string {
  return code === 0 ? "PASS" : code === 1 ? "BLOCK" : "ERROR";
}

function guardVerdictOf(code: number): GuardVerdict {
  return code === 0 ? "pass" : code === 1 ? "block" : "error";
}

/**
 * Turn the steps that ran into the gate's output. Pure: no I/O, no logging.
 *
 * Every design-phase failure routes to the architect. That is not a fallback
 * for want of better attribution — at DESIGN nothing downstream exists yet:
 * there are no tests and no implementation, so no other role could hold a
 * defect even in principle. The typecheck step still PRINTS
 * typecheck-routing's per-owner attribution, because a diagnostic in a
 * generated skeleton points at a different contract defect than one in the
 * contract itself, and that is worth seeing. It just never changes the route.
 */
export function classifyDesignGate(steps: readonly StepOutcome[]): {
  readonly code: 0 | 1 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  readonly lines: string[];
} {
  const lines: string[] = [];
  for (const s of steps) {
    lines.push(...s.lines, `${s.step}: ${stepVerdict(s.code)} (${seconds(s.ms)})`);
  }
  const total = steps.reduce((sum, s) => sum + s.ms, 0);
  const failed = steps.find((s) => s.code !== 0);

  if (failed === undefined) {
    return {
      code: 0,
      verdict: "pass",
      summary: `OK (${DESIGN_STEPS.join(" → ")}, ${seconds(total)})`,
      lines: [...lines, `${GUARD}: OK — ${DESIGN_STEPS.join(" → ")} (${seconds(total)})`],
    };
  }

  const skipped = DESIGN_STEPS.slice(DESIGN_STEPS.indexOf(failed.step) + 1);
  const what = failed.code === 1 ? "blocked" : "could not run";
  return {
    code: failed.code === 1 ? 1 : 2,
    verdict: guardVerdictOf(failed.code),
    summary: `${failed.step} ${what} (route: architect)`,
    lines: [
      ...lines,
      `${GUARD}: FAIL — ${failed.step} ${what}` +
        (skipped.length > 0 ? `; ${skipped.join(", ")} did not run` : ""),
      `${GUARD}: route → architect`,
    ],
  };
}

/** The project typecheck, run exactly as the red and green gates run it — same
 *  runner, same env seam, same routing renderer. */
async function runProjectTypecheck(cwd: string): Promise<{ code: number; lines: readonly string[] }> {
  const result = await typecheck(cwd, gateTypecheckOptionsFromEnv());
  if (result.ok) return { code: 0, lines: [formatTypecheck(result)] };

  const routing = routeTypecheck(result.diagnostics);
  if (routing.errorCount === 0) {
    // tsc failed without emitting a parseable diagnostic — a broken tsconfig, a
    // crash, a missing toolchain. That is misuse (the gate could not run), not
    // a design defect, and claiming "0 type errors" would be a lie.
    return {
      code: 2,
      lines: [
        "typecheck: ERROR — tsc failed without a parseable diagnostic",
        ...result.diagnostics.map((l) => `  ${l}`),
      ],
    };
  }
  const plural = routing.errorCount === 1 ? "" : "s";
  return {
    code: 1,
    // typecheckLines' first line is its own count headline; the rest is the
    // per-owner attribution, reused verbatim rather than re-rendered here.
    lines: [`typecheck: ${routing.errorCount} type error${plural}`, ...typecheckLines(routing).slice(1)],
  };
}

/**
 * Run the whole DESIGN phase and return one verdict.
 *
 * The architect reaches this through the `design_gate` tool and the CLI below
 * reaches it here, so the gate cannot differ by how it was invoked.
 */
export async function runDesignGate(
  cwd: string,
  patterns?: readonly string[],
): Promise<DesignGateResult> {
  const sequence: readonly {
    readonly step: DesignStep;
    readonly run: () => Promise<{ code: number; lines: readonly string[] }>;
  }[] = [
    { step: "contract-purity", run: () => runContractPurity(cwd, patterns) },
    { step: "scaffold", run: async () => runScaffold(cwd) },
    { step: "typecheck", run: () => runProjectTypecheck(cwd) },
    // Freezing LAST is the whole point of the order: the manifest must record
    // the contract that passed every check, not the one that was written.
    { step: "freeze", run: async () => runChecksumGate(cwd, true) },
  ];

  const steps: StepOutcome[] = [];
  for (const { step, run } of sequence) {
    const started = Date.now();
    const r = await run();
    steps.push({ step, code: r.code, lines: [...r.lines], ms: Date.now() - started });
    if (r.code !== 0) break; // stop at the first failure — nothing downstream is meaningful
  }

  const verdict = classifyDesignGate(steps);
  const failed = steps.find((s) => s.code !== 0);
  const detail = {
    steps: steps.map((s) => ({
      step: s.step,
      code: s.code,
      verdict: guardVerdictOf(s.code),
      ms: s.ms,
    })),
    ms: steps.reduce((sum, s) => sum + s.ms, 0),
    ...(failed !== undefined ? { failed: failed.step, route: "architect" } : {}),
  };
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: verdict.verdict,
    summary: verdict.summary,
    detail,
  });
  return { ...verdict, steps, detail };
}

// --- CLI ------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const patterns = argv.slice(1);
  const result = await runDesignGate(argv[0] ?? process.cwd(), patterns.length > 0 ? patterns : undefined);
  for (const line of result.lines) console.log(line);
  return result.code;
}

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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`design-gate: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
