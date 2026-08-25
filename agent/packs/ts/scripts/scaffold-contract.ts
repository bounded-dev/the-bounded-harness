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
// Skeleton value exports are typed by the contract itself
// (`as typeof __Contract.<name>`), so tests written against the contract
// compile against the skeleton unchanged. A compile-time conformance block
// proves every value export of the contract exists in the skeleton.
//
// v1 known limits (fail loudly, by design): enums (use string-literal
// unions — the declaration-only lint rule agrees), value exports inside
// namespaces, default-exported values, `export =`, computed member names.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

const CONTRACT_SUFFIX = ".contract.ts";

/** The fixed naming rule: foo.contract.ts is implemented by sibling foo.ts. */
export function skeletonPathFor(contractPath: string): string {
  if (!contractPath.endsWith(CONTRACT_SUFFIX)) {
    throw new ScaffoldError(`scaffold: '${contractPath}' is not a *.contract.ts path`);
  }
  return contractPath.slice(0, -CONTRACT_SUFFIX.length) + ".ts";
}

type ClassStatic = { name: string; kind: "method" | "getter" | "setter" };
type ValueExport =
  | { kind: "function"; name: string }
  | { kind: "const"; name: string }
  | { kind: "class"; name: string; statics: ClassStatic[] };

const RESERVED = new Set(["NotImplementedError", "throwNotImplemented", "__Contract", "__conformance"]);

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function fail(message: string): never {
  throw new ScaffoldError(`scaffold: ${message}`);
}

/** Namespaces may hold types only; value members are unscaffoldable in v1. */
function namespaceHasValue(decl: ts.ModuleDeclaration): boolean {
  const body = decl.body;
  if (!body || !ts.isModuleBlock(body)) return false;
  return body.statements.some(
    (s) =>
      ts.isFunctionDeclaration(s) ||
      ts.isVariableStatement(s) ||
      ts.isClassDeclaration(s) ||
      ts.isEnumDeclaration(s) ||
      (ts.isModuleDeclaration(s) && namespaceHasValue(s)),
  );
}

function classStatics(node: ts.ClassDeclaration, owner: string): ClassStatic[] {
  const statics: ClassStatic[] = [];
  for (const member of node.members) {
    if (ts.isClassStaticBlockDeclaration(member)) {
      fail(`static block in '${owner}' is not scaffoldable`);
    }
    if (!hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue; // instance members omitted
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue; // unreachable from outside
    const name = member.name;
    if (name === undefined) continue;
    if (ts.isPrivateIdentifier(name)) continue; // #x: unreachable from outside
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
      fail(`computed member name in '${owner}' is not scaffoldable`);
    }
    if (ts.isMethodDeclaration(member)) statics.push({ name: name.text, kind: "method" });
    else if (ts.isGetAccessorDeclaration(member)) statics.push({ name: name.text, kind: "getter" });
    else if (ts.isSetAccessorDeclaration(member)) statics.push({ name: name.text, kind: "setter" });
    else if (ts.isPropertyDeclaration(member)) statics.push({ name: name.text, kind: "getter" }); // read must throw
  }
  return statics;
}

function collectValueExports(sf: ts.SourceFile): ValueExport[] {
  const values: ValueExport[] = [];
  const addFunction = (name: string) => {
    if (!values.some((v) => v.name === name)) values.push({ kind: "function", name });
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (!clause) fail(`side-effect import '${ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "?"}' in contract — contracts declare shapes only`);
      else if (!clause.isTypeOnly) {
        const allTypeSpecifiers =
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly) &&
          clause.name === undefined;
        if (!allTypeSpecifiers) {
          fail(`value import '${ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "?"}' in contract — use 'import type' (declaration-only lint should have caught this)`);
        }
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt)) {
      if (!stmt.isTypeOnly) fail(`value import in contract — use 'import type'`);
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.body) fail(`function body in contract ('${stmt.name?.text ?? "<default>"}') — contracts are declaration-only`);
      if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
        fail("default export of a value is not scaffoldable — use a named export");
      }
      if (stmt.name === undefined) fail("anonymous exported function in contract");
      if (isExported(stmt)) addFunction(stmt.name.text);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      if (!hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
        fail("value binding in contract — contracts are declaration-only (use 'export declare const X: …')");
      }
      if (!isExported(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          fail(`destructuring declare in contract ('${d.name.getText(sf)}') — declare one name per statement`);
        }
        values.push({ kind: "const", name: d.name.text });
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      if (!hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
        fail(`class '${stmt.name?.text ?? "<anonymous>"}' has a runtime body — contracts use 'declare class'`);
      }
      if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) || stmt.name === undefined) {
        fail("default export of a value is not scaffoldable — use a named export");
      }
      if (isExported(stmt)) {
        values.push({ kind: "class", name: stmt.name.text, statics: classStatics(stmt, stmt.name.text) });
      }
      continue;
    }
    if (ts.isEnumDeclaration(stmt)) {
      fail(`enum '${stmt.name.text}' is not scaffoldable — use a string-literal union type in the contract (TN-26-001)`);
    }
    if (ts.isModuleDeclaration(stmt)) {
      const isGlobal = stmt.name.kind === ts.SyntaxKind.Identifier && stmt.name.text === "global";
      if (!isGlobal && namespaceHasValue(stmt)) {
        fail(`namespace '${stmt.name.text}' exports values — namespaces may hold types only; flatten values to top-level 'export declare'`);
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) continue;
    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.isTypeOnly) fail("value re-export in contract — use 'export type …'");
      continue;
    }
    if (ts.isExportAssignment(stmt)) fail("'export =' is CommonJS interop — use named exports");
    if (stmt.kind === ts.SyntaxKind.EmptyStatement) continue;
    fail(`unsupported statement '${ts.SyntaxKind[stmt.kind]}' in contract — contracts contain types and ambient declarations only`);
  }
  return values;
}

// --- rendering ----------------------------------------------------------------

const ERROR_CLASS = [
  "class NotImplementedError extends Error {",
  "  constructor(what: string) {",
  "    super(`NotImplemented: ${what}`);",
  '    this.name = "NotImplementedError";',
  "  }",
  "}",
].join("\n");

const HELPER = [
  "function throwNotImplemented(what: string): never {",
  "  throw new NotImplementedError(what);",
  "}",
].join("\n");

function renderExport(v: ValueExport): string {
  switch (v.kind) {
    case "function":
      return [
        `export const ${v.name} = (() => {`,
        `  throw new NotImplementedError("${v.name}");`,
        `}) as typeof __Contract.${v.name};`,
      ].join("\n");
    case "const":
      return `export const ${v.name} = throwNotImplemented("${v.name}") as typeof __Contract.${v.name};`;
    case "class": {
      const members = [
        "  constructor(..._args: never[]) {",
        `    throw new NotImplementedError("${v.name}.constructor");`,
        "  }",
      ];
      for (const s of v.statics) {
        const head =
          s.kind === "method"
            ? `  static ${s.name}(..._args: never[]) {`
            : s.kind === "getter"
              ? `  static get ${s.name}() {`
              : `  static set ${s.name}(_value: never) {`;
        members.push("", head, `    throw new NotImplementedError("${v.name}.${s.name}");`, "  }");
      }
      return [
        "// Instance members are omitted: the constructor throws first.",
        `export const ${v.name} = class {`,
        members.join("\n"),
        `} as unknown as typeof __Contract.${v.name};`,
      ].join("\n");
    }
  }
}

export function scaffoldContract(contractSource: string, contractFileName: string): string {
  const baseTs = basename(contractFileName);
  if (!baseTs.endsWith(CONTRACT_SUFFIX)) {
    throw new ScaffoldError(`scaffold: '${contractFileName}' is not a *.contract.ts path`);
  }
  const specifier = "./" + baseTs.replace(/\.ts$/, ".js");

  const sf = ts.createSourceFile(contractFileName, contractSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const values = collectValueExports(sf);

  for (const v of values) {
    if (RESERVED.has(v.name)) {
      fail(`export '${v.name}' collides with scaffold internals — rename it in the contract`);
    }
  }

  const sections: string[] = [
    [
      `// GENERATED from ${baseTs} by packs/ts/scripts/scaffold-contract.ts — do not edit.`,
      "// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.",
      "// The builder replaces this file with the real implementation.",
    ].join("\n"),
  ];

  if (values.length > 0) {
    sections.push(`import type * as __Contract from "${specifier}";`);
  }
  sections.push(`export type * from "${specifier}";`);

  if (values.length > 0) {
    sections.push(ERROR_CLASS);
    if (values.some((v) => v.kind === "const")) sections.push(HELPER);
    for (const v of values) sections.push(renderExport(v));
    sections.push(
      [
        "// Compile-time conformance: every value export of the contract exists above,",
        "// each typed by the contract itself.",
        `const __conformance: typeof __Contract = { ${values.map((v) => v.name).join(", ")} };`,
        "void __conformance;",
      ].join("\n"),
    );
  }

  return sections.join("\n\n") + "\n";
}

// --- CLI ------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contractPath = process.argv[2];
  if (!contractPath) {
    console.error("usage: node scaffold-contract.ts <path/to/foo.contract.ts>");
    process.exit(2);
  }
  try {
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
