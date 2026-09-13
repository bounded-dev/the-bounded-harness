// Value-object law generator (TN-26-001): contract → machine-generated laws.
//
//   src/pricing/pricing.contract.ts  →  tests/generated/pricing.laws.test.ts
//
// Same spirit as the scaffolder: pure core (valueObjectLawsSource: string →
// string) + thin CLI, and the output carries a "GENERATED … do not edit"
// header. Skeletons are machine-generated so there is nothing to police; the
// laws that hold for EVERY value object are machine-generated for the same
// reason. What is left for the test-writer is the part no generator can know —
// which strings are valid currencies (ts-contract-authoring, "Boundaries").
//
// In this contract style an exported class IS a value object: private brand,
// private constructor, `static parse(raw: unknown)`. So every exported class
// gets a law suite, and a class that cannot carry one (no `parse`, generic,
// abstract) is reported rather than silently dropped.
//
// ── Two decisions the red gate forces ────────────────────────────────────
//
// 1. A MISSING `@accepts` EXAMPLE IS SKIPPED, NEVER FAILED. The generated
//    file runs inside the red gate, which rejects any failure that is not a
//    NotImplementedError. An `expect.fail("add @accepts")` would therefore be
//    a WRONG-REASON RED: it blocks the entire pipeline, and red-gate routes
//    the fix to the test-writer — who cannot make it, because the fix is a
//    JSDoc tag in a checksum-frozen contract owned by the architect. A skip
//    names the gap in the runner output; the CLI additionally warns on
//    stderr at generation time, which is where the architect is standing.
//
// 2. `parse()` IS NEVER WRAPPED IN try/catch. Against the throwing skeleton
//    the NotImplementedError must reach the runner — that is precisely what
//    makes these laws a valid red. Treating a throw as "rejected" would leave
//    the whole suite vacuously green at the red phase, which is the failure
//    this pipeline exists to prevent. It is also correct at green: a `parse`
//    declared `T | undefined` rejects by returning, never by throwing.
//
// Known limit: the output path is keyed on the contract's BASENAME, so two
// contracts named the same in different directories would collide. The CLI
// takes one contract at a time and says where it wrote.

import { basename, dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodeBlockWriter, Node, Project, SyntaxKind, ts } from "ts-morph";
import type { ClassDeclaration } from "ts-morph";

const CONTRACT_SUFFIX = ".contract.ts";

/** Where generated law suites live in the target project. */
export const GENERATED_TESTS_DIR = "tests/generated";

export class ValueObjectLawsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueObjectLawsError";
  }
}

function fail(message: string): never {
  throw new ValueObjectLawsError(`value-object-laws: ${message}`);
}

/**
 * The UNIVERSAL hostile-input corpus — verbatim expression source, emitted into
 * the generated file as a named const so a failure can name which ones wrongly
 * passed. Every entry is hostile to SOME value object; which entries are hostile
 * to a GIVEN one depends on its base primitive (see `hostileExpressionsFor`).
 *
 * The rule (ADR 2026-024): an input is hostile to a value object iff it is
 * CROSS-TYPE to the VO's base primitive, OR a SAME-TYPE pathological sentinel no
 * VO of that base could accept (`NaN`/`Infinity` for `number`). A same-type
 * ORDINARY value — `0`/`-1` for a numeric base, `""`/`" "` for a string base —
 * is a RANGE decision this law cannot make (a Kelvin of 0–80 accepts 0; a
 * Percent rejects -1), so it is left to the test-writer's boundaries block.
 * Cross-type inputs stay hostile for every base: a string VO must still reject
 * the number 0, a numeric VO must reject "" and [].
 */
export const HOSTILE_INPUT_EXPRESSIONS: readonly string[] = [
  "undefined",
  "null",
  "true",
  "false",
  "0",
  "-1",
  "NaN",
  "Infinity",
  '""',
  '" "',
  "[]",
  "{}",
  "() => {}",
  'Symbol("x")',
  "new Date()",
  "9007199254740993n",
];

/** Base primitives a value object can wrap — the domains we can filter against.
 *  A base outside this set (or an undetectable one) keeps the whole corpus. */
const KNOWN_PRIMITIVES: ReadonlySet<string> = new Set(["number", "string", "boolean", "bigint", "symbol"]);

/** Static typeof-classification of each fixed corpus expression. `undefined` and
 *  `null` are given kinds that match no base, so they stay hostile everywhere. */
const HOSTILE_KIND: Readonly<Record<string, string>> = {
  undefined: "undefined",
  null: "null",
  true: "boolean",
  false: "boolean",
  "0": "number",
  "-1": "number",
  NaN: "number",
  Infinity: "number",
  '""': "string",
  '" "': "string",
  "[]": "object",
  "{}": "object",
  "() => {}": "function",
  'Symbol("x")': "symbol",
  "new Date()": "object",
  "9007199254740993n": "bigint",
};

/** Same-type sentinels that NO value object of the base could accept, so they
 *  stay hostile even though their typeof matches the base. */
const PATHOLOGICAL_SAME_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  number: new Set(["NaN", "Infinity"]),
};

const NO_PATHOLOGICAL: ReadonlySet<string> = new Set();

/** Classify a single `@accepts` example expression to its base primitive, for
 *  the fallback when the nominal shape carries no `readonly value` field. */
function classifyLiteral(expr: string): string | undefined {
  const t = expr.trim();
  if (/^["'`]/.test(t)) return "string";
  if (/^[-+]?\d[\d_]*n$/.test(t)) return "bigint";
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(t)) return "number";
  if (t === "NaN" || t === "Infinity" || t === "-Infinity" || t === "+Infinity") return "number";
  if (t === "true" || t === "false") return "boolean";
  return undefined;
}

/**
 * The corpus entries hostile to THIS value object. Cross-type entries and
 * same-type pathological sentinels are kept; same-type ordinary values are
 * dropped as range decisions. A VO's own `@accepts` example is ALWAYS excluded
 * (belt and braces): the equality laws call `parse(example)` and REQUIRE it to
 * succeed, so it can never also be asserted hostile — the contradiction that
 * blocked dogfood run r17. When the base is unknown we keep the whole corpus and
 * still honour that exclusion (fail safe toward more rejection).
 */
export function hostileExpressionsFor(vo: ValueObjectInfo): readonly string[] {
  const base = vo.base;
  const known = base !== undefined && KNOWN_PRIMITIVES.has(base);
  const pathological = base !== undefined ? (PATHOLOGICAL_SAME_TYPE[base] ?? NO_PATHOLOGICAL) : NO_PATHOLOGICAL;
  return HOSTILE_INPUT_EXPRESSIONS.filter((expr) => {
    if (vo.accepts.includes(expr)) return false;
    if (!known) return true;
    const kind = HOSTILE_KIND[expr];
    if (kind !== base) return true; // cross-type: hostile to every base
    return pathological.has(expr); // same-type: only pathological sentinels
  });
}

// --- paths --------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** tests/generated/<contract-basename>.laws.test.ts */
export function lawsPathFor(contractPath: string): string {
  const base = basename(toPosix(contractPath));
  if (!base.endsWith(CONTRACT_SUFFIX)) {
    fail(`'${contractPath}' is not a *.contract.ts path`);
  }
  return `${GENERATED_TESTS_DIR}/${base.slice(0, -CONTRACT_SUFFIX.length)}.laws.test.ts`;
}

/**
 * Specifier for the IMPLEMENTATION module — the scaffolded sibling of the
 * contract, not the contract itself. Target projects are NodeNext, so the
 * runtime import carries `.js` even though the file is `.ts`.
 */
export function implementationModuleFor(contractPath: string): string {
  const p = toPosix(contractPath);
  if (!p.endsWith(CONTRACT_SUFFIX)) fail(`'${contractPath}' is not a *.contract.ts path`);
  if (isAbsolute(p) || p.startsWith("/")) {
    fail(`'${contractPath}' is absolute — pass the contract path relative to the project root`);
  }
  const impl = p.slice(0, -CONTRACT_SUFFIX.length) + ".js";
  const rel = posix.relative(posix.dirname(lawsPathFor(p)), impl);
  return rel.startsWith(".") ? rel : "./" + rel;
}

// --- reading the contract -----------------------------------------------------

export interface ValueObjectInfo {
  readonly name: string;
  /** Verbatim expression texts from JSDoc `@accepts` tags, in source order. */
  readonly accepts: readonly string[];
  readonly hasEquals: boolean;
  /** Instance `toJSON()` declared — the value object states its wire form, so
   *  the round-trip law parse(toJSON(v)) ≡ v applies (TN-26-004). */
  readonly hasToJson: boolean;
  /** The base primitive this value object wraps ("number" | "string" | …), read
   *  from the nominal `readonly value: <primitive>` field (ADR 2026-015) or, when
   *  absent, inferred from the first `@accepts` example. Absent when unknowable,
   *  in which case the whole hostile corpus is kept. Drives `hostileExpressionsFor`. */
  readonly base?: string;
  /** Why this class gets no executable laws. Absent when it gets them. */
  readonly unsupported?: string;
}

/** The base primitive from the nominal `readonly value: <primitive>` field
 *  (ADR 2026-015), else the first `@accepts` example's literal type, else
 *  undefined. Kept only when it names a primitive we know how to filter. */
function baseOf(cls: ClassDeclaration, accepts: readonly string[]): string | undefined {
  const prop = cls.getProperty("value");
  const fromField = prop?.getTypeNode()?.getText() ?? cls.getGetAccessor("value")?.getReturnTypeNode()?.getText();
  if (fromField !== undefined && KNOWN_PRIMITIVES.has(fromField)) return fromField;
  const first = accepts[0];
  if (first !== undefined) {
    const inferred = classifyLiteral(first);
    if (inferred !== undefined) return inferred;
  }
  return undefined;
}

/** Static `parse(raw: unknown)` is the single door in; without it there is
 *  nothing a law can call. Anything else about parse being wrong is a contract
 *  defect, and is raised rather than worked around. */
function checkParse(cls: ClassDeclaration, name: string): string | undefined {
  const parse = cls
    .getMembers()
    .filter(Node.isMethodDeclaration)
    .find((m) => m.getName() === "parse" && m.hasModifier(SyntaxKind.StaticKeyword));
  if (!parse) {
    return `'${name}' declares no 'static parse(raw: unknown)', which is the single door in for a value object`;
  }
  const params = parse.getParameters();
  const first = params[0];
  if (!first) {
    fail(`'${name}.parse' takes no parameter — a value object's parse faces raw input: 'static parse(raw: unknown)'`);
  }
  const typeText = first.getTypeNode()?.getText();
  if (typeText !== "unknown") {
    fail(
      `'${name}.parse' takes '${typeText ?? "(untyped)"}' — it must take 'unknown', or it cannot be handed the hostile inputs every value object must refuse`,
    );
  }
  for (const extra of params.slice(1)) {
    if (!extra.isOptional() && !extra.isRestParameter() && !extra.hasInitializer()) {
      fail(
        `'${name}.parse' requires a second argument '${extra.getName()}' — parse must be callable with the raw input alone`,
      );
    }
  }
  return undefined;
}

/** `@accepts <expression>` on the class JSDoc. Validated here so a bad tag is a
 *  loud generator error, never a generated file that fails to parse. */
function acceptsOf(cls: ClassDeclaration, name: string): string[] {
  const out: string[] = [];
  const fullText = cls.getSourceFile().getFullText();
  for (const doc of cls.getJsDocs()) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() !== "accepts") continue;
      // TypeScript's JSDoc parser treats `@accepts` as a tag even mid-sentence,
      // so the prose "the architect forgot the @accepts tag" arrives here as a
      // tag whose body is "tag." — and blew up generation on a doc comment that
      // was merely talking about the convention. A tag counts only where a
      // reader would see one: opening its own line, or opening the comment.
      // Anything with prose in front of it on the line is prose.
      const lineStart = fullText.lastIndexOf("\n", tag.getStart() - 1) + 1;
      if (!/^\s*(\/\*\*)?[\s*]*$/.test(fullText.slice(lineStart, tag.getStart()))) continue;
      const raw = (tag.getCommentText() ?? "").trim();
      if (raw === "") {
        fail(`'${name}' has an empty '@accepts' tag — write the example expression, e.g. '@accepts "USD"'`);
      }
      if (raw.includes("\n")) {
        fail(`'${name}' has a multi-line '@accepts' tag — one single-line expression per tag, e.g. '@accepts "USD"'`);
      }
      const diagnostics =
        ts.transpileModule(`const __accepts = (${raw});`, {
          reportDiagnostics: true,
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).diagnostics ?? [];
      if (diagnostics.length > 0) {
        fail(
          `'${name}' has an '@accepts' tag that is not an expression: ${raw} — the tag holds the example and nothing else (no prose, no trailing comment)`,
        );
      }
      out.push(raw);
    }
  }
  return out;
}

/** Every exported class in the contract, with what the laws need to know. */
export function valueObjectsOf(contractSource: string, contractFileName: string): readonly ValueObjectInfo[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile(basename(toPosix(contractFileName)), contractSource, { overwrite: true });

  const out: ValueObjectInfo[] = [];
  for (const stmt of sf.getStatements()) {
    if (!Node.isClassDeclaration(stmt)) continue;
    if (!stmt.hasModifier(SyntaxKind.ExportKeyword)) continue;
    const name = stmt.getName();
    if (name === undefined) continue; // default-exported anonymous class: the scaffolder rejects it

    const accepts = acceptsOf(stmt, name);
    const hasEquals = stmt
      .getMembers()
      .filter(Node.isMethodDeclaration)
      .some((m) => m.getName() === "equals" && !m.hasModifier(SyntaxKind.StaticKeyword));
    const hasToJson = stmt
      .getMembers()
      .filter(Node.isMethodDeclaration)
      .some((m) => m.getName() === "toJSON" && !m.hasModifier(SyntaxKind.StaticKeyword));

    let unsupported: string | undefined;
    if (stmt.getTypeParameters().length > 0) {
      unsupported = `'${name}' is generic — value-object laws apply to a concrete type, so instantiate it in the contract or drop the type parameter`;
    } else if (stmt.hasModifier(SyntaxKind.AbstractKeyword)) {
      unsupported = `'${name}' is abstract — an abstract class has no instances to compare, so it is not a value object`;
    } else {
      unsupported = checkParse(stmt, name);
    }

    const base = baseOf(stmt, accepts);
    out.push({
      name,
      accepts,
      hasEquals,
      hasToJson,
      ...(base !== undefined ? { base } : {}),
      ...(unsupported !== undefined ? { unsupported } : {}),
    });
  }
  return out;
}

// --- rendering ------------------------------------------------------------------

export interface ValueObjectLawsOptions {
  /** Override the implementation module specifier (default: the scaffolded
   *  sibling of the contract, resolved from tests/generated). */
  readonly implementationModule?: string;
}

function q(text: string): string {
  return JSON.stringify(text);
}

const HEADER = (contractBase: string): readonly string[] => [
  `// GENERATED from ${contractBase} by packs/ts/scripts/value-object-laws.ts — do not edit.`,
  "// The laws that hold for EVERY value object, whatever the domain: parse refuses",
  "// junk, equality is by value, parsing is deterministic. What these CANNOT cover",
  '// is an input of the right base type and the wrong value — "usd" is a string,',
  "// and only someone thinking about currencies knows it must fail. Likewise a",
  "// same-type value at the edge of a range — 0 for a Kelvin, -1 for a Percent —",
  "// is a domain decision this file cannot make, so the hostile-input law does",
  "// not assert on it. Both belong to the test-writer's `<Name> — boundaries`",
  "// block (see ts-contract-authoring).",
  "//",
  "// Two properties of this file are forced by the red gate, which rejects any",
  "// failure that is not a NotImplementedError:",
  "//",
  "//   * A missing `@accepts` example is SKIPPED, never failed. A hard failure",
  "//     here would be a wrong-reason red: it would block the whole pipeline and",
  "//     route the fix to the test-writer, when the fix is a JSDoc tag in the",
  "//     frozen contract and belongs to the architect. The generator warns about",
  "//     the same gap on stderr, where the architect is standing.",
  "//   * `parse()` is never wrapped in try/catch. Against the throwing skeleton",
  "//     the NotImplementedError must reach the runner — that is what makes this",
  "//     file a valid red. Swallowing it would leave these laws vacuously green",
  "//     at exactly the phase they exist to fail.",
];

function skipMarker(w: CodeBlockWriter, title: string, why: string): void {
  w.writeLine("test.skip(");
  w.setIndentationLevel(w.getIndentationLevel() + 1);
  w.writeLine(`${q(title)},`);
  w.write("() => ").inlineBlock(() => {
    w.writeLine(`expect.fail(${q(why)});`);
  });
  w.write(",").newLine();
  w.setIndentationLevel(w.getIndentationLevel() - 1);
  w.writeLine(");");
}

/**
 * Emit the law suite for one contract. Pure: source in, source out.
 *
 * Throws ValueObjectLawsError when the contract declares no exported class —
 * an empty vitest file is a SUITE ERROR, which the red gate reads as "suite did
 * not run", so refusing to write one is the point. Call `valueObjectsOf` first
 * if you need to ask without catching.
 */
export function valueObjectLawsSource(
  contractSource: string,
  contractFileName: string,
  options: ValueObjectLawsOptions = {},
): string {
  const contractBase = basename(toPosix(contractFileName));
  const valueObjects = valueObjectsOf(contractSource, contractFileName);
  if (valueObjects.length === 0) {
    fail(
      `${contractBase} declares no exported class, so it has no value objects and no laws — do not write a laws file for it (an empty vitest file is a suite error, which the red gate reads as a broken suite)`,
    );
  }

  const implModule = options.implementationModule ?? implementationModuleFor(contractFileName);
  const testable = valueObjects.filter((vo) => vo.unsupported === undefined);
  const withExample = testable.filter((vo) => vo.accepts.length > 0);

  const w = new CodeBlockWriter({ newLine: "\n", indentNumberOfSpaces: 2, useSingleQuote: false, useTabs: false });

  for (const line of HEADER(contractBase)) w.writeLine(line);
  w.blankLine();
  w.writeLine(`import { describe, expect, test } from "vitest";`);
  // Only classes that are actually referenced are imported: an unused import
  // is a compile error under noUnusedLocals, and a laws file that does not
  // compile is a wrong-reason red at the worst possible moment.
  if (testable.length > 0) {
    w.writeLine(`import { ${testable.map((vo) => vo.name).join(", ")} } from ${q(implModule)};`);
  }

  if (testable.length > 0) {
    w.blankLine();
    w.writeLine("/** Inputs no value object may accept, whatever its domain. Labelled so a");
    w.writeLine(" *  failing law names which ones wrongly got through. */");
    w.writeLine("const HOSTILE_INPUTS: readonly (readonly [string, unknown])[] = [");
    w.setIndentationLevel(1);
    for (const expr of HOSTILE_INPUT_EXPRESSIONS) w.writeLine(`[${q(expr)}, ${expr}],`);
    w.setIndentationLevel(0);
    w.writeLine("];");
  }

  if (withExample.length > 0) {
    w.blankLine();
    w.writeLine("/** Narrow a parse result without a cast. A throwing skeleton never reaches");
    w.writeLine(" *  this line: its NotImplementedError propagates first, which is what the");
    w.writeLine(" *  red gate is looking for. */");
    w.write("function mustParse<T>(result: T | undefined | null, what: string): T").block(() => {
      w.write("if (result === undefined || result === null)").block(() => {
        w.writeLine(
          "throw new Error(`${what} rejected the @accepts example from the contract — fix the tag, or fix the parser`);",
        );
      });
      w.writeLine("return result;");
    });
  }

  for (const vo of valueObjects) {
    w.blankLine();
    w.write(`describe(${q(`${vo.name} — value-object laws (generated)`)}, () => `).inlineBlock(() => {
      writeLaws(w, vo, contractBase);
    });
    w.write(");").newLine();
  }

  let text = w.toString();
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

function writeLaws(w: CodeBlockWriter, vo: ValueObjectInfo, contractBase: string): void {
  const { name } = vo;

  if (vo.unsupported !== undefined) {
    skipMarker(
      w,
      `${name}: no laws generated — ${vo.unsupported}. Fix ${contractBase} and re-generate.`,
      `${name} carries no value-object laws: ${vo.unsupported}`,
    );
    return;
  }

  // Law 1 — needs no example, so it runs for every value object.
  const hostiles = hostileExpressionsFor(vo);
  w.write(`test("refuses every hostile input", () => `).inlineBlock(() => {
    w.writeLine("// The corpus entries hostile to THIS value object's base primitive:");
    w.writeLine("// cross-type inputs, plus same-type pathological sentinels. Same-type");
    w.writeLine("// ordinary values (a range decision) and this VO's own @accepts");
    w.writeLine("// examples are excluded — see the generator's hostileExpressionsFor.");
    w.write("const applicable = new Set<string>([");
    w.newLine();
    w.setIndentationLevel(w.getIndentationLevel() + 1);
    for (const expr of hostiles) w.writeLine(`${q(expr)},`);
    w.setIndentationLevel(w.getIndentationLevel() - 1);
    w.writeLine("]);");
    w.writeLine("const wronglyAccepted = HOSTILE_INPUTS");
    w.setIndentationLevel(w.getIndentationLevel() + 1);
    w.writeLine(".filter(([label]) => applicable.has(label))");
    w.write(".filter(([, raw]) => ").inlineBlock(() => {
      w.writeLine(`const result = ${name}.parse(raw);`);
      w.writeLine("return result !== undefined && result !== null;");
    });
    w.write(")").newLine();
    w.writeLine(".map(([label]) => label);");
    w.setIndentationLevel(w.getIndentationLevel() - 1);
    w.writeLine("expect(wronglyAccepted).toEqual([]);");
  });
  w.write(");").newLine();

  const first = vo.accepts[0];
  if (first === undefined) {
    w.blankLine();
    skipMarker(
      w,
      `${name}: the laws needing a valid example are SKIPPED — add a JSDoc \`@accepts <expression>\` tag to \`declare class ${name}\` in ${contractBase} (e.g. \`@accepts "USD"\`), and a second \`@accepts\` so equality can be checked to discriminate. Skipped rather than failed: this file runs in the red gate, which rejects any failure that is not a NotImplementedError.`,
      `${name} has no @accepts example in ${contractBase}`,
    );
    return;
  }

  const parseFirst = `${name}.parse(${first})`;
  const mustFirst = `mustParse(${parseFirst}, ${q(parseFirst)})`;

  // Law 2 — equal by value, not by reference.
  w.blankLine();
  w.write(`test("is equal by value, not by reference", () => `).inlineBlock(() => {
    w.writeLine(`const a = ${mustFirst};`);
    w.writeLine(`const b = ${mustFirst};`);
    w.writeLine("// Content equality is the law. Identity deliberately is NOT: interning");
    w.writeLine("// (returning a cached instance for the same input) is a legitimate");
    w.writeLine("// value-object implementation, and a law that fires on a correct design");
    w.writeLine("// gets switched off. The reference-based `equals` that distinct");
    w.writeLine("// identities would have caught is checked below instead, where it can");
    w.writeLine("// be checked without forbidding interning.");
    w.writeLine("expect(a).toStrictEqual(b);");
  });
  w.write(");").newLine();

  // Law 3 — deterministic.
  w.blankLine();
  w.write(`test("parses deterministically", () => `).inlineBlock(() => {
    w.writeLine(`expect(${mustFirst}).toStrictEqual(${mustFirst});`);
  });
  w.write(");").newLine();

  // Law 3b — the wire round trip (TN-26-004). Only for value objects that
  // DECLARE a wire form: toJSON() is the opt-in, made when the value crosses
  // an API boundary. JSON.stringify exercises toJSON exactly as the transport
  // will, nesting included, and the parse door must accept what it emitted.
  if (vo.hasToJson) {
    w.blankLine();
    w.write(`test("round-trips through its wire form", () => `).inlineBlock(() => {
      w.writeLine(`const v = ${mustFirst};`);
      w.writeLine("const wire: unknown = JSON.parse(JSON.stringify(v));");
      w.writeLine(
        `const again = mustParse(${name}.parse(wire), ${q(`${name}.parse(<its own wire form>)`)});`,
      );
      w.writeLine("expect(again).toStrictEqual(v);");
    });
    w.write(");").newLine();
  }

  if (!vo.hasEquals) return;

  // Law 4 — equals.
  const second = vo.accepts[1];

  w.blankLine();
  w.write(`test("equals is reflexive", () => `).inlineBlock(() => {
    w.writeLine(`const a = ${mustFirst};`);
    w.writeLine("expect(a.equals(a)).toBe(true);");
  });
  w.write(");").newLine();

  w.blankLine();
  w.write(`test("equals is not reference-based", () => `).inlineBlock(() => {
    w.writeLine(`const a = ${mustFirst};`);
    w.writeLine(`const b = ${mustFirst};`);
    w.writeLine("// Two parses of the same input must be equal. If the implementation");
    w.writeLine("// interns, a and b ARE the same instance and `equals` by reference is");
    w.writeLine("// correct — so the discriminating case only exists when they differ.");
    w.writeLine("expect(a.equals(b)).toBe(true);");
    w.write("if (a !== b) ").inlineBlock(() => {
      w.writeLine("// Not interned: an `equals` that compares references would now be");
      w.writeLine("// wrong for every other pair, so prove it compares content.");
      w.writeLine("expect(Object.is(a, b)).toBe(false);");
      w.writeLine("expect(a.equals(b)).toBe(true);");
    });
    w.newLine();
  });
  w.write(");").newLine();

  w.blankLine();
  w.write(`test("equals is symmetric", () => `).inlineBlock(() => {
    w.writeLine(`const a = ${mustFirst};`);
    w.writeLine(`const b = ${mustFirst};`);
    w.writeLine("expect(a.equals(b)).toBe(b.equals(a));");
  });
  w.write(");").newLine();

  w.blankLine();
  if (second === undefined) {
    skipMarker(
      w,
      `${name}: "equals discriminates" is SKIPPED — it needs a SECOND, different valid input. Add a second \`@accepts\` tag to \`declare class ${name}\` in ${contractBase}. Skipped rather than failed: this file runs in the red gate, which rejects any failure that is not a NotImplementedError.`,
      `${name} has only one @accepts example, so equality cannot be shown to discriminate`,
    );
    return;
  }
  const parseSecond = `${name}.parse(${second})`;
  const mustSecond = `mustParse(${parseSecond}, ${q(parseSecond)})`;
  w.write(`test("equals discriminates two different valid inputs", () => `).inlineBlock(() => {
    w.writeLine(`const a = ${mustFirst};`);
    w.writeLine(`const other = ${mustSecond};`);
    w.writeLine("expect(a.equals(other)).toBe(false);");
    w.writeLine("expect(other.equals(a)).toBe(false);");
  });
  w.write(");").newLine();
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
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node value-object-laws.ts <path/to/foo.contract.ts>   (run from the project root)");
    process.exit(2);
  }
  const cwd = process.cwd();
  const contractPath = toPosix(relative(cwd, resolve(cwd, arg)));
  try {
    const source = readFileSync(resolve(cwd, arg), "utf8");
    const valueObjects = valueObjectsOf(source, contractPath);
    if (valueObjects.length === 0) {
      console.log(`value-object-laws: ${contractPath} declares no exported class — nothing to generate`);
      process.exit(0);
    }
    const text = valueObjectLawsSource(source, contractPath);
    const out = resolve(cwd, lawsPathFor(contractPath));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`value-object-laws: wrote ${lawsPathFor(contractPath)} (${valueObjects.length} value object(s))`);

    // The gaps a skip cannot shout about. Warn here, where the architect is
    // standing, rather than failing inside the red gate where the message
    // would be routed to the wrong role.
    for (const vo of valueObjects) {
      if (vo.unsupported !== undefined) {
        console.error(`value-object-laws: WARN — ${vo.unsupported}; its laws are skipped`);
      } else if (vo.accepts.length === 0) {
        console.error(
          `value-object-laws: WARN — '${vo.name}' has no '@accepts' example, so only the hostile-input law runs; add '@accepts "…"' to ${contractPath}`,
        );
      } else if (vo.hasEquals && vo.accepts.length < 2) {
        console.error(
          `value-object-laws: WARN — '${vo.name}' has one '@accepts' example, so 'equals discriminates' is skipped; add a second tag to ${contractPath}`,
        );
      }
    }
  } catch (e) {
    if (e instanceof ValueObjectLawsError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
