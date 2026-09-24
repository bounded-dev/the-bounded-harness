// test obligations (TN-26-001, TEST → BUILD boundary): did the suite discharge
// what it owes, or merely go red?
//
// The red gate proves the suite fails for the right REASON. It says nothing
// about COVERAGE of the contract, and dogfood Run 7 paid for the gap: 32 tests,
// a valid red, a clean green — and 9 of the contract's 15 value exports were
// never called by a single test. Every value-object parser was untested. Two
// gates passed a suite that had not looked at most of the component.
//
// This module is the measurement both gates were missing. It is PURE: string
// and AST in, typed violations out. It formats nothing and decides nothing
// about exit codes — the red gate owns the verdict, the routing and the wire
// format (`boundaryRemedyLines` / `unreachedRemedyLines` are optional message
// helpers, offered so the wording of an obligation lives next to its rule).
//
// --- CHECKER 1: export reachability ---------------------------------------------
//
// The measurement was already in the gate's hands and thrown away. The
// scaffolder emits `throw new NotImplementedError("<exportName>")` per value
// export and `"<Class>.<member>"` per class member, and the shared errors module
// renders that as `NotImplemented: <name>` — so a red-phase failure message
// reads:
//
//     NotImplementedError: NotImplemented: Currency.parse
//
// The sanitizer keeps the error-name line (it drops stacks, code frames and
// paths), so the name survives all the way to the gate. The red gate's own
// regex matches `NotImplementedError` and discards everything after it. Read
// the name instead and the red phase tells you, for free and with no coverage
// tooling, exactly which exports the suite actually touched: a NotImplemented
// failure IS a call that reached the skeleton. Diff that against the contract's
// declared value exports and the unreached ones are, by construction, exports
// no test calls.
//
// This is exact in one direction and only that one: a name that appears was
// definitely called. An export can also be reached by a test that passes for
// another reason, so the check is deliberately run at RED, where nothing is
// implemented and the only way to touch an export is to throw from it.
//
// --- CHECKER 2: value-object boundaries -----------------------------------------
//
// In this contract style an exported `declare class` with a `static parse` IS a
// value object, and its parse function is the component's only door in from raw
// input. The generated law suite (`tests/generated/**`) covers what is true of
// EVERY value object — parse refuses `null`, `[]`, `42`, `""`, a `Date`. It
// cannot cover the thing that matters: an input of the RIGHT base type and the
// wrong value. `"usd"` is a string; only someone thinking about currencies knows
// it must fail.
//
// So the hand-written suite must contain, per value object, a
// `describe("<Name> — boundaries")` block (em dash, U+2014) with at least one
// accepted literal and at least TWO DISTINCT rejected literals OF THE VALUE
// OBJECT'S OWN BASE TYPE. Wrong-type rejections do not count: the generated
// laws already own them, so re-asserting them here buys nothing.
//
// TWO IS A FLOOR, NOT A TARGET. Two forces a second axis — wrong case AND wrong
// length — where one invites a token gesture. A rule with more axes than the
// block has rejections is under-tested and no gate can see it.
//
// BE HONEST ABOUT WHAT THIS CHECK IS. It eliminates OMISSION, which is the
// failure actually observed: nine parsers, zero assertions, no intent involved.
// It does not eliminate EVASION — two lazy rejections satisfy it, and a
// test-writer who wants to do the minimum can. It is a forcing function for
// attention, not a coverage guarantee and not a proof of thought. The thing
// that makes the block good is the doc comment stating the validity rule, which
// no gate can check.
//
// Known limits, deliberately permissive (a false block costs a whole loop
// iteration; a miss costs one under-tested value object):
//   - literals must be written at the call site or bound to a `const` in scope
//     (lexically resolved, so same-named locals in two tests are two
//     rejections); `it.each([...])` tables are not read.
//   - the base type is inferred from the contract (a `parse<Name>` signature,
//     then the class's SOLE public primitive property). A composite value
//     object infers `unknown`, and then any literal counts as base-typed.
//   - `tests/generated/**` is excluded at collection: machine-generated laws
//     must never discharge a human obligation.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { findContractFiles } from "./checksum-gate.ts";
import { contractSurface } from "./scaffold-contract.ts";
import type { ClassDeclaration, SourceFile } from "ts-morph";

/** One source file's text, addressed by project-relative posix path. */
export interface SourceText {
  readonly file: string;
  readonly source: string;
}

// =================================================================================
// Checker 1 — export reachability
// =================================================================================

// The error-name line, in either of the two forms it can arrive in:
// `NotImplementedError: NotImplemented: <name>` (what the shared errors module
// produces, since its message is itself prefixed) or a bare
// `NotImplemented: <name>`. Anchored to a line start so a mention inside prose
// cannot fabricate a reached export.
const ERROR_LINE = /(?:^|\n)[ \t]*NotImplement(?:edError|ed)[ \t]*:[ \t]*([^\n]*)/;
const REDUNDANT_PREFIX = /^NotImplement(?:edError|ed)[ \t]*:[ \t]*/;
// An export name or a `Class.member` label — `#` because a hash-private field's
// label keeps its sigil.
const EXPORT_NAME = /^[A-Za-z_$#][A-Za-z0-9_$]*(?:\.[A-Za-z_$#][A-Za-z0-9_$]*)*$/;

export interface DeclaredExport {
  readonly name: string;
  readonly contractFile: string;
}

export interface UnreachedExport {
  readonly name: string;
  readonly contractFile: string;
}

/**
 * The export (or `Class.member`) a red-phase failure message reached, if it
 * names one. Returns undefined for any other failure — including a
 * NotImplemented failure whose message was mangled past recognition, because a
 * guess here would silently mark an untested export as covered.
 */
export function reachedName(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const match = ERROR_LINE.exec(message);
  if (match === null) return undefined;
  const name = match[1].replace(REDUNDANT_PREFIX, "").trim();
  if (name === "" || !EXPORT_NAME.test(name)) return undefined;
  // `NotImplementedError` on its own line names the class, not an export.
  if (name === "NotImplemented" || name === "NotImplementedError") return undefined;
  return name;
}

/**
 * Every export name CALLED anywhere in the given test sources, by AST walk.
 *
 * This — not red-phase failure names — is the primary reachability evidence.
 * Run 9 jammed on the difference: `getInvoices(state)` takes a state only
 * `applySubscriptionOperation` can produce, so in the red phase every test
 * that uses both dies at the first skeleton call and `getInvoices` can NEVER
 * appear in a failure message. The test-writer had three tests calling it and
 * the gate demanded a fourth kind of proof that was impossible by
 * construction. A call site is the honest question ("does any test exercise
 * this export?") and it still catches Run 7's real failure — nine parsers
 * with ZERO call sites anywhere.
 *
 * Both direct calls (`getInvoices(x)`) and member calls (`Currency.parse(x)`)
 * count, as does rendering a component with JSX (`<ContactCard />`) or passing
 * the export as a value (`expect(fn).toThrow` style callbacks). Generated law
 * suites count too: reachability asks whether the
 * export is exercised at all; the boundaries obligation separately demands
 * hand-written attention where it matters.
 */
export function calledNames(tests: readonly SourceText[]): Set<string> {
  const called = new Set<string>();
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  for (const { file, source } of tests) {
    const extension = file.endsWith(".tsx") ? "tsx" : "ts";
    const sf = project.createSourceFile(`called-${file.replace(/\W+/g, "_")}.${extension}`, source, {
      overwrite: true,
    });
    sf.forEachDescendant((node) => {
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
        const tag = node.getTagNameNode();
        // Lowercase intrinsic elements are not component exports.
        if (Node.isIdentifier(tag) && /^[A-Z]/.test(tag.getText())) called.add(tag.getText());
      } else if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
        const callee = node.getExpression();
        if (Node.isIdentifier(callee)) {
          called.add(callee.getText());
        } else if (Node.isPropertyAccessExpression(callee)) {
          const base = callee.getExpression();
          if (Node.isIdentifier(base)) {
            called.add(base.getText());
            called.add(`${base.getText()}.${callee.getName()}`);
          }
        }
      } else if (Node.isIdentifier(node)) {
        // An export passed as a VALUE (a callback, an expect() subject) is
        // exercised by whatever receives it; require only that the identifier
        // appears as a call argument, not merely in an import statement.
        const parent = node.getParent();
        if (parent !== undefined && (Node.isCallExpression(parent) || Node.isNewExpression(parent))) {
          const args: readonly unknown[] = parent.getArguments();
          if ((args as readonly Node[]).includes(node)) called.add(node.getText());
        }
      }
    });
  }
  return called;
}

/** Every distinct name reached across a run's failure messages, sorted. */
export function reachedNames(messages: Iterable<string | undefined>): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    const name = reachedName(message);
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/** Every value export the given contracts declare, in declaration order. */
export function declaredExports(contracts: readonly SourceText[]): DeclaredExport[] {
  const out: DeclaredExport[] = [];
  for (const { file, source } of contracts) {
    for (const name of contractSurface(source, file).valueExports) {
      out.push({ name, contractFile: file });
    }
  }
  return out;
}

/**
 * The declared exports no failure message named — i.e. exports no test calls.
 *
 * A member throw reaches its owning export: `Currency.parse` discharges
 * `Currency`. Reached names the contracts do not declare are ignored rather
 * than reported; they belong to another contract, or to a helper.
 */
export function unreachedExports(
  declared: readonly DeclaredExport[],
  reached: Iterable<string>,
): UnreachedExport[] {
  const owners = new Set<string>();
  for (const name of reached) {
    owners.add(name);
    const dot = name.indexOf(".");
    if (dot > 0) owners.add(name.slice(0, dot));
  }
  return declared
    .filter((d) => !owners.has(d.name))
    .map((d) => ({ name: d.name, contractFile: d.contractFile }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Optional message helper: what the test-writer must add, in the pack's voice. */
export function unreachedRemedyLines(unreached: readonly UnreachedExport[]): string[] {
  return [
    `${unreached.length} contract export${unreached.length === 1 ? " is" : "s are"} never called by any test:`,
    ...unreached.map((u) => `  unreached: ${u.name}  (declared in ${u.contractFile})`),
    "  A red phase proves the suite fails for the right reason; it does not prove the suite",
    "  LOOKED at the component. An export no test calls is an export nobody specified.",
    "  Write at least one test per name above that calls it and asserts on its result:",
    ...unreached.slice(0, 3).map((u) => `    expect(${u.name}(/* … */)).toEqual(/* … */);`),
  ];
}

// =================================================================================
// Checker 2 — value-object boundaries
// =================================================================================

/** U+2014. Spelled out because the whole check turns on it not being a hyphen. */
export const BOUNDARY_DASH = "—";

/** The floor, not the target — see the header. */
export const MIN_REJECTIONS = 2;

/** The exact describe name a value object's boundaries block must carry. */
export function boundaryDescribeName(className: string): string {
  return `${className} ${BOUNDARY_DASH} boundaries`;
}

export type ValueObjectBase = "string" | "number" | "unknown";

export interface ValueObjectClass {
  readonly name: string;
  readonly contractFile: string;
  /** Base type of the literals its rejections must use; "unknown" accepts any. */
  readonly base: ValueObjectBase;
  /** No `static parse` ⇒ no door in ⇒ no boundary to test. */
  readonly hasStaticParse: boolean;
}

export type BoundaryViolationKind =
  | "missing-block"
  | "misnamed-block"
  | "skipped-block"
  | "no-accepted-parse"
  | "too-few-rejections";

export interface BoundaryViolation {
  readonly className: string;
  readonly contractFile: string;
  readonly kind: BoundaryViolationKind;
  readonly base: ValueObjectBase;
  /** The describe name the block must have, verbatim. */
  readonly expected: string;
  /** Near-miss or skipped describe names found for this class, if any. */
  readonly found: readonly string[];
  /** Files containing a matching block. */
  readonly testFiles: readonly string[];
  /** Accepted-literal assertions found in the block. */
  readonly accepted: number;
  /** Distinct base-typed rejected literals, as written. */
  readonly rejections: readonly string[];
  /** Rejected inputs that do not count: wrong base type, or not a literal. */
  readonly wrongTypeRejections: readonly string[];
}

// --- contract side: what is a value object, and what is its base type? ------------

function isPublicInstanceProperty(node: Node): boolean {
  if (!Node.isPropertyDeclaration(node)) return false;
  if (node.hasModifier(SyntaxKind.StaticKeyword)) return false;
  if (node.hasModifier(SyntaxKind.PrivateKeyword) || node.hasModifier(SyntaxKind.ProtectedKeyword)) return false;
  const nameNode = node.getNameNode();
  return !Node.isPrivateIdentifier(nameNode);
}

function primitiveOf(typeText: string | undefined): ValueObjectBase | undefined {
  return typeText === "string" || typeText === "number" ? typeText : undefined;
}

/**
 * Infer the base type whose literals a rejection must use.
 *
 * Order of evidence, strongest first: an explicit `static parse(raw: string)`,
 * then a sibling `parse<Name>(raw: string)` (the parse boundary the value-object
 * rule carves out), then the class's SOLE public property. More than one public
 * property means a composite, and a composite's parse takes an object — so the
 * honest answer is "unknown", which makes the check permissive rather than
 * wrong.
 */
function baseTypeOf(cls: ClassDeclaration, sf: SourceFile): ValueObjectBase {
  const staticParse = cls
    .getMembers()
    .find((m) => Node.isMethodDeclaration(m) && m.hasModifier(SyntaxKind.StaticKeyword) && m.getName() === "parse");
  if (staticParse !== undefined && Node.isMethodDeclaration(staticParse)) {
    const fromParse = primitiveOf(staticParse.getParameters()[0]?.getTypeNode()?.getText());
    if (fromParse !== undefined) return fromParse;
  }

  const parserName = `parse${cls.getName() ?? ""}`;
  for (const stmt of sf.getStatements()) {
    if (!Node.isFunctionDeclaration(stmt) || stmt.getName() !== parserName) continue;
    const fromParser = primitiveOf(stmt.getParameters()[0]?.getTypeNode()?.getText());
    if (fromParser !== undefined) return fromParser;
  }

  const properties = cls.getMembers().filter(isPublicInstanceProperty);
  if (properties.length === 1 && Node.isPropertyDeclaration(properties[0])) {
    return primitiveOf(properties[0].getTypeNode()?.getText()) ?? "unknown";
  }
  return "unknown";
}

/**
 * Every exported class in the given contracts. In this contract style an
 * exported class IS a value object; `hasStaticParse` records whether it has the
 * door the boundaries check measures.
 */
export function valueObjectClasses(contracts: readonly SourceText[]): ValueObjectClass[] {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const out: ValueObjectClass[] = [];
  for (const { file, source } of contracts) {
    const sf = project.createSourceFile(`contract-${out.length}-${file.replace(/\W+/g, "_")}.ts`, source, {
      overwrite: true,
    });
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (name === undefined || !cls.hasModifier(SyntaxKind.ExportKeyword)) continue;
      const hasStaticParse = cls
        .getMembers()
        .some((m) => Node.isMethodDeclaration(m) && m.hasModifier(SyntaxKind.StaticKeyword) && m.getName() === "parse");
      out.push({ name, contractFile: file, base: baseTypeOf(cls, sf), hasStaticParse });
    }
  }
  return out;
}

// --- test side: reading a boundaries block ----------------------------------------

/** A literal written at a parse call site. `key` is undefined when the argument
 *  is not a literal at all (an identifier, a call, a computed expression). */
interface LiteralArg {
  readonly kind: "string" | "number" | "other";
  readonly text: string;
  readonly key: string | undefined;
}

const NOT_A_LITERAL: LiteralArg = { kind: "other", text: "", key: undefined };

/** How far a `const` chain is followed before giving up (also breaks cycles). */
const MAX_BINDING_DEPTH = 4;

/**
 * The initializer of the nearest lexical `const`/`let` binding of an identifier.
 *
 * Resolved by walking enclosing blocks rather than by a file-level map, so two
 * `test()` bodies that each bind `const bad = Currency.parse(…)` are two
 * distinct rejections and not one.
 */
function initializerOf(identifier: Node): Node | undefined {
  const name = identifier.getText();
  let node: Node | undefined = identifier;
  while (node !== undefined) {
    const parent: Node | undefined = node.getParent();
    if (parent !== undefined && (Node.isBlock(parent) || Node.isSourceFile(parent))) {
      for (const stmt of parent.getStatements()) {
        if (!Node.isVariableStatement(stmt)) continue;
        for (const decl of stmt.getDeclarationList().getDeclarations()) {
          const declName = decl.getNameNode();
          if (Node.isIdentifier(declName) && declName.getText() === name) return decl.getInitializer();
        }
      }
    }
    node = parent;
  }
  return undefined;
}

function literalArg(node: Node | undefined, depth = 0): LiteralArg {
  if (node === undefined) return NOT_A_LITERAL;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "string", text: node.getText(), key: `s:${node.getLiteralValue()}` };
  }
  if (Node.isNumericLiteral(node)) {
    return { kind: "number", text: node.getText(), key: `n:${node.getLiteralValue()}` };
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    if (Node.isNumericLiteral(operand)) {
      const sign = node.getOperatorToken() === SyntaxKind.MinusToken ? -1 : 1;
      return { kind: "number", text: node.getText(), key: `n:${sign * operand.getLiteralValue()}` };
    }
  }
  if (Node.isIdentifier(node)) {
    if (depth >= MAX_BINDING_DEPTH) return { kind: "other", text: node.getText(), key: undefined };
    const bound = initializerOf(node);
    if (bound !== undefined) return literalArg(bound, depth + 1);
    return { kind: "other", text: node.getText(), key: undefined };
  }
  // Object/array literals: not base-typed, but they ARE literals, so a composite
  // value object's acceptance case can still be recognised.
  if (Node.isObjectLiteralExpression(node) || Node.isArrayLiteralExpression(node)) {
    return { kind: "other", text: node.getText(), key: `o:${node.getText()}` };
  }
  return { kind: "other", text: node.getText(), key: undefined };
}

/** A `<Class>.parse(<arg>)` call under an `expect(…)`. */
interface ParseCall {
  readonly className: string;
  readonly arg: LiteralArg;
}

function parseCallOf(node: Node | undefined, depth = 0): ParseCall | undefined {
  if (node === undefined) return undefined;
  if (Node.isIdentifier(node)) {
    if (depth >= MAX_BINDING_DEPTH) return undefined;
    return parseCallOf(initializerOf(node), depth + 1);
  }
  if (Node.isAwaitExpression(node)) return parseCallOf(node.getExpression(), depth + 1);
  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "parse") return undefined;
  const receiver = callee.getExpression();
  if (!Node.isIdentifier(receiver)) return undefined;
  return { className: receiver.getText(), arg: literalArg(node.getArguments()[0]) };
}

interface Matcher {
  readonly name: string;
  readonly negated: boolean;
  readonly argTexts: readonly string[];
}

/** Walk `expect(x)` → `.not` → `.toBeUndefined()` and report what was asserted. */
function matcherOf(expectCall: Node): Matcher | undefined {
  let node: Node = expectCall;
  let parent = node.getParent();
  let negated = false;
  while (parent !== undefined && Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
    const name = parent.getName();
    const grandparent = parent.getParent();
    if (name === "not") {
      negated = !negated;
    } else if (name !== "resolves" && name !== "rejects") {
      const argTexts =
        grandparent !== undefined && Node.isCallExpression(grandparent) && grandparent.getExpression() === parent
          ? grandparent.getArguments().map((a) => a.getText())
          : [];
      return { name, negated, argTexts };
    }
    node = parent;
    parent = grandparent;
  }
  return undefined;
}

function isAcceptance(m: Matcher): boolean {
  if (m.negated) return m.name === "toBeUndefined" || m.name === "toBeNull";
  return m.name === "toBeDefined" || m.name === "toBeInstanceOf";
}

function isRejection(m: Matcher): boolean {
  if (m.negated) return false;
  if (m.name === "toBeUndefined") return true;
  return (
    (m.name === "toBe" || m.name === "toEqual" || m.name === "toStrictEqual") && m.argTexts[0] === "undefined"
  );
}

/** Evidence accumulated for one value object across every matching block. */
interface Evidence {
  readonly files: Set<string>;
  readonly found: string[];
  exact: boolean;
  skippedExact: boolean;
  accepted: number;
  readonly rejections: Map<string, string>;
  readonly wrongType: string[];
}

function emptyEvidence(): Evidence {
  return {
    files: new Set(),
    found: [],
    exact: false,
    skippedExact: false,
    accepted: 0,
    rejections: new Map(),
    wrongType: [],
  };
}

/** Case, spacing and dash-flavour insensitive — the shape of a near miss. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[-‐-―−]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .trim();
}

interface DescribeBlock {
  readonly title: string;
  readonly body: Node | undefined;
  readonly skipped: boolean;
}

function describeBlocks(sf: SourceFile): DescribeBlock[] {
  const blocks: DescribeBlock[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    let skipped = false;
    let isDescribe = false;
    if (Node.isIdentifier(callee)) {
      isDescribe = callee.getText() === "describe";
    } else if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression())) {
      if (callee.getExpression().getText() === "describe") {
        const modifier = callee.getName();
        isDescribe = ["only", "skip", "todo", "concurrent", "sequential"].includes(modifier);
        skipped = modifier === "skip" || modifier === "todo";
      }
    }
    if (!isDescribe) continue;
    const [titleNode, bodyNode] = call.getArguments();
    if (titleNode === undefined) continue;
    if (!Node.isStringLiteral(titleNode) && !Node.isNoSubstitutionTemplateLiteral(titleNode)) continue;
    const body =
      bodyNode !== undefined && (Node.isArrowFunction(bodyNode) || Node.isFunctionExpression(bodyNode))
        ? bodyNode.getBody()
        : undefined;
    blocks.push({ title: titleNode.getLiteralValue(), body, skipped });
  }
  return blocks;
}

/** Read every `expect(<Class>.parse(<literal>))` assertion inside one block. */
function readBlock(body: Node, className: string, base: ValueObjectBase, evidence: Evidence): void {
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== "expect") continue;
    const subject = parseCallOf(call.getArguments()[0]);
    if (subject === undefined || subject.className !== className) continue;
    const matcher = matcherOf(call);
    if (matcher === undefined) continue;

    if (isAcceptance(matcher)) {
      // Any literal will do here: a value that parses is base-typed by
      // definition, and a composite's accepted input is an object literal.
      if (subject.arg.key !== undefined) evidence.accepted += 1;
      continue;
    }
    if (!isRejection(matcher)) continue;
    const { key, kind, text } = subject.arg;
    // Wrong-type rejections are already owned by the generated law suite, so
    // they buy nothing here and must not count towards the floor.
    if (key !== undefined && (base === "unknown" || kind === base)) evidence.rejections.set(key, text);
    else if (text !== "") evidence.wrongType.push(text);
  }
}

/**
 * Check each value object's boundaries obligation against the hand-written
 * suite. `tests` must already exclude `tests/generated/**` — see
 * {@link readHandWrittenTests}.
 */
export function checkBoundaryBlocks(
  valueObjects: readonly ValueObjectClass[],
  tests: readonly SourceText[],
): BoundaryViolation[] {
  const wanted = valueObjects.filter((vo) => vo.hasStaticParse);
  if (wanted.length === 0) return [];

  const evidence = new Map<string, Evidence>();
  for (const vo of wanted) evidence.set(vo.name, emptyEvidence());

  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  for (const { file, source } of tests) {
    const sf = project.createSourceFile(`test-${file.replace(/\W+/g, "_")}.ts`, source, { overwrite: true });
    for (const block of describeBlocks(sf)) {
      const normalized = normalizeTitle(block.title);
      for (const vo of wanted) {
        const expected = boundaryDescribeName(vo.name);
        const found = evidence.get(vo.name)!;
        if (block.title === expected) {
          found.files.add(file);
          if (block.skipped) {
            found.skippedExact = true;
            found.found.push(block.title);
            continue;
          }
          found.exact = true;
          if (block.body !== undefined) readBlock(block.body, vo.name, vo.base, found);
        } else if (normalized === normalizeTitle(expected)) {
          found.found.push(block.title);
          found.files.add(file);
        }
      }
    }
  }

  const violations: BoundaryViolation[] = [];
  for (const vo of wanted) {
    const found = evidence.get(vo.name)!;
    const common = {
      className: vo.name,
      contractFile: vo.contractFile,
      base: vo.base,
      expected: boundaryDescribeName(vo.name),
      found: [...new Set(found.found)],
      testFiles: [...found.files],
      accepted: found.accepted,
      rejections: [...found.rejections.values()],
      wrongTypeRejections: [...found.wrongType],
    } as const;

    if (!found.exact) {
      const kind: BoundaryViolationKind = found.skippedExact
        ? "skipped-block"
        : common.found.length > 0
          ? "misnamed-block"
          : "missing-block";
      violations.push({ ...common, kind });
      continue;
    }
    if (found.accepted === 0) violations.push({ ...common, kind: "no-accepted-parse" });
    if (found.rejections.size < MIN_REJECTIONS) violations.push({ ...common, kind: "too-few-rejections" });
  }
  return violations;
}

/** Optional message helper: names the sin, then the exact block to write. */
export function boundaryRemedyLines(violation: BoundaryViolation): string[] {
  const { className, expected, base } = violation;
  const good = base === "number" ? "1" : `"OK"`;
  const bad = base === "number" ? ["-1", "1.5"] : [`"ok"`, `"OKAY"`];
  const sin: Record<BoundaryViolationKind, string> = {
    "missing-block": `${className} has no boundaries block: nothing in the suite says which values it accepts.`,
    "misnamed-block": `${className}'s boundaries block is misnamed (${violation.found.join(", ")}) — the separator is an em dash, U+2014, not a hyphen or an en dash.`,
    "skipped-block": `${className}'s boundaries block is skipped: a skipped obligation is an undischarged one.`,
    "no-accepted-parse": `${className}'s boundaries block never asserts that a VALID literal parses — it only says what fails.`,
    "too-few-rejections": `${className}'s boundaries block has ${violation.rejections.length} distinct ${base === "unknown" ? "" : base + " "}rejection${violation.rejections.length === 1 ? "" : "s"}, and needs ${MIN_REJECTIONS}.`,
  };
  const lines = [
    sin[violation.kind],
    `  Write this block in a hand-written test file (tests/generated/** cannot discharge it):`,
    `    describe("${expected}", () => {`,
    `      test("accepts a valid ${className.toLowerCase()}", () => {`,
    `        expect(${className}.parse(${good})).toBeDefined();`,
    `      });`,
    ...bad.map(
      (literal) =>
        `      test(${JSON.stringify(`rejects ${literal}`)}, () => { expect(${className}.parse(${literal})).toBeUndefined(); });`,
    ),
    `    });`,
    `  TWO rejections is the floor, not a target: write one per axis the validity rule has`,
    `  (case, length, character class → three), and pick literals of the value object's own`,
    `  base type. null / 42 / [] are already covered by tests/generated/** — they do not count.`,
  ];
  if (violation.wrongTypeRejections.length > 0) {
    lines.push(
      `  Not counted (wrong-type inputs the generated laws already own): ${violation.wrongTypeRejections.join(", ")}`,
    );
  }
  return lines;
}

// =================================================================================
// IO — the thin wrapper that collects the files the pure checkers consume
// =================================================================================

const IGNORE_DIRS = new Set(["node_modules", ".git", ".bounded", "dist", "build", "coverage"]);
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
/** Machine-generated laws must not satisfy a human obligation. */
const GENERATED_TESTS = /(?:^|\/)tests\/generated\//;

function relPosix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Every *.contract.ts under root, as {@link SourceText}. */
export function readContracts(root: string): SourceText[] {
  return findContractFiles(root).map((path) => ({
    file: relPosix(root, path),
    source: readFileSync(path, "utf8"),
  }));
}

/** Every test file under root, generated laws included — reachability asks
 *  whether an export is exercised AT ALL; only the boundaries obligation
 *  insists on hand-written attention. */
export function readAllTests(root: string): SourceText[] {
  const out: SourceText[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        out.push({ file: relPosix(root, path), source: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

/** Every hand-written test file under root — `tests/generated/**` excluded. */
export function readHandWrittenTests(root: string): SourceText[] {
  const out: SourceText[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        const file = relPosix(root, path);
        if (!GENERATED_TESTS.test(file)) out.push({ file, source: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}
