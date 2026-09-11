import { declarationOnly } from "./rules/declaration-only.ts";
import { noBrandedAliases } from "./rules/no-branded-aliases.ts";
import { noCrossContractTypeImport } from "./rules/no-cross-contract-type-import.ts";
import { noNakedPrimitives } from "./rules/no-naked-primitives.ts";
import { valueObjectDocumented } from "./rules/value-object-documented.ts";
import { valueObjectShape } from "./rules/value-object-shape.ts";
import { valueObjectsOwnContract } from "./rules/value-objects-own-contract.ts";

// pi-harness-ts ESLint plugin (TN-26-001 zone lint rules, ADR 2026-007).
// Loaded programmatically by the gate scripts — target projects never
// hand-wire it; the contract-purity gate owns the flat config:
//   files: ["src/**/*.contract.ts"] → pi-harness-ts/declaration-only
//                                   → pi-harness-ts/no-naked-primitives
export const plugin = {
  meta: { name: "eslint-plugin-pi-harness-ts", version: "0.0.0" },
  rules: {
    "declaration-only": declarationOnly,
    "no-naked-primitives": noNakedPrimitives,
    "no-branded-aliases": noBrandedAliases,
    "value-object-shape": valueObjectShape,
    "value-object-documented": valueObjectDocumented,
    "value-objects-own-contract": valueObjectsOwnContract,
    "no-cross-contract-type-import": noCrossContractTypeImport,
  },
} as const;

export default plugin;
