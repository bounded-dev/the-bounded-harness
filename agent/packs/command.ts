// Generic driver for pack-owned project lifecycle commands.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composedPacks } from "./installed.ts";

export function commandScript(cwd: string, command: string): string {
  const registry = composedPacks(cwd);
  const root = dirname(fileURLToPath(import.meta.url));
  const matches: string[] = [];
  for (const pack of registry.packs) {
    const directory = join(root, pack);
    const manifestPath = join(directory, "contrib.json");
    let manifest: unknown;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch { throw new Error(`selected pack '${pack}' has no readable contrib.json`); }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`selected pack '${pack}' contrib.json must be an object`);
    }
    const commands = (manifest as Record<string, unknown>)["projectCommands"];
    if (commands === undefined) continue;
    if (commands === null || typeof commands !== "object" || Array.isArray(commands)) {
      throw new Error(`selected pack '${pack}' projectCommands must be an object`);
    }
    const target = (commands as Record<string, unknown>)[command];
    if (target === undefined) continue;
    if (typeof target !== "string" || target.startsWith("/") || target.split("/").includes("..")) {
      throw new Error(`selected pack '${pack}' has an invalid '${command}' command path`);
    }
    const script = resolve(directory, target);
    const relativeScript = relative(directory, script);
    if (relativeScript.startsWith(`..${sep}`) || relativeScript === ".." || !existsSync(script)) {
      throw new Error(`selected pack '${pack}' command '${command}' points outside the pack or to a missing file`);
    }
    matches.push(script);
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `no selected pack provides '${command}'`
      : `more than one selected pack provides '${command}'; command ownership must be unique`);
  }
  return matches[0]!;
}

export function runProjectCommand(command: string, cwd: string, args: readonly string[] = []): number {
  const script = commandScript(cwd, command);
  const result = spawnSync(process.execPath, [script, cwd, ...args], { cwd, stdio: "inherit" });
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  let cwd = process.cwd();
  const flag = args.indexOf("--cwd");
  if (flag >= 0) {
    if (!args[flag + 1] || args[flag + 1]!.startsWith("--")) {
      console.error("usage: bounded <pack-command> [--cwd <project>]");
      process.exit(64);
    }
    cwd = resolve(args[flag + 1]!);
    args.splice(flag, 2);
  }
  if (!command) {
    console.error("usage: bounded <pack-command> [--cwd <project>]");
    process.exit(64);
  }
  try { process.exitCode = runProjectCommand(command, cwd, args); }
  catch (error) {
    console.error(`bounded: BLOCK — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
