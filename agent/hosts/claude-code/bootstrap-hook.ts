// Dependency-free project hook entry. A fresh clone has no harness node_modules,
// so importing path-gate-hook.ts before `npm run bounded:setup` would fail.

import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "../..");
const projectRoot = resolve(harnessRoot, "../..");
const mutating = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"]);
const reading = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "Skill"]);

function deny(reason: string): void {
  try {
    appendFileSync(join(projectRoot, ".bounded", "guard-log.jsonl"), JSON.stringify({
      ts: new Date().toISOString(), guard: "team-lead", verdict: "block", summary: reason,
      detail: { host: "claude-code", kind: "dependency-bootstrap" },
    }) + "\n");
  } catch { /* logging must not weaken the refusal */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }) + "\n");
}

function hasDependencies(): boolean {
  return existsSync(join(projectRoot, ".bounded", "setup-complete")) &&
    existsSync(join(projectRoot, "node_modules", ".package-lock.json")) &&
    existsSync(join(harnessRoot, "node_modules", ".package-lock.json"));
}

function insideProject(path: string): boolean {
  try {
    const root = realpathSync(projectRoot);
    const rel = relative(root, realpathSync(path));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch { return false; }
}

function projectContext(cwd: unknown, exactRoot: boolean): string | undefined {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  if (declared === undefined || !insideProject(declared)) return undefined;
  try { if (realpathSync(declared) !== realpathSync(projectRoot)) return undefined; } catch { return undefined; }
  const current = resolve(process.cwd());
  if (!insideProject(current)) return undefined;
  if (exactRoot) {
    try { if (realpathSync(current) !== realpathSync(projectRoot)) return undefined; } catch { return undefined; }
  }
  if (cwd !== undefined && (typeof cwd !== "string" || !insideProject(cwd))) return undefined;
  if (exactRoot && typeof cwd === "string") {
    try { if (realpathSync(cwd) !== realpathSync(projectRoot)) return undefined; } catch { return undefined; }
  }
  return typeof cwd === "string" ? cwd : current;
}

function safeRead(tool: string, input: Record<string, unknown>, cwd: string): boolean {
  const key = tool === "Read" ? "file_path" : "path";
  const candidate = input[key];
  if (tool === "Read" && (typeof candidate !== "string" || candidate === "")) return false;
  if (candidate !== undefined && (typeof candidate !== "string" || candidate === "")) return false;
  const path = candidate === undefined ? cwd : resolve(cwd, candidate as string);
  if (!insideProject(path)) return false;
  if (tool === "Glob") {
    const pattern = input["pattern"];
    if (typeof pattern !== "string" || pattern === "" || isAbsolute(pattern) || pattern.includes("..") || pattern.includes("\\")) return false;
  }
  if (tool === "Grep") {
    const glob = input["glob"];
    if (glob !== undefined && (typeof glob !== "string" || isAbsolute(glob) || glob.includes("..") || glob.includes("\\"))) return false;
  }
  return true;
}

function beforeFirstRun(): boolean {
  try {
    if (!existsSync(join(projectRoot, ".bounded", "installation.json"))) return false;
    if (existsSync(join(projectRoot, ".bounded", "active-ticket")) ||
        existsSync(join(projectRoot, ".bounded", "contract-checksums.json"))) return false;
    const tickets = join(projectRoot, ".bounded", "tickets");
    if (existsSync(tickets) && readdirSync(tickets, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && existsSync(join(tickets, entry.name, "contract-checksums.json")))) return false;
    const log = join(projectRoot, ".bounded", "guard-log.jsonl");
    if (!existsSync(log)) return true;
    return readFileSync(log, "utf8").split("\n").every((line) => {
      if (line.trim() === "") return true;
      const event: unknown = JSON.parse(line);
      return typeof event === "object" && event !== null && (event as { guard?: unknown }).guard !== "run-start";
    });
  } catch { return false; }
}

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {
  deny("team-lead: bootstrap hook could not read the tool call");
  process.exit(0);
}
if (hasDependencies()) {
  const full = spawnSync(process.execPath, [join(here, "path-gate-hook.ts"), ...process.argv.slice(2)], {
    input: raw, encoding: "utf8", cwd: process.cwd(), env: process.env,
  });
  if (full.status === 0) {
    if (full.stdout) process.stdout.write(full.stdout);
    if (full.stderr) process.stderr.write(full.stderr);
  } else {
    deny(`team-lead: full policy hook failed to start (${full.error?.message ?? full.stderr?.trim() ?? "unknown error"})`);
  }
} else {
  let tool: string | undefined;
  let input: Record<string, unknown> = {};
  let agentId: unknown;
  let agentType: unknown;
  let payloadCwd: unknown;
  try {
    const payload: unknown = JSON.parse(raw);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("bad payload");
    const record = payload as Record<string, unknown>;
    tool = typeof record.tool_name === "string" ? record.tool_name : undefined;
    input = typeof record.tool_input === "object" && record.tool_input !== null && !Array.isArray(record.tool_input)
      ? record.tool_input as Record<string, unknown> : {};
    agentId = record.agent_id;
    agentType = record.agent_type;
    payloadCwd = record.cwd;
  } catch { /* malformed calls are refused below */ }
  const bound = process.argv.some((arg) => arg === "--role" || arg.startsWith("--role="));
  const readCwd = projectContext(payloadCwd, false);
  if (tool === "Bash" && input.command === "npm run bounded:setup" && agentId === undefined && agentType === undefined &&
      !bound && projectContext(payloadCwd, true) !== undefined &&
      (beforeFirstRun() || existsSync(join(projectRoot, ".bounded", "setup-complete")))) {
    // Let Claude Code's normal permission decision handle this exact setup.
  } else if (!bound && agentId === undefined && agentType === undefined &&
             readCwd !== undefined && tool !== undefined && ["Read", "Grep", "Glob", "LS"].includes(tool) && safeRead(tool, input, readCwd)) {
    // Read-only discovery can proceed before installation.
  } else if (!bound && agentId === undefined && agentType === undefined && readCwd !== undefined &&
             tool !== undefined && reading.has(tool) && !["Read", "Grep", "Glob", "LS"].includes(tool)) {
    // Web and skill loading do not read local paths through this hook.
  } else if (tool === undefined || mutating.has(tool) || !reading.has(tool) || bound || agentId !== undefined || agentType !== undefined || readCwd === undefined) {
    deny("team-lead: dependencies are not installed; run exactly `npm run bounded:setup` before other tools");
  } else {
    deny("team-lead: local read is outside this project or has malformed paths");
  }
}
