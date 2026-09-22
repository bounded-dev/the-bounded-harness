import { z } from "zod";

export type * from "./celsius.contract.js";

// The bounds and integrality the contract's doc comment promised, expressed once
// as the schema the parse boundary delegates to.
const schema = z.number().int().min(-273).max(1000);

export class Celsius {
  private declare readonly __brand: "Celsius";
  private constructor(readonly value: number) {}

  static parse(raw: unknown): Celsius | undefined {
    const result = schema.safeParse(raw);
    return result.success ? new Celsius(result.data) : undefined;
  }

  equals(other: Celsius): boolean {
    return this.value === other.value;
  }
}
