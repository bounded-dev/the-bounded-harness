import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule (issue #3): value objects over primitives on a
// contract's PUBLIC surface. The `declaration-only` rule checks a contract is
// well-formed; this one checks it says something. Dogfood evidence
// (docs/dogfooding.md, runs 1-3): Haiku shipped `isbn: string`,
// `pagesRead: number`, `authors: string[]` where Sonnet shipped `Isbn`,
// `PagesRead`, `AuthorName` — structurally identical, semantically empty, and
// every gate passed. The preference lived in prose (ts-contract-authoring
// says "value objects over primitives"); prose is not a harness layer.
//
// Error messages are written for an agent reader, not a human (TN appendix,
// Kinney: "write lint error messages like prompts"): each names the sin AND
// the exact declaration to write instead.
//
// --- SCOPE (the precision IS the deliverable) ---------------------------------
//
// A rule that fires on correct designs gets switched off, so the exemptions
// below are deliberate, not gaps:
//
// * Only `string` and `number`. **`boolean` is out of scope**: a branded
//   boolean (`Bool<"Active">`) carries no more information than the property
//   name, and the real fix for a boolean smell is a state union
//   ("active" | "archived") — a domain judgement the linter cannot make
//   deterministically. Flagging every flag would be pure noise. This rule is a
//   floor, not a design review.
// * Only the **public boundary**: exported interfaces, exported type aliases,
//   `export declare function/const`, and ambient namespace members. Unexported
//   types are internal (and the scaffolder already forces any type on the
//   public surface to be exported, so there is no back door).
// * **Intersections are never entered.** `string & { readonly __brand: "Isbn" }`
//   is the base of a value object, not a naked primitive — and the rule stays
//   agnostic about which branding convention (`__brand`, `_tag`, unique symbol)
//   the project uses.
// * **Literal and template-literal types are already value objects.**
//   `"open" | "paid"` is the enum replacement the declaration-only rule
//   mandates; `` `${string}-${number}` `` is a constrained pattern.
// * `void`, `never`, `unknown`, `symbol`, `bigint`, `null`, `undefined` are not
//   domain values, so `Promise<void>` and friends are silent.
// * **Type parameters and their constraints are the caller's choice** — never
//   walked. Nor are type arguments in general: only the transparent containers
//   below are looked through, because for anything else (`Result<string, E>`)
//   the primitive belongs to that type's author, not this contract's.
// * **Index-signature keys and Record/Map key positions are exempt**: an index
//   domain, and TS permits nothing but string/number/symbol there anyway.
// * **`declare class` bodies are exempt.** A class is already nominal — it IS
//   the value object (`declare class Money { readonly amount: number }`), and
//   its smart constructor (`static parse(raw: string): Money`) must accept the
//   raw primitive. Residual hole, accepted: a class-shaped DTO of primitives
//   goes unflagged. Contracts are steered towards interfaces + declare
//   functions, so this is cheap to accept and expensive to police.
// * **Ports are treated exactly like DTOs** — no name or shape heuristic
//   ("…Store", "…Port", methods-only) distinguishes them. Deliberate: the
//   point of a port is that it is domain-facing (`save(id: Isbn)`), infra-
//   facing only in its implementation, so the domain vocabulary must cross it.
//   A heuristic here would make the rule unpredictable, and an agent cannot
//   comply with a rule it cannot predict.
//
// --- The parse boundary (the escape hatch) ------------------------------------
//
// A value object needs somewhere for a raw primitive to become one, and that
// somewhere is a function that RETURNS the value object:
//
//   export type Isbn = string & { readonly __brand: "Isbn" };
//   export declare function parseIsbn(raw: string): Isbn;   // not flagged
//
// So: naked primitives in a signature's PARAMETERS are exempt when the
// signature returns a value object declared in this contract (a branded alias
// or a literal union), unwrapping Promise and `| undefined`. The return
// position itself is never exempt. This is deliberately the rule's only way
// out — it channels every primitive in the design to one named, testable
// place instead of suppressing the complaint.
//
// Known limit, accepted: the value object must be declared in THIS file. The
// rule is syntactic (no type information), so it cannot see through an import
// to tell a branded alias from a DTO — and exempting every imported return
// type would gut the rule. The fix reads as good advice anyway: a brand and
// its only legal constructor belong in the same contract.
//
// --- NOT in scope: cardinality ------------------------------------------------
//
// The dogfood evidence pairs two defects in `authors: string[]`: the element is
// a naked string (this rule's business, one level down — hence the separate
// `nakedPrimitiveElement` message), and the array silently permits empty, so
// the "one or more authors" requirement is lost. Non-emptiness is a SEPARATE
// concern and undecidable from the contract alone — the rule cannot know
// whether empty is legal, and demanding `readonly [T, ...T[]]` everywhere
// would be wrong. So it is not enforced; the element message carries the
// prompt instead, where the architect is already reading.

type MessageId = "nakedPrimitive" | "nakedPrimitiveElement" | "primitiveAlias";

type Primitive = "string" | "number";

const VALUE_OBJECTS =
  "Value objects over primitives on the contract's public surface (TN-26-001): a naked 'string'/'number' carries no domain meaning and no invariant — nothing stops an ISBN being passed where a title is expected.";

const BRAND = 'export type {{brand}} = {{primitive}} & { readonly __brand: "{{brand}}" };';

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Transparent containers: the wrapped type is still the domain value, so a
 *  naked primitive inside one is the same defect one level down. Anything not
 *  listed here is opaque — its type arguments belong to its own author. */
const TRANSPARENT = new Set(["Promise", "Awaited", "Readonly", "Required", "NonNullable"]);
/** Collections: same, but the primitive is an *element*, which gets the
 *  cardinality prompt as well. */
const COLLECTION = new Set(["Array", "ReadonlyArray", "Set", "ReadonlySet"]);
/** Keyed collections: the key is an index domain (exempt, as index signatures
 *  are); the value slot is a domain slot like any other. */
const KEYED = new Set(["Record", "Map", "ReadonlyMap", "WeakMap"]);

const PRIMITIVE_OF: Partial<Record<TSESTree.AST_NODE_TYPES, Primitive>> = {
  [TSESTree.AST_NODE_TYPES.TSStringKeyword]: "string",
  [TSESTree.AST_NODE_TYPES.TSNumberKeyword]: "number",
};

/** PascalCase a member/parameter name for the suggested brand: isbn → Isbn,
 *  pagesRead → PagesRead, DEFAULT_CURRENCY → DefaultCurrency. */
function pascalCase(name: string): string {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0);
  if (segments.length === 0) return "Value";
  return segments.map((s) => s[0]!.toUpperCase() + s.slice(1).toLowerCase()).join("");
}

/** Element brands read better singular: authors → Author, entries → Entry.
 *  Deterministic and deliberately naive — it is a suggestion, not a rename. */
function singularize(word: string): string {
  if (/ies$/.test(word) && word.length > 3) return word.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

interface Ctx {
  /** Nearest naming position — property, parameter, or declaration name. */
  readonly name: string;
  /** Inside a collection element / keyed-collection value slot. */
  readonly element: boolean;
  /** Set while still at the top level of an exported type alias's RHS: a
   *  primitive reached here is an unbranded alias, a different message. */
  readonly aliasName?: string;
}

export const noNakedPrimitives = createRule<[], MessageId>({
  name: "no-naked-primitives",
  meta: {
    type: "problem",
    messages: {
      nakedPrimitive: `${VALUE_OBJECTS} '{{name}}' is declared as '{{primitive}}' — declare the value object in this contract and use it here, e.g. ${BRAND} Validation and parsing belong in the implementation; the contract just names the type.`,
      nakedPrimitiveElement: `${VALUE_OBJECTS} '{{name}}' is a collection of naked '{{primitive}}' — declare the element type here and use {{brand}}[], e.g. ${BRAND} If the field means one-or-more, encode that too: 'readonly [{{brand}}, ...{{brand}}[]]' — an array type silently permits empty, and a requirement no type carries is a requirement nothing checks.`,
      primitiveAlias: `${VALUE_OBJECTS} 'export type {{name}} = {{primitive}}' is an alias, not a value object — it is assignable from every other '{{primitive}}' in the program, so it buys nothing. Brand it: export type {{name}} = {{primitive}} & { readonly __brand: "{{name}}" };`,
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function report(node: TSESTree.Node, primitive: Primitive, ctx: Ctx): void {
      if (ctx.aliasName !== undefined) {
        context.report({
          node,
          messageId: "primitiveAlias",
          data: { name: ctx.aliasName, primitive },
        });
        return;
      }
      const base = pascalCase(ctx.name);
      context.report({
        node,
        messageId: ctx.element ? "nakedPrimitiveElement" : "nakedPrimitive",
        data: {
          name: ctx.name,
          brand: ctx.element ? singularize(base) : base,
          primitive,
        },
      });
    }

    // --- value objects declared in this contract --------------------------------

    /** Names of local type aliases that ARE value objects: a primitive-based
     *  brand (`string & { … }`) or a literal union (`"open" | "paid"`). */
    const valueObjects = new Set<string>();

    function isValueObjectDefinition(node: TSESTree.TypeNode): boolean {
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSIntersectionType:
          // A brand: a primitive base intersected with a marker object.
          return node.types.some((t) => PRIMITIVE_OF[t.type] !== undefined);
        case TSESTree.AST_NODE_TYPES.TSUnionType:
          return node.types.every(
            (t) => t.type === TSESTree.AST_NODE_TYPES.TSLiteralType,
          );
        case TSESTree.AST_NODE_TYPES.TSLiteralType:
        case TSESTree.AST_NODE_TYPES.TSTemplateLiteralType:
          return true;
        default:
          return false;
      }
    }

    /** Does this return type hand back a value object declared here? Unwraps
     *  Promise/Awaited and `| undefined` — the two shapes a parse takes. */
    function returnsValueObject(node: TSESTree.TypeNode | undefined): boolean {
      if (!node) return false;
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSTypeReference: {
          const name =
            node.typeName.type === TSESTree.AST_NODE_TYPES.Identifier ? node.typeName.name : "";
          if (valueObjects.has(name)) return true;
          if (!TRANSPARENT.has(name)) return false;
          return (node.typeArguments?.params ?? []).some(returnsValueObject);
        }
        case TSESTree.AST_NODE_TYPES.TSUnionType:
          return node.types.some(returnsValueObject);
        // An inline literal union is a value object without needing a name.
        case TSESTree.AST_NODE_TYPES.TSLiteralType:
          return true;
        default:
          return false;
      }
    }

    // --- type walking ---------------------------------------------------------

    function walkType(node: TSESTree.TypeNode | undefined, ctx: Ctx): void {
      if (!node) return;
      const primitive = PRIMITIVE_OF[node.type];
      if (primitive) {
        report(node, primitive, ctx);
        return;
      }

      const inner: Ctx = { ...ctx, aliasName: undefined };

      switch (node.type) {
        // A union is still the same slot: `string | undefined` is naked, and an
        // alias to a union of primitives is still an alias.
        case TSESTree.AST_NODE_TYPES.TSUnionType:
          for (const t of node.types) walkType(t, ctx);
          return;

        // Brand construct: `string & { readonly __brand: "Isbn" }`. Never
        // entered — this is what a correct answer looks like.
        case TSESTree.AST_NODE_TYPES.TSIntersectionType:
          return;

        case TSESTree.AST_NODE_TYPES.TSArrayType:
          walkType(node.elementType, { ...inner, element: true });
          return;

        case TSESTree.AST_NODE_TYPES.TSTupleType:
          for (const t of node.elementTypes) walkType(t, { ...inner, element: true });
          return;

        case TSESTree.AST_NODE_TYPES.TSRestType:
        case TSESTree.AST_NODE_TYPES.TSOptionalType:
          walkType(node.typeAnnotation, ctx);
          return;

        case TSESTree.AST_NODE_TYPES.TSNamedTupleMember:
          walkType(node.elementType, ctx);
          return;

        case TSESTree.AST_NODE_TYPES.TSTypeOperator:
          // `readonly T[]` is transparent; `keyof`/`unique` are not domain slots.
          if (node.operator === "readonly") walkType(node.typeAnnotation, ctx);
          return;

        case TSESTree.AST_NODE_TYPES.TSTypeReference: {
          const args = node.typeArguments?.params ?? [];
          if (args.length === 0) return;
          const name =
            node.typeName.type === TSESTree.AST_NODE_TYPES.Identifier ? node.typeName.name : "";
          if (TRANSPARENT.has(name)) {
            for (const a of args) walkType(a, inner);
          } else if (COLLECTION.has(name)) {
            for (const a of args) walkType(a, { ...inner, element: true });
          } else if (KEYED.has(name)) {
            // Key slot exempt (index domain); value slot checked.
            walkType(args[1], { ...inner, element: true });
          }
          // Anything else is opaque: its type arguments are its author's business.
          return;
        }

        case TSESTree.AST_NODE_TYPES.TSTypeLiteral:
          for (const member of node.members) walkMember(member);
          return;

        case TSESTree.AST_NODE_TYPES.TSMappedType:
          // The key is a type parameter; the value is a domain slot.
          walkType(node.typeAnnotation, inner);
          return;

        case TSESTree.AST_NODE_TYPES.TSFunctionType:
        case TSESTree.AST_NODE_TYPES.TSConstructorType:
          walkSignature(node, ctx.name);
          return;

        // Literals, template literals, conditional/indexed-access/infer types,
        // typeof queries, and every remaining keyword: not naked primitives.
        default:
          return;
      }
    }

    /** Parameters + return type of any callable form. */
    function walkSignature(
      node:
        | TSESTree.TSFunctionType
        | TSESTree.TSConstructorType
        | TSESTree.TSMethodSignature
        | TSESTree.TSCallSignatureDeclaration
        | TSESTree.TSConstructSignatureDeclaration
        | TSESTree.TSDeclareFunction
        | TSESTree.FunctionDeclaration,
      ownName: string,
    ): void {
      // The parse boundary: a signature that returns a value object declared
      // in this contract is where raw primitives are supposed to enter.
      if (!returnsValueObject(node.returnType?.typeAnnotation)) {
        for (const param of node.params) walkParam(param);
      }
      walkType(node.returnType?.typeAnnotation, { name: ownName, element: false });
    }

    function walkParam(param: TSESTree.Parameter): void {
      switch (param.type) {
        case TSESTree.AST_NODE_TYPES.Identifier:
          walkType(param.typeAnnotation?.typeAnnotation, { name: param.name, element: false });
          return;
        case TSESTree.AST_NODE_TYPES.RestElement:
          walkType(param.typeAnnotation?.typeAnnotation, {
            name: param.argument.type === TSESTree.AST_NODE_TYPES.Identifier ? param.argument.name : "value",
            element: false,
          });
          return;
        case TSESTree.AST_NODE_TYPES.AssignmentPattern:
        case TSESTree.AST_NODE_TYPES.ArrayPattern:
        case TSESTree.AST_NODE_TYPES.ObjectPattern:
          walkType(param.typeAnnotation?.typeAnnotation, { name: "value", element: false });
          return;
        default:
          return;
      }
    }

    function nameOfKey(node: TSESTree.Node): string {
      if (node.type === TSESTree.AST_NODE_TYPES.Identifier) return node.name;
      if (node.type === TSESTree.AST_NODE_TYPES.Literal) return String(node.value);
      return "value";
    }

    function walkMember(member: TSESTree.TypeElement): void {
      switch (member.type) {
        case TSESTree.AST_NODE_TYPES.TSPropertySignature:
          walkType(member.typeAnnotation?.typeAnnotation, {
            name: nameOfKey(member.key),
            element: false,
          });
          return;
        case TSESTree.AST_NODE_TYPES.TSMethodSignature:
          walkSignature(member, nameOfKey(member.key));
          return;
        case TSESTree.AST_NODE_TYPES.TSCallSignatureDeclaration:
        case TSESTree.AST_NODE_TYPES.TSConstructSignatureDeclaration:
          walkSignature(member, "value");
          return;
        case TSESTree.AST_NODE_TYPES.TSIndexSignature:
          // Key exempt (TS permits string/number/symbol only); value checked.
          walkType(member.typeAnnotation?.typeAnnotation, { name: "value", element: true });
          return;
        default:
          return;
      }
    }

    // --- the public boundary --------------------------------------------------

    /** Declarations reachable from an export, by name (overloads share one). */
    const declared = new Map<string, TSESTree.Node[]>();
    const exportedNames = new Set<string>();
    const checked = new Set<TSESTree.Node>();

    function declare(node: TSESTree.Node, name: string | undefined): void {
      if (name === undefined) return;
      const list = declared.get(name);
      if (list) list.push(node);
      else declared.set(name, [node]);
    }

    function checkDeclaration(node: TSESTree.Node): void {
      if (checked.has(node)) return;
      checked.add(node);
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration:
          for (const member of node.body.body) walkMember(member);
          return;
        case TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration:
          walkType(node.typeAnnotation, {
            name: node.id.name,
            element: false,
            aliasName: node.id.name,
          });
          return;
        case TSESTree.AST_NODE_TYPES.TSDeclareFunction:
        case TSESTree.AST_NODE_TYPES.FunctionDeclaration:
          walkSignature(node, node.id ? node.id.name : "value");
          return;
        case TSESTree.AST_NODE_TYPES.VariableDeclaration:
          for (const d of node.declarations) {
            if (d.id.type !== TSESTree.AST_NODE_TYPES.Identifier) continue;
            walkType(d.id.typeAnnotation?.typeAnnotation, { name: d.id.name, element: false });
          }
          return;
        // ClassDeclaration: exempt — a class is already nominal (see header).
        default:
          return;
      }
    }

    /** Index a top-level statement, queueing it for checking if exported.
     *  Nothing is checked during indexing: the parse-boundary exemption needs
     *  the whole file's value objects known first, so declaration order in the
     *  contract must not change the verdict. */
    function indexStatement(node: TSESTree.Node, exported: boolean): void {
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.TSTypeAliasDeclaration:
          declare(node, node.id.name);
          if (isValueObjectDefinition(node.typeAnnotation)) valueObjects.add(node.id.name);
          break;
        case TSESTree.AST_NODE_TYPES.TSInterfaceDeclaration:
          declare(node, node.id.name);
          break;
        case TSESTree.AST_NODE_TYPES.TSDeclareFunction:
        case TSESTree.AST_NODE_TYPES.FunctionDeclaration:
          declare(node, node.id?.name);
          break;
        case TSESTree.AST_NODE_TYPES.VariableDeclaration:
          for (const d of node.declarations) {
            if (d.id.type === TSESTree.AST_NODE_TYPES.Identifier) declare(node, d.id.name);
          }
          break;
        case TSESTree.AST_NODE_TYPES.TSModuleDeclaration:
          // Ambient namespace: every member of an ambient block is exported.
          if (node.body) {
            for (const stmt of node.body.body) indexStatement(unwrapExport(stmt), true);
          }
          return;
        default:
          break;
      }
      if (exported) pending.push(node);
    }

    /** Exported declarations, in source order, checked after indexing. */
    const pending: TSESTree.Node[] = [];

    function unwrapExport(stmt: TSESTree.Node): TSESTree.Node {
      return stmt.type === TSESTree.AST_NODE_TYPES.ExportNamedDeclaration && stmt.declaration
        ? stmt.declaration
        : stmt;
    }

    return {
      Program(program) {
        for (const stmt of program.body) {
          switch (stmt.type) {
            case TSESTree.AST_NODE_TYPES.ExportNamedDeclaration:
              if (stmt.declaration) {
                indexStatement(stmt.declaration, true);
              } else if (!stmt.source) {
                // `export { Foo }` — Foo is declared locally; resolve below.
                for (const spec of stmt.specifiers) {
                  if (spec.local.type === TSESTree.AST_NODE_TYPES.Identifier) {
                    exportedNames.add(spec.local.name);
                  }
                }
              }
              break;
            case TSESTree.AST_NODE_TYPES.ExportDefaultDeclaration:
              indexStatement(stmt.declaration as TSESTree.Node, true);
              break;
            default:
              indexStatement(stmt, false);
          }
        }
        for (const name of exportedNames) {
          for (const node of declared.get(name) ?? []) pending.push(node);
        }
        // Source order keeps the gate's output stable and greppable.
        pending.sort((a, b) => a.range[0] - b.range[0]);
        for (const node of pending) checkDeclaration(node);
      },
    };
  },
});
