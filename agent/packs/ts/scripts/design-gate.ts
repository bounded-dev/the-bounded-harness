// design gate (issue #13): the DESIGN phase as ONE call with ONE verdict.
//
//   node design-gate.ts [targetDir] [pattern ...]
//
// purity → scaffold → typecheck → design-review → freeze, in that order,
// stopping at the first failure. Every step is the SAME `run*` function the
// individual gates and the CLI already call — this file sequences and reports,
// and reimplements no check. A composite that re-checked anything would be a
// second, drifting implementation of a gate, which is the one thing the gate
// tools exist to avoid.
//
// The design-review step is the one that does not run anything: it reads the
// guard log and refuses to freeze a design no reviewer has read AS IT NOW
// STANDS (issue #13 §2). The reviewer's findings are advisory — the architect
// settles them — so this gate never judges one. What it enforces is that a
// review EXISTS and that it covers the current bytes, which is the half a
// machine can decide.
//
// It also REPLAYS the findings verbatim. Not judging a finding is not the same
// as not showing it, and the two were conflated: the step printed "fresh (3
// findings, 1 blocker)" and stopped. The reviewer holds `record_design_review`
// and the architect does not, so the count was the only thing about the review
// the architect could ever see — and r15's architect duly went looking for the
// text, tried `git` three times, and finally revived the reviewer to make it
// recite what this gate was already holding. Printing the claims costs nothing
// and settles them one round-trip earlier; judging them is still nobody's job
// here.
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
import { diffManifests, hasDrift, hasManifest, runChecksumGate } from "./checksum-gate.ts";
import { findingLines, FREEZABLE_NOW, readReviewed, recordedFindings, type Reviewed } from "./design-review.ts";
import type { Finding } from "./sign-off.ts";
import { gateTypecheckOptionsFromEnv } from "./red-gate.ts";
import { formatTypecheck, typecheck } from "./typecheck.ts";
import { routeTypecheck, typecheckLines } from "./typecheck-routing.ts";
import { logGuardEvent, readGuardLog, type GuardVerdict, type LoggedGuardEvent } from "../../../src/guard-log.ts";

const GUARD = "design-gate";
const REVIEW_GUARD = "design-review";

/** The five steps, in the only order they are legal in. */
export const DESIGN_STEPS = [
  "contract-purity",
  "scaffold",
  "typecheck",
  "design-review",
  "freeze",
] as const;

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
 * How a step's block reads in the gate's ONE failure line. "blocked" is right
 * for a check that ran and said no; the review step never runs anything, so
 * saying it "blocked" would send the architect looking for output that does
 * not exist. The next line names which of the two it was.
 */
const BLOCK_PHRASE: Partial<Record<DesignStep, string>> = {
  "design-review": "missing (or stale)",
};

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

  // What did NOT run is every step absent from `steps`, in canonical order —
  // not "everything after the failure". On the normal path those are the same
  // list, because the sequence is a prefix. On the re-freeze fast path below
  // the review is evaluated FIRST, so the steps that never ran sit BEFORE the
  // failure as well as after it, and slicing would quietly under-report them.
  const ran = new Set(steps.map((s) => s.step));
  const skipped = DESIGN_STEPS.filter((step) => !ran.has(step));
  const what = failed.code === 1 ? (BLOCK_PHRASE[failed.step] ?? "blocked") : "could not run";
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

// --- the design-review step -----------------------------------------------------

/**
 * What the guard log says about the design AS IT NOW STANDS.
 *
 * `fresh` carries the counts AND the findings themselves. The counts are what
 * the gate reasons about (nothing here judges a finding — that is the
 * architect's call, and a gate that could judge one would not need a
 * reviewer); the findings are what it hands on, because the architect cannot
 * reach them any other way.
 */
export type ReviewFreshness =
  | {
      readonly state: "fresh";
      readonly at: string;
      readonly findings: number;
      readonly blockers: number;
      /** The claims themselves, as the reviewer recorded them. */
      readonly recorded: readonly Finding[];
    }
  | { readonly state: "missing" }
  | {
      readonly state: "stale";
      readonly at: string;
      readonly changed: readonly string[];
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  /** The design cannot be reviewed at all (no spec.md), so it cannot be fresh. */
  | { readonly state: "unreviewable"; readonly reason: string };

/** The `detail.reviewed` map of a recorded review, or undefined if it carries none. */
function reviewedBytes(event: LoggedGuardEvent): Reviewed | undefined {
  const raw = (event.detail as { reviewed?: unknown } | undefined)?.reviewed;
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [file, hash] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof hash !== "string") return undefined;
    out[file] = hash;
  }
  return out;
}

/**
 * What the review said: the counts the gate reasons about, and the claims it
 * replays. A malformed detail counts zero and replays nothing — an older event
 * that recorded only severities still yields its counts, which is why the
 * counts are not simply `recorded.length`.
 */
function reviewCounts(event: LoggedGuardEvent): {
  findings: number;
  blockers: number;
  recorded: Finding[];
} {
  const detail = event.detail as
    | { findings?: unknown; severities?: unknown; blockers?: unknown }
    | undefined;
  const severities = Array.isArray(detail?.severities) ? detail.severities : [];
  return {
    findings: Array.isArray(detail?.findings) ? detail.findings.length : severities.length,
    blockers:
      typeof detail?.blockers === "number"
        ? detail.blockers
        : severities.filter((s) => s === "blocker").length,
    recorded: recordedFindings(event.detail),
  };
}

/**
 * Does a recorded review cover the design as it now stands? Pure: no I/O.
 *
 * THE LATEST PASS BY APPEND ORDER is the review that stands — the same rule
 * green-gate uses for the red it requires, and for the same reason: "the last
 * thing the log says" is one event to find and cannot depend on how long the
 * log is. Accepting any older matching review instead would turn a freshness
 * check into a search through history for a set of bytes the reviewer once
 * saw; the only case that costs anything is an edit reverted after a second
 * review, and that costs one re-review.
 *
 * `verdict: "error"` events are misuse — no spec, no contracts, a malformed
 * payload — and are not reviews. So is a pass carrying no byte record: it
 * demonstrably covers nothing.
 */
export function classifyReviewFreshness(
  events: readonly LoggedGuardEvent[],
  current: Reviewed,
): ReviewFreshness {
  let latest: LoggedGuardEvent | undefined;
  for (const e of events) {
    if (e.guard === REVIEW_GUARD && e.verdict === "pass") latest = e;
  }
  if (latest === undefined) return { state: "missing" };

  const reviewed = reviewedBytes(latest);
  if (reviewed === undefined) return { state: "missing" };

  // checksum-gate's own differ over checksum-gate's own hashes: "the bytes the
  // reviewer read" and "the bytes the freeze records" are one question asked
  // twice, never two implementations that can disagree.
  const drift = diffManifests({ files: reviewed }, { files: current });
  if (hasDrift(drift)) {
    return {
      state: "stale",
      at: latest.ts,
      changed: drift.changed,
      added: drift.added,
      removed: drift.removed,
    };
  }
  return { state: "fresh", at: latest.ts, ...reviewCounts(latest) };
}

/** Time of day from an ISO timestamp — enough to find the line in the log. */
function clock(ts: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return match ? `${match[1]}Z` : ts;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Render the freshness verdict as the step's output. Pure: no I/O. */
export function reviewStepOutcome(freshness: ReviewFreshness): {
  code: 0 | 1;
  lines: string[];
} {
  const commission =
    "  Commission the `reviewer` subagent on spec.md and every *.contract.ts; it";
  switch (freshness.state) {
    case "fresh":
      return {
        code: 0,
        // A PASSING step still prints why it passed: a gate that is silent when
        // it agrees leaves "reviewed and clean" and "never checked" looking
        // identical in the transcript, which is the failure the review exists
        // to fix one level up.
        lines: [
          `design-review: fresh (${count(freshness.findings, "finding")}, ` +
            `${count(freshness.blockers, "blocker")}, recorded ${clock(freshness.at)})`,
          // Verbatim, because you hold no `record_design_review` and this is
          // the only place the reviewer's words reach you.
          ...findingLines(freshness.recorded),
          ...(freshness.blockers > 0
            ? [
                `design-review: ${count(freshness.blockers, "blocker")} recorded — advisory: the freeze does not wait on it`,
                "  and nothing downstream raises it again, so settling it is yours.",
              ]
            : // The polish-loop nudge (r15/r16): zero blockers means freezable
              // now. Advisory, no verdict changes — see FREEZABLE_NOW.
              [FREEZABLE_NOW]),
        ],
      };
    case "missing":
      return {
        code: 1,
        lines: [
          "design-review: BLOCK — this design has never been reviewed",
          commission,
          "  records what it found with record_design_review. Settle each blocker —",
          "  fix it, or say in your next design_gate run why it stands — then run",
          "  design_gate again.",
        ],
      };
    case "stale":
      return {
        code: 1,
        lines: [
          `design-review: BLOCK — reviewed at ${clock(freshness.at)}, then edited`,
          ...(freshness.changed.length > 0 ? [`  changed since that review: ${freshness.changed.join(", ")}`] : []),
          ...(freshness.added.length > 0 ? [`  added since that review: ${freshness.added.join(", ")}`] : []),
          ...(freshness.removed.length > 0 ? [`  removed since that review: ${freshness.removed.join(", ")}`] : []),
          "  A review covers the bytes it read and nothing else, so a revised design is",
          "  an unreviewed design. Re-commission the `reviewer` on it as it now stands,",
          "  settle its findings, then run design_gate again.",
        ],
      };
    case "unreviewable":
      return {
        code: 1,
        lines: [`design-review: BLOCK — ${freshness.reason}`, commission, "  records what it found."],
      };
  }
}

/**
 * The freshness check, with its one I/O step: read the design's current bytes
 * and the guard log, then classify.
 */
function runDesignReviewStep(cwd: string): {
  code: number;
  lines: readonly string[];
  freshness: ReviewFreshness;
} {
  const design = readReviewed(cwd);
  const freshness: ReviewFreshness = design.ok
    ? classifyReviewFreshness(readGuardLog(cwd), design.reviewed)
    : { state: "unreviewable", reason: design.error };
  return { ...reviewStepOutcome(freshness), freshness };
}

/**
 * The one line an early-blocked re-freeze prints before the review's own
 * output, so the transcript says why design-review is speaking out of turn.
 */
const EARLY_NOTICE =
  `${GUARD}: already frozen, so design-review is checked FIRST — a stale review blocks before anything is re-run`;

/** Classify, log the composite event, return. Shared by both entry paths so a
 *  fast-path block is reported and recorded exactly like any other. */
function finishDesignGate(
  cwd: string,
  steps: readonly StepOutcome[],
  review: ReviewFreshness | undefined,
  extra: Readonly<Record<string, unknown>>,
): DesignGateResult {
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
    ...(review !== undefined ? { review } : {}),
    ...(failed !== undefined ? { failed: failed.step, route: "architect" } : {}),
    ...extra,
  };
  logGuardEvent(cwd, { guard: GUARD, verdict: verdict.verdict, summary: verdict.summary, detail });
  return { ...verdict, steps: [...steps], detail };
}

/**
 * Run the whole DESIGN phase and return one verdict.
 *
 * The architect reaches this through the `design_gate` tool and the CLI below
 * reaches it here, so the gate cannot differ by how it was invoked.
 *
 * ORDER, AND THE ONE EXCEPTION. The five steps have exactly one legal order and
 * the sequence below is it. But on a RE-FREEZE — a project that already has a
 * checksum manifest, so this design has been through the gate before — the
 * review-freshness step is evaluated first, as a pre-flight, and a stale or
 * missing review blocks there.
 *
 * That is sound because freshness is the one step whose answer does not depend
 * on any other: it compares the guard log against the CURRENT bytes of spec.md
 * and the contracts, and neither purity nor scaffolding nor tsc writes those.
 * (Scaffolding writes skeletons and law suites, which no review covers.) It is
 * worth doing because run r14 paid a full purity + scaffold + typecheck pass,
 * repeatedly, only to be told at step four to go and commission the reviewer.
 *
 * It applies only to a re-freeze. A FIRST run has no earlier review to be stale
 * against, so the fast path could only ever report "never reviewed" — which is
 * the normal state of a design being frozen for the first time — and it would
 * report it before scaffolding, which is what has to happen before anything can
 * typecheck at all.
 *
 * HOW THE TWO CASES READ. An early block prints EARLY_NOTICE, then the review's
 * own lines, then the one FAIL line naming the four steps that did not run: the
 * out-of-turn position is stated rather than left to be inferred. An early PASS
 * is SILENT — the pre-flight prints nothing and the step runs again in its own
 * position, where its `design-review: fresh (…)` line appears between typecheck
 * and freeze exactly as it always has. The second evaluation costs one guard-log
 * read and keeps the passing narrative in the canonical order, which is the half
 * of the transcript anyone reads twice.
 */
export async function runDesignGate(
  cwd: string,
  patterns?: readonly string[],
): Promise<DesignGateResult> {
  // Set by the design-review step below, so the composite event can record what
  // the review said as well as that it ran.
  let review: ReviewFreshness | undefined;

  const reFreeze = hasManifest(cwd);
  if (reFreeze) {
    const started = Date.now();
    const early = runDesignReviewStep(cwd);
    if (early.code !== 0) {
      return finishDesignGate(
        cwd,
        [
          {
            step: "design-review",
            code: early.code,
            lines: [EARLY_NOTICE, ...early.lines],
            ms: Date.now() - started,
          },
        ],
        early.freshness,
        { reFreeze: true, checkedFirst: "design-review" },
      );
    }
  }
  const sequence: readonly {
    readonly step: DesignStep;
    readonly run: () => Promise<{ code: number; lines: readonly string[] }>;
  }[] = [
    { step: "contract-purity", run: () => runContractPurity(cwd, patterns) },
    { step: "scaffold", run: async () => runScaffold(cwd) },
    { step: "typecheck", run: () => runProjectTypecheck(cwd) },
    // Reviewed BEFORE the freeze, because after it the review is worth a
    // fraction of what it cost: run r13 measured 30–38 minutes to repair a
    // contract defect discovered once the test-writer was already building on
    // it. The step reads the log and runs nothing, so it is also the cheapest
    // in the sequence — it just has to sit where a failure is still free.
    {
      step: "design-review",
      run: async () => {
        const r = runDesignReviewStep(cwd);
        review = r.freshness;
        return { code: r.code, lines: r.lines };
      },
    },
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

  return finishDesignGate(cwd, steps, review, { reFreeze });
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
