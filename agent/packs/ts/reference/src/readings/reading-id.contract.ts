/** ReadingId: an opaque handle for one reading — exactly eight lowercase
 *  hexadecimal digits. It is the idempotency key: two recordings that carry the
 *  same id are the same reading, so a replay collapses to one entry.
 *  @accepts "0a1b2c3d"
 *  @accepts "ffffffff"
 */
export declare class ReadingId {
  private readonly __brand: "ReadingId";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): ReadingId | undefined;
  equals(other: ReadingId): boolean;
}
