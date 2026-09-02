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
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { decide, type Role } from "./path-policy.ts";
import { readGuardLog } from "./guard-log.ts";
import { checkSpawnPrecondition, type PhaseEvidence } from "./phase-gate.ts";

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

  // Commissioning a worker is a phase TRANSITION, and transitions are checked
  // the same way artifacts are. Only the architect holds `subagent` at all, so
  // this is the one place a step could be skipped — three consecutive dogfood
  // attempts froze the contract and moved on with no spec.
  if (role === "architect" && ev.toolName === "subagent") {
    // Consulting the retained-children list is what licenses a later cold
    // launch, so it has to be recorded — the gate's own evidence is the
    // architect's tool calls.
    if (ev.input["action"] === "children.list") {
      logGuardEvent(ev.cwd, {
        guard: "phase-gate",
        verdict: "pass",
        summary: "children.list",
        detail: { kind: "children-listed" },
      });
      return undefined;
    }

    const target = spawnTarget(ev.input);
    if (target !== undefined) {
      const decision = checkSpawnPrecondition(target, gatherEvidence(ev.cwd));
      if (!decision.allow) {
        logGuardEvent(ev.cwd, {
          guard: "phase-gate",
          verdict: "block",
          summary: decision.reason,
          detail: { kind: "spawn-refused", role, target },
        });
        return { block: true, reason: decision.reason };
      }
      // Record the ALLOWED spawn: a second cold launch of this role is refused
      // until the architect has consulted children.list.
      logGuardEvent(ev.cwd, {
        guard: "phase-gate",
        verdict: "pass",
        summary: `commissioned ${target}`,
        detail: { kind: "spawn", target },
      });
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

/** The agent a `subagent` call is trying to start, if it names one. */
function spawnTarget(input: Readonly<Record<string, unknown>>): string | undefined {
  // Only a launch has a precondition; status/wait/stop/steer on a running child
  // must never be refused, or a blocked architect could not even inspect it.
  const action = input["action"];
  if (typeof action === "string" && action !== "launch" && action !== "run") return undefined;
  for (const key of ["agent", "agentName", "name", "type"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
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
