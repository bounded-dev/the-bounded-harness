// GENERATED from reading-id.contract.ts by packs/ts/scripts/value-object-laws.ts — do not edit.
// The laws that hold for EVERY value object, whatever the domain: parse refuses
// junk, equality is by value, parsing is deterministic. What these CANNOT cover
// is an input of the right base type and the wrong value — "usd" is a string,
// and only someone thinking about currencies knows it must fail. Likewise a
// same-type value at the edge of a range — 0 for a Kelvin, -1 for a Percent —
// is a domain decision this file cannot make, so the hostile-input law does
// not assert on it. Both belong to the test-writer's `<Name> — boundaries`
// block (see ts-contract-authoring).
//
// Two properties of this file are forced by the red gate, which rejects any
// failure that is not a NotImplementedError:
//
//   * A missing `@accepts` example is SKIPPED, never failed. A hard failure
//     here would be a wrong-reason red: it would block the whole pipeline and
//     route the fix to the test-writer, when the fix is a JSDoc tag in the
//     frozen contract and belongs to the architect. The generator warns about
//     the same gap on stderr, where the architect is standing.
//   * `parse()` is never wrapped in try/catch. Against the throwing skeleton
//     the NotImplementedError must reach the runner — that is what makes this
//     file a valid red. Swallowing it would leave these laws vacuously green
//     at exactly the phase they exist to fail.

import { describe, expect, test } from "vitest";
import { ReadingId } from "../../src/readings/reading-id.js";

/** Inputs no value object may accept, whatever its domain. Labelled so a
 *  failing law names which ones wrongly got through. */
const HOSTILE_INPUTS: readonly (readonly [string, unknown])[] = [
  ["undefined", undefined],
  ["null", null],
  ["true", true],
  ["false", false],
  ["0", 0],
  ["-1", -1],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["\"\"", ""],
  ["\" \"", " "],
  ["[]", []],
  ["{}", {}],
  ["() => {}", () => {}],
  ["Symbol(\"x\")", Symbol("x")],
  ["new Date()", new Date()],
  ["9007199254740993n", 9007199254740993n],
];

/** Narrow a parse result without a cast. A throwing skeleton never reaches
 *  this line: its NotImplementedError propagates first, which is what the
 *  red gate is looking for. */
function mustParse<T>(result: T | undefined | null, what: string): T {
  if (result === undefined || result === null) {
    throw new Error(`${what} rejected the @accepts example from the contract — fix the tag, or fix the parser`);
  }
  return result;
}

describe("ReadingId — value-object laws (generated)", () => {
  test("refuses every hostile input", () => {
    // The corpus entries hostile to THIS value object's base primitive:
    // cross-type inputs, plus same-type pathological sentinels. Same-type
    // ordinary values (a range decision) and this VO's own @accepts
    // examples are excluded — see the generator's hostileExpressionsFor.
    const applicable = new Set<string>([
      "undefined",
      "null",
      "true",
      "false",
      "0",
      "-1",
      "NaN",
      "Infinity",
      "[]",
      "{}",
      "() => {}",
      "Symbol(\"x\")",
      "new Date()",
      "9007199254740993n",
    ]);
    const wronglyAccepted = HOSTILE_INPUTS
      .filter(([label]) => applicable.has(label))
      .filter(([, raw]) => {
        const result = ReadingId.parse(raw);
        return result !== undefined && result !== null;
      })
      .map(([label]) => label);
    expect(wronglyAccepted).toEqual([]);
  });

  test("is equal by value, not by reference", () => {
    const a = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    const b = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    // Content equality is the law. Identity deliberately is NOT: interning
    // (returning a cached instance for the same input) is a legitimate
    // value-object implementation, and a law that fires on a correct design
    // gets switched off. The reference-based `equals` that distinct
    // identities would have caught is checked below instead, where it can
    // be checked without forbidding interning.
    expect(a).toStrictEqual(b);
  });

  test("parses deterministically", () => {
    expect(mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")")).toStrictEqual(mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")"));
  });

  test("equals is reflexive", () => {
    const a = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    expect(a.equals(a)).toBe(true);
  });

  test("equals is not reference-based", () => {
    const a = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    const b = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    // Two parses of the same input must be equal. If the implementation
    // interns, a and b ARE the same instance and `equals` by reference is
    // correct — so the discriminating case only exists when they differ.
    expect(a.equals(b)).toBe(true);
    if (a !== b) {
      // Not interned: an `equals` that compares references would now be
      // wrong for every other pair, so prove it compares content.
      expect(Object.is(a, b)).toBe(false);
      expect(a.equals(b)).toBe(true);
    }
  });

  test("equals is symmetric", () => {
    const a = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    const b = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    expect(a.equals(b)).toBe(b.equals(a));
  });

  test("equals discriminates two different valid inputs", () => {
    const a = mustParse(ReadingId.parse("0a1b2c3d"), "ReadingId.parse(\"0a1b2c3d\")");
    const other = mustParse(ReadingId.parse("ffffffff"), "ReadingId.parse(\"ffffffff\")");
    expect(a.equals(other)).toBe(false);
    expect(other.equals(a)).toBe(false);
  });
});
