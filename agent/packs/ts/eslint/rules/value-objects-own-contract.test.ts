import { afterAll, describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { valueObjectsOwnContract } from "./value-objects-own-contract.ts";

// TN-26-001 architect zone rule (ADR 2026-026): a value object and the
// operations over it may not share a contract file. The value object is a
// nominal `declare class` the scaffolder turns into a runtime class; a same-file
// interface / type-alias / operation / const that references it is emitted
// against that runtime identity while the skeleton's conformance check compares
// it against the contract's ambient class — two `__brand` declarations, and the
// skeleton does not compile (the same-file twin of ADR 2026-023, dogfood
// r18/r19). Value objects get their own '*.contract.ts'; operations import them
// from the implementation module.
//
// The valid[] list is the load-bearing half: a rule that fires on correct
// designs gets switched off. It must accept a value-object-only vocabulary file,
// several value objects in one file, and interfaces/operations that reference
// ordinary (non-value-object) types.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

/** The canonical nominal value object, verbatim from ts-contract-authoring. */
const VO = `export declare class BuildingId {
  private readonly __brand: "BuildingId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): BuildingId | undefined;
}`;

ruleTester.run("value-objects-own-contract", valueObjectsOwnContract, {
  valid: [
    // A value-object-only contract file — the shape the rule steers TOWARD.
    VO,
    // Several value objects in one file: a vocabulary module. One value object
    // referencing another (a class member) is fine — a class is never an
    // offender, and nominal classes are excluded from the conformance object.
    `${VO}

export declare class MeterId {
  private readonly __brand: "MeterId";
  private constructor();
  readonly building: BuildingId;
  static parse(raw: unknown): MeterId | undefined;
}`,
    // An operations contract that references NO same-file value object: the
    // value object is imported from the implementation module, the decomposed
    // shape (ADR 2026-023 routes that identity correctly).
    `import type { BuildingId } from "../ids/ids.js";

export interface Report { readonly id: BuildingId; }
export declare function rate(input: Report): number;`,
    // Interfaces and operations over ordinary (non-value-object) types.
    `export interface Report { readonly title: string; }
export declare function makeReport(title: string): Report;
export declare const DEFAULT_TITLE: string;`,
    // An unexported helper class of value-object shape is not a scaffolded
    // runtime export, so referencing it does not clash — not the concern.
    `declare class Internal {
  private readonly __brand: "Internal";
  private constructor();
  static parse(raw: unknown): Internal | undefined;
}
export interface Report { readonly x: Internal; }`,
    // A plain interface/DTO of the same name shape is not a value object (no
    // brand/private constructor/parse), so referencing it is fine.
    `export interface Address { readonly line1: string; }
export declare function ship(to: Address): void;`,
  ],
  invalid: [
    // THE REPRODUCE CASE (kimi's shape): value object + interface referencing it
    // + operation over the interface, all one file. The interface that names the
    // value object is refused (the operation references the interface, not the
    // value object directly, so it is not itself an offender). Full data is
    // asserted so the message provably names the value object to move.
    {
      code: `${VO}

export interface BuildingReportInput { readonly buildingId: BuildingId; }
export declare function rateBuildingReport(input: BuildingReportInput): number;`,
      errors: [
        {
          messageId: "sharesContract",
          data: {
            offenderKind: "interface",
            offender: "BuildingReportInput",
            vos: "'BuildingId'",
            first: "BuildingId",
            s: "",
            their: "its",
            them: "it",
          },
        },
      ],
    },
    // An operation that takes the value object DIRECTLY.
    {
      code: `${VO}

export declare function rate(id: BuildingId): number;`,
      errors: [{ messageId: "sharesContract" }],
    },
    // A declare const of a same-file value-object type.
    {
      code: `${VO}

export declare const ORIGIN: BuildingId;`,
      errors: [{ messageId: "sharesContract" }],
    },
    // A type-alias referencing a same-file value object.
    {
      code: `${VO}

export type BuildingRef = { readonly id: BuildingId };`,
      errors: [{ messageId: "sharesContract" }],
    },
    // A value object referenced through nesting (array element / union) is still
    // a reference — refused.
    {
      code: `${VO}

export declare function rateAll(ids: readonly BuildingId[]): number;`,
      errors: [{ messageId: "sharesContract" }],
    },
    // Two value objects referenced by one interface — the plural message names
    // both, and the report is a single error on the interface.
    {
      code: `${VO}

export declare class MeterId {
  private readonly __brand: "MeterId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): MeterId | undefined;
}

export interface Reading { readonly building: BuildingId; readonly meter: MeterId; }`,
      errors: [
        {
          messageId: "sharesContract",
          data: {
            offenderKind: "interface",
            offender: "Reading",
            vos: "'BuildingId', 'MeterId'",
            first: "BuildingId",
            s: "s",
            their: "their",
            them: "them",
          },
        },
      ],
    },
  ],
});
