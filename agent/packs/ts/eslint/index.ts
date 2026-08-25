import { declarationOnly } from "./rules/declaration-only.ts";

// pi-harness-ts ESLint plugin (TN-26-001 zone lint rules, ADR 2026-007).
// Loaded programmatically by the gate scripts — target projects never
// hand-wire it; the contract-purity gate owns the flat config:
//   files: ["src/**/*.contract.ts"] → pi-harness-ts/declaration-only
export const plugin = {
  meta: { name: "eslint-plugin-pi-harness-ts", version: "0.0.0" },
  rules: {
    "declaration-only": declarationOnly,
  },
} as const;

export default plugin;
