import { describe, expect, test } from "vitest";
import installArchitectTools from "../extensions/architect-tools.ts";
import installDevTools from "../extensions/dev-tools.ts";
import { DESIGN_STEPS } from "../packs/ts/scripts/design-gate.ts";
import { GATE_TOOLS, ROLE_TOOLS } from "./path-policy.ts";

// The architect has no `bash`, so every capability it needs must exist as a
// registered tool. That makes the tool NAMES load-bearing in a way they were
// not before: a name in ROLE_TOOLS that nothing registers is not a lint error
// or a type error — it is an architect that silently cannot run a gate,
// discovered live, mid-run, at the worst moment.
//
// So pin the two lists against each other. `path-policy.ts` is the authority
// on what the architect may hold; the extensions are the authority on what
// exists; this test is the only thing that makes them agree.

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
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

function registeredNames(install: (pi: never) => void): string[] {
  return registeredTools(install).map((t) => t.name);
}

describe("architect tool registration matches the path policy", () => {
  const architectTools = registeredNames(installArchitectTools);

  test("every gate named in GATE_TOOLS is actually registered", () => {
    for (const name of GATE_TOOLS) {
      expect(architectTools, `${name} is in GATE_TOOLS but nothing registers it`).toContain(name);
    }
  });

  test("git is registered — it is the architect's only route to the repo", () => {
    expect(architectTools).toContain("git");
  });

  test("registers nothing beyond the gates and git", () => {
    expect([...architectTools].sort()).toEqual([...GATE_TOOLS, "git"].sort());
  });

  // The full allowlist has to resolve: built-ins (read/write/…), pi's own
  // `subagent`, the builder's tools from dev-tools, and the architect's own.
  test("every tool in ROLE_TOOLS.architect exists as a builtin or a registration", () => {
    const BUILTIN = ["read", "grep", "find", "ls", "write", "edit", "subagent"];
    const available = new Set([...BUILTIN, ...registeredNames(installDevTools), ...architectTools]);
    for (const tool of ROLE_TOOLS.architect) {
      expect(available, `ROLE_TOOLS.architect names '${tool}' but nothing provides it`).toContain(
        tool,
      );
    }
  });

  // Tools that were RETIRED must not linger. `scaffold` and `freeze_contracts`
  // became steps of `design_gate` (ADR 2026-019), and a step that is still
  // separately callable is a step that can still be called out of order — which
  // is the whole thing the composite removes. The exact-equality test above
  // would catch a stray registration; this one says why it is wrong.
  test("the tools folded into design_gate are gone, and the composite exists", () => {
    expect(architectTools).toContain("design_gate");
    for (const retired of ["scaffold", "freeze_contracts"]) {
      expect(architectTools, `'${retired}' is a step of design_gate, not a tool`).not.toContain(
        retired,
      );
      expect(GATE_TOOLS, `'${retired}' is a step of design_gate, not a tool`).not.toContain(retired);
    }
    // The cheap single check survives: iterating on a contract should not cost
    // a scaffold, a typecheck and a freeze.
    expect(architectTools).toContain("contract_purity");
  });

  // The architect has no `bash` and does not read the gate scripts — the tool
  // DESCRIPTION is the whole interface. A step that can block the phase and is
  // named nowhere in it is a block arriving from a step the architect did not
  // know ran.
  test("the design_gate description names every step it runs", () => {
    const design = registeredTools(installArchitectTools).find((t) => t.name === "design_gate");
    expect(design).toBeDefined();
    const missing = DESIGN_STEPS.filter((step) => !design!.description.includes(step));
    expect(missing).toEqual([]);
  });

  // The worker roles must never be handed one of these by a copy-paste.
  test("no gate tool leaks into a worker role's allowlist", () => {
    for (const role of ["test-writer", "builder", "reviewer"] as const) {
      for (const gate of [...GATE_TOOLS, "git", "subagent"]) {
        expect(ROLE_TOOLS[role], `${role} must not hold '${gate}'`).not.toContain(gate);
      }
    }
  });

  // The reviewer's tool is the mirror image: it belongs to that role alone, for
  // the same reason `run_tests` belongs to the builder alone. An architect
  // recording a review of its own spec is the first reading again, not a
  // second one — and that is the gap the role exists to close.
  test("record_design_review is the reviewer's alone", () => {
    expect(ROLE_TOOLS.reviewer).toContain("record_design_review");
    for (const role of ["architect", "test-writer", "builder"] as const) {
      expect(ROLE_TOOLS[role], `${role} must not hold 'record_design_review'`).not.toContain(
        "record_design_review",
      );
    }
  });

  // The reviewer holds no pen but that one: no write, no edit, no remove, and
  // no shell to work around them with.
  test("the reviewer's allowlist is read-only", () => {
    for (const pen of ["write", "edit", "remove", "bash"]) {
      expect(ROLE_TOOLS.reviewer, `reviewer must not hold '${pen}'`).not.toContain(pen);
    }
  });

  // Same pin as the architect's, for every role: a tool a role is allowed to
  // hold but nothing registers is an instruction to make a call that cannot
  // succeed, discovered live and mid-run.
  test("every tool in every role's allowlist exists as a builtin or a registration", () => {
    const BUILTIN = ["read", "grep", "find", "ls", "write", "edit", "subagent"];
    const available = new Set([...BUILTIN, ...registeredNames(installDevTools), ...architectTools]);
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      for (const tool of tools) {
        expect(available, `ROLE_TOOLS.${role} names '${tool}' but nothing provides it`).toContain(
          tool,
        );
      }
    }
  });
});
