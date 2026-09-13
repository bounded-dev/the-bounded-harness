import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import ts from "typescript";
import {
  HOSTILE_INPUT_EXPRESSIONS,
  ValueObjectLawsError,
  hostileExpressionsFor,
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
      // base "string" is inferred from the @accepts examples: Currency's nominal
      // field is `code`, not `value`, so the field read falls through.
      { name: "Currency", accepts: ['"USD"', '"EUR"'], hasEquals: true, hasToJson: false, base: "string" },
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
    expect(vo).toEqual({ name: "Isbn", accepts: [], hasEquals: false, hasToJson: false });
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

  // TN-26-004: toJSON() is the opt-in for the wire round-trip law. CURRENCY
  // declares none, so the law must be absent — a law generated for a value
  // object with no wire form would fail on every landlocked domain type.
  test("no toJSON, no round-trip law", () => {
    expect(source).not.toContain("round-trips through its wire form");
  });

  test("a declared toJSON() generates the wire round-trip law", () => {
    const withWire = CURRENCY.replace(
      "  equals(other: Currency): boolean;",
      "  equals(other: Currency): boolean;\n  toJSON(): string;",
    );
    const generated = valueObjectLawsSource(withWire, CONTRACT);
    expect(generated).toContain('test("round-trips through its wire form"');
    expect(generated).toContain("JSON.parse(JSON.stringify(v))");
    expect(generated).toContain("Currency.parse(wire)");
    expect(generated).toContain("expect(again).toStrictEqual(v);");
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

// --- base-typed hostile inputs (ADR 2026-024, dogfood run r17) -----------------
//
// r17's cockpit domain was the first with NUMERIC value objects. The universal
// hostile corpus asserted that `parse(0)` and `parse(-1)` MUST return undefined,
// but a Kelvin of 0–80 or a Fraction of 0–1 correctly ACCEPTS them — and the
// equality laws call `parse(<@accepts example>)` and REQUIRE success, so the
// same call was both required to pass and asserted hostile. The fix filters the
// corpus by the VO's base primitive.

/** Run a generated laws file for real: transpile to CJS, feed it a tiny vitest
 *  shim and the given implementation modules, and return the law failures. A
 *  green suite returns []. This is the end-to-end that a source-shape assertion
 *  alone cannot give — it proves a correct impl actually passes every law. */
function runGeneratedLaws(source: string, modules: Record<string, unknown>): string[] {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const failures: string[] = [];
  const fmt = (v: unknown): string => {
    try {
      return typeof v === "bigint" ? `${v}n` : JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  };
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    const ak = Reflect.ownKeys(a as object);
    const bk = Reflect.ownKeys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqual((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k]),
    );
  };

  const matchers = (actual: unknown) => ({
    toBe: (e: unknown) => {
      if (!Object.is(actual, e)) throw new Error(`expected ${fmt(actual)} toBe ${fmt(e)}`);
    },
    toEqual: (e: unknown) => {
      if (!deepEqual(actual, e)) throw new Error(`expected ${fmt(actual)} toEqual ${fmt(e)}`);
    },
    toStrictEqual: (e: unknown) => {
      if (!deepEqual(actual, e)) throw new Error(`expected ${fmt(actual)} toStrictEqual ${fmt(e)}`);
    },
    not: {
      toBe: (e: unknown) => {
        if (Object.is(actual, e)) throw new Error(`expected ${fmt(actual)} not toBe ${fmt(e)}`);
      },
    },
  });
  const expect = Object.assign((actual: unknown) => matchers(actual), {
    fail: (m: string) => {
      throw new Error(m);
    },
  });
  const test = Object.assign(
    (name: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    },
    { skip: () => {} },
  );
  const describe = (_name: string, fn: () => void) => fn();
  const vitest = { describe, test, expect };

  const require = (id: string): unknown => {
    if (id === "vitest") return vitest;
    if (id in modules) return modules[id];
    throw new Error(`unexpected import ${id}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("require", "exports", "module", js)(require, {}, { exports: {} });
  return failures;
}

const IMPL = "./impl.js";

// A correct range-checking numeric value object: accepts 0..80 inclusive
// (so parse(0) and parse(20) succeed), rejects out-of-range, NaN, Infinity and
// every non-number. This is what the architect refused to break in r17.
class KelvinImpl {
  private constructor(readonly value: number) {}
  static parse(raw: unknown): KelvinImpl | undefined {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
    if (raw < 0 || raw > 80) return undefined;
    return new KelvinImpl(raw);
  }
}

const KELVIN = `/**
 * Absolute temperature in the cockpit range.
 * @accepts 20
 */
export declare class Kelvin {
  private readonly __brand: "Kelvin";
  private constructor();
  readonly value: number;
  static parse(raw: unknown): Kelvin | undefined;
}
`;

describe("numeric value objects: 0 and -1 are range decisions, not hostile", () => {
  test("base is read from the nominal `readonly value: number` field", () => {
    const [kelvin] = valueObjectsOf(KELVIN, CONTRACT);
    expect(kelvin?.base).toBe("number");
  });

  test("Kelvin's hostile set drops 0/-1 but keeps cross-type and pathological inputs", () => {
    const [kelvin] = valueObjectsOf(KELVIN, CONTRACT);
    const hostiles = hostileExpressionsFor(kelvin!);
    // The r17 bug: these two were asserted hostile to a numeric VO.
    expect(hostiles).not.toContain("0");
    expect(hostiles).not.toContain("-1");
    // Cross-type inputs (strings, booleans, bigint, containers) and same-type
    // pathological sentinels stay hostile — a Kelvin must still reject them all.
    expect(hostiles).toEqual(
      expect.arrayContaining([
        "undefined",
        "null",
        "true",
        "false",
        "NaN",
        "Infinity",
        '""',
        '" "',
        "[]",
        "{}",
        "9007199254740993n",
      ]),
    );
  });

  test("a correct range-checking Kelvin passes every generated law (end to end)", () => {
    const source = valueObjectLawsSource(KELVIN, CONTRACT, { implementationModule: IMPL });
    expect(runGeneratedLaws(source, { [IMPL]: { Kelvin: KelvinImpl } })).toEqual([]);
  });

  test("the pre-fix corpus WOULD have failed this impl — 0 and -1 were the culprits", () => {
    // Prove the reproduce is real: had the law asserted on 0/-1 (the old
    // behaviour), KelvinImpl.parse(0) succeeding would have named them.
    const wronglyAccepted = HOSTILE_INPUT_EXPRESSIONS.filter((expr) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const raw = new Function(`return (${expr});`)();
      return KelvinImpl.parse(raw) !== undefined;
    });
    expect(wronglyAccepted).toEqual(["0"]); // -1 is out of range; 0 is the accepted boundary
  });
});

describe("string value objects still reject cross-type numbers, not range-dependent strings", () => {
  const ISBN = `export declare class Isbn {
     private readonly __brand: "Isbn";
     private constructor();
     readonly value: string;
     /** @accepts "9780306406157" */
     static parse(raw: unknown): Isbn | undefined;
     equals(other: Isbn): boolean;
   }`;

  class IsbnImpl {
    private constructor(readonly value: string) {}
    static parse(raw: unknown): IsbnImpl | undefined {
      return typeof raw === "string" && /^\d{13}$/.test(raw) ? new IsbnImpl(raw) : undefined;
    }
    equals(other: IsbnImpl): boolean {
      return this.value === other.value;
    }
  }

  test("base is read from `readonly value: string`", () => {
    const [isbn] = valueObjectsOf(ISBN, CONTRACT);
    expect(isbn?.base).toBe("string");
  });

  test("cross-type numbers stay hostile; same-type empty/blank strings do not", () => {
    const [isbn] = valueObjectsOf(ISBN, CONTRACT);
    const hostiles = hostileExpressionsFor(isbn!);
    expect(hostiles).toEqual(expect.arrayContaining(["0", "-1", "NaN", "Infinity"]));
    expect(hostiles).not.toContain('""');
    expect(hostiles).not.toContain('" "');
  });

  test("a correct Isbn passes every generated law (end to end)", () => {
    const source = valueObjectLawsSource(ISBN, CONTRACT, { implementationModule: IMPL });
    expect(runGeneratedLaws(source, { [IMPL]: { Isbn: IsbnImpl } })).toEqual([]);
  });
});

describe("a VO's hostile set never contains its own @accepts examples (belt and braces)", () => {
  test("a numeric VO that accepts 0 excludes 0 from its hostile set", () => {
    const [zero] = valueObjectsOf(
      `/** @accepts 0 */
       export declare class Zero {
         readonly value: number;
         static parse(raw: unknown): Zero | undefined;
       }`,
      CONTRACT,
    );
    expect(hostileExpressionsFor(zero!)).not.toContain("0");
  });

  test("across a multi-VO contract, no VO's hostile set overlaps its @accepts", () => {
    const contract = `/** @accepts 20 */
      export declare class Kelvin { readonly value: number; static parse(raw: unknown): Kelvin | undefined; }
      /** @accepts "USD" */
      export declare class Currency { readonly value: string; static parse(raw: unknown): Currency | undefined; }`;
    for (const vo of valueObjectsOf(contract, CONTRACT)) {
      const hostiles = hostileExpressionsFor(vo);
      for (const accepted of vo.accepts) expect(hostiles).not.toContain(accepted);
    }
  });
});
