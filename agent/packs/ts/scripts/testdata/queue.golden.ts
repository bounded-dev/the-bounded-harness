// GENERATED from queue.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.
// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.
// The builder replaces this file with the real implementation.

import type * as __Contract from "./queue.contract.js";

export type * from "./queue.contract.js";

class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NotImplemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

// Instance members are omitted: the constructor throws first.
export const Queue = class {
  constructor(..._args: never[]) {
    throw new NotImplementedError("Queue.constructor");
  }

  static create(..._args: never[]) {
    throw new NotImplementedError("Queue.create");
  }

  static get instances() {
    throw new NotImplementedError("Queue.instances");
  }
} as unknown as typeof __Contract.Queue;

// Compile-time conformance: every value export of the contract exists above,
// each typed by the contract itself.
const __conformance: typeof __Contract = { Queue };
void __conformance;
