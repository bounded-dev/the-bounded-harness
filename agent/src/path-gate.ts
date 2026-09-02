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

import { logGuardEvent } from "./guard-log.ts";
import { decide, type Role } from "./path-policy.ts";

/** The only roles the gate is active for. Anything else ⇒ inactive. */
export const PIPELINE_ROLES = ["architect", "test-writer", "builder"] as const;

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

type GlobalWithRegistry = typeof globalThis & { [BOUND_ROLE_KEY]?: boolean };

/** Called by a per-role loader; makes the ambient gate inert in this process. */
export function markBoundRoleInstalled(): void {
  (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY] = true;
}

/** Whether a bound role has claimed this process. */
export function isAmbientSuppressed(): boolean {
  return (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY] === true;
}

/** Test-only: restore the pristine process state. */
export function resetPathGateRegistry(): void {
  delete (globalThis as GlobalWithRegistry)[BOUND_ROLE_KEY];
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
