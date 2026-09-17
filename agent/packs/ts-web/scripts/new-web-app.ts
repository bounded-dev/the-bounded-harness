// The FSD skeleton generator (TN-26-006 B1): the ts-web reference layout,
// emitted into a target project.
//
//   node new-web-app.ts [targetDir]
//
// Exit 0 in sync · 1 blocked (a pack-owned path holds hand-written work).
//
// WHY A GENERATOR AND NOT A SKILL SECTION. Structure produced by prose is
// structure that varies per run, and the whole reference-set idea is that only
// the genuine design decisions vary (TN-26-004, CONTEXT.md). The FSD layer
// names, the Tailwind entry, the Vite config and the one door to the network
// are not decisions a ticket gets to re-take, so they are emitted, marked, and
// owned by this pack.
//
// THE SYNC, in the shipped-runtime's shape (scaffold-contract.ts):
//   · byte-compare, and write only when the bytes differ — a re-run over an
//     unchanged tree touches nothing and says so;
//   · a pack-owned path holding a file WITHOUT the generated marker is a BLOCK,
//     not an overwrite. That file is somebody's work, and this generator is the
//     last thing that should decide it was a mistake;
//   · prune nothing in v1. The scaffolder prunes because its output is a pure
//     function of the contract set; this generator's output is a function of
//     the layout, which only ever grows. When pruning arrives it will have the
//     same licence the scaffolder has — the marker, and only the marker.
//
// AND ONE FILE UNDER THE OPPOSITE RULE. `src/ui/theme.css` is a SEED
// (`webAppSeeds`): the project's visual identity, written once when absent,
// never marker'd, never compared, never restored (TN-26-006, "anatomy
// enforced, identity free"). Everything else here is structure the generator
// owns; that one file is identity the project owns, and the sync's job is to
// keep its hands off it.
//
// KEYED ON TREE CONTENT. `src/ui/shared/api/client.tsx` is emitted only once
// the tree holds a service contract re-exporting `ServiceRouter`, because the
// typed client is the router type and nothing else. TN-26-006's dogfood ladder
// runs r24 (a props-driven UI, no API at all) before r25 (the change run that
// wires it to the service), and a client importing a type that does not exist
// would make the first of those impossible to typecheck. So the layout answers
// to the tree it is emitted into — the same "artifacts keyed on contract
// content" socket the scaffolder fills for the service runtime (TN-26-005).

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findContractFiles } from "../../ts/scripts/checksum-gate.ts";
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent } from "../../../src/guard-log.ts";
import {
  APP_CSS,
  clientTsx,
  COMPONENT_KIT,
  INDEX_HTML,
  LAYER_NOTES,
  mainTsx,
  THEME_CSS,
  VITE_CONFIG,
} from "../template.ts";

const GUARD = "new-web-app";

/** The generator's own address, as it appears inside every marker it writes. */
export const GENERATOR = "packs/ts-web/scripts/new-web-app.ts";

/** Where the emitted bytes come from — one module, so one source name. */
const SOURCE = "packs/ts-web/template.ts";

export class WebAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAppError";
  }
}

// --- the marker, in four comment syntaxes ------------------------------------
//
// The sentence is the scaffolder's, verbatim, and must stay that way: its
// `isGeneratedArtifact` is what makes a `.ts`/`.tsx` file provably
// machine-written, and TN-26-006 B1 widened its pack segment precisely so this
// generator's output is recognised there too. Only the WRAPPER varies, because
// `// …` is a comment in TypeScript, a paragraph of text in HTML, and a syntax
// error in CSS.

const MARKER_SENTENCE = `GENERATED from ${SOURCE} by ${GENERATOR} — do not edit.`;

/** Line 1 of a generated file, in the syntax `path`'s language accepts. */
export function markerFor(path: string): string {
  if (path.endsWith(".css")) return `/* ${MARKER_SENTENCE} */`;
  if (path.endsWith(".html")) return `<!-- ${MARKER_SENTENCE} -->`;
  if (path.endsWith(".gitkeep")) return `# ${MARKER_SENTENCE}`;
  return `// ${MARKER_SENTENCE}`;
}

/** The same sentence in any of the four wrappers — what this generator
 *  recognises as its own. Deliberately NOT "any generated file": overwriting
 *  another pack's output would be the cross-pack version of clobbering a
 *  builder's work. */
const OWNED_MARKER = new RegExp(
  `^(//|#|/\\*|<!--)\\s*GENERATED from \\S+ by ${GENERATOR.replace(/[/.]/g, "\\$&")}`,
);

/** Was this text written by THIS generator? Line 1 decides, and only line 1. */
export function isOwnArtifact(source: string): boolean {
  const firstNewline = source.indexOf("\n");
  return OWNED_MARKER.test(firstNewline === -1 ? source : source.slice(0, firstNewline));
}

// --- the plan ----------------------------------------------------------------

/** One file the layout consists of: a project-relative posix path and the
 *  bytes that belong there, marker included. */
export interface EmittedFile {
  readonly path: string;
  readonly content: string;
}

/** What the plan needs to know about the target tree. */
export interface WebAppInputs {
  /** Specifier for the service's implementation module, relative to
   *  `src/ui/shared/api/client.tsx` — or undefined when the tree has no
   *  service contract yet. */
  readonly routerSpecifier: string | undefined;
}

function file(path: string, body: string): EmittedFile {
  return { path, content: `${markerFor(path)}\n${body}` };
}

/**
 * The layout, as data. PURE: no disk, no environment, no clock — so the suite
 * can assert what a tree WOULD receive without building one, and the sync below
 * is reduced to "write what the plan says".
 */
export function webAppPlan(inputs: WebAppInputs): readonly EmittedFile[] {
  const files: EmittedFile[] = [
    file("index.html", INDEX_HTML),
    file("vite.config.ts", VITE_CONFIG),
    file("src/ui/app.css", APP_CSS),
    file("src/ui/main.tsx", mainTsx({ wrapInProvider: inputs.routerSpecifier !== undefined })),
  ];

  if (inputs.routerSpecifier === undefined) {
    // The door's frame, with nothing in it yet. Keeping the directory means the
    // layer exists in the tree (and in the lints' eyes) before the API does.
    files.push(
      file(
        "src/ui/shared/api/.gitkeep",
        "The ONE door to the network. client.tsx lands here the moment a *.contract.ts\n" +
          "re-exports ServiceRouter — re-run the generator then (TN-26-006).\n",
      ),
    );
  } else {
    files.push(file("src/ui/shared/api/client.tsx", clientTsx(inputs.routerSpecifier)));
  }

  // The component kit (TN-26-006 B3). It fills `shared/ui` and `shared/lib`, so
  // neither gets a .gitkeep — a placeholder next to real files is debris.
  for (const component of COMPONENT_KIT) files.push(file(component.path, component.body));

  for (const layer of LAYER_NOTES) files.push(file(`${layer.dir}/.gitkeep`, `${layer.note}\n`));
  return Object.freeze(files.sort((a, b) => (a.path < b.path ? -1 : 1)));
}

/**
 * The SEEDS: files the generator writes once and then never touches again.
 *
 * Exactly one today — `src/ui/theme.css`, the project's visual identity
 * (TN-26-006, "anatomy enforced, identity free"). It is the inverse of
 * everything in `webAppPlan`: no marker, no byte comparison, no restore, and a
 * hand-edited copy is the DESIRED state rather than drift to be repaired.
 *
 * WHY THE DISTINCTION IS A SEPARATE FUNCTION AND NOT A FLAG ON EmittedFile. The
 * two kinds obey opposite rules at every step of the sync — ownership check,
 * write condition, block condition, "already in sync" — so a boolean would have
 * meant four `if (emitted.once)` branches through a function whose whole value
 * is being short enough to read. Two lists, two loops, and no path can
 * accidentally belong to both.
 *
 * WHY IT IS NOT MARKER'D. The marker means "this generator will restore this
 * file". Putting one on a file a project is invited to edit would be a lie the
 * next sync tells the truth about, by deleting the project's work.
 */
export function webAppSeeds(): readonly EmittedFile[] {
  return Object.freeze([{ path: "src/ui/theme.css", content: THEME_CSS }]);
}

// --- reading the target tree -------------------------------------------------

/** A service contract is one that re-exports the router's inferred type —
 *  which `router-type-reexported` makes mandatory, so this is not a heuristic
 *  but the shape the purity gate already enforces (TN-26-006 A2). */
const ROUTER_REEXPORT = /export\s+type\s+ServiceRouter\b/;

/** Contract paths in `cwd` that declare a service router, sorted. */
export function serviceContracts(cwd: string): string[] {
  const out: string[] = [];
  for (const path of findContractFiles(cwd)) {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue; // vanished under us — nothing to read
    }
    if (ROUTER_REEXPORT.test(source)) out.push(path);
  }
  return out;
}

/**
 * The specifier `client.tsx` uses to reach the service's router type.
 *
 * Points at the IMPLEMENTATION module (`api.js`), never at the contract: a
 * contract's ambient declarations are a second identity for everything they
 * declare, and the implementation module re-exports every type its contract
 * declares (ADR 2026-023). The `.js` extension is the harness's NodeNext
 * spelling, which Vite resolves to the `.ts` file natively.
 */
export function routerSpecifierFor(cwd: string, contractPath: string): string {
  const implRel = relative(cwd, contractPath).split(sep).join("/").replace(/\.contract\.ts$/, ".js");
  const spec = posix.relative("src/ui/shared/api", implRel);
  return spec.startsWith(".") ? spec : `./${spec}`;
}

// --- the sync ----------------------------------------------------------------

export interface WebAppRun {
  readonly code: 0 | 1;
  readonly lines: readonly string[];
}

/**
 * Emit (or re-emit) the layout into `cwd`.
 *
 * Idempotent by byte comparison: a second run over an untouched tree writes
 * nothing. The one thing it will not do is overwrite a file at a pack-owned
 * path that does not carry this generator's marker — that file is somebody's
 * work, or another pack's output, and either way the remedy is a human's, not
 * a generator's.
 */
export function syncWebApp(cwd: string): WebAppRun {
  const services = serviceContracts(cwd);
  if (services.length > 1) {
    const named = services.map((p) => relative(cwd, p).split(sep).join("/")).join(", ");
    const summary =
      `${services.length} contracts re-export ServiceRouter (${named}) — the one door cannot point at two ` +
      "services. Compose them behind a single service contract, or run the generator in a tree with one";
    logGuardEvent(cwd, { guard: GUARD, verdict: "block", summary, detail: { services: named } });
    return { code: 1, lines: [`${GUARD}: BLOCK — ${summary}`] };
  }

  const routerSpecifier =
    services[0] === undefined ? undefined : routerSpecifierFor(cwd, services[0]);
  const plan = webAppPlan({ routerSpecifier });

  // Check every path BEFORE writing any of them. A generator that blocks
  // half-way through has already changed the tree, and "nothing was written" is
  // the only honest answer to a run that refused.
  const blocked: string[] = [];
  for (const emitted of plan) {
    const target = join(cwd, emitted.path);
    if (!existsSync(target)) continue;
    const current = readFileSync(target, "utf8");
    if (!isOwnArtifact(current)) blocked.push(emitted.path);
  }
  if (blocked.length > 0) {
    const summary =
      `${blocked.length} pack-owned path${blocked.length === 1 ? "" : "s"} hold${blocked.length === 1 ? "s" : ""} ` +
      `a file this generator did not write: ${blocked.join(", ")}`;
    logGuardEvent(cwd, { guard: GUARD, verdict: "block", summary, detail: { blocked } });
    return {
      code: 1,
      lines: [
        `${GUARD}: BLOCK — ${summary}.`,
        "  These paths belong to the ts-web pack: the layout is generated, marker-carrying and",
        "  never hand-edited, so a file here without the marker is work the generator would",
        "  destroy. Move it aside and re-run, or keep it and stop running the generator.",
        "  Nothing was written.",
      ],
    };
  }

  const lines: string[] = [];
  let wrote = 0;
  for (const emitted of plan) {
    const target = join(cwd, emitted.path);
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    if (current === emitted.content) continue; // byte-identical: nothing to do
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, emitted.content);
    wrote += 1;
    lines.push(`${GUARD}: wrote ${emitted.path}`);
  }

  // The seeds, under the opposite rule: written when ABSENT, left alone in
  // every other case. No byte comparison and no marker check — a theme.css
  // that differs from the starter is the project having a visual identity,
  // which is what the file is for.
  for (const seed of webAppSeeds()) {
    const target = join(cwd, seed.path);
    if (existsSync(target)) {
      lines.push(`${GUARD}: kept ${seed.path} — yours, never overwritten (this app's visual identity)`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, seed.content);
    wrote += 1;
    lines.push(`${GUARD}: wrote ${seed.path} — a STARTER theme, yours to edit; nothing will restore it`);
  }

  if (routerSpecifier === undefined) {
    lines.push(
      `${GUARD}: no service contract in this tree — src/ui/shared/api/client.tsx lands on the next ` +
        "run, once a *.contract.ts re-exports ServiceRouter (TN-26-006 r25)",
    );
  }
  lines.push(
    `${GUARD}: src/ui/main.tsx mounts <App /> from ./app.js — declare src/ui/app.contract.ts and ` +
      "design_gate's scaffold step writes its .tsx skeleton",
  );
  const summary = wrote === 0 ? "already in sync" : `wrote ${wrote} file${wrote === 1 ? "" : "s"}`;
  lines.push(`${GUARD}: ${summary}`);
  logGuardEvent(cwd, { guard: GUARD, verdict: "pass", summary, detail: { wrote } });
  return { code: 0, lines };
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
  const target = resolve(process.argv[2] ?? process.cwd());
  const { code, lines } = syncWebApp(target);
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exit(code);
}
