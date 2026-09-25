// Dependency-free completion marker for a project-local harness installation.
// Run only after both lockfile-backed npm ci commands have succeeded.
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SETUP_COMPLETE_RELATIVE = ".bounded/setup-complete";

export function markSetupComplete(cwd: string): void {
  if (!existsSync(join(cwd, ".bounded", "installation.json"))) {
    throw new Error("bounded setup requires an initialized project");
  }
  writeFileSync(join(cwd, SETUP_COMPLETE_RELATIVE), "complete\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  markSetupComplete(process.cwd());
}
