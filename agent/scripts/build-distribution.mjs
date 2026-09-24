// Compile each module separately for npm. Node cannot type-strip TypeScript
// under node_modules, and module boundaries preserve isMainModule() guards.
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
// npm intentionally excludes package-lock.json from tarballs. This generated
// data copy lets the installed CLI reproduce pinned project lockfiles.
copyFileSync(join(root, "package-lock.json"), join(root, "installer-lock.json"));
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.dist.json")], {
  cwd: root, stdio: "inherit",
});
