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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asRole, evaluatePathGate } from "../src/path-gate.ts";
import type { Role } from "../src/path-policy.ts";

const ROLE_FILE = join(".pi", "dev-stage-role");

/** Resolve an ambient fallback role once per session (env, then role file). */
function makeFallbackResolver(): (cwd: string) => Role | undefined {
  let resolved = false;
  let role: Role | undefined;
  return (cwd: string): Role | undefined => {
    if (resolved) return role;
    resolved = true;
    role = asRole(process.env["PI_DEV_STAGE_ROLE"]);
    if (!role) {
      try {
        role = asRole(readFileSync(join(cwd, ROLE_FILE), "utf8").trim());
      } catch {
        role = undefined; // no role file ⇒ inactive
      }
    }
    return role;
  };
}

/**
 * Install the path gate. Pass `boundRole` from a per-role subagentOnly loader
 * for the deterministic per-subagent path; omit it for the ambient default,
 * which falls back to env / role file (and stays inactive when neither is set).
 */
export function installPathGate(pi: ExtensionAPI, boundRole?: Role): void {
  const fallback = boundRole ? undefined : makeFallbackResolver();

  pi.on("tool_call", async (event, ctx) => {
    const role = boundRole ?? fallback!(ctx.cwd);
    if (!role) return undefined; // inactive: normal / orchestrator session

    return evaluatePathGate({
      role,
      toolName: event.toolName,
      input: event.input as Readonly<Record<string, unknown>>,
      cwd: ctx.cwd,
    });
  });
}

export default function (pi: ExtensionAPI): void {
  installPathGate(pi);
}
