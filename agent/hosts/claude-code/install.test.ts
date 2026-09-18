import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { makeTempProject as makeProject, type TempProject } from "../../test/support/temp-project.ts";
import { mergeAmbientHook } from "./install.ts";
import { hookCommandFor, isGenerated } from "./render-agents.ts";

// The installer, run as a person would run it, in a temp project. Its two
// refusals — a hand-written agent file, an unparseable settings.json — are
// the cases that matter most: both are silent losses if it got them wrong.

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "install.ts");
const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const projects: TempProject[] = [];
function makeTempProject(files: Readonly<Record<string, string>>): string {
  const project = makeProject(files, { prefix: "cc-install-" });
  projects.push(project);
  return project.dir;
}
afterEach(() => {
  while (projects.length) projects.pop()?.cleanup();
});

function install(dir: string, ...extra: string[]) {
  return spawnSync(process.execPath, [INSTALL, dir, "--harness-root", HARNESS_ROOT, ...extra], { encoding: "utf8" });
}

const settingsOf = (dir: string): unknown => JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));

describe("install — fresh project", () => {
  test("writes four generated agents and a settings.json with the ambient hook", () => {
    const dir = makeTempProject({});
    const r = install(dir);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.startsWith("wrote ")).toBe(true);
    for (const role of PIPELINE_ROLES) {
      const file = readFileSync(join(dir, ".claude/agents", `${role}.md`), "utf8");
      expect(isGenerated(file)).toBe(true);
      expect(file).toContain(`name: ${role}`);
      expect(file).toContain(`--role ${role}`);
    }
    expect(settingsOf(dir)).toEqual({
      hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: hookCommandFor(HARNESS_ROOT) }] }] },
    });
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toMatch(/^\{\n {2}"hooks"/); // 2-space JSON
  });

  test("a second run changes nothing and says so", () => {
    const dir = makeTempProject({});
    install(dir);
    const before = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    const r = install(dir);
    expect(r.status).toBe(0);
    for (const line of r.stdout.trim().split("\n")) expect(line.startsWith("unchanged ")).toBe(true);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(before);
  });
});

describe("install — an existing settings.json", () => {
  test("other keys and existing hook entries are kept; ours is appended once", () => {
    const dir = makeTempProject({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }], Stop: [] },
        model: "opus",
      }),
    });
    expect(install(dir).status).toBe(0);
    expect(settingsOf(dir)).toEqual({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] },
          { matcher: "", hooks: [{ type: "command", command: hookCommandFor(HARNESS_ROOT) }] },
        ],
        Stop: [],
      },
      model: "opus",
    });
    expect(install(dir).stdout).toContain("unchanged");
    expect(settingsOf(dir)).toMatchObject({ hooks: { PreToolUse: expect.arrayContaining([expect.anything()]) } });
    const pre: unknown = (settingsOf(dir) as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse;
    expect(pre).toHaveLength(2);
  });

  test("an entry already naming path-gate-hook.ts, from any path, counts as installed", () => {
    const merged = mergeAmbientHook(
      { hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node /elsewhere/path-gate-hook.ts" }] }] } },
      "node /here/path-gate-hook.ts",
    );
    expect(merged).toMatchObject({ ok: true, changed: false });
  });

  test("mergeAmbientHook refuses a PreToolUse that is not a list, and a hooks that is not an object", () => {
    expect(mergeAmbientHook({ hooks: { PreToolUse: "nope" } }, "x")).toMatchObject({ ok: false });
    expect(mergeAmbientHook({ hooks: [] }, "x")).toMatchObject({ ok: false });
  });

  test("unparseable settings.json → exit 1, nothing written", () => {
    const dir = makeTempProject({ ".claude/settings.json": "{ not json" });
    const r = install(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refused");
    expect(existsSync(join(dir, ".claude/agents"))).toBe(false);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe("{ not json");
  });
});

describe("install — refuses to overwrite a hand-written agent", () => {
  test("a builder.md without the marker → exit 1, no agent written, settings untouched", () => {
    const dir = makeTempProject({ ".claude/agents/builder.md": "---\nname: builder\n---\nmy own builder\n" });
    const r = install(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refused ${join(dir, ".claude/agents/builder.md")}: not generated by pi-harness`);
    expect(readFileSync(join(dir, ".claude/agents/builder.md"), "utf8")).toBe("---\nname: builder\n---\nmy own builder\n");
    expect(existsSync(join(dir, ".claude/agents/architect.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(false);
  });

  test("a stale generated file is overwritten", () => {
    const dir = makeTempProject({ ".claude/agents/builder.md": "---\n# generated by pi-harness (old)\nname: builder\n---\nold\n" });
    const r = install(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`wrote ${join(dir, ".claude/agents/builder.md")}`);
    expect(readFileSync(join(dir, ".claude/agents/builder.md"), "utf8")).toContain("## This host: Claude Code");
  });
});

describe("install — usage", () => {
  test("no target → exit 2", () => {
    const r = spawnSync(process.execPath, [INSTALL], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
  test("a target that is not a directory → exit 2", () => {
    const dir = makeTempProject({ "file.txt": "x" });
    expect(install(join(dir, "file.txt")).status).toBe(2);
    expect(install(join(dir, "missing")).status).toBe(2);
  });
});
