import type { Reading, ReadingLog } from "./readings.contract.js";

export type * from "./readings.contract.js";

// record is a pure function of its inputs: no clock, no store, no mutation of
// the argument. A reading whose id is already logged is a replay — the input
// log is returned unchanged, and reference-identically, so nothing downstream
// rebuilds. Otherwise a NEW log with the reading appended is returned; the input
// is never mutated.
export function record(log: ReadingLog, reading: Reading): ReadingLog {
  if (log.entries.some((entry) => entry.id.equals(reading.id))) {
    return log;
  }
  return { entries: [...log.entries, reading] };
}
