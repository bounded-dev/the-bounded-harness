// The installed packs, and the composition the harness runs today.
//
// WHY THIS FILE IS IN packs/ AND NOT IN src/. The core must not name a
// technology (TN-26-005), and a list of pack definitions is a list of
// technologies. `agent/src/socket-registry.ts` is the mechanism and knows none
// of these names; this file is the composition record, and it belongs on the
// pack side of that line — the same side as `contrib.json`.
//
// WHY THE LIST IS STATIC. `pack-contrib.ts` discovers packs by reading
// directories, which is right for JSON that must be readable without executing
// pack code. Code-bearing contributions are different: an ESLint rule is a
// module, a module is reached by an import, and an import the bundler and the
// type checker can both see is worth more than a directory scan that neither
// can. Installing a pack edits this list.
//
// WHY COMPOSITION IS MEMOIZED. Composing runs every socket's validation hook
// over every contributed value. That is cheap, but a gate calls it once per
// lint run and the result cannot change within a process — so it is computed
// once. `composePacks` stays available with an explicit pack list for the
// callers that will need one: composition-at-initiation (TN-26-005) is a
// project passing its own list here, not a rewrite of the gates.

import { composePacks, type PackDefinition, type SocketRegistry } from "../src/socket-registry.ts";
import { tsPack } from "./ts/pack.ts";
import { tsWebPack } from "./ts-web/pack.ts";

/** Every pack installed in this harness, in no particular order — the registry
 *  sorts and dependency-orders them itself. */
export const INSTALLED_PACKS: readonly PackDefinition[] = Object.freeze([tsPack, tsWebPack]);

let memo: SocketRegistry | undefined;

/**
 * The composed registry every gate reads.
 *
 * v1 composes every installed pack, which is the harness's own answer to "which
 * packs does this project use?" while there is one harness and two packs. The
 * moment a project records its own list (`.pi/settings.json`, TN-26-005), the
 * change is `composePacks(INSTALLED_PACKS, thatList)` at this one function —
 * every consumer already reads through the socket and needs no edit at all.
 */
export function composedPacks(): SocketRegistry {
  memo ??= composePacks(INSTALLED_PACKS);
  return memo;
}
