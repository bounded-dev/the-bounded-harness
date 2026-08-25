import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noNakedPrimitives } from "./no-naked-primitives.ts";

// TN-26-001 architect zone rule (issue #3): value objects over primitives on a
// contract's *public* surface. Dogfood evidence (docs/dogfooding.md runs 1-3):
// Haiku shipped `isbn: string` / `pagesRead: number` / `authors: string[]`
// where Sonnet shipped `Isbn` / `PagesRead` / `AuthorName`, and every gate
// passed. This rule is the block that was missing.
//
// The valid[] list is the load-bearing half: a rule that fires on correct
// designs gets switched off. Which files this applies to (**/*.contract.ts)
// is gate wiring, not the rule.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-naked-primitives", noNakedPrimitives, {
  valid: [
    // --- the value-object vocabulary the skill prescribes ---
    'export type Isbn = string & { readonly __brand: "Isbn" };\nexport interface Book { isbn: Isbn }',
    'export type PagesRead = number & { readonly __brand: "PagesRead" };',
    // brand via a helper alias: the primitive sits in a type argument of a
    // type the rule does not see through — caller's choice, not our business
    'export type Isbn = Brand<string, "Isbn">;',
    // string-literal unions ARE value objects (and the enum replacement)
    "export type Status = 'open' | 'paid';\nexport interface Order { status: Status }",
    "export interface Order { status: 'open' | 'paid' }",
    // template-literal types are constrained patterns, not naked strings
    "export type Slug = `${string}-${number}`;",

    // --- non-domain types are out of scope ---
    "export interface Port { save(o: Order): Promise<void> }",
    "export interface X { a: void; b: never; c: unknown; d: boolean; e: symbol }",
    // boolean is deliberately out of scope (see the rule header)
    "export interface Book { archived: boolean }",

    // --- positions where a primitive is correct, not a defect ---
    // index-signature key: TS permits nothing else
    "export interface ByIsbn { [isbn: string]: Book }",
    // Record/Map KEY is an index domain, same reasoning
    "export interface Catalog { byIsbn: Record<string, Book> }",
    "export interface Catalog { byIsbn: ReadonlyMap<string, Book> }",
    // type parameters and their constraints are the caller's choice
    "export interface Box<T> { value: T }",
    "export declare function pick<K extends string>(k: K): K;",
    // opaque generics are not transparent containers — we do not look inside
    "export interface R { result: Result<string, DomainError> }",

    // --- the public boundary only ---
    "interface Internal { isbn: string }", // unexported: not the boundary
    "type Raw = string;", // unexported alias: not the boundary
    // declare class is already nominal — it IS the value object
    "export declare class Money { readonly amount: number;\n  static parse(raw: string): Money;\n}",

    // --- composite shapes built from value objects ---
    "export interface Book { authors: readonly [AuthorName, ...AuthorName[]] }",
    "export interface Book { tags: readonly Tag[] }",
    'export type NewOrder = Omit<Order, "id">;',
    "export declare const DEFAULT_CURRENCY: CurrencyCode;",
    "export default interface Config { level: LogLevel }",
    "",
  ],

  invalid: [
    // --- the three dogfood defects, verbatim ---
    {
      code: "export interface Book { isbn: string }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", primitive: "string" } },
      ],
    },
    {
      code: "export interface ProgressEvent { pagesRead: number }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "pagesRead", brand: "PagesRead", primitive: "number" },
        },
      ],
    },
    {
      code: "export interface Book { authors: string[] }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", primitive: "string" },
        },
      ],
    },
    {
      // Haiku's filter argument, run 2
      code: "export interface BookFilter { author?: string }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "author", brand: "Author", primitive: "string" },
        },
      ],
    },

    // --- aliases are not value objects: assignable from every other string ---
    {
      code: "export type Isbn = string;",
      errors: [
        { messageId: "primitiveAlias", data: { name: "Isbn", primitive: "string" } },
      ],
    },
    {
      code: "export type Id = string | number;",
      errors: [
        { messageId: "primitiveAlias", data: { name: "Id", primitive: "string" } },
        { messageId: "primitiveAlias", data: { name: "Id", primitive: "number" } },
      ],
    },

    // --- declare function / declare const ---
    {
      code: "export declare function findBook(isbn: string): Book;",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", primitive: "string" } },
      ],
    },
    {
      code: "export declare function countBooks(): number;",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "countBooks", brand: "CountBooks", primitive: "number" },
        },
      ],
    },
    {
      code: "export declare const DEFAULT_CURRENCY: string;",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "DEFAULT_CURRENCY", brand: "DefaultCurrency", primitive: "string" },
        },
      ],
    },

    // --- ports get the same treatment as DTOs (see the rule header) ---
    {
      code: "export interface BookStore { get(key: string): Promise<Book | undefined> }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "key", brand: "Key", primitive: "string" } },
      ],
    },
    {
      code: "export interface BookStore { load(): Promise<string> }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "load", brand: "Load", primitive: "string" } },
      ],
    },

    // --- collections: element type is the same sin one level down ---
    {
      code: "export interface Book { readonly tags: readonly string[] }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "tags", brand: "Tag", primitive: "string" },
        },
      ],
    },
    {
      code: "export interface Book { authors: Array<string> }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", primitive: "string" },
        },
      ],
    },
    {
      code: "export interface Book { authors: ReadonlySet<string> }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", primitive: "string" },
        },
      ],
    },
    {
      // a non-empty tuple of naked strings still loses the domain type
      code: "export interface Book { authors: readonly [string, ...string[]] }",
      errors: [{ messageId: "nakedPrimitiveElement" }, { messageId: "nakedPrimitiveElement" }],
    },
    {
      // Record/Map VALUE position is a domain slot (the key is not)
      code: "export interface Catalog { titles: Record<Isbn, string> }",
      errors: [
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "titles", brand: "Title", primitive: "string" },
        },
      ],
    },

    // --- unions, nesting, function-typed members ---
    {
      code: "export interface Book { subtitle: string | undefined }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "subtitle", brand: "Subtitle", primitive: "string" },
        },
      ],
    },
    {
      code: "export interface Book { meta: { isbn: string } }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", primitive: "string" } },
      ],
    },
    {
      code: "export interface Book { onRename: (title: string) => void }",
      errors: [
        {
          messageId: "nakedPrimitive",
          data: { name: "title", brand: "Title", primitive: "string" },
        },
      ],
    },

    // --- every route onto the public boundary is checked ---
    {
      code: "interface Book { isbn: string }\nexport { Book };",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", primitive: "string" } },
      ],
    },
    {
      code: "export default interface Config { host: string }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "host", brand: "Host", primitive: "string" } },
      ],
    },
    {
      code: "export declare namespace Books { interface Repo { get(isbn: string): Book } }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", primitive: "string" } },
      ],
    },

    // --- multiple sins, multiple reports, source order ---
    {
      code: "export interface Book { isbn: string; authors: string[]; pages: number }",
      errors: [
        { messageId: "nakedPrimitive", data: { name: "isbn", brand: "Isbn", primitive: "string" } },
        {
          messageId: "nakedPrimitiveElement",
          data: { name: "authors", brand: "Author", primitive: "string" },
        },
        {
          messageId: "nakedPrimitive",
          data: { name: "pages", brand: "Pages", primitive: "number" },
        },
      ],
    },
  ],
});
