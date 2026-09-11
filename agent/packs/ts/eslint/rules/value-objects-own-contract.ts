import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule: a value object and the operations over it may
// not share a contract file. Value objects live in their OWN `*.contract.ts`;
// the interfaces and operations that consume them import them from the
// implementation module (ADR 2026-026).
//
// This is the same-file twin of ADR 2026-023's cross-contract refusal. A
// value object is a nominal `declare class`, and the scaffolder turns it into a
// RUNTIME class in that contract's skeleton. If the SAME file also declares an
// interface, type-alias, operation or const that references the value object,
// that reference is emitted in the skeleton against the runtime class — while
// the skeleton's compile-time conformance check compares the same operation
// against `typeof __Contract`, where the name is the contract's AMBIENT
// `declare class`. Those are two declarations of the same private `__brand`, so
// the skeleton does not compile: "separate declarations of a private property
// '__brand'". A purity-clean contract that freezes and then scaffolds to code
// TypeScript rejects — dogfood r18/r19 hit it as the third bug of one arm's
// single-file mega-contract, while multi-file designs were clean because they
// already import value objects from the implementation module.
//
// Why a lint rule at contract_purity rather than a scaffold-time crash: it is a
// contract-SHAPE rule, exactly like its neighbours (no-branded-aliases,
// value-object-shape), it fires one gate earlier, and — named in the architect
// brief — it is a rule the architect is told up front rather than one it meets
// as a block (guard-doc-drift).
//
// --- SCOPE (the precision is the deliverable) ---------------------------------
//
// * The offender is an exported INTERFACE, TYPE-ALIAS, FUNCTION or CONST that
//   references — in any member/param/return position — a value-object class
//   declared in the same file. A class is never an offender: a value object may
//   reference another value object (a vocabulary module can hold several), and
//   nominal classes are excluded from the skeleton's conformance object anyway.
// * A value object here is the canonical nominal shape (value-object-shape):
//   a private `__brand` field, a private constructor, a `static parse`. Only
//   that shape becomes a runtime class the reference can clash with; a plain
//   interface/DTO does not, so referencing one is fine.
// * Only value objects that are EXPORTED become a scaffolded runtime class, so
//   only those can clash — an unexported helper class is not the concern.
// * A reference through an INTERFACE the operation imports back does not clash
//   at compile time (the skeleton imports that interface from the contract, so
//   both sides carry the ambient identity), but it is refused all the same: the
//   decomposition rule is architectural — value objects and the operations over
//   them are different cohesive areas, and keeping them apart is the shape that
//   scales.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** A private brand field (`private readonly __brand: "X"` or `#brand: "X"`),
 *  the marker of a nominal value object — same signal as value-object-shape. */
function hasPrivateBrand(node: TSESTree.ClassDeclaration): boolean {
  return node.body.body.some((member) => {
    if (member.type !== TSESTree.AST_NODE_TYPES.PropertyDefinition) return false;
    if (member.static) return false;
    const isPrivate =
      member.key.type === TSESTree.AST_NODE_TYPES.PrivateIdentifier ||
      member.accessibility === "private";
    if (!isPrivate) return false;
    const type = member.typeAnnotation?.typeAnnotation;
    return type?.type === TSESTree.AST_NODE_TYPES.TSLiteralType &&
      type.literal.type === TSESTree.AST_NODE_TYPES.Literal &&
      typeof type.literal.value === "string";
  });
}

function hasPrivateConstructor(node: TSESTree.ClassDeclaration): boolean {
  return node.body.body.some(
    (member) =>
      member.type === TSESTree.AST_NODE_TYPES.MethodDefinition &&
      member.kind === "constructor" &&
      member.accessibility === "private",
  );
}

function hasStaticParse(node: TSESTree.ClassDeclaration): boolean {
  return node.body.body.some(
    (member) =>
      member.type === TSESTree.AST_NODE_TYPES.MethodDefinition &&
      member.static &&
      member.kind === "method" &&
      !member.computed &&
      member.key.type === TSESTree.AST_NODE_TYPES.Identifier &&
      member.key.name === "parse",
  );
}

/** The canonical nominal value object: brand + private constructor + static parse. */
function isValueObject(node: TSESTree.ClassDeclaration): boolean {
  return hasPrivateBrand(node) && hasPrivateConstructor(node) && hasStaticParse(node);
}

/** Every identifier used as a type name anywhere under `node`. Recurses over
 *  the AST by hand (no scope/type info needed): the check is purely syntactic —
 *  does this declaration NAME a same-file value object? */
function typeNamesUnder(node: TSESTree.Node, into: Set<string>): void {
  if (
    node.type === TSESTree.AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === TSESTree.AST_NODE_TYPES.Identifier
  ) {
    into.add(node.typeName.name);
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "type" in item) {
          typeNamesUnder(item as TSESTree.Node, into);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      typeNamesUnder(value as TSESTree.Node, into);
    }
  }
}

/** The declarations that can reference a value object and be emitted against
 *  its runtime identity — everything but the value-object class itself. */
type Offender =
  | { kind: "interface"; node: TSESTree.TSInterfaceDeclaration; name: string }
  | { kind: "type alias"; node: TSESTree.TSTypeAliasDeclaration; name: string }
  | { kind: "operation"; node: TSESTree.TSDeclareFunction; name: string }
  | { kind: "const"; node: TSESTree.VariableDeclarator; name: string };

export const valueObjectsOwnContract = createRule<[], "sharesContract">({
  name: "value-objects-own-contract",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      sharesContract:
        "{{offenderKind}} '{{offender}}' references value object{{s}} {{vos}} declared in the same contract file. " +
        "A value object becomes a runtime class in its skeleton, so a same-file reference to it carries a different " +
        "'__brand' identity than operations get through the implementation module — the generated skeleton stops " +
        "compiling with \"separate declarations of a private property '__brand'\" (the same-file twin of ADR 2026-023). " +
        "Move value object{{s}} {{vos}} into {{their}} own '*.contract.ts'; the operations then import {{them}} from the " +
        "implementation module — import type { {{first}} } from \"../ids/ids.js\"; — giving one class identity " +
        "(ADR 2026-026). A contract file holds one cohesive area, not value objects and the operations over them.",
    },
  },
  defaultOptions: [],
  create(context) {
    const valueObjects = new Set<string>();
    const offenders: Offender[] = [];

    function indexDeclaration(decl: TSESTree.Node, exported: boolean): void {
      switch (decl.type) {
        case TSESTree.AST_NODE_TYPES.ClassDeclaration:
          if (exported && decl.id && isValueObject(decl)) valueObjects.add(decl.id.name);
          return;
        case TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration:
          if (exported) offenders.push({ kind: "interface", node: decl, name: decl.id.name });
          return;
        case TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration:
          if (exported) offenders.push({ kind: "type alias", node: decl, name: decl.id.name });
          return;
        case TSESTree.AST_NODE_TYPES.TSDeclareFunction:
          if (exported && decl.id) offenders.push({ kind: "operation", node: decl, name: decl.id.name });
          return;
        case TSESTree.AST_NODE_TYPES.VariableDeclaration:
          if (exported) {
            for (const d of decl.declarations) {
              if (d.id.type === TSESTree.AST_NODE_TYPES.Identifier) {
                offenders.push({ kind: "const", node: d, name: d.id.name });
              }
            }
          }
          return;
        case TSESTree.AST_NODE_TYPES.TSModuleDeclaration:
          // An ambient namespace: every member of its block is exported.
          if (decl.body && decl.body.type === TSESTree.AST_NODE_TYPES.TSModuleBlock) {
            for (const stmt of decl.body.body) indexDeclaration(unwrapExport(stmt), true);
          }
          return;
        default:
          return;
      }
    }

    function unwrapExport(stmt: TSESTree.Node): TSESTree.Node {
      return stmt.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration && stmt.declaration
        ? stmt.declaration
        : stmt;
    }

    return {
      Program(program) {
        for (const stmt of program.body) {
          if (stmt.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration && stmt.declaration) {
            indexDeclaration(stmt.declaration, true);
          } else {
            indexDeclaration(stmt, false);
          }
        }
        if (valueObjects.size === 0) return;
        for (const offender of offenders) {
          const refs = new Set<string>();
          if (offender.kind === "interface") {
            for (const member of offender.node.body.body) typeNamesUnder(member, refs);
          } else if (offender.kind === "type alias") {
            typeNamesUnder(offender.node.typeAnnotation, refs);
          } else if (offender.kind === "operation") {
            for (const param of offender.node.params) typeNamesUnder(param, refs);
            if (offender.node.returnType) typeNamesUnder(offender.node.returnType, refs);
          } else {
            if (offender.node.id.typeAnnotation) typeNamesUnder(offender.node.id.typeAnnotation, refs);
          }
          const hit = [...refs].filter((r) => valueObjects.has(r)).sort();
          if (hit.length === 0) continue;
          const one = hit.length === 1;
          context.report({
            node: offender.node,
            messageId: "sharesContract",
            data: {
              offenderKind: offender.kind,
              offender: offender.name,
              vos: hit.map((n) => `'${n}'`).join(", "),
              first: hit[0]!,
              s: one ? "" : "s",
              their: one ? "its" : "their",
              them: one ? "it" : "them",
            },
          });
        }
      },
    };
  },
});
