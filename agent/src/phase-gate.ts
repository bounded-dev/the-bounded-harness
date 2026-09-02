// Phase gate: a worker spawn is a transition, and transitions are checked.
//
// Every other gate checks an ARTIFACT — is this contract pure, is this red the
// right red. None of them checked the SEQUENCE, so a step could simply not be
// reached and nothing would notice. Across three consecutive dogfood attempts
// on one prompt the architect froze the contracts with no `spec.md` every time,
// and only wrote one afterwards because it happened to.
//
// The spec is not paperwork. It carries the half of the interface types cannot
// hold: execution order, the exact rounding tie-break, identity guarantees. A
// test-writer handed 38 typed operations and no spec can pin signatures and
// nothing else — which is exactly the class of test the bare arm already
// writes, and the harness's whole measured advantage lives in the difference.
//
// So the spawn itself is gated. Commissioning a worker is a tool call, the path
// gate already sees every tool call, and a spawn whose preconditions are unmet
// is refused. The rule stops being "the skill says do this first" and becomes
// something with no way around it.
//
// Evidence comes from the guard log, which every gate already writes. That
// makes the log load-bearing rather than merely diagnostic: it is the record of
// what actually ran, so it is the right thing to ask.

import type { LoggedGuardEvent } from "./guard-log.ts";

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface PhaseEvidence {
  /** Project-relative paths of the *.contract.ts files that exist. */
  readonly contracts: readonly string[];
  /** Size of spec.md in bytes; 0 when absent. */
  readonly specBytes: number;
  /** The project's guard log, oldest first. */
  readonly events: readonly LoggedGuardEvent[];
}

/**
 * Minimum size for a spec to count as written.
 *
 * A mere existence check is satisfied by `touch spec.md`, and a gate that can
 * be satisfied without doing the work is theatre. This is not a quality bar —
 * nothing deterministic can judge a spec — it is a floor that a real document
 * clears without thinking and a placeholder does not. Live specs have run
 * 147–335 lines, so a few hundred bytes is far below anything genuine.
 */
const MIN_SPEC_BYTES = 400;

/** Roles the phase gate governs. Anything else spawns freely. */
const GATED_TARGETS = new Set(["test-writer", "builder"]);

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/** The latest verdict for a guard, or undefined if it never ran. */
function latestVerdict(
  events: readonly LoggedGuardEvent[],
  guard: string,
): LoggedGuardEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.guard === guard) return events[i];
  }
  return undefined;
}

/** Has `guard` most recently passed? A later block supersedes an earlier pass. */
function passed(events: readonly LoggedGuardEvent[], guard: string): boolean {
  return latestVerdict(events, guard)?.verdict === "pass";
}

/**
 * May the architect spawn `target` given the current evidence?
 *
 * Each refusal names the tool that would satisfy it, so the architect can act
 * on the message rather than guess — and says WHY, because a rule whose purpose
 * is invisible reads as bureaucracy and gets worked around.
 */
export function checkSpawnPrecondition(target: string, evidence: PhaseEvidence): Decision {
  if (!GATED_TARGETS.has(target)) return ALLOW; // scout, product-expert, …

  const { contracts, specBytes, events } = evidence;

  if (contracts.length === 0) {
    return deny(
      `phase-gate: cannot commission the ${target} — no *.contract.ts exists yet. ` +
        "The contract is the shared interface both blind roles build against; without it they have nothing to agree on.",
    );
  }

  if (specBytes === 0) {
    return deny(
      `phase-gate: cannot commission the ${target} — spec.md is missing. ` +
        "The contract carries the half TypeScript can hold; the spec carries the rest — execution " +
        "order, the exact arithmetic and its tie-break, identity guarantees. Two blind agents cannot " +
        'agree on "round to the nearest cent"; they can agree on floor((2n + d) / 2d). Write it, then commission.',
    );
  }

  if (specBytes < MIN_SPEC_BYTES) {
    return deny(
      `phase-gate: cannot commission the ${target} — spec.md is ${specBytes} bytes, which is a ` +
        "placeholder rather than a document. It must carry the ordering, arithmetic and identity " +
        "rules the contract cannot express.",
    );
  }

  if (!passed(events, "contract-purity")) {
    return deny(
      `phase-gate: cannot commission the ${target} — contract_purity has not passed on the current ` +
        "contract. Run it and fix what it reports first.",
    );
  }

  if (!passed(events, "scaffold")) {
    return deny(
      `phase-gate: cannot commission the ${target} — the skeletons have not been generated. Run ` +
        "scaffold: the red phase runs against those throwing stubs, so without them there is nothing to fail.",
    );
  }

  if (!passed(events, "checksum-gate")) {
    return deny(
      `phase-gate: cannot commission the ${target} — the contract is not frozen. Run ` +
        "freeze_contracts, so a contract that moves underneath the workers is detectable rather than silent.",
    );
  }

  if (target === "builder" && !passed(events, "red-gate")) {
    return deny(
      "phase-gate: cannot commission the builder — red_gate has not passed. A suite that has not " +
        "been shown to fail for the right reason has not been shown to test anything, and the " +
        "builder would be implementing against it blind.",
    );
  }

  return ALLOW;
}
