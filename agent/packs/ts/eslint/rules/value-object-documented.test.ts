import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { valueObjectDocumented } from "./value-object-documented.ts";

// TN-26-001 architect zone rule: every exported class (i.e. every value
// object — see `value-object-shape` for that assumption) carries a doc comment
// saying what makes an instance valid. `value-object-shape` checks the class
// is nominal; this one checks the class says what it means, because the shape
// is exactly the part of a value object that no downstream reader can infer.
//
// The valid[] list is the load-bearing half: a rule that fires on correct
// designs gets switched off — so a one-line JSDoc, a multi-line one with
// tags, and every export route all have to pass.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("value-object-documented", valueObjectDocumented, {
  valid: [
    // --- the shape the skill prescribes, verbatim ---
    `/** ISO-4217 alphabetic code: exactly three uppercase letters. */
    export declare class Currency {
      private readonly __brand: "Currency";
      private constructor();
      static parse(raw: unknown): Currency | undefined;
    }`,
    // multi-line, with the axes spelled out — what the test-writer needs
    `/**
     * A 13-digit ISBN: 13 digits, optionally hyphenated, with a valid
     * check digit. Rejects ISBN-10 and rejects a wrong check digit.
     */
    export class Isbn {
      private readonly __brand: "Isbn";
      private constructor(readonly digits: string) {}
      static parse(raw: unknown): Isbn | undefined { return undefined; }
    }`,
    // tags after the prose are fine — the body is non-empty
    `/**
     * Positive minor units of a currency.
     * @see spec.md "Money"
     */
    export declare class Money { private readonly __brand: "Money"; }`,
    // a single-line block that happens to hold the whole rule
    `/** Exactly three uppercase ASCII letters. */ export declare class Currency {}`,

    // --- every export route, documented ---
    `/** Exactly three uppercase letters. */
    export default class Currency {}`,
    `/** Exactly three uppercase letters. */
    class Currency {}
    export { Currency };`,
    `export declare namespace Money {
      /** Exactly three uppercase letters. */
      class Currency {}
    }`,

    // --- not the trigger ---
    // unexported: internal scaffolding, not the contract's surface
    "class Internal {}",
    // interfaces and aliases are ports/DTOs — a different rule's business
    "export interface Book { readonly isbn: Isbn }",
    'export type Isbn = string & { readonly __brand: "Isbn" };',
    "",
  ],

  invalid: [
    // --- absent ---
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },
    {
      // a line comment is not a doc comment: nothing downstream reads it as one
      code: `// ISO-4217 alphabetic code: exactly three uppercase letters.
      export declare class Currency {}`,
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },
    {
      // a plain block comment is not JSDoc either
      code: `/* ISO-4217 alphabetic code. */
      export declare class Currency {}`,
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },
    {
      // the comment belongs to the member, not the class
      code: `export declare class Currency {
        /** The three-letter code. */
        readonly code: string;
      }`,
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },

    // --- present but says nothing ---
    {
      code: `/** */
      export declare class Currency {}`,
      errors: [{ messageId: "emptyDoc", data: { name: "Currency" } }],
    },
    {
      code: `/**
       *
       */
      export declare class Currency {}`,
      errors: [{ messageId: "emptyDoc", data: { name: "Currency" } }],
    },

    // --- every export route is checked ---
    {
      code: "export default class Currency {}",
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },
    {
      code: `class Currency {}
      export { Currency };`,
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },
    {
      code: `export declare namespace Money {
        class Currency {}
      }`,
      errors: [{ messageId: "missingDoc", data: { name: "Currency" } }],
    },

    // --- one report per undocumented value object, in source order ---
    {
      code: `/** Exactly three uppercase letters. */
      export declare class Currency {}
      export declare class Money {}
      export declare class Isbn {}`,
      errors: [
        { messageId: "missingDoc", data: { name: "Money" } },
        { messageId: "missingDoc", data: { name: "Isbn" } },
      ],
    },
  ],
});
