// The build gate (TN-26-006, dogfood Run 29), contributed to the ts pack's
// `deliverChecks` socket (ADR 2026-033) — the technology-bearing half of Fix 2.
//
//   node build-check.ts [targetDir]
//
// Exit 0 pass · 1 block. Also runs as a delivery step (packs/ts-web/pack.ts →
// deliver's pack-check step), and contributes `check:build` to the project's
// own `check` so the DELIVERED repo carries the build in its definition of done.
//
// WHY IT EXISTS. Dogfood Run 29 shipped a "green + delivered" web app that did
// not build: `main.tsx` imported an `app.tsx` that was never written, so `vite
// build` failed — yet `npm run check` passed, because when ts-web is composed
// the check's scope never reached the web bootstrap. "Green" stopped meaning
// "the repo works". Two mechanical fences close it, and both live here so the
// core (agent/src) never learns a framework name (TN-26-005):
//
//   1. run() — a READ-ONLY static check that the bootstrap's own relative
//      imports resolve to files that exist. A missing `app.tsx` is a specifier
//      pointing at nothing, which is exactly the Run 29 Arm 1 shape, and it is
//      arithmetic (does the file exist?) rather than taste, so it is a block.
//      It needs no toolchain, so it answers identically in a target with no
//      node_modules, in the harness suite, and offline — the same discipline
//      theme-check keeps.
//
//   2. checkScript() — the `check:build` script (`vite build`) deliver folds
//      into the project's `check`. run() is the immediate, named block at the
//      delivery gate; the folded build is the thorough, permanent one that
//      stays in the repo a colleague is handed — it catches a build error run()
//      cannot see statically (a real type error deep in the tree), and a red UI
//      test surfaces through the same `npm run check` (its vitest run exits
//      non-zero), so the delivered definition of done can no longer be green
//      over a broken app.
//
// KEYED ON THE TREE, like everything this pack contributes: a project with no
// `src/ui/main.tsx` is not a web target, and both halves say "nothing to build"
// and pass — a service delivered by a ts-web-composed harness must not trip
// over a web pack's opinion.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliverCheckResult, DeliverCheckScript } from "../../ts/pack.ts";

/** The browser entry the generator emits (template.ts → new-web-app.ts). It
 *  imports `./app.js`, which the architect's `app.contract.ts` and the builder
 *  turn into `app.tsx`; a web target always has it, and nothing else does. */
export const BOOTSTRAP_RELATIVE = "src/ui/main.tsx";

/** The npm script the build is folded into, beside `check:surface`. */
export const CHECK_BUILD_SCRIPT = "check:build";

/** The command that script runs. The one place `vite` is named on this path;
 *  it lives in the pack, never in deliver (TN-26-005). */
export const BUILD_COMMAND = "vite build";

// --- static bootstrap resolution ---------------------------------------------

/** Import specifiers in a module's source: `import … from "x"`, bare
 *  `import "x"`, and `import("x")`. A hand-rolled scan for the same reason
 *  theme-check does not depend on a CSS parser — the grammar it needs is tiny,
 *  and a dependency to read a dozen import lines is a dependency every check
 *  run would inherit. */
export function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(re)) {
      if (match[1] !== undefined) specs.add(match[1]);
    }
  }
  return [...specs];
}

/** Extensions a NodeNext specifier for source code may actually resolve to. A
 *  `.js`/`.jsx` specifier names the EMITTED file; the source on disk is `.ts`
 *  or `.tsx` (the harness's one-spelling rule, template.ts). */
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];

/**
 * Does a relative specifier resolve to a file that exists on disk?
 *
 * `./app.js` → `app.tsx` (or `.ts`/…): the emitted name maps back to the
 * source. A specifier that already carries a non-code extension (`.css`,
 * `.json`, …) must exist verbatim. A bare directory falls back to `index.*`.
 * Bare-package specifiers never reach here — the caller filters to relatives.
 */
export function resolvesToFile(fromDir: string, specifier: string): boolean {
  const base = resolve(fromDir, specifier);
  const exists = (p: string): boolean => existsSync(p) && statSync(p).isFile();

  const codeExtMatch = /\.(?:js|jsx|mjs|cjs)$/.exec(specifier);
  if (codeExtMatch) {
    const stem = base.slice(0, base.length - codeExtMatch[0].length);
    if (exists(base)) return true; // the literal file, if it is genuinely there
    return CODE_EXTENSIONS.some((ext) => exists(stem + ext));
  }

  // A specifier with some other explicit extension (`.css`, `.json`, `.svg`):
  // it must exist exactly as written — there is no source-to-emit remap.
  if (/\.[a-z0-9]+$/i.test(specifier)) return exists(base);

  // No extension: a source file by any code extension, or a directory index.
  if (CODE_EXTENSIONS.some((ext) => exists(base + ext))) return true;
  return CODE_EXTENSIONS.some((ext) => exists(join(base, `index${ext}`)));
}

/** Relative specifiers in the bootstrap that point at nothing on disk. */
export function unresolvedBootstrapImports(cwd: string): string[] {
  const mainAbs = join(cwd, BOOTSTRAP_RELATIVE);
  const source = readFileSync(mainAbs, "utf8");
  const dir = dirname(mainAbs);
  return importSpecifiers(source)
    .filter((s) => s.startsWith("."))
    .filter((s) => !resolvesToFile(dir, s))
    .sort();
}

// --- the delivery check ------------------------------------------------------

/** Is this tree a web target — i.e. does the generated bootstrap exist? Both
 *  halves of the gate key on this one predicate, so a build is never folded
 *  into a check it would then run against a service. */
export function isWebTarget(cwd: string): boolean {
  return existsSync(join(cwd, BOOTSTRAP_RELATIVE));
}

/**
 * The read-only half: the bootstrap's relative imports all resolve.
 *
 * A pure existence check, so the suite can put a broken tree in front of it
 * without a toolchain, and so it answers the same offline as it does in CI.
 */
export function runBuildCheck(cwd: string): DeliverCheckResult {
  if (!isWebTarget(cwd)) {
    return { verdict: "pass", summary: `no ${BOOTSTRAP_RELATIVE} — not a web target, nothing to build` };
  }
  let missing: string[];
  try {
    missing = unresolvedBootstrapImports(cwd);
  } catch (e) {
    return {
      verdict: "block",
      summary: `${BOOTSTRAP_RELATIVE} could not be read — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (missing.length === 0) {
    return {
      verdict: "pass",
      summary: `${BOOTSTRAP_RELATIVE} resolves — the app bootstrap builds (check:build carries the full build)`,
    };
  }
  return {
    verdict: "block",
    summary:
      `${BOOTSTRAP_RELATIVE} imports ${missing.length} module${missing.length === 1 ? "" : "s"} that ` +
      `${missing.length === 1 ? "does" : "do"} not exist, so the app cannot build — a "green + delivered" ` +
      `app that does not build is exactly what Run 29 shipped (TN-26-001)`,
    detail: missing.map(
      (s) => `${s} — no file resolves for this import (a contract may be undeclared, or its implementation unwritten)`,
    ),
  };
}

/**
 * The fold half: the `check:build` script deliver adds to the project's own
 * `check`, for a web target only.
 */
export function buildCheckScript(cwd: string): DeliverCheckScript | undefined {
  if (!isWebTarget(cwd)) return undefined;
  return { name: CHECK_BUILD_SCRIPT, command: BUILD_COMMAND };
}

// --- CLI ---------------------------------------------------------------------

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = runBuildCheck(resolve(process.argv[2] ?? process.cwd()));
  const blocked = result.verdict === "block";
  const print = blocked ? console.error : console.log;
  print(`build-check: ${blocked ? "BLOCK — " : ""}${result.summary}`);
  for (const line of result.detail ?? []) print(`  ${line}`);
  process.exit(blocked ? 1 : 0);
}
