import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";
import {
  LAYER_ORDER,
  layerOf,
  layerRank,
  resolveWithinUi,
  uiRelativePath,
} from "../fsd-layers.ts";

// TN-26-006 zone rule, src/ui/**: imports flow strictly DOWNWARD.
//
// shared < entities < features < widgets < pages. A module may import from its
// own layer or any layer below it, and never from one above.
//
// WHY THIS IS THE LOAD-BEARING LAW. The whole point of the layer split is that
// the lower you go, the less the code knows: `shared` knows no domain at all,
// `entities` know one entity's read model, `features` know one interaction.
// One upward import inverts that — a shared Button that imports a feature's
// form is a Button nobody can reuse and nobody can test alone — and it inverts
// it invisibly, because the code still compiles and still runs. By the time it
// is obvious, the layers are a diagram and not a structure.
//
// It is also the law that is cheapest to break by accident. "I need the
// building's status badge here" is a completely reasonable thought to have in
// `shared/ui`, and the correct answer (pass it in as a prop, or move the
// component up a layer) is only obvious once you already know the rule. So the
// message states the order and names BOTH layers: a worker who has never read
// TN-26-006 should be able to fix the import from the block alone.
//
// NOT THIS RULE'S BUSINESS: anything outside `src/ui/`. A component importing a
// domain value object, a contract, or an npm package is ordinary work — the
// direction being policed here is the UI's own internal one.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

const ORDER = LAYER_ORDER.join(" < ");

export const fsdDownwardImports = createRule<[], "upward">({
  name: "fsd-downward-imports",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      upward:
        "'{{from}}' imports from '{{to}}', which is a HIGHER layer. Imports flow strictly downward " +
        `(${ORDER}): a module may import its own layer or a lower one, never a higher one. ` +
        "Either pass what you need in as a prop from the layer above, or move this module up to " +
        "'{{to}}' if it genuinely belongs there (TN-26-006).",
    },
  },
  defaultOptions: [],
  create(context) {
    const uiFile = uiRelativePath(context.filename);
    if (uiFile === undefined) return {};
    const fromLayer = layerOf(uiFile);
    // A file directly under `src/ui/` — main.tsx, app.tsx — is in no layer and
    // composes everything by design.
    if (fromLayer === undefined) return {};

    const check = (node: TSESTree.Node, specifier: string): void => {
      const target = resolveWithinUi(uiFile, specifier);
      if (target === undefined) return;
      const toLayer = layerOf(target);
      if (toLayer === undefined) return;
      if (layerRank(toLayer) <= layerRank(fromLayer)) return;
      context.report({ node, messageId: "upward", data: { from: fromLayer, to: toLayer } });
    };

    return {
      // Type-only imports are policed exactly like value imports here, unlike
      // the one-door rules. A type is a dependency: a shared component whose
      // props are typed by a feature's model is coupled to that feature, and
      // the fact that the coupling vanishes at runtime does not make it any
      // less of an inversion for the next person reading it.
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
