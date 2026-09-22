import { describe, expect, it } from "vitest";
import { Celsius } from "../src/readings/celsius.js";
import { ReadingId } from "../src/readings/reading-id.js";
import { record } from "../src/readings/readings.js";
import type { Reading, ReadingLog } from "../src/readings/readings.js";

// A reading is built only from parsed value objects — the parse boundary is the
// one door in. This helper is called INSIDE tests, never at the top level: in
// the red phase every `parse` throws NotImplementedError, and a throw during
// import/collection is a wrong-reason red rather than a failing test.
function reading(id: string, celsius: number): Reading {
  const parsedId = ReadingId.parse(id);
  const parsedCelsius = Celsius.parse(celsius);
  if (parsedId === undefined || parsedCelsius === undefined) {
    throw new Error(`invalid fixture: ${id}, ${celsius}`);
  }
  return { id: parsedId, celsius: parsedCelsius };
}

const empty: ReadingLog = { entries: [] };

describe("record", () => {
  it("appends a new reading to the log", () => {
    const log = record(empty, reading("0a1b2c3d", 20));
    expect(log.entries).toHaveLength(1);
  });

  // Idempotency + identity, the pattern the spec pins down: replaying a reading
  // whose id is already logged returns the SAME log object, unchanged.
  it("is idempotent on a replayed id, returning the identical log", () => {
    const first = record(empty, reading("0a1b2c3d", 20));
    const second = record(first, reading("0a1b2c3d", 20));
    expect(second).toBe(first); // reference-identical — nothing was rebuilt
    expect(second.entries).toHaveLength(1);
  });

  it("does not mutate the input log when it appends", () => {
    const before = record(empty, reading("0a1b2c3d", 20));
    record(before, reading("ffffffff", -10));
    expect(before.entries).toHaveLength(1); // the earlier log is untouched
  });

  // The cross-cutting invariant: whatever sequence of records built the log, no
  // two entries share an id.
  it("keeps every reading id unique across the log", () => {
    const a = record(empty, reading("0a1b2c3d", 20));
    const b = record(a, reading("ffffffff", -10));
    const c = record(b, reading("0a1b2c3d", 999)); // a replay of the first id
    const ids = c.entries.map((entry) => entry.id.value);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
