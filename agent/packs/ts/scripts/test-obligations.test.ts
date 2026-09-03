import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  BOUNDARY_DASH,
  MIN_REJECTIONS,
  boundaryDescribeName,
  boundaryRemedyLines,
  checkBoundaryBlocks,
  declaredExports,
  readContracts,
  readHandWrittenTests,
  reachedName,
  reachedNames,
  unreachedExports,
  unreachedRemedyLines,
  valueObjectClasses,
} from "./test-obligations.ts";
import type { SourceText, ValueObjectClass } from "./test-obligations.ts";

// --- fixtures ------------------------------------------------------------------

/** The canonical value-object shape from the ts-contract-authoring skill. */
const CURRENCY_CONTRACT = `
/** ISO-4217 alphabetic code: exactly three uppercase letters. */
export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly code: string;
  static parse(raw: unknown): Currency | undefined;
  equals(other: Currency): boolean;
}

export type Isbn = string & { readonly __brand: "Isbn" };

export declare function parseIsbn(raw: string): Isbn | undefined;
`;

function contract(source: string, file = "src/money/money.contract.ts"): SourceText[] {
  return [{ file, source }];
}

function tests(source: string, file = "tests/money.test.ts"): SourceText[] {
  return [{ file, source }];
}

const CURRENCY = (): ValueObjectClass[] => valueObjectClasses(contract(CURRENCY_CONTRACT));

/** A well-formed boundaries block: one acceptance, two distinct string rejections. */
const GOOD_BLOCK = `
import { describe, expect, test } from "vitest";
import { Currency } from "../src/money/money.ts";

describe("Currency ${BOUNDARY_DASH} boundaries", () => {
  test("accepts an ISO code", () => {
    expect(Currency.parse("USD")).toBeDefined();
  });
  test("rejects lowercase", () => {
    expect(Currency.parse("usd")).toBeUndefined();
  });
  test("rejects the wrong length", () => {
    expect(Currency.parse("USDD")).toBeUndefined();
  });
});
`;

// --- checker 1: export reachability ---------------------------------------------

describe("reachedName", () => {
  test("reads the export name out of a real NotImplementedError message", () => {
    // What the shared errors module actually produces: the class name, then
    // the message, which is itself prefixed with "NotImplemented: ".
    expect(reachedName("NotImplementedError: NotImplemented: create")).toBe("create");
  });

  test("reads a Class.member label", () => {
    expect(reachedName("NotImplementedError: NotImplemented: Currency.parse")).toBe("Currency.parse");
  });

  test("reads the bare NotImplemented form", () => {
    expect(reachedName("NotImplemented: parseIsbn")).toBe("parseIsbn");
  });

  test("survives the sanitizer's surviving trailer lines", () => {
    const message = "NotImplementedError: NotImplemented: parseIsbn\n\nExpected: not [Function]\nReceived: [path]";
    expect(reachedName(message)).toBe("parseIsbn");
  });

  test("finds the error line when it is not the first line", () => {
    expect(reachedName("Error thrown while running test\nNotImplementedError: NotImplemented: renew")).toBe("renew");
  });

  test("returns undefined for a failure that reached nothing nameable", () => {
    expect(reachedName("AssertionError: expected 1 to be 2")).toBeUndefined();
    expect(reachedName(undefined)).toBeUndefined();
    expect(reachedName("NotImplementedError")).toBeUndefined();
    expect(reachedName("NotImplementedError: NotImplemented:")).toBeUndefined();
    expect(reachedName("NotImplementedError: NotImplemented: some prose, not a name")).toBeUndefined();
  });
});

describe("reachedNames", () => {
  test("dedupes and sorts, skipping unnameable failures", () => {
    expect(
      reachedNames([
        "NotImplementedError: NotImplemented: parseIsbn",
        "NotImplementedError: NotImplemented: Currency.parse",
        "NotImplementedError: NotImplemented: parseIsbn",
        "AssertionError: nope",
        undefined,
      ]),
    ).toEqual(["Currency.parse", "parseIsbn"]);
  });
});

describe("declaredExports", () => {
  test("lists a contract's value exports with the file that declared them", () => {
    expect(declaredExports(contract(CURRENCY_CONTRACT))).toEqual([
      { name: "Currency", contractFile: "src/money/money.contract.ts" },
      { name: "parseIsbn", contractFile: "src/money/money.contract.ts" },
    ]);
  });
});

describe("unreachedExports", () => {
  const declared = declaredExports(contract(CURRENCY_CONTRACT));

  test("a member throw reaches its owning export", () => {
    expect(unreachedExports(declared, ["Currency.parse"])).toEqual([
      { name: "parseIsbn", contractFile: "src/money/money.contract.ts" },
    ]);
  });

  test("nothing unreached when every export was called", () => {
    expect(unreachedExports(declared, ["Currency", "parseIsbn"])).toEqual([]);
  });

  test("everything unreached when the suite called nothing", () => {
    expect(unreachedExports(declared, []).map((u) => u.name)).toEqual(["Currency", "parseIsbn"]);
  });

  test("a reached name that no contract declares is ignored, not reported", () => {
    expect(unreachedExports(declared, ["parseIsbn", "Currency.parse", "SomethingElse"])).toEqual([]);
  });

  test("Run 7 in miniature: the parsers were never called", () => {
    const decl = declaredExports(
      contract(`
        export declare function planRun(): void;
        export declare function parseTitle(raw: string): string | undefined;
        export declare function parseAuthor(raw: string): string | undefined;
      `),
    );
    expect(unreachedExports(decl, ["planRun"]).map((u) => u.name)).toEqual(["parseAuthor", "parseTitle"]);
  });
});

describe("unreachedRemedyLines", () => {
  test("names the export and the call to write", () => {
    const lines = unreachedRemedyLines([{ name: "parseIsbn", contractFile: "src/book/book.contract.ts" }]);
    expect(lines.join("\n")).toContain("parseIsbn");
    expect(lines.join("\n")).toContain("src/book/book.contract.ts");
  });
});

// --- checker 2: value-object boundaries -----------------------------------------

describe("valueObjectClasses", () => {
  test("finds exported declare classes with a parse door and infers the base type", () => {
    expect(CURRENCY()).toEqual([
      {
        name: "Currency",
        contractFile: "src/money/money.contract.ts",
        base: "string",
        hasStaticParse: true,
      },
    ]);
  });

  test("infers a number base from the sole public property", () => {
    const [vo] = valueObjectClasses(
      contract(`
        export declare class PagesRead {
          private readonly __brand: "PagesRead";
          readonly value: number;
          static parse(raw: unknown): PagesRead | undefined;
        }
      `),
    );
    expect(vo?.base).toBe("number");
  });

  test("prefers an explicit parse<Name> signature over the property", () => {
    const [vo] = valueObjectClasses(
      contract(`
        export declare class Isbn {
          private readonly __brand: "Isbn";
          readonly digits: number;
          static parse(raw: unknown): Isbn | undefined;
        }
        export declare function parseIsbn(raw: string): Isbn | undefined;
      `),
    );
    expect(vo?.base).toBe("string");
  });

  test("stays 'unknown' for a composite value object rather than guessing", () => {
    const [vo] = valueObjectClasses(
      contract(`
        export declare class Money {
          private readonly __brand: "Money";
          readonly amount: number;
          readonly currency: string;
          static parse(raw: unknown): Money | undefined;
        }
      `),
    );
    expect(vo?.base).toBe("unknown");
  });

  test("a class with no static parse has no boundary to test", () => {
    const [vo] = valueObjectClasses(
      contract(`
        export declare class Clock {
          now(): number;
        }
      `),
    );
    expect(vo?.hasStaticParse).toBe(false);
  });
});

describe("checkBoundaryBlocks", () => {
  test("a well-formed block discharges the obligation", () => {
    expect(checkBoundaryBlocks(CURRENCY(), tests(GOOD_BLOCK))).toEqual([]);
  });

  test("a class with no parse door is skipped, not blocked", () => {
    const classes = valueObjectClasses(contract(`export declare class Clock { now(): number; }`));
    expect(checkBoundaryBlocks(classes, tests(""))).toEqual([]);
  });

  test("no block at all is a missing-block violation naming the exact describe", () => {
    const violations = checkBoundaryBlocks(CURRENCY(), tests(`describe("Currency", () => {});`));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("missing-block");
    expect(violations[0]?.expected).toBe(`Currency ${BOUNDARY_DASH} boundaries`);
  });

  test("a hyphen where the em dash belongs is a near miss, not a silent miss", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(GOOD_BLOCK.replace(`Currency ${BOUNDARY_DASH} boundaries`, "Currency - boundaries")),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("misnamed-block");
    expect(violations[0]?.found).toEqual(["Currency - boundaries"]);
  });

  test("an en dash, odd spacing and odd case are all near misses too", () => {
    for (const title of ["Currency – boundaries", "Currency  —  Boundaries", "currency—boundaries"]) {
      const violations = checkBoundaryBlocks(
        CURRENCY(),
        tests(GOOD_BLOCK.replace(`Currency ${BOUNDARY_DASH} boundaries`, title)),
      );
      expect(violations[0]?.kind).toBe("misnamed-block");
    }
  });

  test("a skipped block does not discharge anything", () => {
    const violations = checkBoundaryBlocks(CURRENCY(), tests(GOOD_BLOCK.replace("describe(", "describe.skip(")));
    expect(violations[0]?.kind).toBe("skipped-block");
  });

  test("one rejection is not two", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects", () => { expect(Currency.parse("usd")).toBeUndefined(); });
        });
      `),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("too-few-rejections");
    expect(violations[0]?.rejections).toEqual([`"usd"`]);
  });

  test("the same rejection twice is one rejection", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects lowercase", () => { expect(Currency.parse("usd")).toBeUndefined(); });
          test("rejects lowercase again", () => { expect(Currency.parse('usd')).toBeUndefined(); });
        });
      `),
    );
    expect(violations[0]?.kind).toBe("too-few-rejections");
    expect(violations[0]?.rejections).toHaveLength(1);
  });

  test("wrong-type rejections do not count — the generated laws already own those", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects null", () => { expect(Currency.parse(null)).toBeUndefined(); });
          test("rejects a number", () => { expect(Currency.parse(42)).toBeUndefined(); });
          test("rejects an array", () => { expect(Currency.parse([])).toBeUndefined(); });
        });
      `),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("too-few-rejections");
    expect(violations[0]?.rejections).toEqual([]);
    expect(violations[0]?.wrongTypeRejections).toEqual(["null", "42", "[]"]);
  });

  test("a number-based value object counts numeric literals and not strings", () => {
    const classes = valueObjectClasses(
      contract(`
        export declare class PagesRead {
          private readonly __brand: "PagesRead";
          readonly value: number;
          static parse(raw: unknown): PagesRead | undefined;
        }
      `),
    );
    const violations = checkBoundaryBlocks(
      classes,
      tests(`
        describe("PagesRead ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(PagesRead.parse(12)).toBeDefined(); });
          test("rejects negatives", () => { expect(PagesRead.parse(-1)).toBeUndefined(); });
          test("rejects fractions", () => { expect(PagesRead.parse(1.5)).toBeUndefined(); });
          test("rejects a string", () => { expect(PagesRead.parse("12")).toBeUndefined(); });
        });
      `),
    );
    expect(violations).toEqual([]);
  });

  test("no accepted literal is its own violation", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("rejects lowercase", () => { expect(Currency.parse("usd")).toBeUndefined(); });
          test("rejects length", () => { expect(Currency.parse("USDD")).toBeUndefined(); });
        });
      `),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("no-accepted-parse");
  });

  test("both halves missing produces both violations", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`describe("Currency ${BOUNDARY_DASH} boundaries", () => { test("todo", () => {}); });`),
    );
    expect(violations.map((v) => v.kind)).toEqual(["no-accepted-parse", "too-few-rejections"]);
  });

  test("not.toBeUndefined and toBeInstanceOf count as acceptance", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).not.toBeUndefined(); });
          test("accepts too", () => { expect(Currency.parse("GBP")).toBeInstanceOf(Currency); });
          test("rejects", () => { expect(Currency.parse("usd")).toBeUndefined(); });
          test("rejects", () => { expect(Currency.parse("USDD")).toBe(undefined); });
        });
      `),
    );
    expect(violations).toEqual([]);
  });

  test("a parse result held in a local still counts", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => {
            const usd = Currency.parse("USD");
            expect(usd).toBeDefined();
          });
          test("rejects", () => {
            const lower = Currency.parse("usd");
            const long = Currency.parse("USDD");
            expect(lower).toBeUndefined();
            expect(long).toBeUndefined();
          });
        });
      `),
    );
    expect(violations).toEqual([]);
  });

  test("same-named locals in two tests are two rejections, not one", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects lowercase", () => {
            const bad = Currency.parse("usd");
            expect(bad).toBeUndefined();
          });
          test("rejects length", () => {
            const bad = Currency.parse("USDD");
            expect(bad).toBeUndefined();
          });
        });
      `),
    );
    expect(violations).toEqual([]);
  });

  test("a literal bound to a const is still a literal", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          const LOWER = "usd";
          const LONG = "USDD";
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects", () => { expect(Currency.parse(LOWER)).toBeUndefined(); });
          test("rejects", () => { expect(Currency.parse(LONG)).toBeUndefined(); });
        });
      `),
    );
    expect(violations).toEqual([]);
  });

  test("an unresolvable argument is not a literal and does not count", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test.each(["usd", "USDD"])("rejects %s", (raw) => {
            expect(Currency.parse(raw)).toBeUndefined();
          });
        });
      `),
    );
    expect(violations[0]?.kind).toBe("too-few-rejections");
    expect(violations[0]?.wrongTypeRejections).toEqual(["raw"]);
  });

  test("blocks split across files are aggregated, not double-counted", () => {
    const violations = checkBoundaryBlocks(CURRENCY(), [
      {
        file: "tests/accept.test.ts",
        source: `describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("a", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("b", () => { expect(Currency.parse("usd")).toBeUndefined(); });
        });`,
      },
      {
        file: "tests/reject.test.ts",
        source: `describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("c", () => { expect(Currency.parse("USDD")).toBeUndefined(); });
        });`,
      },
    ]);
    expect(violations).toEqual([]);
  });

  test("an assertion about another class does not satisfy this class's block", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects", () => { expect(Isbn.parse("usd")).toBeUndefined(); });
          test("rejects", () => { expect(Isbn.parse("USDD")).toBeUndefined(); });
        });
      `),
    );
    expect(violations[0]?.kind).toBe("too-few-rejections");
  });

  test("rejections outside the boundaries block do not count", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(`
        describe("Currency ${BOUNDARY_DASH} boundaries", () => {
          test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
          test("rejects", () => { expect(Currency.parse("usd")).toBeUndefined(); });
        });
        describe("Currency elsewhere", () => {
          test("rejects", () => { expect(Currency.parse("USDD")).toBeUndefined(); });
        });
      `),
    );
    expect(violations[0]?.kind).toBe("too-few-rejections");
  });

  test("the violation records where the block was found", () => {
    const violations = checkBoundaryBlocks(
      CURRENCY(),
      tests(
        `describe("Currency ${BOUNDARY_DASH} boundaries", () => {
           test("accepts", () => { expect(Currency.parse("USD")).toBeDefined(); });
         });`,
        "tests/currency.test.ts",
      ),
    );
    expect(violations[0]?.testFiles).toEqual(["tests/currency.test.ts"]);
  });
});

describe("boundaryDescribeName / boundaryRemedyLines", () => {
  test("the required name uses an em dash, U+2014", () => {
    expect(BOUNDARY_DASH).toBe("—");
    expect(boundaryDescribeName("Currency")).toBe("Currency — boundaries");
    expect(MIN_REJECTIONS).toBe(2);
  });

  test("the remedy names the sin and the exact lines to write", () => {
    const [violation] = checkBoundaryBlocks(CURRENCY(), tests(`test("nothing", () => {});`));
    const text = boundaryRemedyLines(violation!).join("\n");
    expect(text).toContain(`describe("Currency — boundaries"`);
    expect(text).toContain("Currency.parse(");
    expect(text).toContain("floor, not a target");
  });
});

// --- IO wrappers -----------------------------------------------------------------

describe("readContracts / readHandWrittenTests", () => {
  const root = mkdtempSync(join(tmpdir(), "obligations-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "src", "money"), { recursive: true });
  mkdirSync(join(root, "tests", "generated"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(root, "src", "money", "money.contract.ts"), CURRENCY_CONTRACT);
  writeFileSync(join(root, "tests", "money.test.ts"), GOOD_BLOCK);
  writeFileSync(join(root, "tests", "generated", "money.laws.test.ts"), GOOD_BLOCK);
  writeFileSync(join(root, "node_modules", "junk", "other.test.ts"), GOOD_BLOCK);

  test("contracts are found with project-relative posix paths", () => {
    expect(readContracts(root).map((c) => c.file)).toEqual(["src/money/money.contract.ts"]);
  });

  test("tests/generated is ignored: machine-written laws cannot discharge a human obligation", () => {
    expect(readHandWrittenTests(root).map((t) => t.file)).toEqual(["tests/money.test.ts"]);
  });
});
