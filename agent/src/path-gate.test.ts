import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readGuardLog } from "./guard-log.ts";
import { asRole, evaluatePathGate, PIPELINE_ROLES } from "./path-gate.ts";

// TN-26-001 Phase 2: the path-gate's testable core — event + role + cwd →
// {block,reason} | undefined, including the guard-log side effect on a block.
// Wiring over the already-tested decide(); we assert the DECISION and the LOG.

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "path-gate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("asRole — only the pipeline roles are recognized", () => {
  test.each(PIPELINE_ROLES)("accepts %s", (role) => {
    expect(asRole(role)).toBe(role);
  });
  test.each([undefined, null, "", "orchestrator", "ARCHITECT", "delegate", 42, {}])(
    "rejects %s → undefined (gate inactive)",
    (value) => {
      expect(asRole(value)).toBeUndefined();
    },
  );
});

describe("gate is inactive without a pipeline role (normal/orchestrator sessions)", () => {
  test.each([undefined, null, "", "orchestrator", "delegate"])(
    "role %s → undefined and writes no log",
    (role) => {
      const cwd = tmp();
      const result = evaluatePathGate({
        role,
        toolName: "write",
        input: { path: "anywhere.ts" },
        cwd,
      });
      expect(result).toBeUndefined();
      expect(readGuardLog(cwd)).toEqual([]);
    },
  );
});

// Representative allowed + blocked call per role. `allowed` must pass through
// (undefined, no log); `blocked` must return a reason AND leave one path-gate
// block entry in the target project's guard log.
type Case = {
  role: (typeof PIPELINE_ROLES)[number];
  allowed: { tool: string; path: string };
  blocked: { tool: string; path: string };
};

const CASES: Case[] = [
  {
    role: "architect",
    allowed: { tool: "write", path: "src/orders/orders.contract.ts" },
    blocked: { tool: "write", path: "src/orders/orders.ts" }, // implementation, not contract
  },
  {
    role: "test-writer",
    allowed: { tool: "write", path: "tests/orders.test.ts" },
    blocked: { tool: "read", path: "src/orders/orders.ts" }, // blind to src/
  },
  {
    role: "builder",
    allowed: { tool: "write", path: "src/orders/orders.ts" },
    blocked: { tool: "read", path: "tests/orders.test.ts" }, // blind to tests/
  },
  {
    role: "reviewer",
    allowed: { tool: "read", path: "src/orders/orders.contract.ts" }, // the design under review
    blocked: { tool: "write", path: "spec.md" }, // not even the file it is reviewing
  },
];

describe.each(CASES)("$role", ({ role, allowed, blocked }) => {
  test(`allows ${allowed.tool} ${allowed.path} → undefined, no log`, () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role,
      toolName: allowed.tool,
      input: { path: allowed.path },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(readGuardLog(cwd)).toEqual([]);
  });

  test(`blocks ${blocked.tool} ${blocked.path} → reason + path-gate log entry`, () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role,
      toolName: blocked.tool,
      input: { path: blocked.path },
      cwd,
    });
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("path-gate");
    expect(result!.reason).toContain(role);

    const events = readGuardLog(cwd);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.guard).toBe("path-gate");
    expect(event.verdict).toBe("block");
    expect(event.summary).toBe(result!.reason);
    expect(event.detail).toMatchObject({
      role,
      tool: blocked.tool,
      path: blocked.path,
    });
  });
});

describe("forbidden tools (bash/subagent) block for a pipeline role and are logged", () => {
  test("builder may not use bash", () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role: "builder",
      toolName: "bash",
      input: { command: "ls tests/" },
      cwd,
    });
    expect(result?.block).toBe(true);
    const events = readGuardLog(cwd);
    expect(events).toHaveLength(1);
    expect(events[0].guard).toBe("path-gate");
    expect(events[0].detail).toMatchObject({ role: "builder", tool: "bash" });
  });
});

describe("ungated tools pass through untouched", () => {
  test("a non-path, non-forbidden tool → undefined, no log", () => {
    const cwd = tmp();
    const result = evaluatePathGate({
      role: "architect",
      toolName: "web_search",
      input: { query: "anything" },
      cwd,
    });
    expect(result).toBeUndefined();
    expect(readGuardLog(cwd)).toEqual([]);
  });
});
