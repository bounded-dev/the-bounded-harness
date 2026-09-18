import { describe, expect, test } from "vitest";
import installArchitectTools from "../../extensions/architect-tools.ts";
import installDevTools from "../../extensions/dev-tools.ts";
import { isGateCommand } from "../../src/gate-command.ts";
import { ARCHITECT_UTILITY_TOOLS, GATE_TOOLS, ROLE_TOOLS } from "../../src/path-policy.ts";
import { gates } from "./gates.ts";

// The registry is the one place a gate's public face lives (ADR 2026-029):
// `pi-gates` reads it for its command line and the pi extensions will read it
// for their tool roster. Until the extensions do, the two must agree by test,
// or Stage 2's switch-over would change what a model reads mid-run.

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly promptGuidelines?: readonly string[];
}

/** Minimal ExtensionAPI stub: records the tools an extension registers. */
function registeredTools(install: (pi: never) => void): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(spec: RegisteredTool) {
      tools.push(spec);
    },
    on() {
      /* extensions may install hooks; irrelevant here */
    },
  };
  install(pi as never);
  return tools;
}

/** The worker-side gate tools: everything a non-architect role holds that is
 *  not a builtin. Derived from ROLE_TOOLS so a new worker tool cannot land
 *  without a registry entry. */
const BUILTIN = new Set(["read", "grep", "find", "ls", "write", "edit", "remove", "subagent", "git"]);
const WORKER_GATE_TOOLS = [
  ...new Set(
    (["test-writer", "builder", "reviewer"] as const).flatMap((role) =>
      ROLE_TOOLS[role].filter((t) => !BUILTIN.has(t)),
    ),
  ),
];

describe("the registry is well-formed", () => {
  test("every entry passes the runtime shape check the CLI applies", () => {
    for (const gate of gates) expect(isGateCommand(gate), gate.name).toBe(true);
  });

  test("names are unique and kebab-case", () => {
    const names = gates.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test("tool names are unique and snake_case", () => {
    const tools = gates.flatMap((g) => (g.tool === undefined ? [] : [g.tool]));
    expect(new Set(tools).size).toBe(tools.length);
    for (const tool of tools) expect(tool).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  test("flags are kebab-case, unique per gate, and only a valued flag repeats", () => {
    for (const gate of gates) {
      const names = gate.flags.map((f) => f.name);
      expect(new Set(names).size, gate.name).toBe(names.length);
      for (const flag of gate.flags) {
        expect(flag.name, gate.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(flag.description.trim(), `${gate.name} --${flag.name}`).not.toBe("");
        if (flag.repeatable) expect(flag.kind, `${gate.name} --${flag.name}`).not.toBe("boolean");
      }
      // The CLI's own flags must never collide with a gate's.
      for (const reserved of ["json", "help", "list"]) expect(names, gate.name).not.toContain(reserved);
    }
  });
});

describe("the registry and the path policy agree", () => {
  // `sleep` is the architect's other utility and is a WAIT, not a gate: it
  // inspects nothing, so it has no place in a registry of artifact gates.
  const TOOL_GATES = [
    ...GATE_TOOLS,
    ...ARCHITECT_UTILITY_TOOLS.filter((t) => t !== "sleep"),
    ...WORKER_GATE_TOOLS,
  ].sort();

  test("the tool-bearing entries are exactly the gate tools every role can hold", () => {
    const tools = gates.flatMap((g) => (g.tool === undefined ? [] : [g.tool])).sort();
    expect(tools).toEqual(TOOL_GATES);
  });

  // A step of design_gate (ADR 2026-019) and the check the delivered project
  // runs on its own: reachable from a shell, never offered to a role.
  test("the CLI-only entries are scaffold and surface-check", () => {
    const cliOnly = gates.filter((g) => g.tool === undefined).map((g) => g.name).sort();
    expect(cliOnly).toEqual(["scaffold", "surface-check"]);
  });
});

describe("the registry and the extensions say the same thing", () => {
  const registered = [...registeredTools(installArchitectTools), ...registeredTools(installDevTools)];
  const NOT_GATES = new Set(["sleep", "git", "remove"]);

  test("every gate tool the extensions register has a registry entry", () => {
    for (const tool of registered) {
      if (NOT_GATES.has(tool.name)) continue;
      expect(gates.find((g) => g.tool === tool.name), `${tool.name} has no registry entry`).toBeDefined();
    }
  });

  // Verbatim, because the description IS the interface of a role with no
  // shell, and the drift tests pin phrases in it.
  test("description and prompt guidelines are verbatim the extension's", () => {
    for (const tool of registered) {
      if (NOT_GATES.has(tool.name)) continue;
      const gate = gates.find((g) => g.tool === tool.name);
      expect(gate?.description, tool.name).toBe(tool.description);
      expect(gate?.promptGuidelines, tool.name).toEqual(tool.promptGuidelines);
    }
  });
});
