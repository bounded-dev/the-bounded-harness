// GENERATED from functions.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.
// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.
// The builder replaces this file with the real implementation.

import type * as __Contract from "./functions.contract.js";

export type * from "./functions.contract.js";

class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NotImplemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

export const createOrder = (() => {
  throw new NotImplementedError("createOrder");
}) as typeof __Contract.createOrder;

export const find = (() => {
  throw new NotImplementedError("find");
}) as typeof __Contract.find;

export const identity = (() => {
  throw new NotImplementedError("identity");
}) as typeof __Contract.identity;

// Compile-time conformance: every value export of the contract exists above,
// each typed by the contract itself.
const __conformance: typeof __Contract = { createOrder, find, identity };
void __conformance;
