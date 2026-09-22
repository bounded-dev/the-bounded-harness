import { describe, expect, it } from "vitest";
import { ReadingId } from "../src/readings/reading-id.js";

// The boundaries block is the shape the red gate's obligations check looks for,
// per value object: the describe title is exactly `<Name> — boundaries` (the
// separator is an em dash, U+2014), it asserts at least one input that PARSES,
// and — the part the generated laws cannot know — at least two DISTINCT
// wrong-value inputs of the value object's own base type that must NOT.
//
// Two rejections is the floor, not the target: write one per axis the validity
// rule actually has. ReadingId has three (case, length, character class), so
// three honest rejections beat a token pair. null / 42 / [] do not count here —
// the generated hostile-input law already owns every wrong-TYPE input.
describe("ReadingId — boundaries", () => {
  it("accepts eight lowercase hex digits", () => {
    expect(ReadingId.parse("0a1b2c3d")).toBeDefined();
  });

  it("rejects uppercase hex (wrong character class)", () => {
    expect(ReadingId.parse("0A1B2C3D")).toBeUndefined();
  });

  it("rejects seven digits (wrong length)", () => {
    expect(ReadingId.parse("0a1b2c3")).toBeUndefined();
  });

  it("rejects a non-hex character", () => {
    expect(ReadingId.parse("0a1b2c3g")).toBeUndefined();
  });
});
