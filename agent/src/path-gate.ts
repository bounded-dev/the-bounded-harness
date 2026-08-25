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

  const decision = decide(role, ev.toolName, ev.input, { cwd: ev.cwd });
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
