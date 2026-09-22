import { describe, expect, it } from "vitest";
import { Celsius } from "../src/readings/celsius.js";

// A numeric value object's boundaries: the accepted extremes AND the rejects one
// step past each edge, so an off-by-one in the bound cannot pass. The min and
// max are asserted AT the boundary because that is the only place a `<` that
// should be `<=` shows itself.
describe("Celsius — boundaries", () => {
  it("accepts a temperature inside the range", () => {
    expect(Celsius.parse(20)).toBeDefined();
  });

  it("accepts the exact minimum (absolute zero)", () => {
    expect(Celsius.parse(-273)).toBeDefined();
  });

  it("accepts the exact maximum", () => {
    expect(Celsius.parse(1000)).toBeDefined();
  });

  it("rejects one below the minimum", () => {
    expect(Celsius.parse(-274)).toBeUndefined();
  });

  it("rejects one above the maximum", () => {
    expect(Celsius.parse(1001)).toBeUndefined();
  });

  it("rejects a non-integer", () => {
    expect(Celsius.parse(1.5)).toBeUndefined();
  });
});
