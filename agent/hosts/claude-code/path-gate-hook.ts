// Claude Code PreToolUse hook: the path gate and the phase gate for one role
// (ADR 2026-029, Tier B on the second host).
//
//   node path-gate-hook.ts [--role <role>] [--harness-root <dir>]  < payload.json
//
// Claude Code runs this once per tool call, feeding the call as JSON on stdin,
// and reads a decision back: nothing on stdout means "allow", a JSON object
// with `permissionDecision: "deny"` means "refuse, and tell the model why",
// and an allowed `pi-gates …` comes back as `permissionDecision: "allow"` with
// `updatedInput` rewriting the command to `PI_DEV_STAGE_ROLE=<role> …` — the
// one place the bound role crosses into the gate's own process, where
// `sessionRole()` reads that variable before any role file.
// It is the analogue of pi's `tool_call` hook (extensions/path-gate.ts), and
// like that hook it is thin wiring: the whole decision is the shared cores —
// decide() through evaluatePathGate(), checkSubagentCall() for a spawn, and
// this host's bash policy for the one tool pi forbids and Claude Code needs.
//
// ── Role source ─────────────────────────────────────────────────────────────
// Bound, from `--role`, when the hook is installed by a generated subagent
// definition (`.claude/agents/<role>.md` carries it in its own `hooks:`, which
// fire only inside that subagent — the exact counterpart of pi's
// `subagentOnlyExtensions`). The role is decided by WHICH definition loaded,
// from outside the project, and nothing the model does can change it.
//
// Ambient, from `.pi/dev-stage-role` (or PI_DEV_STAGE_ROLE), when installed
// project-wide in `.claude/settings.json` with no `--role`. That is the same
// weaker fallback pi has, for a session the user drives directly. Neither
// source ⇒ the gate is inactive and every call passes.
//
// Frontmatter hooks and settings hooks both fire inside a subagent, so where
// both are installed AND a role file exists, the ambient hook applies the
// FILE's role on top of the bound one for every tool it judges (Run 6's
// intersection, on this host). The gate CLI itself is unaffected — it gets
// the bound role from the env prefix above, which beats the file — but Read,
// Edit and the rest are judged twice. The README says: a bound run leaves no
// role file in the project.
//
// ── Failure mode: OPEN ──────────────────────────────────────────────────────
// A hook that crashes must not brick the session. Any error — malformed
// stdin, an unreadable project, a bug here — allows the call, writes one line
// to stderr, and records an `error` event in the guard log, so a run that was
// silently ungated is at least visibly so. Logging itself never throws.
//
// ── Run start ───────────────────────────────────────────────────────────────
// pi stamps `run-start` from the driving session's first tool call, once per
// session, with a closure. This hook is a fresh process per call, so the
// once-latch is the log itself: stamp when the role is driving and the log
// holds no run-start yet. Same marker, same consumer (phase-durations.ts).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { logGuardEvent, readGuardLog, RUN_START_GUARD } from "../../src/guard-log.ts";
import {
  asRole,
  evaluatePathGate,
  isDrivingRole,
  recordRunStart,
  sessionRole,
} from "../../src/path-gate.ts";
import { CONSTRAINTS, declareHost, recordHostDeclaration } from "../../src/host.ts";
import type { Role } from "../../src/path-policy.ts";
import { decideBash } from "./bash-policy.ts";
import { defaultHarnessRoot } from "./render-agents.ts";
import { BASH_TOOL, mapToolCall } from "./tool-map.ts";

/** What one hook run says back to Claude Code. Exit is always 0. */
export interface HookOutcome {
  readonly stdout: string;
  readonly stderr: string;
}

const DENY_PREFIX = "path-gate-hook";

interface Flags {
  readonly role?: string;
  readonly harnessRoot?: string;
}

function parseFlags(argv: readonly string[]): Flags {
  let role: string | undefined;
  let harnessRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = i + 1 < argv.length ? argv[i + 1] : undefined;
    if (arg === "--role") {
      role = next;
      i++;
    } else if (arg === "--harness-root") {
      harnessRoot = next;
      i++;
    } else if (arg.startsWith("--role=")) role = arg.slice("--role=".length);
    else if (arg.startsWith("--harness-root=")) harnessRoot = arg.slice("--harness-root=".length);
  }
  return {
    ...(role !== undefined ? { role } : {}),
    ...(harnessRoot !== undefined ? { harnessRoot } : {}),
  };
}

/** The payload fields this hook reads, narrowed from untrusted JSON. */
interface Payload {
  readonly event?: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(raw: string): Payload {
  const rec: unknown = JSON.parse(raw);
  if (!isRecord(rec)) throw new Error("payload is not a JSON object");
  const toolName = rec["tool_name"];
  if (typeof toolName !== "string") throw new Error("payload has no tool_name");
  const event = rec["hook_event_name"];
  const cwd = rec["cwd"];
  return {
    ...(typeof event === "string" ? { event } : {}),
    toolName,
    toolInput: rec["tool_input"],
    ...(typeof cwd === "string" && cwd !== "" ? { cwd } : {}),
  };
}

function deny(reason: string): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

/** Allow, with the tool input rewritten. Other fields of the original input
 *  (`description`, `timeout`) are kept: `updatedInput` REPLACES the input. */
function allowWith(updatedInput: Readonly<Record<string, unknown>>): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput,
      },
    }) + "\n"
  );
}

/** The env var `sessionRole()` reads first (src/path-gate.ts), which is how
 *  the bound role reaches the `pi-gates` process the shell starts. */
const ROLE_ENV = "PI_DEV_STAGE_ROLE";

/** A subagent bound by its definition holds every constraint: `tools:` is the
 *  strip, this hook is the path and phase gate, and the role env prefix gives
 *  the gates their scoped views. */
const CLAUDE_CODE_BOUND = declareHost("claude-code", CONSTRAINTS);
/** An ambient session (role from `.pi/dev-stage-role`) has no allowlist — the
 *  hook judges what it maps and the rest of the toolset stays. */
const CLAUDE_CODE_AMBIENT = declareHost("claude-code", ["path-gate", "phase-gate", "scoped-views"]);

/**
 * One hook run, as a function: argv + stdin → what to print. `fallbackCwd` is
 * the process cwd, used only when the payload names none or cannot be read —
 * Claude Code runs hooks in the project directory, so an error event still
 * lands in the right guard log.
 */
export function runHook(argv: readonly string[], rawStdin: string, fallbackCwd: string): HookOutcome {
  const flags = parseFlags(argv);
  let cwd = fallbackCwd;
  try {
    const payload = parsePayload(rawStdin);
    if (payload.event !== undefined && payload.event !== "PreToolUse") return { stdout: "", stderr: "" };
    cwd = payload.cwd ?? fallbackCwd;
    const harnessRoot = flags.harnessRoot ?? defaultHarnessRoot();

    const role = resolveRole(flags, cwd);
    if (role.kind === "none") return { stdout: "", stderr: role.note ?? "" };

    return { stdout: evaluate(role.role, role.kind === "bound", payload, cwd, harnessRoot), stderr: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logGuardEvent(cwd, {
      guard: "path-gate",
      verdict: "error",
      summary: `${DENY_PREFIX}: error, call allowed: ${message}`,
      detail: { host: "claude-code", kind: "hook-error" },
    });
    return { stdout: "", stderr: `${DENY_PREFIX}: error, allowing the call: ${message}\n` };
  }
}

type RoleSource = { readonly kind: "bound" | "ambient"; readonly role: Role } | { readonly kind: "none"; readonly note?: string };

/** `--role` beats the file; a `--role` that names no pipeline role is a
 *  configuration error and is said out loud, but still fails open. */
function resolveRole(flags: Flags, cwd: string): RoleSource {
  if (flags.role !== undefined) {
    const bound = asRole(flags.role);
    if (bound !== undefined) return { kind: "bound", role: bound };
    logGuardEvent(cwd, {
      guard: "path-gate",
      verdict: "error",
      summary: `${DENY_PREFIX}: --role '${flags.role}' is not a pipeline role; gate inactive`,
      detail: { host: "claude-code", kind: "hook-error", role: flags.role },
    });
    return { kind: "none", note: `${DENY_PREFIX}: --role '${flags.role}' is not a pipeline role; gate inactive\n` };
  }
  const ambient = sessionRole(cwd);
  return ambient === undefined ? { kind: "none" } : { kind: "ambient", role: ambient };
}

/** The decision proper: stdout to print ("" ⇒ allow). */
function evaluate(role: Role, bound: boolean, payload: Payload, cwd: string, harnessRoot: string): string {
  // Say which host this is and what it holds (ADR 2026-029). The strip is the
  // agent definition's `tools:` allowlist, so only a BOUND role has it; an
  // ambient session keeps every Claude Code tool and the hook judges what it
  // maps. Recorded on change, so the line appears once per stretch of a run.
  recordHostDeclaration(cwd, bound ? CLAUDE_CODE_BOUND : CLAUDE_CODE_AMBIENT);

  // The first call the driving role makes is where the run demonstrably
  // starts — marked before it is judged, as in pi, because a refused first
  // call still started the run.
  if (isDrivingRole(role) && !readGuardLog(cwd).some((e) => e.guard === RUN_START_GUARD)) {
    recordRunStart(cwd, role, payload.toolName);
  }

  const calls = mapToolCall({ tool_name: payload.toolName, tool_input: payload.toolInput }, cwd);
  let allowed = "";
  for (const call of calls) {
    if (call.toolName === BASH_TOOL) {
      const raw = call.input["command"];
      const command = typeof raw === "string" ? raw : "";
      const decision = decideBash(role, command, { cwd, harnessRoot });
      if (!decision.allow) {
        // decide() logs its own blocks through evaluatePathGate; the bash
        // policy is pure, so its refusal is recorded here.
        logGuardEvent(cwd, {
          guard: "path-gate",
          verdict: "block",
          summary: decision.reason,
          detail: { role, tool: BASH_TOOL, command },
        });
        return deny(decision.reason);
      }
      // A gate run inherits the bound role through its environment: the
      // policy has already refused every construct that could make the
      // prefix mean anything but an env assignment. git, sleep and rm pass
      // through untouched — nothing in them reads a role.
      if (decision.carrier === "pi-gates") {
        const original = isRecord(payload.toolInput) ? payload.toolInput : {};
        allowed = allowWith({ ...original, command: `${ROLE_ENV}=${role} ${command}` });
      }
      continue;
    }
    const blocked = evaluatePathGate({ role, toolName: call.toolName, input: call.input, cwd, harnessRoot });
    if (blocked !== undefined) return deny(blocked.reason);
  }
  return allowed;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return ""; // no stdin ⇒ malformed payload ⇒ fail open, loudly
  }
}

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
  const out = runHook(process.argv.slice(2), readStdin(), process.cwd());
  if (out.stdout !== "") process.stdout.write(out.stdout);
  if (out.stderr !== "") process.stderr.write(out.stderr);
  process.exit(0); // never non-zero: a hook failure is a fail-open, not a block
}
