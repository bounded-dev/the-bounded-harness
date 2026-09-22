import { describe, expect, test } from "vitest";
import { BASH_TOOL, claudeTaskModel, mapToolCall } from "./tool-map.ts";

// ADR 2026-034: the Claude Code hook judges the SAME pi-shaped call the pi
// extension would. These fixtures are the tool_input shapes the Claude Code
// docs give, one per tool, and the pi call each must become.

const CWD = "/proj";
const map = (tool_name: string, tool_input: unknown) => mapToolCall({ tool_name, tool_input }, CWD);

describe("file tools → read/write/edit with input.path", () => {
  test("Read {file_path} → read", () => {
    expect(map("Read", { file_path: "/proj/src/x.ts" })).toEqual([{ toolName: "read", input: { path: "/proj/src/x.ts" } }]);
  });
  test("Write {file_path, content} → write", () => {
    expect(map("Write", { file_path: "/proj/src/x.ts", content: "…" })).toEqual([
      { toolName: "write", input: { path: "/proj/src/x.ts" } },
    ]);
  });
  test("Edit {file_path, old_string, new_string} → edit", () => {
    expect(map("Edit", { file_path: "/proj/a.ts", old_string: "a", new_string: "b" })).toEqual([
      { toolName: "edit", input: { path: "/proj/a.ts" } },
    ]);
  });
  test("NotebookEdit {notebook_path} → edit", () => {
    expect(map("NotebookEdit", { notebook_path: "/proj/n.ipynb", new_source: "" })).toEqual([
      { toolName: "edit", input: { path: "/proj/n.ipynb" } },
    ]);
  });
  test("a missing path is passed through empty, so decide() refuses it as such", () => {
    expect(map("Read", {})).toEqual([{ toolName: "read", input: {} }]);
    expect(map("Read", "not an object")).toEqual([{ toolName: "read", input: {} }]);
    expect(map("Write", undefined)).toEqual([{ toolName: "write", input: {} }]);
  });
});

describe("MultiEdit → one edit per distinct path", () => {
  test("the documented shape: top-level file_path, edits without one", () => {
    expect(map("MultiEdit", { file_path: "/proj/a.ts", edits: [{ old_string: "x", new_string: "y" }] })).toEqual([
      { toolName: "edit", input: { path: "/proj/a.ts" } },
    ]);
  });
  test("per-edit file_path values are judged too, deduplicated", () => {
    expect(
      map("MultiEdit", {
        file_path: "/proj/a.ts",
        edits: [{ file_path: "/proj/b.ts" }, { file_path: "/proj/a.ts" }, { file_path: "/proj/c.ts" }],
      }),
    ).toEqual([
      { toolName: "edit", input: { path: "/proj/a.ts" } },
      { toolName: "edit", input: { path: "/proj/b.ts" } },
      { toolName: "edit", input: { path: "/proj/c.ts" } },
    ]);
  });
  test("no path anywhere → a pathless edit (refused downstream, never allowed)", () => {
    expect(map("MultiEdit", { edits: [{ old_string: "x" }] })).toEqual([{ toolName: "edit", input: {} }]);
  });
});

describe("search tools → find/grep, defaulting to the session cwd", () => {
  test("Glob {pattern, path} → find {path}", () => {
    expect(map("Glob", { pattern: "**/*.ts", path: "/proj/src" })).toEqual([{ toolName: "find", input: { path: "/proj/src" } }]);
  });
  test("Glob without path searches cwd, so cwd is what is judged", () => {
    expect(map("Glob", { pattern: "**/*.ts" })).toEqual([{ toolName: "find", input: { path: CWD } }]);
  });
  test("Grep {pattern, path} → grep {path}; without path → cwd", () => {
    expect(map("Grep", { pattern: "TODO", path: "/proj/tests" })).toEqual([{ toolName: "grep", input: { path: "/proj/tests" } }]);
    expect(map("Grep", { pattern: "TODO" })).toEqual([{ toolName: "grep", input: { path: CWD } }]);
  });
  test("LS {path} → ls", () => {
    expect(map("LS", { path: "/proj/tests" })).toEqual([{ toolName: "ls", input: { path: "/proj/tests" } }]);
  });
});

describe("Agent → subagent launch", () => {
  test("subagent_type becomes agent, prompt becomes task, no action (a launch)", () => {
    expect(map("Agent", { subagent_type: "builder", prompt: "implement", description: "d" })).toEqual([
      { toolName: "subagent", input: { agent: "builder", task: "implement" } },
    ]);
  });
  test("Task is the same tool under its older name", () => {
    expect(map("Task", { subagent_type: "reviewer", prompt: "review" })).toEqual([
      { toolName: "subagent", input: { agent: "reviewer", task: "review" } },
    ]);
  });
  test("a shapeless Agent call still reaches the phase gate as a subagent call", () => {
    expect(map("Agent", {})).toEqual([{ toolName: "subagent", input: {} }]);
  });
});

describe("Bash and the rest", () => {
  test("Bash → the explicit bash marker carrying the command", () => {
    expect(map("Bash", { command: "bounded gates typecheck" })).toEqual([{ toolName: BASH_TOOL, input: { command: "bounded gates typecheck" } }]);
    expect(BASH_TOOL).toBe("bash"); // the pi name: decide() would refuse it outright if a host forgot to route it
  });
  test.each(["WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion", "Skill", "SomethingNew"])(
    "%s is not a tool the gate judges → []",
    (tool) => {
      expect(map(tool, { anything: true })).toEqual([]);
    },
  );
});

describe("Agent model passthrough and claudeTaskModel — ADR 2026-022 on this host", () => {
  test("a caller-passed model rides into the mapped spawn so the tier core can judge it", () => {
    const calls = map("Agent", { subagent_type: "builder", prompt: "implement it", model: "haiku" });
    expect(calls).toEqual([{ toolName: "subagent", input: { agent: "builder", task: "implement it", model: "haiku" } }]);
  });

  test.each([
    ["anthropic/claude-opus-5:high", "opus"],
    ["anthropic/claude-sonnet-5", "sonnet"],
    ["claude-haiku-4-5", "haiku"],
    ["anthropic/claude-fable-5", "fable"],
    ["anthropic/claude-mythos-5", "fable"], // same model, Fable's gated tier
  ])("%s → %s", (pattern, family) => {
    expect(claudeTaskModel(pattern)).toBe(family);
  });

  test.each(["fireworks/kimi-k3-fast:medium", "openai/gpt-6", "anthropic/claude-unknown-9"])(
    "%s names no model this host can run",
    (pattern) => {
      expect(claudeTaskModel(pattern)).toBeUndefined();
    },
  );
});
