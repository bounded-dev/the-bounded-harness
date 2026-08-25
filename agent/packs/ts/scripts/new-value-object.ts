// new-value-object scaffolder (TN-26-001, issue #3): declares a branded value
// object in an existing contract.
//
//   node new-value-object.ts src/reading-list/book.contract.ts Isbn PagesRead=number [--parse]
//
// The companion to the `no-naked-primitives` rule: that gate tells the
// architect exactly which declaration is missing, and this writes it. The
// boilerplate is small but error-prone in the one way that matters — if the
// brand string does not match the type name, TypeScript silently gives you two
// unrelated types that both look right. Generating it removes that failure
// mode entirely, which is the same reason skeletons are machine-generated.
//
// What it deliberately does NOT do: retype the members that triggered the
// violation. Deciding that `isbn` is an `Isbn` while `title` is a `BookTitle`
// is design work — the architect's job, and a one-token edit. This tool owns
// the part where a typo is invisible.
//
// Pure core (addValueObjects: source → source) + thin CLI, like every other
// script in this pack. Idempotent by construction: re-running is a no-op, and
// a bare alias (`export type Isbn = string`, the rule's `primitiveAlias`
// violation) is upgraded in place rather than duplicated.
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
  /** Also declare `parseName(raw: base): Name | undefined` — the parse
   *  boundary, the one place the rule lets a raw primitive in. */
  readonly parse?: boolean;
}

export interface ValueObjectResult {
  readonly source: string;
  /** Newly declared, in the order requested. */
  readonly added: string[];
  /** Bare aliases rewritten as brands. */
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

/** The brand string is derived from the name, never typed twice — a mismatch
 *  would silently produce two unrelated types. */
export function renderValueObject(spec: ValueObjectSpec): string {
  return `export type ${spec.name} = ${spec.base} & { readonly __brand: "${spec.name}" };`;
}

export function parserNameFor(spec: ValueObjectSpec): string {
  return "parse" + spec.name;
}

/** The non-throwing smart constructor: the architect can widen it, but
 *  `| undefined` is the shape that forces the caller to handle bad input. */
export function renderParser(spec: ValueObjectSpec): string {
  return `export declare function ${parserNameFor(spec)}(raw: ${spec.base}): ${spec.name} | undefined;`;
}

// --- inspection of what is already there -----------------------------------------

type Existing =
  | { kind: "absent" }
  | { kind: "branded"; base: string; node: TypeAliasDeclaration }
  | { kind: "bareAlias"; base: string; node: TypeAliasDeclaration }
  | { kind: "other"; what: string };

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
  if (sf.getClass(name)) return { kind: "other", what: "a class" };
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
    if (Node.isImportDeclaration(stmt) || Node.isTypeAliasDeclaration(stmt)) {
      last = stmt.getEnd();
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
      case "branded":
        if (existing.base !== spec.base) {
          fail(
            `'${spec.name}' is already a value object over '${existing.base}', not '${spec.base}' — rebasing it would silently change every use. Edit the contract deliberately if that is what you mean.`,
          );
        }
        unchanged.push(spec.name);
        break;
      case "bareAlias": {
        if (existing.base !== spec.base) {
          fail(
            `'${spec.name}' is already an alias for '${existing.base}', not '${spec.base}' — rebasing it would silently change every use. Edit the contract deliberately if that is what you mean.`,
          );
        }
        // The rule's `primitiveAlias` violation, fixed in place.
        const node = existing.node;
        source =
          source.slice(0, node.getStart()) +
          renderValueObject(spec) +
          source.slice(node.getEnd());
        upgraded.push(spec.name);
        break;
      }
      case "absent":
        source = splice(source, insertionPoint(sf, source), renderValueObject(spec) + "\n");
        added.push(spec.name);
        break;
    }

    if (spec.parse) {
      const sfNow = project.createSourceFile("contract.ts", source, { overwrite: true });
      if (!sfNow.getFunction(parserNameFor(spec))) {
        if (!source.endsWith("\n")) source += "\n";
        source += "\n" + renderParser(spec) + "\n";
      }
    }
  }

  return { source, added, upgraded, unchanged };
}

// --- CLI --------------------------------------------------------------------------

const USAGE =
  "usage: node new-value-object.ts <path/to/foo.contract.ts> <Name>[=string|number] … [--parse]";

export function parseArgv(argv: readonly string[]): {
  contractPath: string;
  specs: ValueObjectSpec[];
} {
  const parse = argv.includes("--parse");
  const rest = argv.filter((a) => a !== "--parse");
  const [contractPath, ...names] = rest;
  if (!contractPath || names.length === 0) fail(USAGE);
  return {
    contractPath,
    specs: names.map((n) => ({ ...parseSpec(n), parse })),
  };
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
    const before = readFileSync(contractPath, "utf8");
    const result = addValueObjects(before, contractPath, parsed.specs);
    if (result.source !== before) writeFileSync(contractPath, result.source);

    const wrote = [...result.added, ...result.upgraded];
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`declared ${result.added.join(", ")}`);
    if (result.upgraded.length > 0) parts.push(`branded ${result.upgraded.join(", ")}`);
    if (result.unchanged.length > 0) parts.push(`already declared: ${result.unchanged.join(", ")}`);
    const summary = `${parts.join("; ")} in ${contractPath}`;
    console.log(`new-value-object: ${summary}`);
    if (wrote.length > 0) {
      console.log(
        `new-value-object: now use ${wrote.join("/")} in place of the naked primitive, then re-run contract-purity and scaffold-contract.`,
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
