import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { valueObjectShape } from "./value-object-shape.ts";

// TN-26-001 architect zone rule: an exported class IS a value object, so it
// must have the canonical shape the skill prescribes (ts-contract-authoring,
// "The canonical shape is a nominal class") — private brand, private
// constructor, `static parse(raw: unknown): X | undefined`, readonly fields,
// no `extends`. `no-naked-primitives` deliberately exempts class bodies
// because a class is already nominal; this rule is what makes that exemption
// safe, by checking the class really is one.
//
// The valid[] list is the load-bearing half: a rule that fires on correct
// designs gets switched off. It has to accept both halves of the pack's world
// — the bodiless `export declare class` of a *.contract.ts and the
// parameter-property implementation in the sibling .ts — and everything the
// skill explicitly welcomes (extra smart constructors, behaviour methods,
// getters for derived values).

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

/** The shape the skill prescribes, verbatim from ts-contract-authoring. */
const CANONICAL = `export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly code: string;
  static parse(raw: unknown): Currency | undefined;
  equals(other: Currency): boolean;
}`;

ruleTester.run("value-object-shape", valueObjectShape, {
  valid: [
    // --- the canonical shape, both halves of the world ---
    CANONICAL,
    // the implementation form: parameter property + `#` brand + real bodies
    `export class Money {
      readonly #brand: "Money" = "Money";
      private constructor(readonly amount: number) {}
      static parse(raw: unknown): Money | undefined {
        return typeof raw === "number" ? new Money(raw) : undefined;
      }
    }`,
    // `undefined | X` is the same type as `X | undefined`
    `export declare class Currency {
      private readonly __brand: "Currency";
      private constructor();
      static parse(raw: unknown): undefined | Currency;
    }`,

    // --- everything the skill explicitly welcomes ---
    // extra smart constructors, behaviour, a derived getter, statics
    `export class Money {
      private readonly __brand: "Money";
      static readonly ZERO: Money;
      private constructor(readonly minorUnits: number, readonly currency: Currency) {}
      static parse(raw: unknown): Money | undefined { return undefined; }
      static of(minorUnits: number, currency: Currency): Money { return new Money(minorUnits, currency); }
      get major(): number { return this.minorUnits / 100; }
      plus(other: Money): Money { return other; }
      equals(other: Money): boolean { return this.minorUnits === other.minorUnits; }
      toString(): string { return String(this.minorUnits); }
    }`,
    // an optional readonly field is still readonly
    `export declare class Book {
      private readonly __brand: "Book";
      private constructor();
      readonly title: BookTitle;
      readonly subtitle?: BookTitle;
      static parse(raw: unknown): Book | undefined;
    }`,
    // a private method's locals and parameters are not property declarations
    `export declare class Currency {
      private readonly __brand: "Currency";
      private constructor();
      private static check(raw: string): boolean;
      static parse(raw: unknown): Currency | undefined;
    }`,

    // --- the export boundary is where the rule applies ---
    // `export { X }` reaches a correct class: still nothing to say
    `class Currency {
      private readonly __brand: "Currency";
      private constructor() {}
      static parse(raw: unknown): Currency | undefined { return undefined; }
    }
    export { Currency };`,
    // unexported classes are internal — not the contract's public surface
    "declare class Internal { code: string; constructor(); }",
    // ambient namespace members are exported, and this one is correct
    `export declare namespace Money {
      class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown): Currency | undefined;
      }
    }`,

    // --- non-class exports are somebody else's rule ---
    "export interface Book { readonly isbn: Isbn }",
    'export type Isbn = string & { readonly __brand: "Isbn" };',
    "export declare function parseIsbn(raw: unknown): Isbn | undefined;",
    "",
  ],

  invalid: [
    // --- 1. the brand: without it the class is a DTO in a value object's
    // clothing, structurally assignable from any matching object literal ---
    {
      code: `export declare class Currency {
        private constructor();
        readonly code: string;
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "missingBrand", data: { name: "Currency" } }],
    },
    {
      // a public brand does not flip nominal comparison: an object literal
      // can simply supply it
      code: `export declare class Currency {
        readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "missingBrand", data: { name: "Currency" } }],
    },
    {
      // private, but not a literal type: `string` names nothing
      code: `export declare class Currency {
        private readonly __brand: string;
        private constructor();
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "missingBrand", data: { name: "Currency" } }],
    },
    {
      // THE invisible typo new-value-object.ts exists to prevent
      code: `export declare class Currency {
        private readonly __brand: "Curency";
        private constructor();
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "brandMismatch", data: { name: "Currency", brand: "Curency" } }],
    },
    {
      // copy-pasted from the value object next door
      code: `export class Currency {
        readonly #brand: "Money" = "Money";
        private constructor(readonly code: string) {}
        static parse(raw: unknown): Currency | undefined { return undefined; }
      }`,
      errors: [{ messageId: "brandMismatch", data: { name: "Currency", brand: "Money" } }],
    },

    // --- 2. the private constructor: the single door in ---
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        readonly code: string;
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "missingPrivateConstructor", data: { name: "Currency" } }],
    },
    {
      code: `export class Currency {
        private readonly __brand: "Currency";
        constructor(readonly code: string) {}
        static parse(raw: unknown): Currency | undefined { return undefined; }
      }`,
      errors: [{ messageId: "constructorNotPrivate", data: { name: "Currency" } }],
    },
    {
      // `protected` is not private: a subclass can still skip parse
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        protected constructor();
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "constructorNotPrivate", data: { name: "Currency" } }],
    },

    // --- 3. static parse: missing, wrong parameter, wrong return ---
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        readonly code: string;
      }`,
      errors: [{ messageId: "missingParse", data: { name: "Currency" } }],
    },
    {
      // an instance `parse` cannot be the boundary: it needs an instance first
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "missingParse", data: { name: "Currency" } }],
    },
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: string): Currency | undefined;
      }`,
      errors: [{ messageId: "parseParamNotUnknown", data: { name: "Currency" } }],
    },
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(): Currency | undefined;
      }`,
      errors: [{ messageId: "parseParamNotUnknown", data: { name: "Currency" } }],
    },
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown, strict: boolean): Currency | undefined;
      }`,
      errors: [{ messageId: "parseParamNotUnknown", data: { name: "Currency" } }],
    },
    {
      // returning the bare class means failure has to throw
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown): Currency;
      }`,
      errors: [{ messageId: "parseReturnNotOptional", data: { name: "Currency" } }],
    },
    {
      // parse is pure and synchronous; the boundary is not IO
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown): Promise<Currency | undefined>;
      }`,
      errors: [{ messageId: "parseReturnNotOptional", data: { name: "Currency" } }],
    },
    {
      // copy-paste again: parse hands back the neighbouring value object
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        static parse(raw: unknown): Money | undefined;
      }`,
      errors: [{ messageId: "parseReturnNotOptional", data: { name: "Currency" } }],
    },

    // --- 4. readonly fields: parse validated the value, nothing may rewrite it ---
    {
      code: `export declare class Currency {
        private readonly __brand: "Currency";
        private constructor();
        code: string;
        static parse(raw: unknown): Currency | undefined;
      }`,
      errors: [{ messageId: "mutableProperty", data: { name: "Currency", member: "code" } }],
    },
    {
      // a parameter property is a property declaration too
      code: `export class Currency {
        private readonly __brand: "Currency";
        private constructor(private code: string) {}
        static parse(raw: unknown): Currency | undefined { return undefined; }
      }`,
      errors: [{ messageId: "mutableProperty", data: { name: "Currency", member: "code" } }],
    },

    // --- 5. extends: a value object is a leaf ---
    {
      code: `export class Money extends Amount {
        private readonly __brand: "Money";
        private constructor(readonly minorUnits: number) { super(); }
        static parse(raw: unknown): Money | undefined { return undefined; }
      }`,
      errors: [{ messageId: "classExtends", data: { name: "Money", super: "Amount" } }],
    },

    // --- the whole failure at once: the shape an agent reaches for by
    // default, which every gate used to pass ---
    {
      code: `export class Currency {
        constructor(public code: string) {}
      }`,
      errors: [
        { messageId: "missingBrand", data: { name: "Currency" } },
        { messageId: "missingParse", data: { name: "Currency" } },
        { messageId: "constructorNotPrivate", data: { name: "Currency" } },
        { messageId: "mutableProperty", data: { name: "Currency", member: "code" } },
      ],
    },

    // --- every route onto the public boundary is checked ---
    {
      code: `class Currency {
        private constructor() {}
        static parse(raw: unknown): Currency | undefined { return undefined; }
      }
      export { Currency };`,
      errors: [{ messageId: "missingBrand", data: { name: "Currency" } }],
    },
    {
      code: `export default class Currency {
        private constructor() {}
        static parse(raw: unknown): Currency | undefined { return undefined; }
      }`,
      errors: [{ messageId: "missingBrand", data: { name: "Currency" } }],
    },
    {
      code: `export declare namespace Money {
        class Currency {
          private readonly __brand: "Currency";
          private constructor();
        }
      }`,
      errors: [{ messageId: "missingParse", data: { name: "Currency" } }],
    },
  ],
});
