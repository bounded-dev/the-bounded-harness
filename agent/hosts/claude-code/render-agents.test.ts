import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { ARTIFACT_GATE_TOOLS, GATE_TOOLS, ROLE_TOOLS, type Role } from "../../src/path-policy.ts";
import { cliGates, gateCommand } from "./bash-policy.ts";
import {
  claudeTools,
  GENERATED_MARKER,
  hookCommandFor,
  isGenerated,
  PI_TO_CLAUDE_TOOLS,
  readPiAgent,
  renderAgent,
  renderAllAgents,
} from "./render-agents.ts";

// ADR 2026-034: "Drift tests extend to the rendered Claude Code agent
// definitions: `tools:` allowlists are pinned to ROLE_TOOLS." This is
// agent-config-drift.test.ts for the second host — the same pins, through the
// one mapping, so the two hosts cannot grant a role two different toolsets.

const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Extract the YAML frontmatter block (between the first two `---` lines). */
function frontmatter(source: string): string {
  const lines = source.split(/\r?\n/);
  const fences: number[] = [];
  for (let i = 0; i < lines.length && fences.length < 2; i++) {
    if (lines[i].trim() === "---") fences.push(i);
  }
  if (fences.length < 2) throw new Error("no frontmatter block found");
  return lines.slice(fences[0] + 1, fences[1]).join("\n");
}

function field(fm: string, key: string): string | undefined {
  const line = fm.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

function toolList(fm: string): string[] {
  const raw = field(fm, "tools");
  if (raw === undefined) throw new Error("no tools field");
  return raw.split(",").map((t) => t.trim()).filter((t) => t !== "");
}

/** The mapped allowlist, computed independently of claudeTools(). */
function expectedTools(role: Role): string[] {
  return [...new Set(ROLE_TOOLS[role].map((t) => PI_TO_CLAUDE_TOOLS[t]))];
}

describe("PI_TO_CLAUDE_TOOLS — the one mapping", () => {
  test("covers every tool any role holds", () => {
    for (const role of PIPELINE_ROLES) {
      for (const tool of ROLE_TOOLS[role]) expect(PI_TO_CLAUDE_TOOLS[tool], tool).toBeDefined();
    }
  });
  test("every gate, and every bash carrier, maps to Bash", () => {
    for (const gate of GATE_TOOLS) expect(PI_TO_CLAUDE_TOOLS[gate]).toBe("Bash");
    for (const gate of ARTIFACT_GATE_TOOLS) expect(PI_TO_CLAUDE_TOOLS[gate]).toBe("Bash");
    for (const role of PIPELINE_ROLES) for (const gate of cliGates(role)) expect(PI_TO_CLAUDE_TOOLS[gate]).toBe("Bash");
    for (const carrier of ["remove", "git", "sleep"]) expect(PI_TO_CLAUDE_TOOLS[carrier]).toBe("Bash");
  });
  test("the file tools and subagent map to their Claude Code tools", () => {
    expect(PI_TO_CLAUDE_TOOLS).toMatchObject({ read: "Read", grep: "Grep", find: "Glob", ls: "Glob", write: "Write", edit: "Edit", subagent: "Agent" });
  });
  test("bash itself is not in the mapping: no role's ROLE_TOOLS names it", () => {
    expect(PI_TO_CLAUDE_TOOLS["bash"]).toBeUndefined();
  });
});

describe("rendered Claude Code agent definitions", () => {
  const rendered = renderAllAgents({ harnessRoot: HARNESS_ROOT });

  test("one definition per pipeline role", () => {
    expect(Object.keys(rendered).sort()).toEqual([...PIPELINE_ROLES].sort());
  });

  for (const role of PIPELINE_ROLES) {
    describe(role, () => {
      const source = rendered[role];
      const fm = frontmatter(source);

      test("tools exactly equals ROLE_TOOLS mapped through PI_TO_CLAUDE_TOOLS, deduplicated, in order", () => {
        expect(toolList(fm)).toEqual(expectedTools(role));
        expect(toolList(fm)).toEqual([...claudeTools(role)]);
      });

      test("name and description come from the pi definition", () => {
        expect(field(fm, "name")).toBe(role);
        const desc: unknown = JSON.parse(field(fm, "description") ?? "null");
        expect(desc).toBe(readPiAgent(HARNESS_ROOT, role).description);
      });

      test("the hooks block binds this host's hook with --role", () => {
        expect(fm).toContain("hooks:\n  PreToolUse:\n    - matcher: \"\"\n      hooks:\n        - type: command\n          command: ");
        const command: unknown = JSON.parse(field(fm, "          command") ?? "null");
        expect(command).toBe(hookCommandFor(HARNESS_ROOT, role));
        expect(command).toContain("hosts/claude-code/path-gate-hook.ts");
        expect(command).toMatch(new RegExp(` --role ${role}$`));
      });

      test("carries the generated marker, inside the frontmatter", () => {
        expect(isGenerated(source)).toBe(true);
        expect(fm).toContain(GENERATED_MARKER);
        expect(source.slice(source.indexOf("\n---", 4))).not.toContain(GENERATED_MARKER);
      });

      test("the pi brief body is present verbatim, below a rule", () => {
        const body = readPiAgent(HARNESS_ROOT, role).body;
        expect(body.length).toBeGreaterThan(200);
        expect(source).toContain(`\n---\n\n${body}\n`);
      });

      test("the host preamble names each gate the role holds as a pi-gates command, and no other", () => {
        const preamble = source.slice(fm.length, source.indexOf("\n---\n", fm.length + 8));
        expect(preamble).toContain("## This host: Claude Code");
        for (const gate of cliGates(role)) expect(preamble).toContain(`\`pi-gates ${gateCommand(gate)}\``);
        for (const gate of GATE_TOOLS) {
          if (!ROLE_TOOLS[role].includes(gate)) expect(preamble).not.toContain(`\`pi-gates ${gateCommand(gate)}\``);
        }
        expect(preamble).toContain("Bash is refused for anything else");
        expect(preamble).toContain("the hook prefixes `PI_HOST=claude-code PI_DEV_STAGE_ROLE=<role>` itself");
      });

      // (b2) `subagent` and `git` belong to the architect alone: no worker
      // may hold Agent, or a worker could launder its blindness through a child.
      if (role !== "architect") {
        test("no worker role holds Agent", () => {
          expect(toolList(fm)).not.toContain("Agent");
        });
      } else {
        test("the architect holds Agent and Bash", () => {
          expect(toolList(fm)).toEqual(expect.arrayContaining(["Agent", "Bash"]));
        });
      }

      // (b3) The reviewer holds no pen.
      if (role === "reviewer") {
        test("the reviewer holds neither Write nor Edit", () => {
          expect(toolList(fm)).not.toContain("Write");
          expect(toolList(fm)).not.toContain("Edit");
        });
      }
    });
  }

  test("hookCommand override is honoured verbatim", () => {
    const source = renderAgent("builder", { harnessRoot: HARNESS_ROOT, hookCommand: "pi-cc-hook --role builder" });
    expect(field(frontmatter(source), "          command")).toBe(JSON.stringify("pi-cc-hook --role builder"));
  });

  test("the pi agents on disk still say what this test assumes about their shape", () => {
    // The source of the description and body is the pi definition; if its
    // frontmatter grows a multi-line description this parser must change.
    for (const role of PIPELINE_ROLES) {
      const raw = readFileSync(fileURLToPath(new URL(`../../agents/${role}.md`, import.meta.url)), "utf8");
      expect(raw.startsWith("---\n")).toBe(true);
      expect(raw).toMatch(/\ndescription: \S/);
    }
  });
});
