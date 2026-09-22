// The operations live in their own contract file, apart from the value objects
// they use: `value-objects-own-contract` refuses a value-object class in the
// same file as an interface or operation that references it, because the
// scaffolder would emit that class as a runtime class here and its `__brand`
// would clash with the ambient one. So each value object gets its own
// `*.contract.ts`, and this file reaches them through their IMPLEMENTATION
// modules (`./reading-id.js`, never `./reading-id.contract.js`) — one identity
// per value object (ADR 2026-023/026/027).
import type { Celsius } from "./celsius.js";
import type { ReadingId } from "./reading-id.js";

export interface Reading {
  readonly id: ReadingId;
  readonly celsius: Celsius;
}

export interface ReadingLog {
  readonly entries: readonly Reading[];
}

/** Append `reading` to the log — unless a reading with the same id is already
 *  present, in which case the input log is returned unchanged. See spec.md for
 *  the idempotency, identity and uniqueness rules the tests hold it to. */
export declare function record(log: ReadingLog, reading: Reading): ReadingLog;
