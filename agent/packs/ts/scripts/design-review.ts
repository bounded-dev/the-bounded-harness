// design-review (issue #13 §2): the reviewer's pen.
//
//   node design-review.ts [targetDir] '<findings json>'
//
// THE DESIGN PHASE HAD NO REVIEW STEP. The architect wrote a spec and a
// contract, and the only quality check on either was "commission the
// test-writer and see what explodes". Live run r13 measured the bill: a
// contract frozen as four files, ~38 minutes lost mid-loop to collapsing it to
// one, and the discovery arrived as 129 type errors when the test-writer's
// output met the frozen contract. Every one of those errors was legible in the
// contract before a single test existed — nobody was asked to look.
//
// So somebody is asked to look, before the freeze. The reviewer reads the spec
// and every contract as the two blind consumers will, and records what it found
// here. Like sign-off, THIS GATE RECORDS A CLAIM AND NEVER JUDGES ONE: whether
// a finding is real is the architect's call, and a gate that could decide it
// would not need the reviewer. What the gate guarantees is that the answer
// EXISTS, in a greppable line, including the answer "I found nothing" — a
// silence and a clean review are indistinguishable unless one of them is
// written down.
//
// The record is CHECKSUM-BOUND. A review is a review of specific bytes, and the
// bytes are still editable when it is recorded: the architect may revise the
// spec or the contract in response to a finding, which is the point of hearing
// it. So the event carries a sha256 per file, computed exactly as checksum-gate
// computes them, and any later edit makes the review demonstrably stale rather
// than silently obsolete.
//
// Exit 0 recorded · 2 misuse (no spec.md, no contracts, malformed findings).
// There is no exit 1: findings are not a failure, they are the deliverable.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logGuardEvent, type GuardVerdict } from "../../../src/guard-log.ts";
import { computeManifest, hashContract } from "./checksum-gate.ts";
import { parseFindings, type Finding } from "./sign-off.ts";

const GUARD = "design-review";
const SPEC_RELATIVE = "spec.md";

/** How much of a sha256 is worth printing to a human. Full hashes go in the log. */
const SHORT_HASH = 12;

export interface DesignReviewResult {
  readonly code: 0 | 2;
  readonly verdict: GuardVerdict;
  readonly summary: string;
  readonly lines: string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * The exact bytes reviewed: project-relative posix path → sha256, `spec.md`
 * first, then every contract in checksum-gate's order.
 *
 * Hashing is checksum-gate's `hashContract` (newline-normalized sha256) and
 * contract discovery is its `computeManifest`, so "the contract the reviewer
 * read" and "the contract the freeze recorded" are the same question asked
 * twice, never two implementations that can disagree.
 */
export type Reviewed = Readonly<Record<string, string>>;

/** Read and hash the design under review. The one I/O step. */
export function readReviewed(cwd: string): { ok: true; reviewed: Reviewed } | { ok: false; reason: string; error: string } {
  const specPath = join(cwd, SPEC_RELATIVE);
  if (!existsSync(specPath)) {
    return {
      ok: false,
      reason: "no-spec",
      error:
        "no spec.md to review — the reviewer is commissioned on the spec AND the contracts, because the spec carries the half of the interface types cannot hold (ordering, arithmetic and its tie-break, identity). Write it, then commission the review",
    };
  }

  const contracts = computeManifest(cwd).files;
  if (Object.keys(contracts).length === 0) {
    return {
      ok: false,
      reason: "no-contracts",
      error:
        "no *.contract.ts files to review — the contract is the typed half of what the two blind roles build against, and a review of half a design is not a review",
    };
  }

  const reviewed: Record<string, string> = {
    [SPEC_RELATIVE]: hashContract(readFileSync(specPath, "utf8")),
  };
  for (const [file, hash] of Object.entries(contracts)) reviewed[file] = hash;
  return { ok: true, reviewed };
}

/** Format the record. Pure: no I/O, no logging, no judgement of a finding. */
export function classifyDesignReview(
  findings: readonly Finding[],
  reviewed: Reviewed,
): DesignReviewResult {
  const files = Object.keys(reviewed);
  const blockers = findings.filter((f) => f.severity === "blocker");
  const summary =
    findings.length === 0
      ? `reviewed ${files.length} file${files.length === 1 ? "" : "s"}, no findings`
      : `${findings.length} finding${findings.length === 1 ? "" : "s"} (${blockers.length} blocker${blockers.length === 1 ? "" : "s"}) over ${files.length} file${files.length === 1 ? "" : "s"}`;

  return {
    code: 0,
    verdict: "pass",
    summary,
    lines: [
      `design-review: RECORDED — ${summary}`,
      ...findings.map((f) => `  ${f.severity}: ${f.summary}${f.evidence ? ` — ${f.evidence}` : ""}`),
      ...(blockers.length > 0
        ? [
            "design-review: you recorded a blocker — it is a claim for the architect to settle, not a verdict; the design is not ready to freeze until it has been answered",
          ]
        : []),
      "design-review: bound to the bytes below — any later edit to one of them makes this review stale",
      ...files.map((f) => `  ${reviewed[f]!.slice(0, SHORT_HASH)}  ${f}`),
    ],
    // No `findings` count here: the logged event carries the findings
    // THEMSELVES under that key, and one key that means a number in one object
    // and a list in another is a trap for whatever reads the log next.
    detail: {
      blockers: blockers.length,
      severities: findings.map((f) => f.severity),
    },
  };
}

function misuse(reason: string, error: string): DesignReviewResult {
  return {
    code: 2,
    verdict: "error",
    summary: error,
    lines: [`design-review: ERROR — ${error}`],
    detail: { reason },
  };
}

/**
 * Record the reviewer's findings against the design as it stands.
 *
 * The one implementation both the `record_design_review` tool and the CLI go
 * through, so a review cannot differ by how it was invoked.
 */
export function runRecordDesignReview(cwd: string, raw: unknown): DesignReviewResult {
  const parsed = parseFindings(raw);
  if (!parsed.ok) {
    const result = misuse("bad-payload", parsed.error);
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
    return result;
  }

  const design = readReviewed(cwd);
  if (!design.ok) {
    const result = misuse(design.reason, design.error);
    logGuardEvent(cwd, { guard: GUARD, verdict: result.verdict, summary: result.summary, detail: result.detail });
    return result;
  }

  const result = classifyDesignReview(parsed.findings, design.reviewed);
  // ONE event, carrying both halves: the claims, and the bytes they are claims
  // about. Splitting them would let a later gate believe a review covered a
  // file it never saw.
  logGuardEvent(cwd, {
    guard: GUARD,
    verdict: result.verdict,
    summary: result.summary,
    detail: { ...result.detail, findings: parsed.findings, reviewed: design.reviewed },
  });
  return result;
}

// --- CLI ------------------------------------------------------------------------

function main(argv: string[]): number {
  const cwd = argv[0] ?? process.cwd();
  let raw: unknown = [];
  if (argv[1] !== undefined) {
    try {
      raw = JSON.parse(argv[1]);
    } catch {
      console.error("design-review: ERROR — findings argument is not valid JSON");
      return 2;
    }
  }
  const result = runRecordDesignReview(cwd, raw);
  for (const line of result.lines) {
    if (result.code === 0) console.log(line);
    else console.error(line);
  }
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

if (isMainModule()) process.exit(main(process.argv.slice(2)));
