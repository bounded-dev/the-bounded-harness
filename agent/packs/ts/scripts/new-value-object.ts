// new-value-object scaffolder (TN-26-001, issue #3): declares a value object in
// an existing contract, in the canonical shape — a nominal `declare class`.
//
//   node new-value-object.ts src/reading-list/book.contract.ts Isbn PagesRead=number
//
// The companion to the `no-naked-primitives` rule: that gate tells the
// architect exactly which declaration is missing, and this writes it.
//
//     /** Isbn: state what makes it valid. */
//     export declare class Isbn {
//       private readonly __brand: "Isbn";
//       private constructor();
//       readonly value: string;
//       static parse(raw: unknown): Isbn | undefined;
//       equals(other: Isbn): boolean;
//     }
//
// Why a class rather than the branded alias this used to emit: a class can be
// asked things (`equals`, `plus`, `toString`) where an alias can only be passed
// around, and it is built with a real constructor behind `parse` instead of
// `raw as Isbn` — which is what makes `src/**`'s blanket ban on `as`, `!`,
// `any` and `@ts-expect-error` livable. See the ts-contract-authoring skill,
// "The canonical shape is a nominal class", for what each member refuses.
//
// The boilerplate is small but error-prone in the one way that matters — if the
// brand string does not match the type name, TypeScript silently gives you two
// unrelated types that both look right. Generating it removes that failure mode
// entirely, the same reason skeletons are machine-generated.
//
// The carried field is named `value`, always, for both bases. The generator
// cannot know the domain word (`code` for a Currency, `digits` for an Isbn),
// and a name it invents per-type would be a guess the architect has to check.
// One boring placeholder is renamed in one token, and it stays predictable
// across every contract in the tree.
//
// What it deliberately does NOT do: retype the members that triggered the
// violation, or write the doc comment's actual rule. Deciding that `isbn` is an
// `Isbn` while `title` is a `BookTitle`, and that an ISBN is thirteen digits, is
// design work — the architect's job. This tool owns the part where a typo is
// invisible. An upgrade keeps a doc comment that is already there, so that
// judgment is never overwritten.
//
// Pure core (addValueObjects: source → source) + thin CLI, like every other
// script in this pack. Idempotent by construction: re-running is a no-op, and an
// existing alias — bare (`export type Isbn = string`, the rule's
// `primitiveAlias` violation) or branded (`string & { __brand }`, the previous
// canonical shape) — is upgraded in place rather than duplicated.
//
// Exit 0 wrote (or nothing to do) · 1 refused · 2 usage.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";
// Harness-core guard log (NOTE: this relative import only resolves when the
// pack runs inside the harness checkout; pack distribution is issue #4).
import { logGuardEvent } from "../../../src/guard-log.ts";
import type { SourceFile, TypeAliasDeclaration } from "ts-morph";

export class ValueObjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueObjectError";
  }
}

const CONTRACT_SUFFIX = ".contract.ts";

/** The bases the value-object rule polices. `boolean` is absent on purpose:
 *  a branded flag says nothing the property name doesn't, and the fix for a
 *  boolean smell is a state union, not a brand (see the rule's header). */
export type ValueObjectBase = "string" | "number";

export interface ValueObjectSpec {
  readonly name: string;
  readonly base: ValueObjectBase;
}

export interface ValueObjectResult {
  readonly source: string;
  /** Newly declared, in the order requested. */
  readonly added: string[];
  /** Aliases — bare or branded — rewritten as the canonical class. */
  readonly upgraded: string[];
  /** Already correct — nothing to do. */
  readonly unchanged: string[];
}

function fail(message: string): never {
  throw new ValueObjectError(`new-value-object: ${message}`);
}

// --- spec parsing ---------------------------------------------------------------

/** "Isbn" | "Isbn=string" | "PagesRead=number" → a spec. */
export function parseSpec(arg: string): ValueObjectSpec {
  const [name = "", base = "string"] = arg.split("=", 2);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    fail(
      `'${name}' is not a value-object name — type names are PascalCase (Isbn, PagesRead, AuthorName). Name it for the domain concept, not the primitive.`,
    );
  }
  if (base !== "string" && base !== "number") {
    fail(
      `'${base}' is not a value-object base — use 'string' or 'number'. A branded boolean carries no more meaning than the property name; if a boolean is the smell, model the states instead: export type ${name} = "active" | "archived".`,
    );
  }
  return { name, base };
}

// --- rendering ------------------------------------------------------------------

/** The carried field, for every generated value object. See the header for
 *  why one placeholder beats a per-type guess. */
export const VALUE_FIELD = "value";

/**
 * The canonical shape, rendered.
 *
 * Every member is load-bearing and every one of them is a `tsc` error rather
 * than a convention: the private `__brand` makes the type nominal (TS2739 for a
 * structural impostor), the private constructor refuses construction that
 * skipped validation (TS2673), `parse` takes `unknown` so it can face parsed
 * JSON directly, `| undefined` forces the caller to handle failure (TS2322),
 * and `readonly` refuses mutation after construction (TS2540).
 *
 * The brand string is derived from the name, never typed twice — a mismatch
 * would silently produce two unrelated types that both look right.
 *
 * `withDoc: false` for an upgrade that already has a doc comment: the rule an
 * architect wrote down outranks the placeholder.
 */
export function renderValueObject(spec: ValueObjectSpec, withDoc = true): string {
  const doc = withDoc ? `/** ${spec.name}: state what makes it valid. */\n` : "";
  return (
    doc +
    `export declare class ${spec.name} {\n` +
    `  private readonly __brand: "${spec.name}";\n` +
    `  private constructor();\n` +
    `  readonly ${VALUE_FIELD}: ${spec.base};\n` +
    `  static parse(raw: unknown): ${spec.name} | undefined;\n` +
    `  equals(other: ${spec.name}): boolean;\n` +
    `}`
  );
}

// --- inspection of what is already there -----------------------------------------

type Existing =
  | { kind: "absent" }
  | { kind: "valueClass" }
  | { kind: "branded"; base: string; node: TypeAliasDeclaration }
  | { kind: "bareAlias"; base: string; node: TypeAliasDeclaration }
  | { kind: "other"; what: string };

/** A `declare class` carrying the private brand is already the canonical shape,
 *  whatever else the architect has added to it. */
function isValueObjectClass(node: Node): boolean {
  return Node.isClassDeclaration(node) && node.getProperty("__brand") !== undefined;
}

function inspect(sf: SourceFile, name: string): Existing {
  const alias = sf.getTypeAlias(name);
  if (alias) {
    const type = alias.getTypeNode();
    if (type && Node.isIntersectionTypeNode(type)) {
      const base = type
        .getTypeNodes()
        .find((t) => t.getKind() === SyntaxKind.StringKeyword || t.getKind() === SyntaxKind.NumberKeyword);
      if (base) return { kind: "branded", base: base.getText(), node: alias };
      return { kind: "other", what: "a type alias that is not a branded primitive" };
    }
    if (
      type &&
      (type.getKind() === SyntaxKind.StringKeyword || type.getKind() === SyntaxKind.NumberKeyword)
    ) {
      return { kind: "bareAlias", base: type.getText(), node: alias };
    }
    return { kind: "other", what: "a type alias that is not a branded primitive" };
  }
  if (sf.getInterface(name)) return { kind: "other", what: "an interface" };
  const cls = sf.getClass(name);
  if (cls) {
    // Already the canonical shape. Its body is the architect's — extra
    // constructors, `plus`, a renamed carried field — so leave it entirely
    // alone rather than reconciling it against the requested base.
    if (isValueObjectClass(cls)) return { kind: "valueClass" };
    return { kind: "other", what: "a class without the private brand" };
  }
  if (sf.getFunction(name)) return { kind: "other", what: "a function" };
  return { kind: "absent" };
}

// --- placement -------------------------------------------------------------------

interface Insertion {
  readonly offset: number;
  /** The declaration above is a type alias, so join the block rather than
   *  opening a new one — value objects read as one vocabulary list. */
  readonly grouped: boolean;
}

/** Value objects belong at the top, with each other: after the (type-only)
 *  imports, or after the leading run of type aliases, or after the file's
 *  header comment. Deterministic so repeated runs keep one tidy block. */
function insertionPoint(sf: SourceFile, source: string): Insertion {
  let last: number | undefined;
  let grouped = false;
  for (const stmt of sf.getStatements()) {
    if (
      Node.isImportDeclaration(stmt) ||
      Node.isTypeAliasDeclaration(stmt) ||
      isValueObjectClass(stmt)
    ) {
      last = stmt.getEnd();
      // Only aliases group into a run. A class is a multi-line block and reads
      // better with a blank line between it and the next one.
      grouped = Node.isTypeAliasDeclaration(stmt);
      continue;
    }
    break;
  }
  if (last !== undefined) return { offset: lineEnd(source, last), grouped };

  // No imports and no aliases: skip a file header comment, if there is one.
  let offset = 0;
  for (const line of source.split("\n")) {
    if (!/^\s*\/\//.test(line)) break;
    offset += line.length + 1;
  }
  return { offset, grouped: false };
}

/** Advance past the end of the line containing `offset`. */
function lineEnd(source: string, offset: number): number {
  const nl = source.indexOf("\n", offset);
  return nl === -1 ? source.length : nl + 1;
}

function splice(source: string, at: Insertion, block: string): string {
  const before = source.slice(0, at.offset);
  const after = source.slice(at.offset);
  const blankBefore =
    !at.grouped && before.length > 0 && !before.endsWith("\n\n") ? "\n" : "";
  const blankAfter = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  return before + blankBefore + block + blankAfter + after;
}

// --- the core --------------------------------------------------------------------

export function addValueObjects(
  contractSource: string,
  contractFileName: string,
  specs: readonly ValueObjectSpec[],
): ValueObjectResult {
  if (!contractFileName.endsWith(CONTRACT_SUFFIX)) {
    fail(
      `'${contractFileName}' is not a *.contract.ts path — value objects belong in the contract, next to the surface that uses them.`,
    );
  }
  if (specs.length === 0) fail("no value objects requested");

  const project = new Project({ useInMemoryFileSystem: true });
  let source = contractSource;
  const added: string[] = [];
  const upgraded: string[] = [];
  const unchanged: string[] = [];

  // One pass per spec, re-parsing each time: slower, but every spec sees the
  // file the previous one produced, so batching cannot diverge from repeating.
  for (const spec of specs) {
    const sf = project.createSourceFile("contract.ts", source, { overwrite: true });
    const existing = inspect(sf, spec.name);

    switch (existing.kind) {
      case "other":
        fail(
          `'${spec.name}' is already declared in ${contractFileName} as ${existing.what} — pick another name, or make that declaration the value object yourself.`,
        );
        break;
      case "valueClass":
        unchanged.push(spec.name);
        break;
      case "branded":
      case "bareAlias": {
        if (existing.base !== spec.base) {
          const what =
            existing.kind === "branded"
              ? `a value object over '${existing.base}'`
              : `an alias for '${existing.base}'`;
          fail(
            `'${spec.name}' is already ${what}, not '${spec.base}' — rebasing it would silently change every use. Edit the contract deliberately if that is what you mean.`,
          );
        }
        // Both alias forms are upgraded in place, never duplicated: the bare
        // alias is the rule's `primitiveAlias` violation, and the branded alias
        // is this generator's own previous output. Expect `tsc` to complain at
        // the use sites afterwards — a class is not assignable from a raw
        // string, so every complaint is a place the primitive was leaking, named
        // for you.
        const node = existing.node;
        source =
          source.slice(0, node.getStart()) +
          renderValueObject(spec, node.getJsDocs().length === 0) +
          source.slice(node.getEnd());
        upgraded.push(spec.name);
        break;
      }
      case "absent":
        source = splice(source, insertionPoint(sf, source), renderValueObject(spec) + "\n");
        added.push(spec.name);
        break;
    }
  }

  return { source, added, upgraded, unchanged };
}

// --- CLI --------------------------------------------------------------------------

const USAGE =
  "usage: node new-value-object.ts <path/to/foo.contract.ts> <Name>[=string|number] …";

/** `--parse` used to add a free `parseName` function alongside a branded alias.
 *  `static parse` is now part of the shape, so the flag has nothing left to ask
 *  for. Accepted and ignored rather than rejected: an architect following an
 *  older note should get the value object, not a usage error. */
const RETIRED_FLAGS = new Set(["--parse"]);

export function parseArgv(argv: readonly string[]): {
  contractPath: string;
  specs: ValueObjectSpec[];
  retired: string[];
} {
  const retired = argv.filter((a) => RETIRED_FLAGS.has(a));
  const rest = argv.filter((a) => !RETIRED_FLAGS.has(a));
  const [contractPath, ...names] = rest;
  if (!contractPath || names.length === 0) fail(USAGE);
  return { contractPath, specs: names.map(parseSpec), retired };
}

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
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) {
    console.error(USAGE);
    process.exit(2);
  }
  let contractPath = "<unknown>";
  try {
    const parsed = parseArgv(argv);
    contractPath = parsed.contractPath;
    for (const flag of parsed.retired) {
      console.log(
        `new-value-object: ignoring ${flag} — 'static parse(raw: unknown)' is part of the canonical class shape now.`,
      );
    }
    const before = readFileSync(contractPath, "utf8");
    const result = addValueObjects(before, contractPath, parsed.specs);
    if (result.source !== before) writeFileSync(contractPath, result.source);

    const wrote = [...result.added, ...result.upgraded];
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`declared ${result.added.join(", ")}`);
    if (result.upgraded.length > 0) parts.push(`upgraded ${result.upgraded.join(", ")}`);
    if (result.unchanged.length > 0) parts.push(`already declared: ${result.unchanged.join(", ")}`);
    const summary = `${parts.join("; ")} in ${contractPath}`;
    console.log(`new-value-object: ${summary}`);
    if (wrote.length > 0) {
      console.log(
        `new-value-object: now use ${wrote.join("/")} in place of the naked primitive, state each one's validity rule in its doc comment (the test-writer reads nothing else), then re-run contract-purity and scaffold-contract.`,
      );
    }
    logGuardEvent(process.cwd(), {
      guard: "new-value-object",
      verdict: "pass",
      summary,
      detail: {
        contract: contractPath,
        added: result.added,
        upgraded: result.upgraded,
        unchanged: result.unchanged,
      },
    });
  } catch (e) {
    if (e instanceof ValueObjectError) {
      console.error(e.message);
      logGuardEvent(process.cwd(), {
        guard: "new-value-object",
        verdict: "block",
        summary: e.message,
        detail: { contract: contractPath },
      });
      process.exit(1);
    }
    throw e;
  }
}
