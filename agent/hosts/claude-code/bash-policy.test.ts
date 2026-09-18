import { describe, expect, test } from "vitest";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { GATE_TOOLS, ROLE_TOOLS, type Role } from "../../src/path-policy.ts";
import { carriers, cliGates, decideBash, gateCommand, shellWords } from "./bash-policy.ts";

// ADR 2026-029: in Claude Code, Bash is the carrier for `pi-gates`, and the
// hook narrows it to exactly the gates in the role's ROLE_TOOLS. Anything else
// — compound commands, redirects, substitutions — is refused with the role's
// forbiddenWhy reason. Table-driven over all four roles so a change to
// ROLE_TOOLS shows up here as a changed row, never as a silent widening.

const CTX = { cwd: "/proj" };
type Verdict = "allow" | "deny";
type Row = readonly [command: string, expected: Readonly<Record<Role, Verdict>>];

const all = (v: Verdict): Readonly<Record<Role, Verdict>> => ({ architect: v, "test-writer": v, builder: v, reviewer: v });
const only = (...roles: Role[]): Readonly<Record<Role, Verdict>> => ({
  architect: roles.includes("architect") ? "allow" : "deny",
  "test-writer": roles.includes("test-writer") ? "allow" : "deny",
  builder: roles.includes("builder") ? "allow" : "deny",
  reviewer: roles.includes("reviewer") ? "allow" : "deny",
});

const TABLE: readonly Row[] = [
  // The gates, by role — the list IS ROLE_TOOLS.
  ["pi-gates typecheck", all("allow")],
  ["pi-gates typecheck --json", all("allow")],
  ["pi-gates typecheck .", all("allow")],
  ["pi-gates red-gate", only("architect")],
  ["pi-gates red_gate", only("architect")], // the pi spelling is accepted too
  ["pi-gates design-gate", only("architect")],
  ["pi-gates deliver", only("architect")],
  ["pi-gates mutation-score", only("architect")],
  ["pi-gates run-tests", only("builder")],
  ["pi-gates record-design-review", only("reviewer")],
  ["pi-gates --list", all("allow")],
  ["pi-gates --help", all("allow")],
  ["pi-gates", all("deny")],
  ["pi-gates nosuch", all("deny")],
  ["pi-gates read", all("deny")], // a file tool is not a gate
  // Host-only flags: the role reaches the CLI through the hook's env prefix.
  ["pi-gates typecheck --role architect", all("deny")],
  ["pi-gates typecheck --role=architect", all("deny")],
  ["pi-gates red-gate --role architect", all("deny")],
  ["pi-gates record-design-review --findings-file f.json", all("deny")],
  ["pi-gates --role builder typecheck", all("deny")],
  ["PI_DEV_STAGE_ROLE=architect pi-gates red-gate", all("deny")], // only the hook adds this
  ["/usr/local/bin/pi-gates typecheck", all("deny")], // only the bare name; a path could be anything
  // git: the architect's alone, and never a way back to a shell.
  ["git status", only("architect")],
  ["git log --oneline -10", only("architect")],
  ["git show HEAD:tests/x.test.ts", only("architect")],
  ["git commit -m \"fix: tidy; and more\"", only("architect")], // `;` inside quotes is text
  ["git commit -m 'literal $(x) `y`'", only("architect")], // single quotes are literal
  ["git commit -m \"$(cat notes)\"", all("deny")], // expansion inside double quotes
  ["git -c alias.t=!npm x", all("deny")],
  ["git --exec-path=/tmp/evil status", all("deny")],
  ["git config alias.t '!npm test'", all("deny")],
  ["git config core.hooksPath scratch/hooks", all("deny")], // then `git commit` would be a shell
  ["git config --get core.hooksPath", only("architect")],
  ["git config --list", only("architect")],
  ["git bisect run npm test", all("deny")],
  ["git bisect start", only("architect")],
  ["git rebase -x 'npm test' HEAD~3", all("deny")],
  ["git rebase --exec=npm HEAD~3", all("deny")],
  ["git rebase -i HEAD~3", only("architect")],
  ["git filter-branch --tree-filter 'rm x' HEAD", all("deny")],
  ["git submodule foreach npm test", all("deny")],
  ["git difftool", all("deny")],
  // sleep: the architect's, bounded like the pi tool.
  ["sleep 30", only("architect")],
  ["sleep 1", only("architect")],
  ["sleep 120", only("architect")],
  ["sleep 0", all("deny")],
  ["sleep 121", all("deny")],
  ["sleep 5 5", all("deny")],
  ["sleep abc", all("deny")],
  // rm: one path, judged as a pi `remove` — so the write zones apply.
  ["rm tests/a.test.ts", only("test-writer")],
  ["rm /proj/tests/a.test.ts", only("test-writer")],
  ["rm src/x.ts", only("builder")],
  ["rm /proj/src/x.ts", only("builder")],
  ["rm src/x.contract.ts", only("architect")],
  ["rm spec.md", only("architect")],
  ["rm .pi/guard-log.jsonl", all("deny")],
  ["rm -rf src", all("deny")],
  ["rm src/*.ts", all("deny")],
  ["rm 'src/*.ts'", all("deny")], // a pattern is refused even when quoted
  ["rm ~/x", all("deny")],
  ["rm a b", all("deny")],
  ["rm", all("deny")],
  // Everything else.
  ["npm test", all("deny")],
  ["npx vitest run", all("deny")],
  ["cat tests/a.test.ts", all("deny")],
  ["ls src", all("deny")],
  ["node -e 1", all("deny")],
  ["", all("deny")],
  ["   ", all("deny")],
  // Compound forms: refused whatever they start with.
  ["pi-gates typecheck && cat tests/a.test.ts", all("deny")],
  ["pi-gates typecheck; cat tests/a.test.ts", all("deny")],
  ["pi-gates typecheck || true", all("deny")],
  ["pi-gates typecheck | head", all("deny")],
  ["pi-gates typecheck > out.txt", all("deny")],
  ["pi-gates typecheck < in.txt", all("deny")],
  ["pi-gates typecheck &", all("deny")],
  ["pi-gates $(echo typecheck)", all("deny")],
  ["pi-gates `echo typecheck`", all("deny")],
  ["pi-gates typecheck\ncat tests/a.test.ts", all("deny")],
  ["PATH=/tmp pi-gates typecheck", all("deny")],
  ["pi-gates typecheck (x)", all("deny")],
  ["pi-gates {typecheck,deliver}", all("deny")],
  ["pi-gates 'typecheck", all("deny")], // unterminated quote
  ["pi-gates typ\\echeck", all("deny")], // backslash escape
];

describe("decideBash — the decision table over all four roles", () => {
  for (const [command, expected] of TABLE) {
    for (const role of PIPELINE_ROLES) {
      test(`${role}: ${JSON.stringify(command)} → ${expected[role]}`, () => {
        const d = decideBash(role, command, CTX);
        expect(d.allow ? "allow" : "deny").toBe(expected[role]);
        if (!d.allow) {
          // Every refusal is one greppable line naming the role.
          expect(d.reason.startsWith(`path-gate: ${role} may not `)).toBe(true);
          expect(d.reason).not.toContain("\n");
        }
      });
    }
  }
});

describe("refusal reasons — specific, and the pi wording where pi has one", () => {
  test("a shell command outside the carriers gets forbiddenWhy(role, 'bash') plus this host's list", () => {
    const d = decideBash("builder", "npm test", CTX);
    expect(d).toMatchObject({ allow: false });
    if (!d.allow) {
      expect(d.reason).toBe(
        "path-gate: builder may not run 'npm': no role holds a shell — use read/grep/find/ls, run_tests, or typecheck — in Claude Code, Bash carries only pi-gates <gate>, rm <path>",
      );
    }
  });
  test("a gate another role holds is refused with pi's reason for that tool", () => {
    const d = decideBash("builder", "pi-gates red-gate", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: builder may not run 'pi-gates red-gate': 'red_gate' is the architect's — use read/grep/find/ls, run_tests, or typecheck");
    const a = decideBash("architect", "pi-gates run-tests", CTX);
    if (!a.allow) expect(a.reason).toContain("run_tests is the builder's blind-safe channel — run red_gate/green_gate instead");
  });
  test("an unknown gate names the role's own gates", () => {
    const d = decideBash("test-writer", "pi-gates nosuch", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: test-writer may not run 'pi-gates nosuch': no such gate for this role — test-writer's gates are typecheck");
  });
  test("a compound command names the construct and the carriers", () => {
    const d = decideBash("architect", "pi-gates typecheck && cat x", CTX);
    if (!d.allow) {
      expect(d.reason).toContain("a background/and operator ('&')");
      expect(d.reason).toContain("Bash here carries only pi-gates <gate>, git …, sleep <1-120>, rm <path>");
    }
  });
  test("rm outside the zone gets decide()'s own zone reason", () => {
    const d = decideBash("builder", "rm tests/a.test.ts", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: builder may not write 'tests/a.test.ts': outside builder write zones — the builder's writable surface is src/**");
    const r = decideBash("reviewer", "rm spec.md", CTX);
    if (!r.allow) expect(r.reason).toContain("reviewer has no write zone");
  });
  test("a long command is quoted bounded, on one line", () => {
    const d = decideBash("builder", `npm ${"x".repeat(200)}`, CTX);
    if (!d.allow) expect(d.reason.length).toBeLessThan(400);
  });
});

describe("an allow names its carrier, so the hook knows which to decorate", () => {
  test.each([
    ["pi-gates typecheck", "pi-gates"],
    ["pi-gates --list", "pi-gates"],
    ["git status", "git"],
    ["sleep 5", "sleep"],
    ["rm spec.md", "rm"],
  ] as const)("architect: %s → carrier %s", (command, carrier) => {
    expect(decideBash("architect", command, CTX)).toEqual({ allow: true, carrier });
  });
  test("a host-only flag is refused by name", () => {
    const d = decideBash("builder", "pi-gates typecheck --role architect", CTX);
    if (!d.allow) expect(d.reason).toBe("path-gate: builder may not pass '--role' to pi-gates: the host supplies the role and findings are passed inline");
  });
});

describe("cliGates — derived from ROLE_TOOLS, never a second list", () => {
  test.each(PIPELINE_ROLES)("%s: every gate is in ROLE_TOOLS and no file/carrier tool is a gate", (role) => {
    for (const gate of cliGates(role)) expect(ROLE_TOOLS[role]).toContain(gate);
    for (const notGate of ["read", "grep", "find", "ls", "write", "edit", "remove", "subagent", "git", "sleep", "bash"]) {
      expect(cliGates(role)).not.toContain(notGate);
    }
  });
  test("the architect holds every GATE_TOOLS entry as a CLI gate", () => {
    for (const gate of GATE_TOOLS) expect(cliGates("architect")).toContain(gate);
  });
  test("the CLI spelling is hyphenated", () => {
    expect(gateCommand("red_gate")).toBe("red-gate");
    expect(gateCommand("record_design_review")).toBe("record-design-review");
  });
  test("carriers names exactly what each role may put through Bash", () => {
    expect(carriers("architect")).toBe("pi-gates <gate>, git …, sleep <1-120>, rm <path>");
    expect(carriers("builder")).toBe("pi-gates <gate>, rm <path>");
    expect(carriers("reviewer")).toBe("pi-gates <gate>");
  });
});

describe("shellWords — the shell's reading, or the construct that stops it", () => {
  test("plain words and quotes", () => {
    expect(shellWords("git commit -m 'a b' \"c d\"")).toEqual({ ok: true, argv: ["git", "commit", "-m", "a b", "c d"] });
    expect(shellWords("  pi-gates\ttypecheck  ")).toEqual({ ok: true, argv: ["pi-gates", "typecheck"] });
  });
  test("a comment at word start is refused; '#' inside a word is text", () => {
    expect(shellWords("git log # x")).toMatchObject({ ok: false });
    expect(shellWords("git log --grep=#12")).toEqual({ ok: true, argv: ["git", "log", "--grep=#12"] });
  });
});
