import { z } from "zod";

// The implementation module is the component's public surface: it re-exports
// every type its own contract declares and shadows the ambient `declare class`
// with the real one below, so callers reach ReadingId through here — never
// through the sibling `*.contract.ts`.
export type * from "./reading-id.contract.js";

// A value object's `parse` is implemented over a zod schema, never a hand-rolled
// typeof-chain (`zod-backed-parse`, ADR 2026-031): schemas compose, and the
// generated hostile-input laws interrogate a schema far better than an ad-hoc
// chain. The schema IS the validity rule the contract's doc comment states.
const schema = z.string().regex(/^[0-9a-f]{8}$/);

export class ReadingId {
  // The private brand — not the private constructor — is what makes the type
  // nominal. `declare` because it carries no runtime value; surface-check treats
  // `private declare readonly __brand` as the contract's `private readonly
  // __brand`.
  private declare readonly __brand: "ReadingId";
  private constructor(readonly value: string) {}

  // `unknown` is the boundary: parse faces raw input directly, and returning
  // `T | undefined` forces every caller to handle the reject case. No `as`, no
  // `!` — the real constructor behind parse is what makes the src escape-hatch
  // ban livable.
  static parse(raw: unknown): ReadingId | undefined {
    const result = schema.safeParse(raw);
    return result.success ? new ReadingId(result.data) : undefined;
  }

  equals(other: ReadingId): boolean {
    return this.value === other.value;
  }
}
