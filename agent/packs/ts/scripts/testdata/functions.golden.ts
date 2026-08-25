// GENERATED from functions.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.
// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.
// The builder replaces this file with the real implementation.

import { NotImplementedError } from "./shared/errors.js";
import type { NewOrder, Order } from "./functions.contract.js";
import type * as __Contract from "./functions.contract.js";

export type * from "./functions.contract.js";

export function createOrder(input: NewOrder): Order {
  throw new NotImplementedError("createOrder");
}

export function find(id: string): Order | undefined;
export function find(id: number): Order | undefined;
export function find(..._args: unknown[]): unknown {
  throw new NotImplementedError("find");
}

export function identity<T>(value: T): T {
  throw new NotImplementedError("identity");
}

// Compile-time conformance: every scaffoldable value export of the contract
// exists above, with the signature the contract declared.
const __conformance: typeof __Contract = { createOrder, find, identity };
void __conformance;
