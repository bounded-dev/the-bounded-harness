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
//
// WHAT THE GATE CHECKS, AND WHAT IT NO LONGER DOES (ADR 2026-021)
//
// The precondition for a worker is the FREEZE, not the red. red_gate proves red
// in a shadow project it builds itself — contracts plus regenerated skeletons
// plus the tests tree, never the live `src/` — and green_gate requires the
// standing red to match the current tests-tree hash. So a red is bound to the
// bytes it was proven against rather than to a moment in the run, and
// sequencing the builder behind it bought nothing the hashes do not already
// hold. The test-writer and the builder are therefore commissioned in parallel
// once DESIGN is complete, and nothing here enforces an order between them.
//
// Two spawn SHAPES are refused outright, because both were observed live
// carrying pipeline work past every check in this file:
//
//   * a multi-spawn form (`workflowScript`, or a `chain`/`parallel` item array)
//     that names a pipeline role — the gate sees one tool call and cannot
//     evaluate a precondition per child inside a script it never watches run,
//     and the per-role model tier is injected at the plain spawn too;
//   * `delegate`, the general write-capable worker, in a session that already
//     holds a bound role — inside the developer stage every writer is a role
//     with a zone, and an unbound one writes wherever it likes.

import type { LoggedGuardEvent } from "./guard-log.ts";
import type { Role } from "./path-policy.ts";

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

/** Index of the last event matching a predicate, or -1. */
function lastIndexWhere(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
): number {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i]!)) return i;
  return -1;
}

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

  // The three checks below read the INNER guard names, which `design_gate` logs
  // as it runs each step (ADR 2026-019). So they still say precisely which step
  // is missing, and the remedy for every one of them is the same single call.
  if (!passed(events, "contract-purity")) {
    return deny(
      `phase-gate: cannot commission the ${target} — contract_purity has not passed on the current ` +
        "contract. Run design_gate — contract-purity is its first step — and fix what it reports first.",
    );
  }

  if (!passed(events, "scaffold")) {
    return deny(
      `phase-gate: cannot commission the ${target} — the skeletons have not been generated. Run ` +
        "design_gate: its scaffold step writes the throwing stubs the red phase runs against, so " +
        "without them there is nothing to fail.",
    );
  }

  if (!passed(events, "checksum-gate")) {
    return deny(
      `phase-gate: cannot commission the ${target} — the contract is not frozen. Run ` +
        "design_gate: its freeze step records the checksum manifest, so a contract that moves " +
        "underneath the workers is detectable rather than silent.",
    );
  }

  // A cold launch of a role that has already run re-primes an entire context.
  // Run 6 spent ~1.6M cache-read tokens — about a quarter of the run — starting
  // over with agents that already knew the task: 1.75M for the first builder,
  // then 649k, 603k and 362k re-priming its successors.
  //
  // pi retains completed children, so a bounce should CONTINUE one rather than
  // start another. The architect must consult the retained list before it may
  // launch cold; consulting and then launching is fine, because that is the
  // legitimate case where the child was not resumable. What is refused is
  // respawning without looking. `children.list` is itself a subagent call, so
  // the gate sees it — the evidence is the architect's own tool calls, and no
  // knowledge of pi's internal state is needed.
  const lastSpawn = lastIndexWhere(
    events,
    (e) => e.guard === "phase-gate" && (e.detail as { kind?: string } | undefined)?.kind === "spawn"
      && (e.detail as { target?: string }).target === target,
  );
  if (lastSpawn !== -1) {
    const consulted = lastIndexWhere(
      events,
      (e) =>
        e.guard === "phase-gate" &&
        (e.detail as { kind?: string } | undefined)?.kind === "children-listed",
    );
    if (consulted < lastSpawn) {
      return deny(
        `phase-gate: a ${target} has already run — do not launch a second one cold. ` +
          "A cold launch re-primes the whole context; Run 6 spent about a quarter of its tokens " +
          "re-teaching agents what they already knew. Continue the existing child instead: " +
          '`{ action: "children.list" }` to find its run id and whether it is resumable, then ' +
          '`{ action: "resume", id: "<run-id>", message: "<the bounce>" }`. ' +
          "If children.list reports it not resumable, launch again and it will be allowed.",
      );
    }
  }

  // Nothing below this line orders the two workers. The builder used to wait on
  // a red-gate pass; it no longer does (ADR 2026-021). red_gate proves red in a
  // shadow project built from the contracts, regenerated skeletons and the
  // tests tree, so it never reads live `src/` and a builder working in parallel
  // cannot contaminate it; green_gate then requires the standing red to match
  // the current tests-tree hash, so a red that no longer describes the suite is
  // void whether or not it was established first. Ordering was enforcing what
  // the hashes already prove, at the cost of a serialized phase.

  return ALLOW;
}

// ---------------------------------------------------------------------------
// The spawn FORM, not just the spawn target.
// ---------------------------------------------------------------------------
//
// Everything above assumes one child per tool call, named in the call. Two
// live runs showed that assumption is not free:
//
//   * r13/r14, twice: the architect wrapped both workers in a `workflowScript`
//     (`runs.all([...])`). The gate saw one `subagent` call carrying a string,
//     found no `agent`, and let it through — the builder ran with no
//     precondition checked and no model tier injected.
//   * twice more: the architect spawned `delegate`, the general write-capable
//     worker, inside the pipeline. `delegate` carries no role binding, so the
//     path gate has no zone to apply to it and it writes anywhere.
//
// Both are refused by SHAPE, which is the only thing a gate can check here: it
// cannot follow a script it never watches run, and it cannot bind a role to a
// child it never sees named.

/** The pipeline roles, as names to be matched inside a script or item array. */
const PIPELINE_ROLE_NAMES: readonly Role[] = ["architect", "test-writer", "builder", "reviewer"];

/**
 * Subagent input fields that can carry MORE THAN ONE child in a single call.
 *
 * `workflowScript` is the live one (pi-subagents runs it as a statement body
 * over `runs.run`/`runs.all`). `chain` and `parallel` are the item-array forms
 * the same schema models; they are covered here so the rule is about the shape
 * rather than about one field name that happens to be current.
 */
const MULTI_SPAWN_FIELDS = ["workflowScript", "chain", "parallel"] as const;

/** Word-boundary mention of a pipeline role. Blunt on purpose: a script that
 *  merely talks about the builder is refused too, and rewording it costs a
 *  sentence, while a missed spawn costs an ungated worker. */
const ROLE_MENTION = new RegExp(`\\b(?:${PIPELINE_ROLE_NAMES.join("|")})\\b`, "g");

/** A multi-spawn form found in a subagent input. */
export interface MultiSpawnForm {
  /** The field that carried it: "workflowScript", "chain", "parallel". */
  readonly field: string;
  /** Pipeline roles named anywhere inside it, deduplicated, in role order. */
  readonly roles: readonly string[];
}

/** The multi-spawn form this input carries, if any, and the roles it names. */
export function detectMultiSpawn(
  input: Readonly<Record<string, unknown>>,
): MultiSpawnForm | undefined {
  for (const field of MULTI_SPAWN_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const text = typeof value === "string" ? value : safeStringify(value);
    const found = new Set(text.match(ROLE_MENTION) ?? []);
    return { field, roles: PIPELINE_ROLE_NAMES.filter((r) => found.has(r)) };
  }
  return undefined;
}

/** JSON with cycles and unserializable values degraded, never thrown. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The general write-capable worker — no role, therefore no zone. */
const UNBOUND_WRITER = "delegate";

/** What the wiring should do with one `subagent` tool call. */
export type SpawnVerdict =
  /** Not a launch (status/steer/resume/…): never refuse, never record. */
  | { readonly kind: "ignore" }
  /** `children.list` — record the consult that licenses a later cold launch. */
  | { readonly kind: "children-listed" }
  /** A plain one-child spawn, permitted. */
  | { readonly kind: "allow"; readonly target: string }
  /** A fan-out naming no pipeline role: allowed, but recorded. */
  | { readonly kind: "allow-multi"; readonly form: MultiSpawnForm }
  /** Refused, with the line the architect reads. */
  | {
      readonly kind: "block";
      readonly reason: string;
      readonly target?: string;
      readonly form?: MultiSpawnForm;
    };

/**
 * Decide one `subagent` call made by a session that holds a bound pipeline role.
 *
 * The bound-role condition is the caller's (the path gate is inactive without
 * one), and it is what makes rule 3 correct: `delegate` is an ordinary worker
 * in an ordinary session and is refused only INSIDE the pipeline.
 */
export function checkSubagentCall(
  input: Readonly<Record<string, unknown>>,
  evidence: PhaseEvidence,
): SpawnVerdict {
  const action = input["action"];
  if (typeof action === "string") {
    if (action === "children.list") return { kind: "children-listed" };
    // status/wait/stop/steer/resume on an existing child must never be refused,
    // or a blocked architect could not even inspect what it started.
    if (action !== "launch" && action !== "run") return { kind: "ignore" };
  }

  // Shape first: a multi-spawn form is refused whatever the phase, because the
  // objection is that the gate cannot see the children at all.
  const form = detectMultiSpawn(input);
  if (form !== undefined) {
    if (form.roles.length === 0) return { kind: "allow-multi", form };
    return {
      kind: "block",
      form,
      reason:
        `phase-gate: this ${form.field} commissions pipeline roles (${form.roles.join(", ")}) — ` +
        "spawn them one at a time through the plain form instead: " +
        '`{ agent: "test-writer", task: "…" }`, one call per role. The gate cannot evaluate a ' +
        "precondition per child inside a script it never watches run, and the model-tier injection " +
        "that gives each role its model cannot reach a child spawned there either — so a role " +
        "commissioned this way runs ungated and on the wrong model. A multi-spawn form that names " +
        "no pipeline role is left alone.",
    };
  }

  const target = spawnTarget(input);
  if (target === undefined) return { kind: "ignore" };

  if (target === UNBOUND_WRITER) {
    return {
      kind: "block",
      target,
      reason:
        "phase-gate: delegate holds no role binding — inside the developer stage every writer is a " +
        "bound role. Generated-file cleanup happens in design_gate's scaffold sync; implementation " +
        "belongs to the builder; tests to the test-writer. Commission the role that owns the work; " +
        "`scout` and `product-expert` stay available for read-only help.",
    };
  }

  const decision = checkSpawnPrecondition(target, evidence);
  if (!decision.allow) return { kind: "block", reason: decision.reason, target };
  return { kind: "allow", target };
}

/** The agent a `subagent` call is trying to start, if it names one. */
export function spawnTarget(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["agent", "agentName", "name", "type"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}
