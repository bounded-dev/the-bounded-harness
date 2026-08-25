// GENERATED from values.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.
// Red-phase skeleton (TN-26-001): every value export throws NotImplementedError.
// The builder replaces this file with the real implementation.

import { notImplemented } from "./shared/errors.js";
import type * as __Contract from "./values.contract.js";

export type * from "./values.contract.js";

export const DEFAULT_PAGE_SIZE: number = notImplemented("DEFAULT_PAGE_SIZE");

export const SERVICE_NAME: string = notImplemented("SERVICE_NAME");

// Compile-time conformance: every scaffoldable value export of the contract
// exists above, with the signature the contract declared.
const __conformance: typeof __Contract = { DEFAULT_PAGE_SIZE, SERVICE_NAME };
void __conformance;
