// Scaffolder (TN-26-001): contract → throwing skeleton.
//
//   src/orders/orders.contract.ts  →  src/orders/orders.ts   (fixed naming rule)
//
// Pure core (scaffoldContract: string → string) + thin CLI. Skeletons are
// machine-generated, never agent-written: nothing to police, and the red
// gate gets a guaranteed NotImplementedError failure reason. Contracts that
// can't be scaffolded fail loudly with ScaffoldError — the architect fixes
// the contract, never the skeleton.
//
// Built on ts-morph (AST in, CodeBlockWriter out): signature *text* is
// echoed verbatim from the contract — no `as` casts, no `any` — so
// skeleton/contract drift is a compile error, not an assertion. Overloads
// keep their declared signatures plus an unknown-typed implementation
// signature. NotImplementedError lives in the project's shared errors
// module (template convention: <root>/shared/errors.ts) so its identity is
// stable across components and gates.
//
// v1 known limits (fail loudly, by design): enums (use string-literal
// unions — the declaration-only lint rule agrees), value exports inside
// namespaces, default-exported values, `export =`, computed member names,
// overloaded class methods/constructors.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { CodeBlockWriter, Node, Project, SyntaxKind } from "ts-morph";
import type {
  ClassDeclaration,
  ClassMemberTypes,
  FunctionDeclaration,
  GetAccessorDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  SetAccessorDeclaration,
  SourceFile,
  VariableStatement,
} from "ts-morph";

type NamedClassMember =
  | MethodDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration
  | PropertyDeclaration;

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

const CONTRACT_SUFFIX = ".contract.ts";

/** Canonical content of the template's shared errors module — single source
 *  of truth for the CLI (auto-create), the bootstrapper, and tests. */
export const ERRORS_MODULE_SOURCE = `export class NotImplementedError extends Error {
  constructor(what: string) {
    super(\`NotImplemented: \${what}\`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
`;

/** The fixed naming rule: foo.contract.ts is implemented by sibling foo.ts. */
export function skeletonPathFor(contractPath: string): string {
  if (!contractPath.endsWith(CONTRACT_SUFFIX)) {
    throw new ScaffoldError(`scaffold: '${contractPath}' is not a *.contract.ts path`);
  }
  return contractPath.slice(0, -CONTRACT_SUFFIX.length) + ".ts";
}

/** Template convention: the shared errors module lives at <root>/shared/errors,
 *  where root is the path up to and including the first 'src' segment. */
export function errorsModuleFor(contractPath: string): string {
  const segs = contractPath.replace(/\\/g, "/").split("/");
  const i = segs.indexOf("src");
  return (i >= 0 ? segs.slice(0, i + 1).join("/") + "/" : "") + "shared/errors";
}

function relativeSpecifier(fromFile: string, toModuleNoExt: string): string {
  const fromDir = posix.dirname(fromFile.replace(/\\/g, "/"));
  const rel = posix.relative(fromDir, toModuleNoExt + ".js");
  return rel.startsWith(".") ? rel : "./" + rel;
}

function fail(message: string): never {
  throw new ScaffoldError(`scaffold: ${message}`);
}

// --- AST collection -----------------------------------------------------------

type ValueExport =
  | { kind: "function"; name: string; signatures: string[] } // verbatim "function name(…): T" texts
  | { kind: "const"; name: string; typeText: string }
  | { kind: "class"; name: string; head: string; members: ClassMemberOut[]; nominal: boolean };

/** 'line' members (declare fields, index signatures) join adjacent lines
 *  without a blank line; 'throwing' members get paragraph spacing. */
type ClassMemberOut =
  | { kind: "throwing"; sig: string; label: string; compact: false }
  | { kind: "line"; text: string; compact: boolean };

interface ContractInfo {
  values: ValueExport[];
  exportedTypes: string[]; // exported interface / type-alias names
  localTypes: string[]; // declared but not exported
  imports: { source: string; names: string[]; verbatim: string }[]; // type-only imports, source order
}

const RESERVED = new Set(["NotImplementedError", "notImplemented", "__Contract", "__conformance"]);

function isExportDecl(node: Node): boolean {
  return Node.isModifierable(node) && node.hasModifier(SyntaxKind.ExportKeyword);
}

/** Namespaces may hold types only; value members are unscaffoldable in v1. */
function namespaceHasValue(decl: Node & import("ts-morph").ModuleDeclaration): boolean {
  const body = decl.getBody();
  if (!body || !Node.isModuleBlock(body)) return false;
  return body.getStatements().some(
    (s) =>
      Node.isFunctionDeclaration(s) ||
      Node.isVariableStatement(s) ||
      Node.isClassDeclaration(s) ||
      Node.isEnumDeclaration(s) ||
      (Node.isModuleDeclaration(s) && namespaceHasValue(s)),
  );
}

/** Rebuild a function's signature text from parts (normalizes, never includes modifiers). */
function functionSignature(fn: FunctionDeclaration): string {
  const typeParams = fn.getTypeParameters();
  const tp = typeParams.length > 0 ? `<${typeParams.map((t) => t.getText()).join(", ")}>` : "";
  const params = fn.getParameters().map((p) => p.getText()).join(", ");
  const ret = fn.getReturnTypeNode()?.getText();
  return `function ${fn.getName() ?? ""}${tp}(${params})${ret ? `: ${ret}` : ""}`;
}

function memberNameText(member: NamedClassMember): string {
  const name = member.getNameNode();
  if (name === undefined) fail("anonymous class member in contract");
  if (Node.isIdentifier(name) || Node.isPrivateIdentifier(name)) return name.getText();
  if (Node.isStringLiteral(name)) return name.getLiteralValue();
  fail(`computed member name '${name.getText()}' is not scaffoldable`);
}

function renderClass(node: ClassDeclaration): ValueExport & { kind: "class" } {
  const name = node.getName()!;
  const ctors = node.getMembers().filter(Node.isConstructorDeclaration);
  if (ctors.length > 1) {
    fail(`overloaded constructor in '${name}' is not scaffoldable in v1 — use a single signature or a static factory`);
  }
  const methodCounts = new Map<string, number>();
  for (const m of node.getMembers()) {
    if (Node.isMethodDeclaration(m) && Node.isIdentifier(m.getNameNode())) {
      methodCounts.set(m.getName(), (methodCounts.get(m.getName()) ?? 0) + 1);
    }
  }
  for (const [n, c] of methodCounts) {
    if (c > 1) {
      fail(`overloaded method '${name}.${n}' is not scaffoldable in v1 — use distinct names or a discriminated input`);
    }
  }

  const typeParams = node.getTypeParameters();
  const tp = typeParams.length > 0 ? `<${typeParams.map((t) => t.getText()).join(", ")}>` : "";
  const heritage = node.getHeritageClauses();
  const head = `class ${name}${tp}${heritage.length > 0 ? " " + heritage.map((h) => h.getText()).join(" ") : ""}`;

  const members: ClassMemberOut[] = [];
  let nominal = false;

  for (const member of node.getMembers()) {
    const isPrivate =
      Node.isModifierable(member) &&
      (member.hasModifier(SyntaxKind.PrivateKeyword) || member.hasModifier(SyntaxKind.ProtectedKeyword));
    const isHashPrivate =
      "getNameNode" in member && member.getNameNode() !== undefined && Node.isPrivateIdentifier(member.getNameNode()!);
    if (isPrivate || isHashPrivate) nominal = true;

    if (Node.isConstructorDeclaration(member)) {
      const sig = member.getText().replace(/;\s*$/, "");
      members.push({ kind: "throwing", sig, label: `${name}.constructor`, compact: false });
      continue;
    }
    if (Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
      const sig = member.getText().replace(/;\s*$/, "");
      members.push({ kind: "throwing", sig, label: `${name}.${memberNameText(member)}`, compact: false });
      continue;
    }
    if (Node.isPropertyDeclaration(member)) {
      const memberName = memberNameText(member);
      const typeNode = member.getTypeNode()?.getText();
      const typeText = typeNode ? `: ${typeNode}` : "";
      const isStatic = member.hasModifier(SyntaxKind.StaticKeyword);
      if (isHashPrivate) {
        // 'declare' is not allowed on # fields; an initializer is unreachable
        // (the constructor throws first) and satisfies strictPropertyInitialization.
        members.push({
          kind: "line",
          text: `${member.getNameNode()!.getText()}${typeText} = notImplemented("${name}.${memberName}");`,
          compact: false,
        });
        continue;
      }
      if (isStatic && !isPrivate) {
        // Public static property: reads must throw → emit as a throwing getter.
        members.push({
          kind: "throwing",
          sig: `static get ${memberName}()${typeText}`,
          label: `${name}.${memberName}`,
          compact: false,
        });
        continue;
      }
      // Instance (or private static) property: re-emit as a declare field.
      const mods = member
        .getModifiers()
        .filter((m) => m.getKind() !== SyntaxKind.ReadonlyKeyword && m.getKind() !== SyntaxKind.DeclareKeyword)
        .map((m) => m.getText());
      const readonly = member.hasModifier(SyntaxKind.ReadonlyKeyword) ? ["readonly"] : [];
      const optional = member.hasQuestionToken() ? "?" : "";
      members.push({
        kind: "line",
        text: `${[...mods, "declare", ...readonly].join(" ")} ${memberName}${optional}${typeText};`,
        compact: true,
      });
      continue;
    }
    if (Node.isIndexSignatureDeclaration(member)) {
      members.push({ kind: "line", text: `${member.getText()};`, compact: true });
      continue;
    }
    if (Node.isClassStaticBlockDeclaration(member)) {
      fail(`static block in '${name}' is not scaffoldable`);
    }
    fail(`unsupported class member '${(member as ClassMemberTypes).getKindName()}' in '${name}'`);
  }

  return { kind: "class", name, head, members, nominal };
}

function collect(sf: SourceFile): ContractInfo {
  const info: ContractInfo = { values: [], exportedTypes: [], localTypes: [], imports: [] };

  for (const stmt of sf.getStatements()) {
    if (Node.isImportDeclaration(stmt)) {
      const source = stmt.getModuleSpecifierValue();
      const clause = stmt.getImportClause();
      if (!clause) fail(`side-effect import '${source}' in contract — contracts declare shapes only`);
      else {
        const named: string[] = [];
        let typeOnly = clause.isTypeOnly();
        const namedBindings = clause.getNamedBindings();
        if (namedBindings && Node.isNamedImports(namedBindings)) {
          for (const el of namedBindings.getElements()) {
            if (!clause.isTypeOnly() && !el.isTypeOnly()) typeOnly = false;
            named.push(el.getName());
          }
        } else if (namedBindings) {
          if (!clause.isTypeOnly()) typeOnly = false; // namespace import
          named.push(namedBindings.getName());
        }
        const def = clause.getDefaultImport();
        if (def) {
          if (!clause.isTypeOnly()) typeOnly = false;
          named.push(def.getText());
        }
        if (!typeOnly) {
          fail(`value import '${source}' in contract — use 'import type' (declaration-only lint should have caught this)`);
        }
        info.imports.push({ source, names: named, verbatim: stmt.getText() });
      }
      continue;
    }
    if (Node.isImportEqualsDeclaration(stmt)) {
      if (!stmt.isTypeOnly()) fail("value import in contract — use 'import type'");
      continue;
    }
    if (Node.isFunctionDeclaration(stmt)) {
      if (stmt.hasBody()) fail(`function body in contract ('${stmt.getName() ?? "<default>"}') — contracts are declaration-only`);
      if (stmt.hasModifier(SyntaxKind.DefaultKeyword) || stmt.getName() === undefined) {
        fail("default export of a value is not scaffoldable — use a named export");
      }
      if (!isExportDecl(stmt)) continue;
      const sig = functionSignature(stmt);
      const existing = info.values.find((v) => v.kind === "function" && v.name === stmt.getName());
      if (existing && existing.kind === "function") existing.signatures.push(sig);
      else info.values.push({ kind: "function", name: stmt.getName()!, signatures: [sig] });
      continue;
    }
    if (Node.isVariableStatement(stmt)) {
      if (!stmt.hasModifier(SyntaxKind.DeclareKeyword)) {
        fail("value binding in contract — contracts are declaration-only (use 'export declare const X: …')");
      }
      if (!isExportDecl(stmt)) continue;
      collectConst(stmt, info);
      continue;
    }
    if (Node.isClassDeclaration(stmt)) {
      if (!stmt.hasModifier(SyntaxKind.DeclareKeyword)) {
        fail(`class '${stmt.getName() ?? "<anonymous>"}' has a runtime body — contracts use 'declare class'`);
      }
      if (stmt.hasModifier(SyntaxKind.DefaultKeyword) || stmt.getName() === undefined) {
        fail("default export of a value is not scaffoldable — use a named export");
      }
      if (isExportDecl(stmt)) info.values.push(renderClass(stmt));
      continue;
    }
    if (Node.isEnumDeclaration(stmt)) {
      fail(`enum '${stmt.getName()}' is not scaffoldable — use a string-literal union type in the contract (TN-26-001)`);
    }
    if (Node.isModuleDeclaration(stmt)) {
      const isGlobal = stmt.getName() === "global";
      if (!isGlobal && namespaceHasValue(stmt)) {
        fail(`namespace '${stmt.getName()}' exports values — namespaces may hold types only; flatten values to top-level 'export declare'`);
      }
      continue;
    }
    if (Node.isInterfaceDeclaration(stmt) || Node.isTypeAliasDeclaration(stmt)) {
      (isExportDecl(stmt) ? info.exportedTypes : info.localTypes).push(stmt.getName());
      continue;
    }
    if (Node.isExportDeclaration(stmt)) {
      if (!stmt.isTypeOnly()) fail("value re-export in contract — use 'export type …'");
      continue;
    }
    if (Node.isExportAssignment(stmt)) fail("'export =' is CommonJS interop — use named exports");
    if (stmt.getKind() === SyntaxKind.EmptyStatement) continue;
    fail(`unsupported statement '${stmt.getKindName()}' in contract — contracts contain types and ambient declarations only`);
  }
  return info;
}

function collectConst(stmt: VariableStatement, info: ContractInfo): void {
  for (const d of stmt.getDeclarationList().getDeclarations()) {
    const nameNode = d.getNameNode();
    if (!Node.isIdentifier(nameNode)) {
      fail(`destructuring declare in contract ('${nameNode.getText()}') — declare one name per statement`);
    }
    const typeNode = d.getTypeNode();
    if (!typeNode) {
      fail(`declare const '${d.getName()}' needs an explicit type — inference has nothing to work with in a contract`);
    }
    info.values.push({ kind: "const", name: d.getName(), typeText: typeNode.getText() });
  }
}

// --- type-reference resolution (so verbatim signatures compile) ----------------

function leftmostName(node: Node): string {
  return Node.isQualifiedName(node) ? leftmostName(node.getLeft()) : node.getText();
}

function typeRefsOf(node: Node, exclude: Set<string>): Set<string> {
  const refs = new Set<string>();
  for (const ref of node.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    refs.add(leftmostName(ref.getTypeName() as Node));
  }
  for (const tq of node.getDescendantsOfKind(SyntaxKind.TypeQuery)) {
    refs.add(leftmostName(tq.getExprName()));
  }
  for (const e of exclude) refs.delete(e);
  for (const v of [...refs]) if (exclude.has(v)) refs.delete(v);
  return refs;
}

// --- rendering ------------------------------------------------------------------

export interface ScaffoldOptions {
  /** Project-relative path (no extension) of the shared errors module.
   *  Default: errorsModuleFor(contractFileName) → <root>/shared/errors. */
  readonly errorsModule?: string;
}

export function scaffoldContract(
  contractSource: string,
  contractFileName: string,
  options: ScaffoldOptions = {},
): string {
  const baseTs = basename(contractFileName);
  if (!baseTs.endsWith(CONTRACT_SUFFIX)) {
    throw new ScaffoldError(`scaffold: '${contractFileName}' is not a *.contract.ts path`);
  }
  const contractSpecifier = "./" + baseTs.replace(/\.ts$/, ".js");
  const errorsSpecifier = relativeSpecifier(
    contractFileName.replace(/\\/g, "/"),
    options.errorsModule ?? errorsModuleFor(contractFileName),
  );

  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile(baseTs, contractSource);
  const info = collect(sf);

  // Only value-exporting declarations are re-emitted, so only their type
  // references need resolving in the skeleton.
  const refs = new Set<string>();
  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt) && stmt.getName() && isExportDecl(stmt)) {
      for (const r of typeRefsOf(stmt, new Set(stmt.getTypeParameters().map((t) => t.getName())))) refs.add(r);
    } else if (Node.isVariableStatement(stmt) && isExportDecl(stmt)) {
      for (const r of typeRefsOf(stmt, new Set())) refs.add(r);
    } else if (Node.isClassDeclaration(stmt) && stmt.getName() && isExportDecl(stmt)) {
      const classTPs = new Set(stmt.getTypeParameters().map((t) => t.getName()));
      for (const h of stmt.getHeritageClauses()) for (const r of typeRefsOf(h, classTPs)) refs.add(r);
      for (const m of stmt.getMembers()) {
        const memberTPs =
          Node.isMethodDeclaration(m) || Node.isGetAccessorDeclaration(m) || Node.isSetAccessorDeclaration(m)
            ? m.getTypeParameters().map((t) => t.getName())
            : [];
        for (const r of typeRefsOf(m, new Set([...classTPs, ...memberTPs]))) refs.add(r);
      }
    }
  }

  for (const v of info.values) {
    if (RESERVED.has(v.name)) fail(`export '${v.name}' collides with scaffold internals — rename it in the contract`);
  }
  for (const t of info.exportedTypes) {
    if (RESERVED.has(t)) fail(`type '${t}' collides with scaffold internals — rename it in the contract`);
  }

  const unexported = [...refs].filter((r) => info.localTypes.includes(r));
  if (unexported.length > 0) {
    fail(`'${unexported[0]}' is part of the public surface but not exported — export it from the contract`);
  }

  const contractTypeImports = [...refs].filter((r) => info.exportedTypes.includes(r)).sort();
  const externalImports: string[] = [];
  for (const imp of info.imports) {
    const needed = imp.names.filter((n) => refs.has(n));
    if (needed.length === 0) continue;
    if (imp.verbatim.includes("*")) {
      externalImports.push(imp.verbatim); // namespace type import: re-emit whole
    } else {
      externalImports.push(`import type { ${[...needed].sort().join(", ")} } from "${imp.source}";`);
    }
  }

  const conformance = info.values.filter((v) => v.kind !== "class" || !v.nominal);
  const usesNotImplementedError = info.values.some((v) => v.kind !== "const");
  const usesNotImplemented = info.values.some(
    (v) =>
      v.kind === "const" ||
      (v.kind === "class" && v.members.some((m) => m.kind === "line" && m.text.includes("notImplemented("))),
  );

  // --- emit ---
  const w = new CodeBlockWriter({ newLine: "\n", indentNumberOfSpaces: 2, useSingleQuote: false, useTabs: false });

  w.writeLine(`// GENERATED from ${baseTs} by packs/ts/scripts/scaffold-contract.ts — do not edit.`);
  w.writeLine("// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.");
  w.writeLine("// The builder replaces this file with the real implementation.");
  w.blankLine();

  if (info.values.length > 0) {
    const errorNames = [
      usesNotImplementedError ? "NotImplementedError" : null,
      usesNotImplemented ? "notImplemented" : null,
    ].filter((n): n is string => n !== null);
    w.writeLine(`import { ${errorNames.join(", ")} } from "${errorsSpecifier}";`);
    for (const line of externalImports) w.writeLine(line);
    if (contractTypeImports.length > 0) {
      w.writeLine(`import type { ${contractTypeImports.join(", ")} } from "${contractSpecifier}";`);
    }
    if (conformance.length > 0) {
      w.writeLine(`import type * as __Contract from "${contractSpecifier}";`);
    }
    w.blankLine();
  }
  w.writeLine(`export type * from "${contractSpecifier}";`);

  for (const v of info.values) {
    w.blankLine();
    switch (v.kind) {
      case "function": {
        if (v.signatures.length === 1) {
          w.write(`export ${v.signatures[0]}`).block(() => {
            w.writeLine(`throw new NotImplementedError("${v.name}");`);
          });
        } else {
          for (const s of v.signatures) w.writeLine(`export ${s};`);
          w.write(`export function ${v.name}(..._args: unknown[]): unknown`).block(() => {
            w.writeLine(`throw new NotImplementedError("${v.name}");`);
          });
        }
        break;
      }
      case "const":
        w.writeLine(`export const ${v.name}: ${v.typeText} = notImplemented("${v.name}");`);
        break;
      case "class": {
        w.write(`export ${v.head}`).block(() => {
          v.members.forEach((m, i) => {
            const prev = v.members[i - 1];
            if (i > 0 && !(m.compact && prev?.compact)) w.blankLine();
            if (m.kind === "throwing") {
              w.write(m.sig).block(() => {
                w.writeLine(`throw new NotImplementedError("${m.label}");`);
              });
            } else {
              w.writeLine(m.text);
            }
          });
        });
        if (v.nominal) {
          w.blankLine();
          w.writeLine("// Conformance note: classes with private/protected members are nominal in TS,");
          w.writeLine("// so class conformance is by verbatim construction, not a typeof check.");
        }
        break;
      }
    }
  }

  if (conformance.length > 0) {
    w.blankLine();
    w.writeLine("// Compile-time conformance: every scaffoldable value export of the contract");
    w.writeLine("// exists above, with the signature the contract declared.");
    w.writeLine(`const __conformance: typeof __Contract = { ${conformance.map((v) => v.name).join(", ")} };`);
    w.writeLine("void __conformance;");
  }

  let text = w.toString();
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

// --- CLI ------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contractPath = process.argv[2];
  if (!contractPath) {
    console.error("usage: node scaffold-contract.ts <path/to/foo.contract.ts>");
    process.exit(2);
  }
  try {
    const errorsPath = errorsModuleFor(contractPath) + ".ts";
    if (!existsSync(errorsPath)) {
      mkdirSync(dirname(errorsPath), { recursive: true });
      writeFileSync(errorsPath, ERRORS_MODULE_SOURCE);
      console.log(`scaffold: created ${errorsPath} (template shared errors module)`);
    }
    const out = skeletonPathFor(contractPath);
    writeFileSync(out, scaffoldContract(readFileSync(contractPath, "utf8"), contractPath));
    console.log(`scaffold: wrote ${out}`);
  } catch (e) {
    if (e instanceof ScaffoldError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
