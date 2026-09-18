// Claude Code → pi tool vocabulary (ADR 2026-034, Tier B: capability
// constraints per host).
//
// The path gate's pure core, decide() in src/path-policy.ts, speaks pi's tool
// names — `read grep find ls write edit remove subagent bash` — and reads one
// field, `input.path`. Claude Code's PreToolUse hook speaks its own: `Read
// {file_path}`, `Glob {pattern, path?}`, `Agent {subagent_type, prompt}`. This
// module is the whole translation, in one place, so the hook stays thin
// wiring over the same decision the pi extension makes and the two hosts
// cannot drift into enforcing two different rules.
//
// Pure: no fs, no process, no logging. A Claude Code tool call comes in; zero
// or more pi-shaped calls for the gate to judge come out. Zero means "not a
// tool the gate has an opinion on" (WebFetch, TodoWrite, …); the hook allows
// those. More than one happens for MultiEdit, which touches several files in
// one call and is denied if ANY of them would be.
//
// Bash is the one call that maps to a pi tool the gate would flatly refuse —
// `bash` is in every role's FORBIDDEN_TOOLS — and in this host it is instead
// the carrier for `pi-gates`. It is still returned as a `bash` GateCall rather
// than swallowed: the hook routes `bash` to the bash policy, and if it ever
// forgot to, decide() would refuse the call rather than let it through. The
// safe default is the one that needs no code.

export interface GateCall {
  /** A pi tool name: what decide() and the phase gate understand. */
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** The subset of a PreToolUse payload the mapping reads. */
export interface ClaudeToolCall {
  readonly tool_name: string;
  readonly tool_input: unknown;
}

/** The pi tool the bash policy answers for; the marker `mapToolCall` emits. */
export const BASH_TOOL = "bash";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One pi call. A missing path is passed through as-is: decide() has the
 *  right refusal for "missing path", and inventing one here would hide it. */
function one(toolName: string, path: unknown): readonly GateCall[] {
  return [{ toolName, input: path === undefined ? {} : { path } }];
}

/**
 * Translate one Claude Code tool call into the pi calls the gate judges.
 *
 * `cwd` is the session's project directory: Glob and Grep search it when no
 * `path` is given, so that is the directory the gate is asked about.
 */
export function mapToolCall(call: ClaudeToolCall, cwd: string): readonly GateCall[] {
  const input = asRecord(call.tool_input);
  switch (call.tool_name) {
    case "Read":
      return one("read", input["file_path"]);
    case "Write":
      return one("write", input["file_path"]);
    case "Edit":
      return one("edit", input["file_path"]);
    case "NotebookEdit":
      return one("edit", input["notebook_path"]);
    case "MultiEdit":
      return mapMultiEdit(input);
    // `LS` is an older Claude Code tool name; gating it costs one line and a
    // directory listing of a blind zone leaks exactly what `ls` would in pi.
    case "LS":
      return one("ls", input["path"]);
    case "Glob":
      return one("find", str(input["path"]) ?? cwd);
    case "Grep":
      return one("grep", str(input["path"]) ?? cwd);
    // `Task` is the tool's pre-rename name; hook payloads may still carry it.
    case "Agent":
    case "Task":
      return mapAgent(input);
    case "Bash":
      return [{ toolName: BASH_TOOL, input: { command: input["command"] } }];
    default:
      return []; // not a tool the gate judges
  }
}

/**
 * MultiEdit: `{file_path, edits: [{old_string, new_string}]}` in the shape the
 * docs give — but treated defensively, because a per-edit `file_path` would be
 * a second target the top-level one does not mention. Every path named
 * anywhere in the call is judged; the hook denies if any one is denied.
 */
function mapMultiEdit(input: Readonly<Record<string, unknown>>): readonly GateCall[] {
  const paths = new Set<string>();
  const top = str(input["file_path"]);
  if (top !== undefined) paths.add(top);
  const edits = input["edits"];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const p = str(asRecord(edit)["file_path"]);
      if (p !== undefined) paths.add(p);
    }
  }
  // No path anywhere: hand decide() a pathless edit so it refuses with its own
  // "missing path" reason rather than letting a shapeless call through.
  if (paths.size === 0) return one("edit", undefined);
  return [...paths].map((path) => ({ toolName: "edit", input: { path } }));
}

/**
 * Agent: a commission. pi's `subagent` tool takes `{agent, task}` with no
 * `action` for a plain launch, and that is exactly how checkSubagentCall()
 * treats a call without one — so `subagent_type` becomes `agent` and the
 * phase gate sees a launch of that role.
 */
function mapAgent(input: Readonly<Record<string, unknown>>): readonly GateCall[] {
  const agent = input["subagent_type"];
  const task = input["prompt"];
  return [
    {
      toolName: "subagent",
      input: {
        ...(agent !== undefined ? { agent } : {}),
        ...(task !== undefined ? { task } : {}),
      },
    },
  ];
}
