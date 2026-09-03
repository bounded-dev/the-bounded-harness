import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule: an exported class must have the canonical
// value-object shape. `declaration-only` asks "is this a well-formed
// contract?", `no-naked-primitives` asks "does it say anything?"; this one
// asks "is the thing it says actually nominal?".
//
// The shape is the one ts-contract-authoring prescribes ("The canonical shape
// is a nominal class") and every part of it is a `tsc` error rather than a
// convention:
//
//   export declare class Currency {
//     private readonly __brand: "Currency";   // TS2739 — nominal comparison
//     private constructor();                  // TS2673 — no unvalidated `new`
//     readonly code: string;                  // TS2540 — no mutation after parse
//     static parse(raw: unknown): Currency | undefined;  // TS2322 at the callsite
//     equals(other: Currency): boolean;
//   }
//
// Why a lint rule and not prose: the guidance already existed in the skill,
// and prose is not a harness layer (the same lesson as issue #3, where a
// weaker model shipped `isbn: string` past every gate). Two of these defects
// are invisible on review — a brand string that does not match the class name
// silently gives you two unrelated types, and a missing brand gives you a DTO
// that *looks* nominal because the constructor is private.
//
// Error messages are written for an agent reader, not a human (TN appendix,
// Kinney: "write lint error messages like prompts"): each names the sin AND
// the exact declaration to write instead.
//
// --- SCOPE (the precision IS the deliverable) ---------------------------------
//
// A rule that fires on correct designs gets switched off, so the boundaries
// below are deliberate, not gaps:
//
// * **An exported class IS a value object.** That is this rule's one
//   assumption, and it holds because of the contract style the pack enforces
//   everywhere else: ports, DTOs and aggregates are `interface`s (that is what
//   `no-naked-primitives` walks, and what the scaffolder generates), so the
//   only reason to reach for a `class` here is nominality plus behaviour —
//   i.e. a value object. If that assumption ever stops holding, this rule is
//   the thing to revisit, not the exemption list.
// * **Both halves of the world are checked, with the same rules.** In a
//   `*.contract.ts` the members are bodiless (`declare class`); in the sibling
//   implementation the constructor is usually a parameter-property
//   constructor, `private constructor(readonly code: string) {}`. A parameter
//   property is a property declaration, so it must be `readonly` too.
// * **Only exported classes**, by every route: `export class`,
//   `export declare class`, `export default class`, `export { Currency }`,
//   and members of an ambient namespace (where everything is exported). An
//   unexported class is internal scaffolding.
// * **`no-naked-primitives` exempts `declare class` bodies** because a class
//   is already nominal and its `parse` must accept the raw primitive. That
//   exemption is only safe if something checks the class really is nominal —
//   this rule is that something. The two are a pair; neither is complete alone.
// * **Class expressions and anonymous default exports are not checked.**
//   `export default class { … }` has no name, so the brand has nothing to
//   match and the "write this instead" message could not be written. The
//   scaffolder never emits either form.
// * **Statics are exempt from the readonly check.** `static readonly ZERO` is
//   a cached instance, not domain state, and a mutable static is a different
//   smell with a different fix.
// * **Getters are exempt.** The skill welcomes a getter for a *derived* value
//   (`get major(): number`); it is a method, not a place mutation can land.
// * **Extra members are welcome and never counted.** `static of(...)` for when
//   the parts are already value objects, `plus`, `equals`, `toString` — the
//   skill asks for behaviour on the class, so the rule only ever checks that
//   the required members are present and correct, never that others are absent.
// * **Nothing about `equals` is enforced.** It is in the canonical shape as
//   an illustration of behaviour, not a requirement: a value object with no
//   equality question worth asking should not be forced to answer one.
// * **Validation is not checked.** Whether `parse` really rejects `"usd"` is
//   the test-writer's job (`value-object-documented` is what tells them what
//   to test). This rule is syntactic: it checks the door exists and is the
//   only one, not what the door lets through.
//
// --- Why `extends` is a defect, not a style ------------------------------------
//
// Inheritance shares the brand, so a subclass is assignable wherever the base
// is expected and the nominal typing you paid for is gone. The scaffolder
// already refuses to generate a value object with a superclass; reporting it
// here moves the same failure earlier — to design time, where the fix is a
// one-line edit — and replaces "the scaffolder crashed" with a reason.

type MessageId =
  | "missingBrand"
  | "brandMismatch"
  | "missingPrivateConstructor"
  | "constructorNotPrivate"
  | "missingParse"
  | "parseParamNotUnknown"
  | "parseReturnNotOptional"
  | "mutableProperty"
  | "classExtends";

const CANONICAL =
  "An exported class is a value object, and a value object is a nominal class (TN-26-001, ts-contract-authoring): a private brand, a private constructor, and a 'static parse' taking 'unknown'.";

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** The brand field: a *private* member (`private` or `#`) whose type is a
 *  string literal. Privacy is the whole mechanism — a public brand can be
 *  supplied by an object literal, so it flips nothing. */
function brandOf(member: TSESTree.ClassElement): string | undefined {
  if (member.type !== TSESTree.AST_NODE_TYPES.PropertyDefinition) return undefined;
  if (member.static) return undefined;
  const isPrivate =
    member.key.type === TSESTree.AST_NODE_TYPES.PrivateIdentifier ||
    member.accessibility === "private";
  if (!isPrivate) return undefined;
  const type = member.typeAnnotation?.typeAnnotation;
  if (type?.type !== TSESTree.AST_NODE_TYPES.TSLiteralType) return undefined;
  if (type.literal.type !== TSESTree.AST_NODE_TYPES.Literal) return undefined;
  return typeof type.literal.value === "string" ? type.literal.value : undefined;
}

/** `static parse(...)`, bodiless or not. A non-static `parse` is not the
 *  boundary: it would need an instance, which is exactly what parse makes. */
function isStaticParse(member: TSESTree.ClassElement): member is TSESTree.MethodDefinition {
  return (
    member.type === TSESTree.AST_NODE_TYPES.MethodDefinition &&
    member.static &&
    member.kind === "method" &&
    !member.computed &&
    member.key.type === TSESTree.AST_NODE_TYPES.Identifier &&
    member.key.name === "parse"
  );
}

/** Exactly one parameter, typed `unknown`. `unknown` is the point: parse is
 *  the boundary that faces parsed JSON, so a narrower parameter just moves
 *  the unchecked cast to the caller. */
function takesUnknown(fn: TSESTree.FunctionLike): boolean {
  if (fn.params.length !== 1) return false;
  const param = fn.params[0]!;
  if (param.type !== TSESTree.AST_NODE_TYPES.Identifier) return false;
  return param.typeAnnotation?.typeAnnotation.type === TSESTree.AST_NODE_TYPES.TSUnknownKeyword;
}

/** Exactly `<ClassName> | undefined`, in either order. Not `Promise<…>` (the
 *  boundary is pure and synchronous) and not a bare `<ClassName>` (which
 *  forces failure to throw, and callers to remember). */
function returnsOptionalSelf(fn: TSESTree.FunctionLike, className: string): boolean {
  const returned = fn.returnType?.typeAnnotation;
  if (returned?.type !== TSESTree.AST_NODE_TYPES.TSUnionType) return false;
  if (returned.types.length !== 2) return false;
  const hasUndefined = returned.types.some(
    (t) => t.type === TSESTree.AST_NODE_TYPES.TSUndefinedKeyword,
  );
  const hasSelf = returned.types.some(
    (t) =>
      t.type === TSESTree.AST_NODE_TYPES.TSTypeReference &&
      t.typeName.type === TSESTree.AST_NODE_TYPES.Identifier &&
      t.typeName.name === className &&
      t.typeArguments === undefined,
  );
  return hasUndefined && hasSelf;
}

function memberName(node: TSESTree.Node): string {
  if (node.type === TSESTree.AST_NODE_TYPES.Identifier) return node.name;
  // `private constructor(readonly code: string = "USD")` — the name is under
  // the default value.
  if (node.type === TSESTree.AST_NODE_TYPES.AssignmentPattern) return memberName(node.left);
  if (node.type === TSESTree.AST_NODE_TYPES.PrivateIdentifier) return `#${node.name}`;
  if (node.type === TSESTree.AST_NODE_TYPES.Literal) return String(node.value);
  return "value";
}

export const valueObjectShape = createRule<[], MessageId>({
  name: "value-object-shape",
  meta: {
    type: "problem",
    messages: {
      missingBrand: `${CANONICAL} class '{{name}}' has no brand field, so it is structurally typed: '{ code: "usd" }' is assignable to it, and so is every other class of the same shape. Add it as the first member: private readonly __brand: "{{name}}"; (a '#brand: "{{name}}"' field works too). The private FIELD is what flips TypeScript into nominal comparison (TS2739) — a private constructor does not, and a *public* brand does not either, because an object literal can just supply it.`,
      brandMismatch: `${CANONICAL} class '{{name}}' brands itself "{{brand}}" — the brand string must equal the class name, or the two become unrelated types and nothing tells you. Write: private readonly __brand: "{{name}}"; This is the invisible typo new-value-object.ts exists to prevent: it type-checks, it reviews clean, and it silently gives you a second, incompatible '{{brand}}'.`,
      missingPrivateConstructor: `${CANONICAL} class '{{name}}' declares no constructor, so TypeScript gives it a public one and 'new {{name}}(…)' skips validation entirely. Declare it: private constructor(); in a *.contract.ts, or private constructor(readonly …) {} in the implementation. 'static parse' is the single door in (TS2673).`,
      constructorNotPrivate: `${CANONICAL} class '{{name}}' has a constructor callers can reach, so 'new {{name}}(…)' bypasses validation and the invariant holds only where callers remember it. Mark it private: private constructor(…). 'protected' is not enough — a subclass reopens the same door. Validation belongs in 'static parse' (TS2673).`,
      missingParse: `${CANONICAL} class '{{name}}' has no 'static parse', so with a private constructor nothing can build one at all. Add the smart constructor: static parse(raw: unknown): {{name}} | undefined; An instance 'parse' is not it — the boundary has to be callable before an instance exists.`,
      parseParamNotUnknown: `${CANONICAL} '{{name}}.parse' must take exactly one parameter typed 'unknown' — write: static parse(raw: unknown): {{name}} | undefined; 'unknown' is the point: parse is the boundary that faces parsed JSON, form input and env vars directly, and a narrower parameter type only moves the unchecked cast out to the caller, where no gate sees it.`,
      parseReturnNotOptional: `${CANONICAL} '{{name}}.parse' must return '{{name}} | undefined' — write: static parse(raw: unknown): {{name}} | undefined; Returning the bare class makes failure throw, which a caller can forget; the union makes tsc refuse the value until failure is handled (TS2322). Not 'Promise<…>' either: parsing is pure and synchronous, and IO belongs behind a port.`,
      mutableProperty: `${CANONICAL} '{{name}}.{{member}}' is mutable, so 'value.{{member}} = …' rewrites a value that 'parse' already validated and the invariant survives only until someone assigns. Declare it readonly: readonly {{member}}: …; — or, as a constructor parameter property, private constructor(readonly {{member}}: …) {} (TS2540).`,
      classExtends: `${CANONICAL} class '{{name}}' extends '{{super}}' — a value object is a leaf. Inheritance shares the brand, so a subclass is assignable wherever '{{name}}' is expected and the nominal typing you paid for is gone. Drop 'extends {{super}}': hold the shared parts as readonly fields, or make '{{super}}' a plain function that both call. (The scaffolder refuses this shape as well; failing here fails it at design time, with a reason instead of a crash.)`,
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function checkClass(node: TSESTree.ClassDeclaration): void {
      // Anonymous default export: no name, so no brand to match and no
      // "write this instead" to offer (see header).
      if (!node.id) return;
      const name = node.id.name;

      if (node.superClass) {
        context.report({
          node: node.superClass,
          messageId: "classExtends",
          data: { name, super: memberName(node.superClass) },
        });
      }

      let brand: string | undefined;
      let brandNode: TSESTree.ClassElement | undefined;
      let constructor: TSESTree.MethodDefinition | undefined;
      let parse: TSESTree.MethodDefinition | undefined;

      for (const member of node.body.body) {
        const found = brandOf(member);
        if (found !== undefined && brand === undefined) {
          brand = found;
          brandNode = member;
        }

        if (
          member.type === TSESTree.AST_NODE_TYPES.MethodDefinition &&
          member.kind === "constructor"
        ) {
          constructor = member;
          // A parameter property is a property declaration wearing a
          // parameter's clothes, and mutation lands on it just the same.
          for (const param of member.value.params) {
            if (param.type !== TSESTree.AST_NODE_TYPES.TSParameterProperty) continue;
            if (param.readonly) continue;
            context.report({
              node: param,
              messageId: "mutableProperty",
              data: { name, member: memberName(param.parameter) },
            });
          }
        }

        if (isStaticParse(member) && parse === undefined) parse = member;

        // Instance fields only: statics are not domain state, and getters are
        // methods, not a place an assignment can land.
        if (
          member.type === TSESTree.AST_NODE_TYPES.PropertyDefinition &&
          !member.static &&
          !member.readonly
        ) {
          context.report({
            node: member,
            messageId: "mutableProperty",
            data: { name, member: memberName(member.key) },
          });
        }
      }

      if (brand === undefined) {
        context.report({ node: node.id, messageId: "missingBrand", data: { name } });
      } else if (brand !== name) {
        context.report({
          node: brandNode!,
          messageId: "brandMismatch",
          data: { name, brand },
        });
      }

      if (!constructor) {
        context.report({ node: node.id, messageId: "missingPrivateConstructor", data: { name } });
      } else if (constructor.accessibility !== "private") {
        context.report({ node: constructor, messageId: "constructorNotPrivate", data: { name } });
      }

      if (!parse) {
        context.report({ node: node.id, messageId: "missingParse", data: { name } });
        return;
      }
      if (!takesUnknown(parse.value)) {
        context.report({ node: parse, messageId: "parseParamNotUnknown", data: { name } });
      }
      if (!returnsOptionalSelf(parse.value, name)) {
        context.report({ node: parse, messageId: "parseReturnNotOptional", data: { name } });
      }
    }

    // --- the public boundary --------------------------------------------------
    //
    // Same indexing shape as `no-naked-primitives`: classes are collected
    // first and checked afterwards in source order, so `export { Currency }`
    // reaches a class declared above or below it and the gate's output stays
    // stable and greppable.

    const declared = new Map<string, TSESTree.ClassDeclaration[]>();
    const exportedNames = new Set<string>();
    const pending: TSESTree.ClassDeclaration[] = [];
    const checked = new Set<TSESTree.ClassDeclaration>();

    function indexStatement(node: TSESTree.Node, exported: boolean): void {
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.ClassDeclaration: {
          if (node.id) {
            const list = declared.get(node.id.name);
            if (list) list.push(node);
            else declared.set(node.id.name, [node]);
          }
          if (exported) pending.push(node);
          return;
        }
        case TSESTree.AST_NODE_TYPES.TSModuleDeclaration:
          // Ambient namespace: every member of an ambient block is exported.
          if (node.body) {
            for (const stmt of node.body.body) indexStatement(unwrapExport(stmt), true);
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
          switch (stmt.type) {
            case TSESTree.AST_NODE_TYPES.ExportNamedDeclaration:
              if (stmt.declaration) {
                indexStatement(stmt.declaration, true);
              } else if (!stmt.source) {
                // `export { Currency }` — declared locally; resolved below.
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
        pending.sort((a, b) => a.range[0] - b.range[0]);
        for (const node of pending) {
          if (checked.has(node)) continue;
          checked.add(node);
          checkClass(node);
        }
      },
    };
  },
});
