import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-001 architect zone rule: every exported class carries a doc comment
// stating what makes an instance valid.
//
//   /** ISO-4217 alphabetic code: exactly three uppercase letters. */
//   export declare class Currency { … }
//
// The trigger is the same as `value-object-shape`'s, and rests on the same
// assumption: in this pack's contract style ports, DTOs and aggregates are
// interfaces, so an exported class IS a value object. That rule checks the
// class is nominal; this one checks it says what it means.
//
// --- Why this is a gate and not advice -----------------------------------------
//
// The test-writer reads spec.md and the contract. Nothing else — not the
// implementation (it does not exist yet), not the architect's reasoning, not
// this conversation. So a validity rule that lives only in the architect's
// head is a rule the test-writer has to invent: it guesses "three letters",
// the builder guesses "any non-empty string", both are internally consistent,
// both pass their own gates, and they agree only by luck. The same failure as
// an unstated precondition order, and just as invisible on review — the suite
// is green, the types line up, and the domain rule is whatever the last agent
// assumed.
//
// The generated law suite covers what is true of *every* value object (parse
// refuses null, [], 42, "", a Date). It cannot cover the case that matters:
// an input of the right base type and the wrong value. `"usd"` is a string —
// only someone told what a currency is knows it must fail. This comment is
// how they are told, which is why an empty `/** */` is reported as loudly as
// no comment at all: it satisfies a checklist and hands the reader nothing.
//
// --- SCOPE ---------------------------------------------------------------------
//
// * **Presence, not quality.** The rule cannot judge whether "the code" is a
//   useful description; it checks there is a non-whitespace body. Whether the
//   stated rule has as many axes as the real one (case, length, character
//   class…) is the architect's judgement, and the skill's brief for the
//   test-writer is where that is pressed.
// * **JSDoc block comments only.** A `//` line comment above a class is not
//   read as documentation by editors, by `tsc`'s quick-info, or by an agent
//   scanning a contract for the domain rules — so it does not count, and the
//   message says so rather than leaving the author to guess why.
// * **Only exported classes**, by every route (`export class`,
//   `export declare class`, `export default class`, `export { Currency }`,
//   ambient namespace members). An anonymous default-export class is skipped:
//   `value-object-shape` already treats it as out of scope.
// * **Interfaces, type aliases and functions are untouched.** Documenting a
//   DTO is good manners; documenting a value object is the difference between
//   a test-writer that knows the rule and one that invents it. Only the second
//   is worth a gate.
//
// Error messages are written for an agent reader, not a human (TN appendix,
// Kinney: "write lint error messages like prompts"): each names the sin AND
// the exact declaration to write instead.

type MessageId = "missingDoc" | "emptyDoc";

const WHY =
  "The test-writer reads only spec.md and this contract — not the implementation, which does not exist yet. An unstated rule is a rule it has to invent: it guesses 'three letters', the builder guesses 'any non-empty string', both suites go green, and they agree only by luck.";

const EXAMPLE =
  'Write the rule directly above the class, e.g. /** ISO-4217 alphabetic code: exactly three uppercase letters. */ — name every axis it has (length, case, character class, range), because each axis is a rejection case the test-writer can then choose deliberately instead of guessing.';

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** A JSDoc block comment — the only form editors, tsc quick-info and an
 *  agent scanning a contract all read as documentation. */
function isJsDoc(comment: TSESTree.Comment): boolean {
  return comment.type === TSESTree.AST_TOKEN_TYPES.Block && comment.value.startsWith("*");
}

/** The prose inside a JSDoc block, with the leading `*` of each line stripped.
 *  Empty means the comment documents nothing. */
function jsDocBody(comment: TSESTree.Comment): string {
  return comment.value
    .slice(1)
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, ""))
    .join("\n")
    .trim();
}

export const valueObjectDocumented = createRule<[], MessageId>({
  name: "value-object-documented",
  meta: {
    type: "problem",
    messages: {
      missingDoc: `Every value object states what makes it valid (TN-26-001, ts-contract-authoring): exported class '{{name}}' has no doc comment. ${EXAMPLE} ${WHY} A '//' line comment does not count — use a '/** … */' block, directly above 'class {{name}}' (above the 'export', if it is exported inline).`,
      emptyDoc: `Every value object states what makes it valid (TN-26-001, ts-contract-authoring): exported class '{{name}}' has an empty doc comment, which satisfies a checklist and tells the reader nothing. Fill it in: /** … what makes a {{name}} valid … */ ${EXAMPLE} ${WHY}`,
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;

    /** `node` is the class; `docNode` is where its doc comment sits — the
     *  export statement when the class is exported inline (`export class X`),
     *  the class itself when it is exported separately (`export { X }`). */
    interface Candidate {
      readonly node: TSESTree.ClassDeclaration;
      readonly docNode: TSESTree.Node;
    }

    function checkClass({ node, docNode }: Candidate): void {
      // Anonymous default export: no name to document, and out of scope for
      // `value-object-shape` too (see header).
      if (!node.id) return;
      const name = node.id.name;
      const comments = sourceCode.getCommentsBefore(docNode);
      const last = comments[comments.length - 1];
      if (!last || !isJsDoc(last)) {
        context.report({ node: node.id, messageId: "missingDoc", data: { name } });
        return;
      }
      if (jsDocBody(last) === "") {
        context.report({ node: node.id, messageId: "emptyDoc", data: { name } });
      }
    }

    // --- the public boundary --------------------------------------------------
    //
    // Same indexing shape as `no-naked-primitives` and `value-object-shape`:
    // classes are collected first and checked afterwards in source order, so
    // `export { Currency }` reaches a class declared either side of it and the
    // gate's output stays stable and greppable.

    const declared = new Map<string, Candidate[]>();
    const exportedNames = new Set<string>();
    const pending: Candidate[] = [];
    const checked = new Set<TSESTree.ClassDeclaration>();

    function indexStatement(node: TSESTree.Node, docNode: TSESTree.Node, exported: boolean): void {
      switch (node.type) {
        case TSESTree.AST_NODE_TYPES.ClassDeclaration: {
          const candidate: Candidate = { node, docNode };
          if (node.id) {
            const list = declared.get(node.id.name);
            if (list) list.push(candidate);
            else declared.set(node.id.name, [candidate]);
          }
          if (exported) pending.push(candidate);
          return;
        }
        case TSESTree.AST_NODE_TYPES.TSModuleDeclaration:
          // Ambient namespace: every member of an ambient block is exported.
          if (node.body) {
            for (const stmt of node.body.body) indexStatement(unwrapExport(stmt), stmt, true);
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
                // The doc comment sits above `export`, not above `class`.
                indexStatement(stmt.declaration, stmt, true);
              } else if (!stmt.source) {
                for (const spec of stmt.specifiers) {
                  if (spec.local.type === TSESTree.AST_NODE_TYPES.Identifier) {
                    exportedNames.add(spec.local.name);
                  }
                }
              }
              break;
            case TSESTree.AST_NODE_TYPES.ExportDefaultDeclaration:
              indexStatement(stmt.declaration as TSESTree.Node, stmt, true);
              break;
            default:
              indexStatement(stmt, stmt, false);
          }
        }
        for (const name of exportedNames) {
          for (const candidate of declared.get(name) ?? []) pending.push(candidate);
        }
        pending.sort((a, b) => a.node.range[0] - b.node.range[0]);
        for (const candidate of pending) {
          if (checked.has(candidate.node)) continue;
          checked.add(candidate.node);
          checkClass(candidate);
        }
      },
    };
  },
});
