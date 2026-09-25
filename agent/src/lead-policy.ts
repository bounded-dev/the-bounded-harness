// The project-local entry seat coordinates a run without editing product files.
// Both hosts translate their tool calls into this small, host-neutral policy.

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deliveryState } from "./change-run-status.ts";
import { guardLogPath, logGuardEvent } from "./guard-log.ts";
import { decide } from "./path-policy.ts";
import { markSetupComplete } from "./setup-complete.ts";

export const ACTIVE_TICKET_RELATIVE = ".bounded/active-ticket";
export const LEAD_PREPARE_TOOL = "lead_prepare";
export const LEAD_SETUP_TOOL = "lead_setup";

export type LeadDecision =
  | { readonly allow: true; readonly action?: "prepare" | "setup" }
  | { readonly allow: false; readonly reason: string };

const ALLOW: LeadDecision = { allow: true };
const deny = (why: string): LeadDecision => ({ allow: false, reason: `team-lead: ${why}` });
const PROJECT_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const OTHER_READ_TOOLS = new Set(["web_search", "web_fetch", "skill"]);
const CHILD_READ_ACTIONS = new Set(["children.list", "status", "wait"]);
const TICKET = /^[1-9][0-9]*$/;

/** An installed project has this manifest; a global pi session does not. */
export function isProjectLocalHarness(cwd: string): boolean {
  return existsSync(join(cwd, ".bounded", "installation.json")) &&
    existsSync(join(cwd, ".bounded", "harness", "src", "lead-policy.ts"));
}

/** The lead may inspect, prepare a ticket, or commission one bound seat. */
export function decideLeadTool(toolName: string, input: Readonly<Record<string, unknown>>, cwd?: string): LeadDecision {
  if (PROJECT_READ_TOOLS.has(toolName)) {
    if (cwd === undefined) return ALLOW; // tool-visibility query at session start
    const result = decide("architect", toolName, input, { cwd });
    return result.allow ? ALLOW : deny(result.reason);
  }
  if (OTHER_READ_TOOLS.has(toolName)) return ALLOW;
  if (toolName === LEAD_PREPARE_TOOL) return { allow: true, action: "prepare" };
  if (toolName === LEAD_SETUP_TOOL) {
    return cwd !== undefined && isInitialSetup(cwd)
      ? { allow: true, action: "setup" }
      : deny("dependency setup is only available before the first prepared run");
  }
  if (toolName === "subagent_wait") return ALLOW;
  if (toolName !== "subagent") return deny(`'${toolName}' is outside the read-only lead toolset`);

  for (const field of ["workflowScript", "chain", "parallel", "runs"]) {
    if (input[field] !== undefined) return deny(`subagent ${field} hides individual commissions`);
  }
  const action = input["action"];
  if (typeof action === "string" && CHILD_READ_ACTIONS.has(action)) return ALLOW;
  if (action !== undefined && action !== "launch" && action !== "run") {
    return deny(`subagent action '${String(action)}' cannot be used by the lead`);
  }
  if (input["agentScope"] !== undefined && input["agentScope"] !== "project") {
    return deny("subagents must use this project's bound definitions");
  }
  const agent = input["agent"] ?? input["subagent_type"];
  if (input["agent"] !== undefined && input["subagent_type"] !== undefined &&
      input["agent"] !== input["subagent_type"]) {
    return deny("subagent role fields disagree");
  }
  if (agent !== "scout" && agent !== "architect") {
    return deny("only scout and architect may be commissioned by the lead");
  }
  if (typeof input["task"] !== "string" || input["task"].trim() === "") {
    return deny("a scout or architect commission needs a task");
  }
  if (agent === "architect" && (cwd === undefined || preparedTicket(cwd) === undefined)) {
    return deny("prepare the ticket's run boundary before commissioning its architect");
  }
  return ALLOW;
}

const execFileAsync = promisify(execFile);

/** Install only the two lockfile-pinned dependency trees owned by this project. */
export async function setupLeadProject(cwd: string, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly summary: string }> {
  if (!isInitialSetup(cwd)) {
    return { ok: false, summary: "team-lead: dependency setup is only available before the first prepared run" };
  }
  for (const [label, args] of [
    ["project", ["ci"]],
    ["local harness", ["ci", "--prefix", ".bounded/harness"]],
  ] as const) {
    try {
      await execFileAsync("npm", [...args], { cwd, signal, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const summary = `team-lead: ${label} dependency setup failed: ${detail.slice(-1200)}`;
      logGuardEvent(cwd, { guard: "team-lead", verdict: "block", summary, detail: { kind: "setup", stage: label } });
      return { ok: false, summary };
    }
  }
  markSetupComplete(cwd);
  const summary = "team-lead: project and local harness dependencies installed from lockfiles";
  logGuardEvent(cwd, { guard: "team-lead", verdict: "pass", summary, detail: { kind: "setup" } });
  return { ok: true, summary };
}

/** A one-time dependency setup may run before any ticket design or run. */
export function isInitialSetup(cwd: string): boolean {
  if (!isProjectLocalHarness(cwd)) return false;
  if (existsSync(join(cwd, ACTIVE_TICKET_RELATIVE)) ||
      existsSync(join(cwd, ".bounded", "contract-checksums.json"))) return false;
  const tickets = join(cwd, ".bounded", "tickets");
  if (existsSync(tickets) && readdirSync(tickets, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() && existsSync(join(tickets, entry.name, "contract-checksums.json")))) return false;
  const log = guardLogPath(cwd);
  if (!existsSync(log)) return true;
  const raw = readFileSync(log, "utf8");
  if (deliveryState(raw) === "malformed") return false;
  return !raw.split("\n").some((line) => {
    if (!line.trim()) return false;
    const event = JSON.parse(line) as { guard?: unknown };
    return event.guard === "run-start";
  });
}

/** The recorded ticket, only after the lead has selected a boundary for it. */
export function preparedTicket(cwd: string): string | undefined {
  if (!isProjectLocalHarness(cwd)) return undefined;
  const path = join(cwd, ACTIVE_TICKET_RELATIVE);
  if (!existsSync(path) || !lstatSync(path).isFile()) return undefined;
  const ticket = readFileSync(path, "utf8").trim();
  if (!TICKET.test(ticket)) return undefined;
  const log = guardLogPath(cwd);
  if (!existsSync(log)) return undefined;
  const state = deliveryState(readFileSync(log, "utf8"));
  if (state === "malformed" || state === "delivered") return undefined;
  const events = readFileSync(log, "utf8").split("\n");
  return events.some((line) => {
    if (!line.trim()) return false;
    try {
      const event = JSON.parse(line) as { guard?: unknown; verdict?: unknown; detail?: { kind?: unknown; ticket?: unknown } };
      return event.guard === "team-lead" && event.verdict === "pass" &&
        event.detail?.kind === "run-prepared" && event.detail.ticket === ticket;
    } catch { return false; }
  }) ? ticket : undefined;
}

export type LeadPrepareResult =
  | { readonly ok: true; readonly kind: "first" | "change" | "resume"; readonly ticket: string; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

/** Prepare one ticket in one project worktree. The lead owns this boundary. */
function nextLocalTicket(cwd: string): string {
  const used = new Set<number>();
  const tnDir = join(cwd, "docs", "tn");
  if (existsSync(tnDir)) for (const entry of readdirSync(tnDir)) {
    const match = /^TN-([1-9][0-9]*)\.md$/.exec(entry);
    if (match) used.add(Number(match[1]));
  }
  const ticketDir = join(cwd, ".bounded", "tickets");
  if (existsSync(ticketDir)) for (const entry of readdirSync(ticketDir)) {
    if (TICKET.test(entry)) used.add(Number(entry));
  }
  const active = join(cwd, ACTIVE_TICKET_RELATIVE);
  if (existsSync(active) && lstatSync(active).isFile()) {
    const number = readFileSync(active, "utf8").trim();
    if (TICKET.test(number)) used.add(Number(number));
  }
  const next = Math.max(0, ...used) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("no safe local ticket number remains");
  return String(next);
}

export function prepareLeadRun(cwd: string, requestedTicket?: string, fresh = false): LeadPrepareResult {
  if (!isProjectLocalHarness(cwd)) return { ok: false, reason: "team-lead: no project-local Bounded installation" };
  const activePath = join(cwd, ACTIVE_TICKET_RELATIVE);
  if (existsSync(activePath) && !lstatSync(activePath).isFile()) {
    return { ok: false, reason: "team-lead: active ticket is not a regular file" };
  }
  const previous = existsSync(activePath) ? readFileSync(activePath, "utf8").trim() : undefined;
  if (previous !== undefined && !TICKET.test(previous)) {
    return { ok: false, reason: "team-lead: active ticket is malformed" };
  }
  const ticket = requestedTicket ?? (fresh || previous === undefined ? nextLocalTicket(cwd) : previous);
  if (!TICKET.test(ticket)) return { ok: false, reason: "team-lead: ticket must be a positive number" };
  if (fresh && previous === ticket) {
    return { ok: false, reason: `team-lead: ticket #${ticket} is already active; omit new to change or resume it` };
  }
  if (process.env.BOUNDED_TICKET !== undefined && process.env.BOUNDED_TICKET !== ticket) {
    return { ok: false, reason: `team-lead: BOUNDED_TICKET selects #${process.env.BOUNDED_TICKET}; use that ticket or clear the override` };
  }
  if (!existsSync(join(cwd, "docs", "tn", "README.md"))) {
    return { ok: false, reason: "team-lead: this project has no ticket-numbered design notes" };
  }

  const switching = previous !== undefined && previous !== ticket;
  if (switching && !fresh) {
    return { ok: false, reason: `team-lead: ticket #${previous} is active; use a new work item after its final delivery` };
  }

  const priorManifest = join(cwd, ".bounded", "tickets", previous ?? ticket, "contract-checksums.json");
  const log = guardLogPath(cwd);
  const hasLog = existsSync(log);
  const events = hasLog ? readFileSync(log, "utf8") : "";
  const state = hasLog ? deliveryState(events) : undefined;
  if (state === "malformed") return { ok: false, reason: "team-lead: guard log is malformed; boundary not changed" };
  const guards = events.split("\n").filter((line) => line.trim() !== "").map((line) =>
    (JSON.parse(line) as { guard: string }).guard);

  let kind: "first" | "change" | "resume";
  if (switching && state !== "delivered") {
    return { ok: false, reason: "team-lead: the active ticket has no final delivery; continue it before starting a new work item" };
  }
  if (state === "delivered") {
    if (!existsSync(priorManifest)) {
      return { ok: false, reason: "team-lead: delivered log has no frozen design for the prior ticket" };
    }
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "bounded-change-run");
    try {
      execFileSync("bash", [script, cwd], {
        cwd,
        env: { ...process.env, BOUNDED_TICKET: previous ?? ticket },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `team-lead: change boundary failed: ${message}` };
    }
    kind = switching ? "first" : "change";
  } else if (state === "undelivered" && guards.includes("run-start")) {
    kind = "resume";
  } else if (hasLog && state === "undelivered" && guards.some((guard) =>
    guard !== "team-lead" && guard !== "path-gate" && guard !== "host")) {
    return { ok: false, reason: "team-lead: unfinished run evidence exists; resume or resolve it before starting another ticket" };
  } else {
    kind = "first";
  }

  if (previous !== ticket) writeFileSync(activePath, `${ticket}\n`);
  const summary = `team-lead: ${kind} run prepared for ticket #${ticket}`;
  logGuardEvent(cwd, { guard: "team-lead", verdict: "pass", summary, detail: { kind: "run-prepared", ticket, boundary: kind } });
  return { ok: true, kind, ticket, summary };
}
