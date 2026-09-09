// Delivery pass (TN-26-001): finished run → repo you would hand a colleague.
//
//   node deliver.ts [targetDir]
//
// The developer stage leaves the target correct but harness-shaped: red-phase
// scaffolding (shared/errors.ts), __conformance blobs, no package entry point,
// and nothing that keeps contract/implementation alignment honest once the
// harness is gone. This pass is mechanical — it decides nothing about the
// design; it only removes what the loop needed and ships what a colleague
// needs. Steps, in order, each logging one guard event and printing one line:
//
//   1. scaffolding    delete src/shared/errors.ts iff nothing in src/ imports
//                     it (ts-morph, not grep). A surviving import of
//                     NotImplementedError is a BLOCK: an unimplemented export
//                     reached delivery. Imports from tests/ only ⇒ keep it.
//   2. shadow         remove .pi/shadow-red/, the throwaway project red_gate
//                     rebuilds to prove red in. It is a second copy of the
//                     contracts, the skeletons and the whole tests tree — a
//                     reader who found it would reasonably wonder which copy
//                     is the real one.
//   3. conformance    strip the trailing `const __conformance: typeof
//                     __Contract = {…}; void __conformance;` blob and the
//                     `import type * as __Contract` line from each
//                     implementation (the shipped surface check replaces
//                     them). `export type * from "./x.contract.js"` stays —
//                     it is load-bearing for interface/type-alias exports.
//   4. barrel         generate src/index.ts, one `export *` per
//                     contract-implementation pair. A pre-existing index.ts
//                     the run produced is a BLOCK — merging is a design act.
//   5. surface check  ship scripts/surface-check.ts into the target, add
//                     `check:surface` to package.json, fold it into `check`,
//                     pin ts-morph (the pack's own version).
//   6. gitignore      ensure `.pi/` is ignored.
//   7. README         add a "## Contracts" section for a reader who has
//                     never seen the convention.
//   8. timing         READ-ONLY: print where the run's minutes went, from the
//                     project's own guard log (issue #13). Measure before
//                     optimizing further — and the run that just finished is
//                     the only one whose numbers nobody has to remember.
//
// Idempotent: every step checks before acting; a second run applies 0 steps.
// Exit 0 delivered · 1 block · 2 misuse (bad target / missing checker
// source). The checker source is injectable for tests via options or
// PI_DELIVER_SURFACE_CHECK (the real file is packs/ts/scripts/surface-check.ts).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project } from "ts-morph";
import { logGuardEvent, readGuardLog, type GuardVerdict } from "../../../src/guard-log.ts";
import {
  formatPhaseDurations,
  phaseDurations,
  type PhaseDurations,
} from "../../../src/phase-durations.ts";
import { findContractFiles } from "./checksum-gate.ts";
import { SHADOW_RELATIVE } from "./red-gate.ts";
import { skeletonPathFor } from "./scaffold-contract.ts";

const GUARD = "deliver";
const ERRORS_REL = "src/shared/errors.ts";
const SURFACE_SCRIPT = "node --experimental-strip-types scripts/surface-check.ts";
const BARREL_MARKER = "// Public API of this package";

const README_SECTION = `## Contracts

Every \`src/**/*.contract.ts\` file declares the public surface of the module
beside it — the types, functions, and classes callers may depend on. The
sibling file of the same name implements it. In code review, the contract
file is the one to read first: it is the API.

\`npm run check\` fails if an implementation's exported surface drifts from
its contract. Changing a contract is therefore a deliberate design act:
edit the contract first, then bring the implementation along with it.
`;

export interface DeliverOptions {
  /** Path to the surface checker to ship. Default: this pack's
   *  surface-check.ts (or PI_DELIVER_SURFACE_CHECK). */
  readonly surfaceCheckSource?: string;
}

export interface DeliverResult {
  readonly code: number;
  readonly lines: readonly string[];
}

// --- pure cores -----------------------------------------------------------------

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** All .ts files under dir, project-relative posix paths, sorted. */
function tsFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", ".pi"].includes(entry.name)) walk(join(d, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(toPosix(relative(root, join(d, entry.name))));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Does this module specifier, written in `fromRel`, resolve to the shared
 *  errors module? (Relative specifiers only — that is how it is ever imported.) */
function refersToErrors(fromRel: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  const noExt = resolved.replace(/\.(js|ts)$/, "");
  return noExt === ERRORS_REL.replace(/\.ts$/, "");
}

/** Names a file imports from the shared errors module ([] if none). AST, not
 *  grep: a mention in a comment or string must not count. */
function errorsImportsOf(source: string, fileRel: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(fileRel), source, { overwrite: true });
  const names: string[] = [];
  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt) && refersToErrors(fileRel, stmt.getModuleSpecifierValue())) {
      const clause = stmt.getImportClause();
      const bindings = clause?.getNamedBindings();
      if (bindings && Node.isNamedImports(bindings)) names.push(...bindings.getElements().map((e) => e.getName()));
      else if (bindings) names.push("* as " + bindings.getName());
      else names.push(clause?.getDefaultImport()?.getText() ?? "(side effect)");
    } else if (Node.isExportDeclaration(stmt)) {
      const spec = stmt.getModuleSpecifierValue();
      if (spec !== undefined && refersToErrors(fileRel, spec)) names.push("(re-export)");
    }
  }
  return names;
}

/**
 * Strip the compile-time conformance apparatus from an implementation file:
 * the `import type * as __Contract` line and the trailing
 * `const __conformance … ; void __conformance;` blob with its comment.
 * Returns the cleaned source, or null when there is nothing to strip.
 * Text surgery at AST positions: predictable, and it cannot touch anything
 * the AST did not point at.
 */
export function stripConformance(source: string, fileName: string): string | null {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(fileName), source, { overwrite: true });
  const ranges: [number, number][] = [];

  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt)) {
      const bindings = stmt.getImportClause()?.getNamedBindings();
      if (bindings && Node.isNamespaceImport(bindings) && bindings.getName() === "__Contract") {
        ranges.push([stmt.getStart(), stmt.getEnd()]);
      }
    } else if (Node.isVariableStatement(stmt)) {
      if (stmt.getDeclarations().some((d) => d.getName() === "__conformance")) {
        const comments = stmt.getLeadingCommentRanges();
        ranges.push([comments.length > 0 ? comments[0]!.getPos() : stmt.getStart(), stmt.getEnd()]);
      }
    } else if (Node.isExpressionStatement(stmt) && /^void\s+__conformance\s*;?$/.test(stmt.getText())) {
      ranges.push([stmt.getStart(), stmt.getEnd()]);
    }
  }
  if (ranges.length === 0) return null;

  let text = source;
  for (const [start, endRaw] of ranges.sort((a, b) => b[0] - a[0])) {
    let end = endRaw;
    if (text.startsWith("\r\n", end)) end += 2;
    else if (text.startsWith("\n", end)) end += 1;
    text = text.slice(0, start) + text.slice(end);
  }
  return text.replace(/\n+$/, "\n");
}

/** The barrel: one `export *` per implementation module (src-relative paths). */
export function barrelFor(implRelToSrc: readonly string[]): string {
  const lines = [...implRelToSrc]
    .sort()
    .map((p) => `export * from "./${p.replace(/\.ts$/, ".js")}";`);
  return `${BARREL_MARKER} — one line per module. Generated at delivery.\n${lines.join("\n")}\n`;
}

// --- runner -----------------------------------------------------------------------

export function runDeliver(cwd: string, options: DeliverOptions = {}): DeliverResult {
  const lines: string[] = [];
  let applied = 0;

  const log = (verdict: GuardVerdict, step: string, summary: string, detail: Record<string, unknown> = {}): void =>
    logGuardEvent(cwd, { guard: GUARD, verdict, summary, detail: { step, ...detail } });
  const pass = (step: string, changed: boolean, line: string, detail: Record<string, unknown> = {}): void => {
    if (changed) applied += 1;
    lines.push(`deliver: ${step} — ${line}`);
    log("pass", step, line, detail);
  };
  const block = (step: string, line: string, detail: Record<string, unknown> = {}): DeliverResult => {
    lines.push(`deliver: BLOCK — ${line}`);
    log("block", step, line, detail);
    return { code: 1, lines };
  };

  // --- preconditions (all checked before anything mutates) ---
  const misuse = (summary: string): DeliverResult => {
    log("error", "preflight", summary);
    return { code: 2, lines: [...lines, `deliver: error — ${summary}`] };
  };
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return misuse(`'${cwd}' is not a directory`);
  if (!existsSync(join(cwd, "package.json"))) return misuse(`no package.json in '${cwd}' — not a project root`);
  if (!existsSync(join(cwd, "src"))) return misuse(`no src/ in '${cwd}' — nothing to deliver`);
  const checkerSource =
    options.surfaceCheckSource ??
    process.env["PI_DELIVER_SURFACE_CHECK"] ??
    join(dirname(fileURLToPath(import.meta.url)), "surface-check.ts");
  if (!existsSync(checkerSource)) {
    return misuse(`surface checker source not found at '${checkerSource}'`);
  }

  // --- 1. dead red-phase scaffolding ---
  const errorsAbs = join(cwd, ERRORS_REL);
  if (!existsSync(errorsAbs)) {
    pass("scaffolding", false, `${ERRORS_REL} already gone`);
  } else {
    const importers = { src: [] as { file: string; names: string[] }[], tests: [] as string[] };
    for (const dir of ["src", "tests"] as const) {
      for (const rel of tsFilesUnder(cwd, join(cwd, dir))) {
        if (rel === ERRORS_REL) continue;
        const names = errorsImportsOf(readFileSync(join(cwd, rel), "utf8"), rel);
        if (names.length === 0) continue;
        if (dir === "src") importers.src.push({ file: rel, names });
        else importers.tests.push(rel);
      }
    }
    if (importers.src.length > 0) {
      const [first] = importers.src;
      return block(
        "scaffolding",
        `${first!.file} still imports ${first!.names.join(", ")} from the shared errors module — ` +
          `an unimplemented export survived to delivery`,
        { importers: importers.src },
      );
    }
    if (importers.tests.length > 0) {
      pass("scaffolding", false, `kept ${ERRORS_REL} (${importers.tests.join(", ")} still imports it)`, {
        keptFor: importers.tests,
      });
    } else {
      rmSync(errorsAbs);
      const sharedDir = dirname(errorsAbs);
      if (readdirSync(sharedDir).length === 0) rmdirSync(sharedDir);
      pass("scaffolding", true, `removed ${ERRORS_REL} (nothing imports it)`);
    }
  }

  // --- 2. the red-phase shadow project ---
  //
  // red_gate proves red in a project it builds itself at `.pi/shadow-red/` —
  // contracts, regenerated skeletons and a copy of the tests tree — so the
  // proof never depends on the live `src/`, and the builder may work in
  // parallel without touching it. Once the run is over that copy is confusing
  // rather than useful: a duplicate of the tests beside the real one.
  //
  // Removal, not preservation: the shadow is reproducible from the repo at any
  // time by running red_gate again.
  {
    const shadowAbs = join(cwd, SHADOW_RELATIVE);
    if (existsSync(shadowAbs)) {
      rmSync(shadowAbs, { recursive: true, force: true });
      pass("shadow", true, `removed ${SHADOW_RELATIVE}/ (red_gate rebuilds it on demand)`);
    } else {
      pass("shadow", false, `no ${SHADOW_RELATIVE}/ to remove`);
    }
  }

  // --- pairs: contract → existing sibling implementation ---
  const srcAbs = join(cwd, "src");
  const pairs: string[] = []; // impl paths relative to src/, posix
  for (const contract of findContractFiles(srcAbs)) {
    const impl = skeletonPathFor(contract);
    if (existsSync(impl)) pairs.push(toPosix(relative(srcAbs, impl)));
  }

  // --- 3. __conformance blobs ---
  const stripped: string[] = [];
  for (const implRel of pairs) {
    const abs = join(srcAbs, implRel);
    const cleaned = stripConformance(readFileSync(abs, "utf8"), implRel);
    if (cleaned !== null) {
      writeFileSync(abs, cleaned);
      stripped.push("src/" + implRel);
    }
  }
  pass(
    "conformance",
    stripped.length > 0,
    stripped.length > 0 ? `stripped __conformance from ${stripped.join(", ")}` : "nothing to strip",
    { stripped },
  );

  // --- 4. barrel ---
  const indexAbs = join(srcAbs, "index.ts");
  if (pairs.length === 0) {
    pass("barrel", false, "no contract implementations — no barrel to write");
  } else {
    const desired = barrelFor(pairs);
    const existing = existsSync(indexAbs) ? readFileSync(indexAbs, "utf8") : undefined;
    if (existing === desired) {
      pass("barrel", false, "src/index.ts already current");
    } else if (existing !== undefined && !existing.startsWith(BARREL_MARKER)) {
      return block(
        "barrel",
        "src/index.ts already exists and was not generated by deliver — " +
          "merging its exports into the barrel is a design act; resolve it by hand",
      );
    } else {
      writeFileSync(indexAbs, desired);
      pass("barrel", true, `wrote src/index.ts (${pairs.length} module${pairs.length === 1 ? "" : "s"})`, {
        modules: pairs,
      });
    }
  }

  // --- 5. ship the surface check ---
  {
    const checker = readFileSync(checkerSource, "utf8");
    const shippedAbs = join(cwd, "scripts", "surface-check.ts");
    const did: string[] = [];
    if (!existsSync(shippedAbs) || readFileSync(shippedAbs, "utf8") !== checker) {
      mkdirSync(dirname(shippedAbs), { recursive: true });
      writeFileSync(shippedAbs, checker);
      did.push("shipped scripts/surface-check.ts");
    }
    const pkgAbs = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgAbs, "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    pkg.scripts ??= {};
    if (pkg.scripts["check:surface"] !== SURFACE_SCRIPT) {
      pkg.scripts["check:surface"] = SURFACE_SCRIPT;
      did.push("added check:surface");
    }
    if (pkg.scripts["check"] === undefined) {
      pkg.scripts["check"] = "npm run check:surface";
      did.push("created check");
    } else if (!pkg.scripts["check"].includes("check:surface")) {
      pkg.scripts["check"] += " && npm run check:surface";
      did.push("folded into check");
    }
    if (pkg.devDependencies?.["ts-morph"] === undefined) {
      const pin = tsMorphPin();
      const deps: Record<string, string> = { ...pkg.devDependencies, "ts-morph": pin };
      pkg.devDependencies = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]!]));
      did.push(`pinned ts-morph@${pin}`);
    }
    if (did.length > 0) writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2) + "\n");
    pass("surface-check", did.length > 0, did.length > 0 ? did.join(", ") : "already shipped and wired", { did });
  }

  // --- 6. .gitignore ---
  {
    const ignoreAbs = join(cwd, ".gitignore");
    const current = existsSync(ignoreAbs) ? readFileSync(ignoreAbs, "utf8") : "";
    const ignored = current.split("\n").some((l) => l.trim() === ".pi/" || l.trim() === ".pi");
    if (ignored) {
      pass("gitignore", false, ".pi/ already ignored");
    } else {
      writeFileSync(ignoreAbs, (current === "" || current.endsWith("\n") ? current : current + "\n") + ".pi/\n");
      pass("gitignore", true, "added .pi/ to .gitignore");
    }
  }

  // --- 7. README ---
  {
    const readmeAbs = join(cwd, "README.md");
    const current = existsSync(readmeAbs) ? readFileSync(readmeAbs, "utf8") : undefined;
    if (current?.includes("## Contracts")) {
      pass("readme", false, "README.md already documents contracts");
    } else if (current !== undefined) {
      writeFileSync(readmeAbs, (current.endsWith("\n") ? current : current + "\n") + "\n" + README_SECTION);
      pass("readme", true, 'appended "## Contracts" to README.md');
    } else {
      writeFileSync(readmeAbs, README_SECTION);
      pass("readme", true, 'created README.md with a "## Contracts" section');
    }
  }

  // --- 8. phase timing (issue #13) ---
  //
  // Every gate already timestamps itself into .pi/guard-log.jsonl, so the
  // shape of the run — which phase cost the minutes, where it bounced and to
  // whom — is recorded and was simply never read back. Delivery is the one
  // moment the whole run is over and someone is reading the output, so this
  // is where the read-back belongs.
  //
  // Idempotency: trivial, unlike every step above. This one READS and writes
  // nothing, so it is never an applied step and a second delivery re-reports
  // the same run (plus the events the first delivery itself logged).
  //
  // It must never block delivery. An absent, empty or corrupt log is a missing
  // measurement, not a defect in the repo being handed over: the step degrades
  // to one line saying timing was unavailable and why, and delivery proceeds.
  {
    let timing: PhaseDurations | undefined;
    let blockLines: string[];
    try {
      timing = phaseDurations(readGuardLog(cwd));
      blockLines = formatPhaseDurations(timing);
    } catch (e) {
      blockLines = [`unavailable — ${e instanceof Error ? e.message : String(e)}`];
    }
    const [headline, ...rest] = blockLines;
    pass(
      "timing",
      false,
      headline ?? "unavailable — nothing to report",
      timing !== undefined ? { timing } : {},
    );
    lines.push(...rest);
  }

  const summary = `deliver: OK — ${applied} steps applied`;
  lines.push(summary);
  log("pass", "summary", summary, { applied });
  return { code: 0, lines };
}

/** The pack's own ts-morph version — the shipped checker gets the same pin. */
function tsMorphPin(): string {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const pin = pkg.devDependencies?.["ts-morph"];
  if (pin === undefined) throw new Error("deliver: cannot find the pack's ts-morph version to pin");
  return pin;
}

// --- CLI ------------------------------------------------------------------------

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
  const { code, lines } = runDeliver(process.argv[2] ?? process.cwd());
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
