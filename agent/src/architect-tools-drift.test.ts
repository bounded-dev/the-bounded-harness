import { describe, expect, test } from "vitest";
import installArchitectTools from "../extensions/architect-tools.ts";
import installDevTools from "../extensions/dev-tools.ts";
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

/** Minimal ExtensionAPI stub: records the tool names an extension registers. */
function registeredNames(install: (pi: never) => void): string[] {
  const names: string[] = [];
  const pi = {
    registerTool(spec: { name: string }) {
      names.push(spec.name);
    },
    on() {
      /* extensions may install hooks; irrelevant here */
    },
  };
  install(pi as never);
  return names;
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

  // The blind roles must never be handed one of these by a copy-paste.
  test("no gate tool leaks into a blind role's allowlist", () => {
    for (const role of ["test-writer", "builder"] as const) {
      for (const gate of [...GATE_TOOLS, "git", "subagent"]) {
        expect(ROLE_TOOLS[role], `${role} must not hold '${gate}'`).not.toContain(gate);
      }
    }
  });
});
