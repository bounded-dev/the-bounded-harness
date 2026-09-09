// Path-gate core (TN-26-001 Phase 2): the testable heart of the tool_call
// path gate, with no pi-runtime dependency.
//
// This is thin wiring over the already-tested pure decision core decide()
// (path-policy.ts). Its one job beyond decide() is the trust-boundary side
// effect: a block is recorded in the target project's guard log so a jammed
// pipeline is inspectable ("a deterministic system that is opaque when it
// jams is just a deterministic jam"). Pure cores never log; this layer does.
//
// The extension (extensions/path-gate.ts) sources the role at runtime and
// calls evaluatePathGate(); everything decision-shaped lives here so it can
// be unit-tested without spawning pi.

import { logGuardEvent, RUN_START_GUARD } from "./guard-log.ts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { decide, FORBIDDEN_TOOLS, type Role } from "./path-policy.ts";
import { readGuardLog } from "./guard-log.ts";
import { checkSubagentCall, type PhaseEvidence } from "./phase-gate.ts";

/** The only roles the gate is active for. Anything else ⇒ inactive. */
export const PIPELINE_ROLES = ["architect", "test-writer", "builder", "reviewer"] as const;

const ROLE_SET: ReadonlySet<string> = new Set(PIPELINE_ROLES);

/** Narrow an untrusted role value (env, file, config) to a pipeline Role. */
export function asRole(value: unknown): Role | undefined {
  return typeof value === "string" && ROLE_SET.has(value) ? (value as Role) : undefined;
}

// --- Bound-role registry (dogfood Run 6) ------------------------------------
//
// A subagent installs TWO hooks and neither knows about the other: the BOUND
// one its frontmatter names, and the AMBIENT one, because extensions/*.ts
// auto-load in every pi session — a child included — and the ambient gate
// resolves its role from `.pi/dev-stage-role` in the project cwd, which the
// child SHARES with its parent.
//
// So a parent gated as `architect` through that file silently applied
// architect's zone on top of every child's. Both hooks run on each tool call
// and either may block, confining the child to the INTERSECTION. Live result:
// the test-writer was refused permission to write its own tests — "architect
// may not write 'tests/start.test.ts'" — and the run deadlocked at its first
// worker.
//
// Restrictions must never leak DOWNWARD. A child's role is decided by its
// parent at spawn from a file outside the project; that binding is the
// authority, and the ambient guess stands down in any process where a bound
// role was installed.
//
// Stored on globalThis, NOT in a module-level `let`.
//
// The host loads the ambient extension by auto-discovery and the per-role
// loader from an explicit `--extension` path. Those arrive through different
// module registries, so a module-scoped flag set by one is invisible to the
// other — which is exactly what happened on the first attempt at this fix: the
// unit tests passed, and a live spawned test-writer was still refused as
// "architect". globalThis is shared by every module instance in the process,
// which is the scope this actually needs.
//
// Deliberately one-way: nothing should ever re-enable the ambient gate in a
// process that has a bound role. Subagents are separate processes, so the flag
// never crosses between them.
const BOUND_ROLE_KEY = Symbol.for("pi-harness.path-gate.boundRoleInstalled");
// The role ITSELF, not just the fact of a binding. Other worker tools need the
// same answer the gate acts on: `typecheck` scopes its diagnostics by the
// calling role (packs/ts/scripts/typecheck-scope.ts), and a second, private
// notion of "who am I" is exactly how two enforcement layers drift apart.
const BOUND_ROLE_VALUE_KEY = Symbol.for("pi-harness.path-gate.boundRole");

type GlobalWithRegistry = typeof globalThis & {
  [BOUND_ROLE_KEY]?: boolean;
  [BOUND_ROLE_VALUE_KEY]?: Role;
};

/** Called by a per-role loader; makes the ambient gate inert in this process,
 *  and publishes the bound role for any other tool that must respect it. */
export function markBoundRoleInstalled(role?: Role): void {
  (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY] = true;
  if (role !== undefined) (globalThis as GlobalWithRegistry)[BOUND_ROLE_VALUE_KEY] = role;
}

/** Whether a bound role has claimed this process. */
export function isAmbientSuppressed(): boolean {
  return (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY] === true;
}

/** The role a per-role loader bound to this process, if any. */
export function boundRole(): Role | undefined {
  return (globalThis as GlobalWithRegistry)[BOUND_ROLE_VALUE_KEY];
}

/** Test-only: restore the pristine process state. */
export function resetPathGateRegistry(): void {
  delete (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY];
  delete (globalThis as GlobalWithRegistry)[BOUND_ROLE_VALUE_KEY];
}

/** The ambient fallback role: env var first, then `.pi/dev-stage-role` in the
 *  project. Both are process/cwd-global — see extensions/path-gate.ts for why
 *  they are a fallback and not the mechanism. */
export function ambientRole(cwd: string): Role | undefined {
  const fromEnv = asRole(process.env["PI_DEV_STAGE_ROLE"]);
  if (fromEnv) return fromEnv;
  try {
    return asRole(readFileSync(join(cwd, ".pi", "dev-stage-role"), "utf8").trim());
  } catch {
    return undefined; // no role file ⇒ no role
  }
}

/**
 * The role this session is acting as, by exactly the rules the path gate
 * applies: the bound role if a per-role loader claimed the process, otherwise
 * the ambient fallback — and nothing at all once a binding exists, because
 * restrictions must never leak downward from a parent to its children.
 *
 * This is the single answer every role-sensitive tool must ask for. Used by
 * the `typecheck` worker tool to scope its diagnostics (extensions/dev-tools.ts).
 */
export function sessionRole(cwd: string): Role | undefined {
  const bound = boundRole();
  if (bound !== undefined) return bound;
  if (isAmbientSuppressed()) return undefined;
  return ambientRole(cwd);
}

// --- Tool strip (the visible-toolset half of the gate) ----------------------
//
// Refusing a forbidden tool is not the same as not having it. A model that can
// SEE `bash` in its toolset plans around it and reaches for it when stuck, and
// every attempt costs a full turn: a live architect session spent six turns on
// `bash` alone, plus one each on `run_tests` and the rest, all refused.
//
// Subagent-spawned roles never had this problem — their frontmatter `tools:`
// allowlist strips the toolset before the model is ever shown it, which is why
// the refusal text calls the allowlist the primary layer. A DIRECTLY launched
// session (`.pi/dev-stage-role` + plain `pi`, or `pi-ticket`) has no
// frontmatter, so the allowlist is documentation there and the gate was doing
// all the work by refusing calls the model had every reason to make.
//
// pi's ExtensionAPI closes this: `getActiveTools()` / `setActiveTools(names)`
// are live once extensions are bound, and `session_start` fires after that
// binding and before the first provider request. Setting the active tools
// rebuilds the system prompt too, so the tool vanishes from the prompt's
// tool list as well as from the provider's schema — the model is never told
// the tool exists.
//
// This is deliberately the SAME data the refusals use (FORBIDDEN_TOOLS), so
// the two layers cannot disagree about what a role may hold.

/** What a session-start strip did: what was hidden, and what is left active. */
export interface ToolStrip {
  readonly hidden: readonly string[];
  readonly active: readonly string[];
}

/**
 * Which of `active` this role may not hold, and what remains.
 *
 * Returns `undefined` when the role already holds nothing forbidden — the
 * caller then makes no call at all, so a normally-launched subagent (already
 * stripped by its frontmatter) is untouched.
 */
export function planToolStrip(role: Role, active: readonly string[]): ToolStrip | undefined {
  const forbidden = FORBIDDEN_TOOLS[role];
  const hidden = active.filter((name) => forbidden.has(name));
  if (hidden.length === 0) return undefined;
  return { hidden, active: active.filter((name) => !forbidden.has(name)) };
}

/**
 * Record a strip in the target project's guard log.
 *
 * The strip is the reason a forbidden tool never appears in the transcript, so
 * without this line the absence is indistinguishable from the model simply not
 * trying — and "a deterministic system that is opaque when it jams is just a
 * deterministic jam" applies to a system that silently DOESN'T jam too.
 */
export function recordToolStrip(cwd: string, role: Role, strip: ToolStrip): void {
  logGuardEvent(cwd, {
    guard: "path-gate",
    verdict: "pass",
    summary: `hid ${strip.hidden.join(", ")} from ${role}`,
    detail: { kind: "tool-strip", role, hidden: [...strip.hidden] },
  });
}

// --- Run start (r15) --------------------------------------------------------
//
// The timing block reported an 80-minute DESIGN phase for a run whose design
// really took about 58: a provider outage sat between the session opening and
// the prompt landing, and the phase measured from the first event in the log,
// which is the session-start tool strip. Wall clock during which nothing was
// asked of the model is not design time.
//
// The gate is the one component that sees the first moment a session does
// work: the first tool call it evaluates. So it stamps a `run-start` event
// there, and phase-durations starts its clock at that marker when it exists.
//
// ONCE PER SESSION, which is why the latch is a closure handed out by
// `makeRunStartRecorder` and held by the installed hook, exactly as the
// fallback role resolver is: a session is one installPathGate call, so a
// closure is per-session by construction — and unlike module or global state
// it cannot leak between the pi processes a subagent fan-out creates, each of
// which is its own session and deserves its own marker.
//
// A restart therefore appends a second marker to the same project log; the
// analysis takes the last one before the first phase marker (see the "The
// clock" section of phase-durations.ts).

/** Log the run-start marker: this session's first gated tool call. */
export function recordRunStart(cwd: string, role: Role, toolName: string): void {
  logGuardEvent(cwd, {
    guard: RUN_START_GUARD,
    verdict: "pass",
    summary: `first gated tool call (${role}: ${toolName})`,
    detail: { kind: "run-start", role, tool: toolName },
  });
}

/**
 * A once-per-session latch around `recordRunStart`. Call it on every gated
 * tool call; only the first one writes.
 */
export function makeRunStartRecorder(): (cwd: string, role: Role, toolName: string) => void {
  let recorded = false;
  return (cwd, role, toolName) => {
    if (recorded) return;
    recorded = true;
    recordRunStart(cwd, role, toolName);
  };
}

/** Blocking result returned to pi's tool_call hook. */
export interface GateBlock {
  readonly block: true;
  readonly reason: string;
}

export interface GateInput {
  /** Untrusted role source; non-pipeline values leave the gate inactive. */
  readonly role: unknown;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Target project root — paths resolve against it, guard log lands under it. */
  readonly cwd: string;
  /** Harness config home, so a role may read its own skill instructions. */
  readonly harnessRoot?: string;
}

/**
 * Decide whether a tool call is allowed for the given role, logging a
 * `path-gate` block to <cwd>/.pi/guard-log.jsonl on denial.
 *
 * Returns `undefined` (allow / inactive) or `{ block, reason }` (deny).
 */
export function evaluatePathGate(ev: GateInput): GateBlock | undefined {
  const role = asRole(ev.role);
  if (!role) return undefined; // no pipeline role ⇒ gate inactive

  // Commissioning a worker is a phase TRANSITION, and transitions are checked
  // the same way artifacts are. The check runs for any BOUND role, not just the
  // architect: "this session already holds a role" is exactly the condition
  // that makes an unbound `delegate` wrong, and a role that should not hold
  // `subagent` at all is refused a few lines below by the tool policy anyway.
  //
  // Thin by construction — the whole decision is checkSubagentCall(); this
  // layer only performs the side effect the pure core may not, which is writing
  // what happened to the target project's guard log.
  if (ev.toolName === "subagent") {
    const verdict = checkSubagentCall(ev.input, gatherEvidence(ev.cwd));
    switch (verdict.kind) {
      case "children-listed":
        // Consulting the retained-children list is what licenses a later cold
        // launch, so it has to be recorded — the gate's own evidence is the
        // architect's tool calls.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: "children.list",
          detail: { kind: "children-listed" },
        });
        return undefined;
      case "block":
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "block",
          summary: verdict.reason,
          detail: {
            kind: "spawn-refused",
            role,
            ...(verdict.target !== undefined ? { target: verdict.target } : {}),
            ...(verdict.form !== undefined
              ? { form: verdict.form.field, roles: [...verdict.form.roles] }
              : {}),
          },
        });
        return { block: true, reason: verdict.reason };
      case "allow":
        // Record the ALLOWED spawn: a second cold launch of this role is refused
        // until the architect has consulted children.list.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: `commissioned ${verdict.target}`,
          detail: { kind: "spawn", target: verdict.target },
        });
        break;
      case "allow-multi":
        // Legitimate background fan-out. It is allowed and it is RECORDED: an
        // unexplained cluster of children in a pipeline run should be traceable
        // to the call that started them.
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "pass",
          summary: `${verdict.form.field} fan-out (no pipeline role)`,
          detail: { kind: "fan-out", role, form: verdict.form.field },
        });
        break;
      case "ignore":
        break;
    }
  }

  const decision = decide(role, ev.toolName, ev.input, {
    cwd: ev.cwd,
    ...(ev.harnessRoot !== undefined ? { harnessRoot: ev.harnessRoot } : {}),
  });
  if (decision.allow) return undefined;

  const rawPath = ev.input["path"];
  logGuardEvent(ev.cwd, {
    guard: "path-gate",
    verdict: "block",
    summary: decision.reason,
    detail: { role, tool: ev.toolName, path: rawPath ?? null },
  });
  return { block: true, reason: decision.reason };
}

/**
 * The AMBIENT gate's decision: identical to `evaluatePathGate`, except that it
 * stands down entirely once a bound role has claimed this process.
 *
 * The ambient hook exists so a session the user starts themselves can be gated
 * from a `.pi/dev-stage-role` file. That file lives in the project, which every
 * subagent shares — so without this check the parent's role is applied to each
 * child on top of its own, and the child is confined to the intersection.
 */
export function evaluateAmbientPathGate(ev: GateInput): GateBlock | undefined {
  if (isAmbientSuppressed()) return undefined;
  return evaluatePathGate(ev);
}

/** Read the project's current state: what exists, and what actually ran. */
function gatherEvidence(cwd: string): PhaseEvidence {
  let specBytes = 0;
  try {
    specBytes = statSync(join(cwd, "spec.md")).size;
  } catch {
    specBytes = 0; // absent
  }
  let events: PhaseEvidence["events"] = [];
  try {
    events = readGuardLog(cwd);
  } catch {
    events = []; // an unreadable log must not silently permit a skip
  }
  return { contracts: findContracts(cwd), specBytes, events };
}

/** Project-relative *.contract.ts paths, skipping the obvious noise. */
function findContracts(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".pi", "dist", "build"]);
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(join(dir, e.name), depth + 1);
      } else if (e.name.endsWith(".contract.ts")) {
        out.push(relative(root, join(dir, e.name)));
      }
    }
  };
  walk(root, 0);
  return out;
}
