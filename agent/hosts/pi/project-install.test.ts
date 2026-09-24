import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { installProjectPi } from "./project-install.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stage(): { project: string; harness: string } {
  const project = mkdtempSync(join(tmpdir(), "bounded-pi-project-"));
  roots.push(project);
  const harness = join(project, ".bounded", "harness");
  const extensions = join(harness, "hosts", "pi", "extensions");
  for (const name of ["architect-tools", "dev-tools", "model-tier", "path-gate", "web"]) {
    mkdirSync(extensions, { recursive: true });
    writeFileSync(join(extensions, `${name}.ts`), "export default () => {};\n");
  }
  mkdirSync(join(extensions, "path-gate"));
  writeFileSync(join(extensions, "path-gate", "architect.ts"), "export default () => {};\n");
  mkdirSync(join(harness, "agents"));
  writeFileSync(join(harness, "agents", "architect.md"),
    "---\nname: architect\nsubagentOnlyExtensions: ~/.pi/agent/hosts/pi/extensions/path-gate/architect.ts\n---\n");
  mkdirSync(join(harness, "skills"));
  mkdirSync(join(harness, "packs"));
  return { project, harness };
}

describe("project-local pi install", () => {
  test("writes pi-discoverable adapter, settings, and local role paths", () => {
    const { project, harness } = stage();
    installProjectPi(project, harness);

    const loader = readFileSync(join(project, ".pi/extensions/bounded/index.ts"), "utf8");
    expect(loader).toContain("../../../.bounded/harness/hosts/pi/extensions/path-gate.ts");
    expect(loader).toContain("extension3(pi);");
    expect(loader).toContain('input.agentScope = "project"');
    const settings = JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"));
    expect(settings.packages).toEqual(["npm:pi-subagents@0.52.1"]);
    expect(settings.skills).toEqual(["../.bounded/harness/skills", "../.bounded/harness/packs"]);
    const architect = readFileSync(join(project, ".pi/agents/architect.md"), "utf8");
    expect(architect).toContain("subagentOnlyExtensions: .bounded/harness/hosts/pi/extensions/path-gate/architect.ts");
    expect(architect).not.toContain("~/.pi/agent");
    expect(loader + architect + JSON.stringify(settings)).not.toContain(project);
  });

  test("refuses a foreign destination before writing any host file", () => {
    const { project, harness } = stage();
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi/settings.json"), "{}\n");
    expect(() => installProjectPi(project, harness)).toThrow("refused existing file");
    expect(readFileSync(join(project, ".pi/settings.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(project, ".pi/extensions"))).toBe(false);
  });

  test("refuses an uncopied role extension before writing anything", () => {
    const { project, harness } = stage();
    rmSync(join(harness, "hosts/pi/extensions/path-gate/architect.ts"));
    expect(() => installProjectPi(project, harness)).toThrow("missing role extension");
    expect(existsSync(join(project, ".pi"))).toBe(false);
  });
});
