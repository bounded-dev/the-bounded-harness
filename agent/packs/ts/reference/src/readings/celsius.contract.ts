/** Celsius: a whole-degree temperature reading, from absolute zero (-273 C) up
 *  to a 1000 C ceiling, inclusive. A non-integer or an out-of-range number is
 *  not a reading this log accepts.
 *  @accepts -273
 *  @accepts 20
 */
export declare class Celsius {
  private readonly __brand: "Celsius";
  private constructor();
  readonly value: number;
  static parse(raw: unknown): Celsius | undefined;
  equals(other: Celsius): boolean;
}
