// Claude Code PreToolUse hook: the path gate and the phase gate for one role
// (ADR 2026-029, Tier B on the second host).
//
//   node path-gate-hook.ts [--role <role>] [--harness-root <dir>]  < payload.json
//
// Claude Code runs this once per tool call, feeding the call as JSON on stdin,
// and reads a decision back: nothing on stdout means "allow", a JSON object
// with `permissionDecision: "deny"` means "refuse, and tell the model why",
// and an allowed `pi-gates …` comes back as `permissionDecision: "allow"` with
// `updatedInput` rewriting the command to `PI_HOST=claude-code
// PI_DEV_STAGE_ROLE=<role> …` — the one place the bound role and the host
// cross into the gate's own process, where `sessionRole()` reads the role
// before any role file and the CLI records which host ran it.
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
// Edit and the rest are judged twice. Mitigation, UNVERIFIED live: if the
// PreToolUse payload carries the subagent's identity (`agent_type` or
// `agent_id`, as SubagentStart's does), the AMBIENT hook stands down — that
// call is a bound subagent's, and its own definition's hook judges it. A
// bound hook never stands down. The README says: a bound run leaves no role
// file in the project.
//
// ── Failure mode: OPEN for reads, CLOSED for writes ─────────────────────────
// A hook that crashes must not brick the session, but a gate that fails open
// on a write is no gate. Any error — malformed stdin, an unreadable project,
// a bug here — writes one line to stderr and records an `error` event in the
// guard log, so a run that went ungated is at least visibly so. Then: if the
// tool is known to mutate (Bash, Write, Edit, MultiEdit, NotebookEdit,
// Agent, Task) the call is DENIED with a reason that says the hook errored;
// a read, or a tool the payload never named, is allowed. Logging itself
// never throws.
//
// ── Run start ───────────────────────────────────────────────────────────────
// pi stamps `run-start` from the driving session's first tool call, once per
// session, with a closure. This hook is a fresh process per call, so the
// once-latch is the log itself: stamp when the role is driving and the log
// holds no run-start yet. Same marker, same consumer (phase-durations.ts).

import { readFileSync } from "node:fs";
import { logGuardEvent, readGuardLog, RUN_START_GUARD } from "../../src/guard-log.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  asRole,
  evaluatePathGate,
  isDrivingRole,
  PIPELINE_ROLES,
  recordRunStart,
  sessionRole,
} from "../../src/path-gate.ts";
import { CONSTRAINTS, declareHost, HOST_ENV, recordHostDeclaration } from "../../src/host.ts";
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
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  /** The calling subagent's identity, when the payload carries one. */
  readonly agentType?: string;
  readonly agentId?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(raw: string): Readonly<Record<string, unknown>> {
  const rec: unknown = JSON.parse(raw);
  if (!isRecord(rec)) throw new Error("payload is not a JSON object");
  return rec;
}

/** The tool the payload names — read first and on its own, so the failure
 *  mode can be chosen by tool even when the rest of the payload is bad. */
function toolNameOf(rec: Readonly<Record<string, unknown>>): string {
  const toolName = rec["tool_name"];
  if (typeof toolName !== "string") throw new Error("payload has no tool_name");
  return toolName;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function narrowPayload(rec: Readonly<Record<string, unknown>>, toolName: string): Payload {
  const toolInput = rec["tool_input"] ?? {};
  if (!isRecord(toolInput)) throw new Error("payload tool_input is not an object");
  const event = nonEmpty(rec["hook_event_name"]);
  const cwd = nonEmpty(rec["cwd"]);
  const agentType = nonEmpty(rec["agent_type"]);
  const agentId = nonEmpty(rec["agent_id"]);
  return {
    ...(event !== undefined ? { event } : {}),
    toolName,
    toolInput,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/** The Claude Code tools that change the tree or start an agent: the ones an
 *  errored hook must refuse rather than wave through. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"]);

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

/** The env prefix an allowed `pi-gates` call is given: the host, so the CLI
 *  records `claude-code` rather than `none`, and the bound role. */
export function gateEnvPrefix(role: Role): string {
  return `${HOST_ENV}=claude-code ${ROLE_ENV}=${role}`;
}

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
  let toolName: string | undefined;
  try {
    const rec = parseRecord(rawStdin);
    toolName = toolNameOf(rec);
    const payload = narrowPayload(rec, toolName);
    if (payload.event !== undefined && payload.event !== "PreToolUse") return { stdout: "", stderr: "" };
    cwd = payload.cwd ?? fallbackCwd;
    const harnessRoot = flags.harnessRoot ?? defaultHarnessRoot();

    const role = resolveRole(flags, cwd);
    if (role.kind === "none") return { stdout: "", stderr: role.note ?? "" };
    // A bound subagent's call, seen by the ambient hook: its own definition's
    // hook judges it, and judging it again here would confine it to the
    // intersection of two roles. Stand down, silently.
    if (role.kind === "ambient" && (payload.agentType !== undefined || payload.agentId !== undefined)) {
      return { stdout: "", stderr: "" };
    }

    return { stdout: evaluate(role.role, role.kind === "bound", payload, cwd, harnessRoot), stderr: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const closed = toolName !== undefined && MUTATING_TOOLS.has(toolName);
    const outcome = closed ? "call refused" : "call allowed";
    logGuardEvent(cwd, {
      guard: "path-gate",
      verdict: "error",
      summary: `${DENY_PREFIX}: error, ${outcome}: ${message}`,
      detail: { host: "claude-code", kind: "hook-error", ...(toolName !== undefined ? { tool: toolName } : {}) },
    });
    if (closed) {
      const reason = `${DENY_PREFIX}: the hook errored (${message}), so this ${toolName} call is refused rather than let through ungated`;
      return { stdout: deny(reason), stderr: `${DENY_PREFIX}: error, refusing the ${toolName} call: ${message}\n` };
    }
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
        allowed = allowWith({ ...payload.toolInput, command: `${gateEnvPrefix(role)} ${command}` });
      }
      continue;
    }
    if (call.toolName === "subagent") {
      const unbound = unboundSpawn(call.input);
      if (unbound !== undefined) {
        logGuardEvent(cwd, {
          guard: "phase-gate",
          verdict: "block",
          summary: unbound.reason,
          detail: { kind: "spawn-refused", role, ...(unbound.target !== undefined ? { target: unbound.target } : {}) },
        });
        return deny(unbound.reason);
      }
    }
    const blocked = evaluatePathGate({ role, toolName: call.toolName, input: call.input, cwd, harnessRoot });
    if (blocked !== undefined) return deny(blocked.reason);
  }
  return allowed;
}

/**
 * On this host only the four generated definitions carry a tool strip and a
 * bound hook. Any other `subagent_type` — `general-purpose`, `Explore`, a
 * user's own agent, pi's `delegate` — starts with every tool and no hook: a
 * full-toolset proxy for the caller, which is exactly what the phase gate's
 * `delegate` refusal exists to prevent. So a commission is judged first by
 * WHAT it names: not a pipeline role ⇒ refused, before the phase gate sees
 * it. Logged as the phase gate's own spawn-refused block.
 */
function unboundSpawn(
  input: Readonly<Record<string, unknown>>,
): { readonly reason: string; readonly target?: string } | undefined {
  const named = input["agent"];
  const target = typeof named === "string" ? named : undefined;
  if (target !== undefined && asRole(target) !== undefined) return undefined;
  const who = target === undefined ? "an Agent call with no subagent_type" : `'${target}'`;
  const reason =
    `phase-gate: ${who} holds no role binding — inside the developer stage every subagent is a bound role, ` +
    `and on Claude Code only the generated definitions (${PIPELINE_ROLES.join(", ")}) carry the tool strip and ` +
    "the path-gate hook; any other subagent_type runs with every tool and no hook. Commission the role that owns the work.";
  return { reason, ...(target !== undefined ? { target } : {}) };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return ""; // no stdin ⇒ malformed payload ⇒ fail open, loudly
  }
}

if (isMainModule(import.meta.url)) {
  const out = runHook(process.argv.slice(2), readStdin(), process.cwd());
  if (out.stdout !== "") process.stdout.write(out.stdout);
  if (out.stderr !== "") process.stderr.write(out.stderr);
  process.exit(0); // never non-zero: a hook failure is a fail-open, not a block
}
