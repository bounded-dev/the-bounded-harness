// Claude Code discovery files for a project-local Bounded installation.
// The caller assembles the harness in a staging project before invoking this.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PIPELINE_ROLES } from "../../src/path-gate.ts";
import { DEV_STAGE_SKILL, mergeAmbientHook } from "./install.ts";
import { renderAgent } from "./render-agents.ts";

function containedPath(target: string, path: string): string {
  const rel = relative(resolve(target), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("the copied harness must be inside the project");
  }
  return rel;
}

/** Install only Claude Code's project-local discovery files. The copied
 * harness remains the single source for skills, roles, hooks and gate code. */
export function installProjectClaude(target: string, harnessRoot: string): void {
  const relRoot = containedPath(target, harnessRoot);
  const hook = join(harnessRoot, "hosts", "claude-code", "path-gate-hook.ts");
  const skill = join(harnessRoot, "skills", DEV_STAGE_SKILL);
  const gate = join(harnessRoot, "scripts", "bounded");
  const projectInstructions = join(target, "AGENTS.md");
  const claudeInstructions = join(target, "CLAUDE.md");
  if (existsSync(claudeInstructions)) throw new Error("Claude Code installation refuses an existing CLAUDE.md");
  for (const source of [hook, join(skill, "SKILL.md"), gate, projectInstructions]) {
    if (!existsSync(source)) throw new Error(`Claude Code installation requires ${source}`);
  }

  // Claude Code supplies CLAUDE_PROJECT_DIR even when a tool changes cwd.
  // Keep the stored command independent of both cwd and installer location.
  const relativeHook = join(relRoot, "hosts", "claude-code", "path-gate-hook.ts")
    .replace(/[\\`"$]/g, "\\$&");
  const hookCommand = `node "\${CLAUDE_PROJECT_DIR}/${relativeHook}" --project-local`;
  const settingsPath = join(target, ".claude", "settings.json");
  let settings: Readonly<Record<string, unknown>> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Claude Code settings must be a JSON object");
    }
    settings = parsed as Readonly<Record<string, unknown>>;
  }
  const merged = mergeAmbientHook(settings, hookCommand);
  if (!merged.ok) throw new Error(`Claude Code settings: ${merged.reason}`);

  // Rendering reads role briefs from the project-local copy. No generated
  // definition refers to the installer checkout.
  const rendered = Object.fromEntries(
    PIPELINE_ROLES.map((role) => [role, renderAgent(role, { harnessRoot, hookCommand: `${hookCommand} --role ${role}` })]),
  ) as Record<(typeof PIPELINE_ROLES)[number], string>;

  const agentsDir = join(target, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const role of PIPELINE_ROLES) {
    writeFileSync(join(agentsDir, `${role}.md`), rendered[role]);
  }
  const skillDest = join(target, ".claude", "skills", DEV_STAGE_SKILL);
  mkdirSync(join(target, ".claude", "skills"), { recursive: true });
  cpSync(skill, skillDest, { recursive: true, force: false, errorOnExist: true });
  writeFileSync(settingsPath, JSON.stringify(merged.value, null, 2) + "\n");
  cpSync(projectInstructions, claudeInstructions, { force: false, errorOnExist: true });
}
