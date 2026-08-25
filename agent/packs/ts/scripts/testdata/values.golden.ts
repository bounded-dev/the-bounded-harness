// GENERATED from values.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.
// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.
// The builder replaces this file with the real implementation.

import type * as __Contract from "./values.contract.js";

export type * from "./values.contract.js";

class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NotImplemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

function throwNotImplemented(what: string): never {
  throw new NotImplementedError(what);
}

export const DEFAULT_PAGE_SIZE = throwNotImplemented("DEFAULT_PAGE_SIZE") as typeof __Contract.DEFAULT_PAGE_SIZE;

export const SERVICE_NAME = throwNotImplemented("SERVICE_NAME") as typeof __Contract.SERVICE_NAME;

// Compile-time conformance: every value export of the contract exists above,
// each typed by the contract itself.
const __conformance: typeof __Contract = { DEFAULT_PAGE_SIZE, SERVICE_NAME };
void __conformance;
