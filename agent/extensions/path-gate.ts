/**
 * Path-gate extension (TN-26-001 Phase 2)
 *
 * A `tool_call` hook that enforces the developer-stage blindness matrix for a
 * pipeline role: architect / test-writer / builder. For those roles it runs
 * the pure decision core (src/path-policy.ts via src/path-gate.ts), blocks
 * out-of-zone reads/edits/writes/searches, and records each block in the
 * target project's guard log. With no pipeline role — every normal or
 * orchestrator session — the gate is INACTIVE and every call passes through.
 *
 * It also installs a `session_start` hook that REMOVES the role's forbidden
 * tools from the model's visible toolset (pi.setActiveTools), so a directly
 * launched session gets the same "the tool was never there" property a
 * subagent gets free from its frontmatter allowlist. The tool_call refusals
 * become the backstop they were always described as.
 *
 * ── Role source (the key design decision) ────────────────────────────────
 * Subagents run as SEPARATE `pi` child processes (pi-subagents spawns them),
 * so they do not share a process with the orchestrator — but every child
 * inherits the parent's `process.env`, so a parent-set env var is NOT
 * per-agent: it would tag every child, of every role, identically. There is
 * also no per-agent env injected by pi-subagents (no `PI_SUBAGENT_AGENT_NAME`
 * or equivalent), and no `env:` frontmatter field.
 *
 * The mechanism pi ACTUALLY supports per-subagent is `subagentOnlyExtensions`
 * in the agent's frontmatter: extension paths loaded ONLY in that agent's
 * spawned child session (pi-subagents passes them as `--extension` args). So
 * each pipeline agent binds its role by loading a distinct per-role loader
 * from ./path-gate/ (architect.ts / test-writer.ts / builder.ts), each of
 * which calls installPathGate(pi, "<role>"). The role is baked into WHICH
 * extension the agent loads — deterministic, per-subagent, and impossible for
 * a normal session to trip (it never loads those files).
 *
 * Example agent frontmatter (agents/architect.md):
 *   subagentOnlyExtensions: <harness>/extensions/path-gate/architect.ts
 *
 * ── Fallback (documented limitation) ─────────────────────────────────────
 * This file also auto-loads ambiently (extensions/*.ts). Its default export
 * binds NO role, so it is inert unless a role is found via the fallbacks:
 *   1. PI_DEV_STAGE_ROLE env var, then
 *   2. a `.pi/dev-stage-role` file in the project cwd.
 * Both are PROCESS/CWD-global: they cannot distinguish two roles operating in
 * the same project at once, and env leaks to nested children. They exist only
 * so the gate can be exercised without a full subagent launch; the
 * subagentOnlyExtensions loaders are the real mechanism. Prefer them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ambientRole,
  evaluateAmbientPathGate,
  evaluatePathGate,
  isAmbientSuppressed,
  makeRunStartRecorder,
  markBoundRoleInstalled,
  planToolStrip,
  recordToolStrip,
} from "../src/path-gate.ts";
import type { Role } from "../src/path-policy.ts";

// This file lives at <harness>/extensions/path-gate.ts, so the harness root is
// its parent's parent. Derived rather than configured: it must stay correct
// through the ~/.pi/agent symlink and in any checkout.
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Resolve an ambient fallback role once per session (env, then role file).
 *  The resolution itself is `ambientRole` in ../src/path-gate.ts — shared with
 *  the other role-sensitive tools so they cannot disagree about who is acting. */
function makeFallbackResolver(): (cwd: string) => Role | undefined {
  let resolved = false;
  let role: Role | undefined;
  return (cwd: string): Role | undefined => {
    if (resolved) return role;
    resolved = true;
    role = ambientRole(cwd);
    return role;
  };
}

/**
 * Install the path gate. Pass `boundRole` from a per-role subagentOnly loader
 * for the deterministic per-subagent path; omit it for the ambient default,
 * which falls back to env / role file (and stays inactive when neither is set).
 */
export function installPathGate(pi: ExtensionAPI, boundRole?: Role): void {
  // A bound role claims the process, which makes the ambient hook inert — see
  // the registry in src/path-gate.ts. Without this, a subagent gets its
  // parent's role (read from the shared `.pi/dev-stage-role`) applied on top of
  // its own and is confined to the intersection of the two zones. That
  // deadlocked dogfood Run 6 at its first worker: the test-writer was refused
  // permission to write its own tests as "architect".
  if (boundRole) markBoundRoleInstalled(boundRole);

  const fallback = boundRole ? undefined : makeFallbackResolver();

  // Per-SESSION state, in the same shape as the fallback resolver above: one
  // installPathGate call is one session, so a closure is the scope this needs.
  const noteRunStart = makeRunStartRecorder();

  // Take the forbidden tools AWAY, rather than refusing them one turn at a
  // time. See the tool-strip block in ../src/path-gate.ts for why: a refused
  // tool the model can still see costs a turn per attempt, and a directly
  // launched session has no frontmatter allowlist to strip it first.
  //
  // `session_start` is the earliest point the tool actions are live — they
  // throw during extension LOAD ("Action methods cannot be called during
  // extension loading") — and it still fires before the first provider
  // request, so the model never sees the tool at all.
  pi.on("session_start", (_event, ctx) => {
    const role = boundRole ?? fallback!(ctx.cwd);
    if (!role) return; // inactive: normal session with no role
    // The ambient hook stands down wherever a bound role claimed the process,
    // for exactly the reason it stands down on tool calls: otherwise a
    // subagent's toolset loses its PARENT's forbidden tools too, and a
    // test-writer would be stripped of nothing while a builder lost run_tests.
    if (!boundRole && isAmbientSuppressed()) return;

    // Defence in depth over a gate that already refuses these calls: if the
    // host cannot strip, the session must still start and still be gated.
    try {
      const strip = planToolStrip(role, pi.getActiveTools());
      if (!strip) return; // already stripped (frontmatter allowlist did it)
      pi.setActiveTools([...strip.active]);
      recordToolStrip(ctx.cwd, role, strip);
    } catch {
      // The tool_call gate below is unaffected and still refuses every one.
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const role = boundRole ?? fallback!(ctx.cwd);
    if (!role) return undefined; // inactive: normal session with no role

    // The first gated call is where the run demonstrably starts, so it is
    // marked before it is judged — a refused first call still started the run.
    // Recorded only by the hook that will actually evaluate the call: the
    // ambient hook stands down where a bound role claimed the process (see
    // evaluateAmbientPathGate), and a second marker from a stood-down hook
    // would be a second run-start for one session.
    if (boundRole !== undefined || !isAmbientSuppressed()) {
      noteRunStart(ctx.cwd, role, event.toolName);
    }

    const input = event.input as Readonly<Record<string, unknown>>;
    const ev = {
      role,
      toolName: event.toolName,
      input,
      cwd: ctx.cwd,
      harnessRoot: HARNESS_ROOT,
    };

    // Suppression is checked per CALL, not at install: extensions load in an
    // arbitrary order, and the ambient one may well arrive first.
    return boundRole ? evaluatePathGate(ev) : evaluateAmbientPathGate(ev);
  });
}

export default function (pi: ExtensionAPI): void {
  installPathGate(pi);
}
