import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-004 zone rule, src/**: the shipped service runtime is the ONLY module
// that may touch the RPC framework's raw entry points at runtime. The error
// taxonomy (parse failure → BAD_REQUEST, catch-all → INTERNAL, the named
// throwers for the rest) lives inside `service-runtime.ts` as code; a second
// `initTRPC` elsewhere is a second place the taxonomy can be got wrong, which
// is precisely what shipping ONE implementation exists to prevent.
//
// Type-only imports stay legal everywhere (`import type { TRPCError }` for a
// signature harms nothing — types cannot re-map an error code), and the
// runtime file itself is exempt by name: it is generated, marker-carrying,
// and byte-compared against the pack's canonical copy on every scaffold, so
// an edit to it does not survive a design_gate anyway.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

function isFrameworkModule(source: string): boolean {
  return source === "@trpc/server" || source.startsWith("@trpc/");
}

export const rawFrameworkEntry = createRule<[], "rawEntry">({
  name: "raw-framework-entry",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      rawEntry:
        'a runtime import of "{{source}}" outside service-runtime.ts — the shipped runtime is the one place ' +
        "the framework's raw entry points may be touched, because the error taxonomy lives there as code " +
        "(TN-26-004). Build procedures through createService/command/query from ./service-runtime.js; " +
        "`import type` is fine anywhere.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (context.filename.endsWith("service-runtime.ts")) return {};
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!isFrameworkModule(node.source.value)) return;
        if (node.importKind === "type") return;
        // A value-position import with only inline `type` specifiers is still
        // type-only in effect; report only when some specifier is a value.
        const hasValueSpecifier = node.specifiers.some(
          (s) =>
            s.type !== TSESTree.AST_NODE_TYPES.ImportSpecifier || s.importKind !== "type",
        );
        if (!hasValueSpecifier && node.specifiers.length > 0) return;
        context.report({ node, messageId: "rawEntry", data: { source: node.source.value } });
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (!node.source || !isFrameworkModule(node.source.value)) return;
        if (node.exportKind === "type") return;
        context.report({ node, messageId: "rawEntry", data: { source: node.source.value } });
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        if (!node.source || !isFrameworkModule(node.source.value)) return;
        if (node.exportKind === "type") return;
        context.report({ node, messageId: "rawEntry", data: { source: node.source.value } });
      },
    };
  },
});
