import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import { isSliceRoot, resolveWithinUi, sliceOf, uiRelativePath } from "../fsd-layers.ts";

// TN-26-006 zone rule, src/ui/**: a slice is reached through its public API.
//
// `../building` is fine; `../building/model/query` is not. Inside your own
// slice, reach for anything you like.
//
// WHY. The layer law says which direction a dependency may point; this one says
// how WIDE it may be. A slice's index is the list of things the rest of the app
// is allowed to depend on, which makes everything else in the slice free to
// move, rename, split and delete — and that freedom is the entire return on
// having slices at all. A single deep import silently revokes it: the file is
// now load-bearing for a module that never announced it, and the next person to
// reorganise the slice finds out from a red build somewhere else.
//
// It is also the law a model breaks most naturally, because the deep path is
// the one it just read. `import { useBuilding } from "../building/model/query.js"`
// is a perfectly sensible-looking line — the file exists, the export exists, the
// import resolves — and nothing but this rule ever objects.
//
// SAME-SLICE DEEP IMPORTS ARE FREE, and must be: the slice's own modules are
// how a slice is built, and forcing them through the index would be a cycle.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

export const fsdSlicePublicApi = createRule<[], "deepImport">({
  name: "fsd-slice-public-api",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      deepImport:
        "'{{specifier}}' reaches inside the '{{slice}}' slice. A cross-slice import must target the " +
        "slice root — its index — so the slice keeps one public API and everything else in it stays " +
        "free to move. Export what you need from '{{slice}}/index.ts' and import the slice itself " +
        "(TN-26-006).",
    },
  },
  defaultOptions: [],
  create(context) {
    const uiFile = uiRelativePath(context.filename);
    if (uiFile === undefined) return {};
    const ownSlice = sliceOf(uiFile);

    const check = (node: TSESTree.Node, specifier: string): void => {
      const target = resolveWithinUi(uiFile, specifier);
      if (target === undefined) return;
      const targetSlice = sliceOf(target);
      // Not a sliced layer (shared/**), or not inside a slice at all.
      if (targetSlice === undefined) return;
      // Your own slice's internals are yours.
      if (targetSlice === ownSlice) return;
      if (isSliceRoot(target)) return;
      context.report({ node, messageId: "deepImport", data: { specifier, slice: targetSlice } });
    };

    return {
      // Types are policed too, for the same reason the layer rule polices them:
      // a type imported from three directories inside someone else's slice
      // pins that file's path just as firmly as a value would.
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        check(node, node.source.value);
      },
    };
  },
});
