import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noCrossContractTypeImport } from "./no-cross-contract-type-import.ts";

// TN-26-001 architect zone rule (ADR 2026-027): a contract may not import or
// re-export types from another `*.contract.ts` — it reaches across a component
// boundary through the IMPLEMENTATION module. The cross-file twin of
// value-objects-own-contract (ADR 2026-026); together they put the whole "one
// identity per value object" concern (ADR 2026-023) at contract-purity.
//
// The valid[] list is the load-bearing half: the correct form — importing the
// implementation module — must lint clean, or the rule steers nowhere.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-cross-contract-type-import", noCrossContractTypeImport, {
  valid: [
    // THE CORRECT FORM: reach the sibling component through its implementation
    // module, which re-exports every type its own contract declares.
    `import type { Foo } from "../b/b.js";
export interface R { readonly f: Foo; }
export declare function rate(r: R): R;`,
    // Third-party and node types are never contract modules.
    `import type { Buffer } from "node:buffer";
export declare function encode(b: Buffer): Buffer;`,
    // A same-package non-contract module.
    `import type { Foo } from "./foo.js";
export declare function use(f: Foo): Foo;`,
    // Re-exporting an implementation module is the correct barrel form.
    `export type { Foo } from "../b/b.js";`,
    // A bare local re-export reaches no module — nothing to check.
    `interface Foo { readonly x: string }
export type { Foo };`,
  ],
  invalid: [
    // THE REPRODUCE CASE: contract A imports a type from contract B. The message
    // names the type to move and the implementation specifier to import instead.
    {
      code: `import type { Foo } from "../b/b.contract.js";
export interface R { readonly f: Foo; }
export declare function rate(r: R): R;`,
      errors: [
        {
          messageId: "crossContractImport",
          data: { what: "Foo", source: "../b/b.contract.js", impl: "../b/b.js" },
        },
      ],
    },
    // Extensionless contract specifier — the impl form keeps the bare shape.
    {
      code: `import type { Foo } from "./values.contract";
export declare function use(f: Foo): Foo;`,
      errors: [
        {
          messageId: "crossContractImport",
          data: { what: "Foo", source: "./values.contract", impl: "./values" },
        },
      ],
    },
    // A `.ts` specifier resolves the same way (extension preserved).
    {
      code: `import type { A, B } from "../vocab/vocab.contract.ts";
export declare function use(a: A): B;`,
      errors: [
        {
          messageId: "crossContractImport",
          data: { what: "A, B", source: "../vocab/vocab.contract.ts", impl: "../vocab/vocab.ts" },
        },
      ],
    },
    // A type re-export from another contract launders the second identity into
    // this contract's own surface — the identical defect one level further out.
    {
      code: `export type { Foo } from "../b/b.contract.js";`,
      errors: [
        {
          messageId: "crossContractReexport",
          data: { what: "Foo", source: "../b/b.contract.js", impl: "../b/b.js" },
        },
      ],
    },
    // `export * from` a contract is the same laundering with no named types.
    {
      code: `export type * from "../b/b.contract.js";`,
      errors: [
        {
          messageId: "crossContractReexport",
          data: { what: "types", source: "../b/b.contract.js", impl: "../b/b.js" },
        },
      ],
    },
  ],
});
