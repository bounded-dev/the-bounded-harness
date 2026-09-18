import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { readGuardLog, RUN_START_GUARD } from "../../src/guard-log.ts";
import { makeTempProject as makeProject, type TempProject } from "../../test/support/temp-project.ts";

// ADR 2026-029: the adapter is verified by fixture until the first live run.
// Each case spawns the hook exactly as Claude Code would — a fresh process,
// the call as JSON on stdin — in a temp project, and asserts the decision it
// prints and the guard-log lines it leaves.

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "path-gate-hook.ts");

const projects: TempProject[] = [];
function makeTempProject(files: Readonly<Record<string, string>>): string {
  const project = makeProject(files, { prefix: "cc-hook-" });
  projects.push(project);
  return project.dir;
}
afterEach(() => {
  while (projects.length) projects.pop()?.cleanup();
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly decision: "allow" | "deny";
  readonly reason: string;
  /** The rewritten tool input an explicit allow carried, if any. */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

interface HookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: string;
    readonly permissionDecision: string;
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
  };
}

function run(dir: string, stdin: string, flags: readonly string[] = []): Run {
  const env = { ...process.env };
  delete env["PI_GUARD_LOG"];
  delete env["PI_DEV_STAGE_ROLE"];
  const r = spawnSync(process.execPath, [HOOK, ...flags], { cwd: dir, input: stdin, encoding: "utf8", env });
  let decision: Run["decision"] = "allow";
  let reason = "";
  let updatedInput: Run["updatedInput"];
  if (r.stdout.trim() !== "") {
    // The test's own reading of the wire format; a shape mismatch fails here.
    const out = (JSON.parse(r.stdout) as HookOutput).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    if (out.permissionDecision === "deny") {
      decision = "deny";
      reason = out.permissionDecisionReason ?? "";
    } else {
      expect(out.permissionDecision).toBe("allow");
      expect(out.updatedInput).toBeDefined();
      updatedInput = out.updatedInput;
    }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, decision, reason, ...(updatedInput !== undefined ? { updatedInput } : {}) };
}

function payload(dir: string, tool_name: string, tool_input: unknown): string {
  return JSON.stringify({
    session_id: "s1",
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    permission_mode: "default",
  });
}

describe("path-gate-hook — the path gate, by role file", () => {
  test("test-writer reading src/x.ts → deny JSON, exit 0, and a path-gate block in the log", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "test-writer\n" });
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "src/x.ts") }));
    expect(r.status).toBe(0);
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("path-gate: test-writer may not read 'src/x.ts': denied zone 'src/**'");
    expect(r.stderr).toBe("");
    const log = readGuardLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ guard: "path-gate", verdict: "block", detail: { role: "test-writer", tool: "read" } });
  });

  test("test-writer reading src/x.contract.ts → allow, no output, no log", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "test-writer\n" });
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "src/x.contract.ts") }));
    expect(r.status).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBe("");
    expect(readGuardLog(dir)).toEqual([]);
  });

  test("builder reading tests/a.test.ts → deny", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "tests/a.test.ts") }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("path-gate: builder may not read 'tests/a.test.ts': denied zone 'tests/**'");
  });

  test("builder Grep without a path searches the project root, which overlaps tests/ → deny", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Grep", { pattern: "TODO" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("may not search '.'");
  });

  test("MultiEdit is denied if any path is denied", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(
      dir,
      payload(dir, "MultiEdit", { file_path: join(dir, "src/a.ts"), edits: [{ file_path: join(dir, "src/a.contract.ts") }] }),
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("may not write 'src/a.contract.ts'");
  });
});

describe("path-gate-hook — Bash, by role", () => {
  test.each(["architect", "test-writer", "builder", "reviewer"])("%s: `npm test` → deny with the reason, and a logged block", (role) => {
    const dir = makeTempProject({ ".pi/dev-stage-role": `${role}\n` });
    const r = run(dir, payload(dir, "Bash", { command: "npm test" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain(`path-gate: ${role} may not run 'npm': no role holds a shell`);
    const block = readGuardLog(dir).find((e) => e.guard === "path-gate" && e.verdict === "block");
    expect(block).toMatchObject({ summary: r.reason, detail: { role, tool: "bash", command: "npm test" } });
  });

  test("`pi-gates red-gate`: architect allow, builder deny", () => {
    const a = makeTempProject({ ".pi/dev-stage-role": "architect\n" });
    const ok = run(a, payload(a, "Bash", { command: "pi-gates red-gate" }));
    expect(ok.decision).toBe("allow");
    expect(ok.updatedInput?.["command"]).toBe("PI_DEV_STAGE_ROLE=architect pi-gates red-gate");
    const b = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(b, payload(b, "Bash", { command: "pi-gates red-gate" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("'red_gate' is the architect's");
  });

  test("`pi-gates typecheck`: builder allow, with the bound role handed to the CLI through the env", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "pi-gates typecheck", description: "typecheck", timeout: 60000 }));
    expect(r.status).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.updatedInput).toEqual({ command: "PI_DEV_STAGE_ROLE=builder pi-gates typecheck", description: "typecheck", timeout: 60000 });
    expect(readGuardLog(dir)).toEqual([]);
  });

  test("the env prefix carries the BOUND role, not the file's", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "pi-gates typecheck" }), ["--role", "reviewer"]);
    expect(r.updatedInput?.["command"]).toBe("PI_DEV_STAGE_ROLE=reviewer pi-gates typecheck");
  });

  test("a model-supplied --role is refused; the host supplies the role", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", { command: "pi-gates typecheck --role architect" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("may not pass '--role' to pi-gates");
  });

  test("git, sleep and rm allows stay silent: no updatedInput", () => {
    const a = makeTempProject({ ".pi/dev-stage-role": "architect\n" });
    for (const command of ["git status", "sleep 1"]) {
      const r = run(a, payload(a, "Bash", { command }));
      expect(r.decision).toBe("allow");
      expect(r.stdout).toBe("");
    }
    const t = makeTempProject({ ".pi/dev-stage-role": "test-writer\n", "tests/a.test.ts": "" });
    const r = run(t, payload(t, "Bash", { command: "rm tests/a.test.ts" }));
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBe("");
  });

  test("a Bash call with no command string is refused, not crashed on", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Bash", {}));
    expect(r.decision).toBe("deny");
    expect(r.stderr).toBe("");
  });
});

describe("path-gate-hook — the phase gate on Agent", () => {
  test("architect spawning the builder with no contracts → deny, logged as a phase-gate block", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Agent", { subagent_type: "builder", prompt: "implement it" }), ["--role", "architect"]);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("phase-gate: cannot commission the builder — no *.contract.ts exists yet");
    const block = readGuardLog(dir).find((e) => e.guard === "phase-gate");
    expect(block).toMatchObject({ verdict: "block", detail: { kind: "spawn-refused", role: "architect", target: "builder" } });
  });

  test("a worker holding no `subagent` is refused by the tool policy, not the phase", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, payload(dir, "Agent", { subagent_type: "scout", prompt: "look" }));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("builder may not use 'subagent'");
  });
});

describe("path-gate-hook — role source", () => {
  test("--role beats the role file", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    // As builder this read is denied; as the bound test-writer it is its own zone.
    expect(run(dir, payload(dir, "Read", { file_path: join(dir, "tests/a.test.ts") }), ["--role", "test-writer"]).decision).toBe("allow");
    expect(run(dir, payload(dir, "Read", { file_path: join(dir, "src/x.ts") }), ["--role", "test-writer"]).decision).toBe("deny");
  });

  test("no role anywhere → inactive: allow, no log", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "tests/a.test.ts") }));
    expect(r.decision).toBe("allow");
    expect(r.stdout).toBe("");
    expect(readGuardLog(dir)).toEqual([]);
  });

  test("a --role that is not a pipeline role fails open, loudly", () => {
    const dir = makeTempProject({});
    const r = run(dir, payload(dir, "Read", { file_path: join(dir, "src/x.ts") }), ["--role", "wizard"]);
    expect(r.status).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.stderr).toContain("--role 'wizard' is not a pipeline role");
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "path-gate", verdict: "error" });
  });

  test("a tool the gate has no opinion on passes through", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    expect(run(dir, payload(dir, "WebFetch", { url: "https://example.com" })).decision).toBe("allow");
  });

  test("a non-PreToolUse event is ignored", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const evt = JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(dir, "tests/a.test.ts") } });
    expect(run(dir, evt).decision).toBe("allow");
  });
});

describe("path-gate-hook — failure mode is open", () => {
  test("malformed stdin → allow, exit 0, one stderr line, an error event in the cwd's log", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    const r = run(dir, "this is not json");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr.split("\n").filter((l) => l !== "")).toHaveLength(1);
    expect(r.stderr).toContain("path-gate-hook: error, allowing the call");
    const log = readGuardLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ guard: "path-gate", verdict: "error", detail: { host: "claude-code", kind: "hook-error" } });
  });

  test("empty stdin and a payload without tool_name are the same failure", () => {
    const dir = makeTempProject({});
    expect(run(dir, "").stderr).toContain("allowing the call");
    expect(run(dir, JSON.stringify({ cwd: dir })).stderr).toContain("no tool_name");
  });
});

describe("path-gate-hook — run start", () => {
  test("the architect's first call stamps run-start once; later calls do not add another", () => {
    const dir = makeTempProject({});
    const call = payload(dir, "Read", { file_path: join(dir, "spec.md") });
    run(dir, call, ["--role", "architect"]);
    run(dir, call, ["--role", "architect"]);
    run(dir, payload(dir, "Bash", { command: "npm test" }), ["--role", "architect"]);
    const starts = readGuardLog(dir).filter((e) => e.guard === RUN_START_GUARD);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ verdict: "pass", summary: "first gated tool call (architect: Read)", detail: { kind: "run-start", role: "architect", tool: "Read" } });
  });

  test("a worker stamps no run-start", () => {
    const dir = makeTempProject({ ".pi/dev-stage-role": "builder\n" });
    run(dir, payload(dir, "Read", { file_path: join(dir, "tests/a.test.ts") }));
    expect(readGuardLog(dir).filter((e) => e.guard === RUN_START_GUARD)).toEqual([]);
  });
});
