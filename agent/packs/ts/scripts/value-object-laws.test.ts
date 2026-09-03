import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import ts from "typescript";
import {
  HOSTILE_INPUT_EXPRESSIONS,
  ValueObjectLawsError,
  implementationModuleFor,
  lawsPathFor,
  valueObjectLawsSource,
  valueObjectsOf,
} from "./value-object-laws.ts";

const CONTRACT = "src/pricing/pricing.contract.ts";

const CURRENCY = `/**
 * ISO-4217 alphabetic code: exactly three uppercase letters.
 * @accepts "USD"
 * @accepts "EUR"
 */
export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly code: string;
  static parse(raw: unknown): Currency | undefined;
  equals(other: Currency): boolean;
}
`;

// --- paths --------------------------------------------------------------------

describe("output path and implementation specifier", () => {
  test("laws file lives in tests/generated, named after the contract", () => {
    expect(lawsPathFor(CONTRACT)).toBe("tests/generated/pricing.laws.test.ts");
    expect(lawsPathFor("subscription-billing.contract.ts")).toBe(
      "tests/generated/subscription-billing.laws.test.ts",
    );
  });

  test("a non-contract path is rejected", () => {
    expect(() => lawsPathFor("src/pricing/pricing.ts")).toThrow(ValueObjectLawsError);
  });

  test("imports the IMPLEMENTATION sibling, with a NodeNext .js extension", () => {
    expect(implementationModuleFor(CONTRACT)).toBe("../../src/pricing/pricing.js");
    expect(implementationModuleFor("src/money.contract.ts")).toBe("../../src/money.js");
  });

  test("an absolute contract path is rejected — the specifier must be project-relative", () => {
    expect(() => implementationModuleFor("/abs/src/pricing/pricing.contract.ts")).toThrow(
      ValueObjectLawsError,
    );
  });
});

// --- contract reading ---------------------------------------------------------

describe("valueObjectsOf", () => {
  test("an exported class is a value object; @accepts tags are collected in order", () => {
    expect(valueObjectsOf(CURRENCY, CONTRACT)).toEqual([
      { name: "Currency", accepts: ['"USD"', '"EUR"'], hasEquals: true },
    ]);
  });

  test("a class without equals is still a value object", () => {
    const [vo] = valueObjectsOf(
      `export declare class Isbn {
         private readonly __brand: "Isbn";
         static parse(raw: unknown): Isbn | undefined;
       }`,
      CONTRACT,
    );
    expect(vo).toEqual({ name: "Isbn", accepts: [], hasEquals: false });
  });

  test("non-exported classes, interfaces and functions are not value objects", () => {
    expect(
      valueObjectsOf(
        `export interface Money { readonly cents: number }
         export declare function priceOf(x: unknown): Money;
         declare class Hidden { static parse(raw: unknown): Hidden | undefined }`,
        CONTRACT,
      ),
    ).toEqual([]);
  });

  test("a class with no static parse is reported unsupported, not silently dropped", () => {
    const [vo] = valueObjectsOf(`export declare class Odd { readonly n: number }`, CONTRACT);
    expect(vo?.name).toBe("Odd");
    expect(vo?.unsupported).toMatch(/static parse/);
  });

  test("generic and abstract classes are reported unsupported", () => {
    const [box] = valueObjectsOf(
      `export declare class Box<T> { static parse(raw: unknown): Box<unknown> | undefined }`,
      CONTRACT,
    );
    expect(box?.unsupported).toMatch(/generic/);
    const [shape] = valueObjectsOf(
      `export declare abstract class Shape { static parse(raw: unknown): Shape | undefined }`,
      CONTRACT,
    );
    expect(shape?.unsupported).toMatch(/abstract/);
  });
});

// --- loud failures ------------------------------------------------------------

describe("the generator fails loudly rather than emitting a broken file", () => {
  test("a contract with no exported class has no laws to generate", () => {
    expect(() =>
      valueObjectLawsSource(`export declare function f(x: unknown): void;`, CONTRACT),
    ).toThrow(ValueObjectLawsError);
    // An empty vitest file is a suite error, which the red gate reads as
    // "suite did not run" — so refusing to write one is the whole point.
    expect(() =>
      valueObjectLawsSource(`export declare function f(x: unknown): void;`, CONTRACT),
    ).toThrow(/no exported class/);
  });

  test("parse must take `unknown` — a narrower parameter cannot face hostile input", () => {
    expect(() =>
      valueObjectLawsSource(
        `export declare class Currency { static parse(raw: string): Currency | undefined }`,
        CONTRACT,
      ),
    ).toThrow(/unknown/);
  });

  test("parse must be callable with one argument", () => {
    expect(() =>
      valueObjectLawsSource(
        `export declare class Currency { static parse(raw: unknown, strict: boolean): Currency | undefined }`,
        CONTRACT,
      ),
    ).toThrow(/strict/);
  });

  test("`@accepts` mentioned in prose is not a tag — TS's parser says it is", () => {
    // TypeScript parses a mid-sentence @accepts as a real tag, so without the
    // start-of-line rule this doc comment would abort generation.
    const [vo] = valueObjectsOf(
      `/** A code. The architect forgot the @accepts tag. */
       export declare class CouponCode { static parse(raw: unknown): CouponCode | undefined }`,
      CONTRACT,
    );
    expect(vo?.accepts).toEqual([]);
  });

  test("an @accepts tag that is not a single-line expression is rejected", () => {
    expect(() =>
      valueObjectLawsSource(
        `/** @accepts "USD */
         export declare class Currency { static parse(raw: unknown): Currency | undefined }`,
        CONTRACT,
      ),
    ).toThrow(/@accepts/);
  });
});

// --- generated text -----------------------------------------------------------

describe("generated file", () => {
  const source = valueObjectLawsSource(CURRENCY, CONTRACT);

  test("carries the GENERATED header and names its generator", () => {
    expect(source.split("\n")[0]).toBe(
      "// GENERATED from pricing.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.",
    );
  });

  test("the header justifies skipping over failing, because of the red gate", () => {
    expect(source).toMatch(/SKIPPED, never failed/);
    expect(source).toMatch(/wrong-reason red/);
    expect(source).toMatch(/NotImplementedError/);
  });

  test("imports the implementation module, not the contract", () => {
    expect(source).toContain(`import { Currency } from "../../src/pricing/pricing.js";`);
    expect(source).not.toContain("pricing.contract.js");
  });

  test("the hostile corpus is a named const holding every listed input", () => {
    expect(source).toContain("const HOSTILE_INPUTS: readonly (readonly [string, unknown])[] = [");
    expect(HOSTILE_INPUT_EXPRESSIONS).toEqual([
      "undefined",
      "null",
      "true",
      "false",
      "0",
      "-1",
      "NaN",
      "Infinity",
      '""',
      '" "',
      "[]",
      "{}",
      "() => {}",
      'Symbol("x")',
      "new Date()",
      "9007199254740993n",
    ]);
    for (const expr of HOSTILE_INPUT_EXPRESSIONS) {
      expect(source).toContain(`[${JSON.stringify(expr)}, ${expr}],`);
    }
  });

  test("law 1 asserts on the FILTERED ARRAY, so the failure names the culprits", () => {
    expect(source).toMatch(/const wronglyAccepted = HOSTILE_INPUTS\s*\n?\s*\.filter/);
    expect(source).toContain("expect(wronglyAccepted).toEqual([]);");
    // One expect per input would name only the first offender.
    expect(source.match(/expect\(wronglyAccepted\)/g)).toHaveLength(1);
  });

  test("parse is never wrapped in try/catch — the red gate needs the throw", () => {
    // Catching would turn the skeleton's NotImplementedError into a pass, and
    // leave these laws vacuously green at exactly the phase they exist to fail.
    expect(source).not.toMatch(/\btry\s*\{/);
    expect(source).not.toMatch(/\}\s*catch\b/);
  });

  test("emits laws 2, 3 and 4 using the @accepts examples", () => {
    expect(source).toContain(`test("is equal by value, not by reference"`);
    expect(source).toContain(`test("parses deterministically"`);
    expect(source).toContain(`test("equals is reflexive"`);
    expect(source).toContain(`test("equals is symmetric"`);
    expect(source).toContain(`test("equals is not reference-based"`);
    expect(source).toContain(`test("equals discriminates two different valid inputs"`);
    expect(source).toContain(`Currency.parse("USD")`);
    expect(source).toContain(`Currency.parse("EUR")`);
  });

  test("no equals declared ⇒ no equals laws", () => {
    const noEquals = valueObjectLawsSource(
      `/** @accepts "9780306406157" */
       export declare class Isbn { static parse(raw: unknown): Isbn | undefined }`,
      CONTRACT,
    );
    expect(noEquals).toContain(`test("parses deterministically"`);
    expect(noEquals).not.toContain(".equals(");
    expect(noEquals).not.toMatch(/test\("equals /);
  });
});

// --- the missing-@accepts marker ----------------------------------------------

describe("missing @accepts is SKIPPED, never failed", () => {
  const source = valueObjectLawsSource(
    `export declare class Currency {
       static parse(raw: unknown): Currency | undefined;
       equals(other: Currency): boolean;
     }`,
    CONTRACT,
  );

  test("law 1 still runs — it needs no example", () => {
    expect(source).toContain(`test("refuses every hostile input"`);
  });

  test("the rest are test.skip, naming the class and the fix", () => {
    expect(source).toContain("test.skip(");
    expect(source).toMatch(/@accepts/);
    expect(source).toMatch(/Currency/);
    expect(source).toContain("pricing.contract.ts");
  });

  test("expect.fail appears only inside skipped bodies, which never execute", () => {
    // The whole justification for skipping: at the red phase an executed
    // expect.fail would be a wrong-reason red and would block the pipeline.
    expect(source.match(/expect\.fail\(/g)).toHaveLength((source.match(/test\.skip\(/g) ?? []).length);
    expect(source).toContain("test.skip(");
  });

  test("one @accepts is enough for every law except discrimination, which is skipped", () => {
    const one = valueObjectLawsSource(
      `/** @accepts "USD" */
       export declare class Currency {
         static parse(raw: unknown): Currency | undefined;
         equals(other: Currency): boolean;
       }`,
      CONTRACT,
    );
    expect(one).toContain(`test("equals is reflexive"`);
    expect(one).toContain("test.skip(");
    expect(one).toMatch(/second `@accepts`/);
  });

  test("an unsupported class is skipped with its reason, and never imported", () => {
    const src = valueObjectLawsSource(
      `export declare class Odd { readonly n: number }
       /** @accepts "USD" */
       export declare class Currency { static parse(raw: unknown): Currency | undefined }`,
      CONTRACT,
    );
    expect(src).toContain(`import { Currency } from`);
    expect(src).not.toContain("Odd,");
    expect(src).toMatch(/test\.skip\(\s*\n?\s*"Odd:/);
  });
});

// --- the generated file compiles under the dogfood tsconfig -------------------

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** The dogfood target project's compiler options, verbatim from
 *  agent/scripts/dogfood-reset — the settings the generated file must survive. */
const DOGFOOD_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  noEmit: true,
  noUnusedLocals: true,
  types: [],
};

function typecheck(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "vo-laws-test-"));
  tmpDirs.push(dir);
  // NodeNext + verbatimModuleSyntax: without "type": "module" every ESM import
  // in the generated file is an error, exactly as it would be in a real target.
  writeFileSync(join(dir, "package.json"), `{"name":"vo-laws-fixture","type":"module"}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const program = ts.createProgram(
    Object.keys(files).map((f) => join(dir, f)),
    DOGFOOD_OPTIONS,
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? "<global>"}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

// A minimal stand-in for vitest's surface: the real thing is not installed in
// the throwaway project, and the laws only ever use these three.
const VITEST_STUB = `declare module "vitest" {
  export function describe(name: string, fn: () => void): void;
  export const test: {
    (name: string, fn: () => void): void;
    skip(name: string, fn: () => void): void;
  };
  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    not: { toBe(expected: unknown): void };
  };
  export namespace expect {
    function fail(message: string): never;
  }
}
`;

const CURRENCY_IMPL = `export class Currency {
  private constructor(readonly code: string) {}
  static parse(raw: unknown): Currency | undefined {
    return typeof raw === "string" && /^[A-Z]{3}$/.test(raw) ? new Currency(raw) : undefined;
  }
  equals(other: Currency): boolean {
    return this.code === other.code;
  }
}
`;

describe("the generated file typechecks under the dogfood tsconfig", () => {
  test("against a conforming implementation", () => {
    expect(
      typecheck({
        "vitest.d.ts": VITEST_STUB,
        "src/pricing/pricing.ts": CURRENCY_IMPL,
        "tests/generated/pricing.laws.test.ts": valueObjectLawsSource(CURRENCY, CONTRACT),
      }),
    ).toEqual([]);
  });

  test("when every class is skipped (nothing imported, nothing unused)", () => {
    expect(
      typecheck({
        "vitest.d.ts": VITEST_STUB,
        "src/pricing/pricing.ts": "export class Odd { readonly n = 1; }\n",
        "tests/generated/pricing.laws.test.ts": valueObjectLawsSource(
          `export declare class Odd { readonly n: number }`,
          CONTRACT,
        ),
      }),
    ).toEqual([]);
  });
});
