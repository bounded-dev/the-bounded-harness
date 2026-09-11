import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule: a contract may not import (or re-export) types
// from ANOTHER `*.contract.ts`. It must reach across a component boundary
// through the IMPLEMENTATION module — `../b/b.js`, never `../b/b.contract.js`.
//
// This is the cross-FILE twin of `value-objects-own-contract` (ADR 2026-026),
// which forbids the same clash INSIDE one file. Together the two rules put the
// whole "one identity per value object" concern at contract-purity: the
// same-file case in value-objects-own-contract, the cross-file case here (ADR
// 2026-027). A sibling rule rather than an extension, because the two check
// different AST shapes with different fixes — value-objects-own-contract walks
// same-file type references and tells you to SPLIT the file; this one walks
// module specifiers and tells you to re-point the SPECIFIER — and this one fires
// on any type from a sibling contract, value object or not (see SCOPE).
//
// Why it is a defect (ADR 2026-023). A contract's `declare class Money` and the
// runtime `class Money` the scaffolder writes into that contract's sibling
// implementation are two declarations of the same private `__brand`, which
// TypeScript treats as unrelated types. So a contract that reaches `Money`
// through `values.contract.js` binds the AMBIENT identity, while every value the
// test can build (through the only legal route, the runtime class) carries the
// implementation identity — and the shadow red comes back with "separate
// declarations of a private property '__brand'" over a value no test can pass to
// any operation declared this way. r15 froze exactly this design: 41
// unsatisfiable errors, ~44 of that arm's 76 live minutes, eight invented
// `parse*` functions and a mid-loop re-freeze. The implementation module
// re-exports every type its own contract declares (and shadows the ambient class
// with the real one), so re-pointing the specifier is the total fix.
//
// Why a lint rule at contract_purity rather than a scaffold-time crash: it is a
// contract-SHAPE rule, exactly like its neighbours, it fires one gate earlier,
// and — named in the architect brief — it is a rule the architect is told up
// front rather than one it meets as a block (guard-doc-drift). The scaffolder
// keeps the same refusal as a backstop (ADR 2026-027).
//
// --- SCOPE (the precision is the deliverable) --------------------------------
//
// * The offender is a module specifier that resolves to a `*.contract` module —
//   `./x.contract.js`, `../a/a.contract.ts`, or the extensionless
//   `./x.contract`. The check is on the SPECIFIER, mirroring the scaffolder's
//   `implementationSpecifierFor`; a non-contract specifier is never touched.
// * Both entry points are covered: an `import` (`import type { Foo } from
//   "…contract.js"`) and a re-export from a source (`export type … from
//   "…contract.js"`, `export * from "…contract.js"`) — the re-export launders
//   the second identity into this contract's own surface, the identical defect
//   one level further out.
// * ANY imported type is refused, not only value objects. An interface pulled
//   from a sibling contract has no runtime clash of its own, but the rule is
//   still deterministic and total: the implementation module re-exports
//   everything the contract declares, so the impl module is the one correct
//   source for every cross-component type — and a check that had to tell value
//   objects from interfaces would need type information a purity lint does not
//   have. Import from the implementation module and the question never arises.
// * A value import or value re-export is `declaration-only`'s concern, not this
//   rule's; by the time both run, a surviving import from a contract module is
//   type-only, so this rule speaks only to the identity, never the runtime.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** `./values.contract.js` → `./values.js`; a non-contract specifier → undefined.
 *  Mirrors `implementationSpecifierFor` in scaffold-contract.ts (the scaffolder
 *  backstop): the two must name the same replacement, so they share this shape.
 *  Extension is preserved (NodeNext writes `.js`; a bare `./x.contract` stays
 *  bare). */
function implementationSpecifierFor(moduleSpecifier: string): string | undefined {
  const m = /^(.*)\.contract(\.[cm]?[jt]s)?$/.exec(moduleSpecifier);
  return m === null ? undefined : `${m[1]}${m[2] ?? ""}`;
}

/** The names an import/export clause pulls, sorted; "types" when a bare
 *  `export * from` names nothing. Purely for the message. */
function importedNames(
  specifiers: readonly (TSESTree.ImportClause | TSESTree.ExportSpecifier)[],
): string {
  const names: string[] = [];
  for (const spec of specifiers) {
    switch (spec.type) {
      case TSESTree.AST_NODE_TYPES.ImportSpecifier:
        names.push(spec.imported.type === TSESTree.AST_NODE_TYPES.Identifier
          ? spec.imported.name
          : String(spec.imported.value));
        break;
      case TSESTree.AST_NODE_TYPES.ImportDefaultSpecifier:
      case TSESTree.AST_NODE_TYPES.ImportNamespaceSpecifier:
        names.push(spec.local.name);
        break;
      case TSESTree.AST_NODE_TYPES.ExportSpecifier:
        names.push(spec.local.type === TSESTree.AST_NODE_TYPES.Identifier
          ? spec.local.name
          : String(spec.local.value));
        break;
    }
  }
  return names.length > 0 ? [...names].sort().join(", ") : "types";
}

export const noCrossContractTypeImport = createRule<[], "crossContractImport" | "crossContractReexport">({
  name: "no-cross-contract-type-import",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      crossContractImport:
        "'{{what}}' is imported from \"{{source}}\", another contract — a contract's ambient declarations are a " +
        "SECOND identity: a value object declared there is nominally distinct from the runtime class in that " +
        "contract's implementation module, and TypeScript rejects every value built through the real class with " +
        "\"separate declarations of a private property '__brand'\" (ADR 2026-023). There is exactly one identity per " +
        "value object, so import the implementation module instead — it re-exports every type its contract declares: " +
        "import type { {{what}} } from \"{{impl}}\";",
      crossContractReexport:
        "re-exporting '{{what}}' from \"{{source}}\", another contract, launders that contract's ambient declarations " +
        "into this contract's surface — a value object so re-exported is nominally distinct from the runtime class in " +
        "its implementation module, and TypeScript rejects every value built through the real class with \"separate " +
        "declarations of a private property '__brand'\" (ADR 2026-023). Re-export the implementation module instead — " +
        "it re-exports every type its contract declares: export type { {{what}} } from \"{{impl}}\";",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        const impl = implementationSpecifierFor(node.source.value);
        if (impl === undefined) return;
        context.report({
          node,
          messageId: "crossContractImport",
          data: { what: importedNames(node.specifiers), source: node.source.value, impl },
        });
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (!node.source) return; // a bare local `export { Foo }` — no module reached
        const impl = implementationSpecifierFor(node.source.value);
        if (impl === undefined) return;
        context.report({
          node,
          messageId: "crossContractReexport",
          data: { what: importedNames(node.specifiers), source: node.source.value, impl },
        });
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        const impl = implementationSpecifierFor(node.source.value);
        if (impl === undefined) return;
        context.report({
          node,
          messageId: "crossContractReexport",
          data: {
            // `export * as NS from …` names NS; a bare `export * from …` names
            // nothing.
            what: node.exported ? node.exported.name : "types",
            source: node.source.value,
            impl,
          },
        });
      },
    };
  },
});
