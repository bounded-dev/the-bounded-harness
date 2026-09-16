// The ts-web pack as a pack DEFINITION (TN-26-006 Phase B, TN-26-005).
//
// React/Vite/Tailwind/shadcn web frontends. It is the second real pack, and
// therefore the first proof that the composition rules are rules and not
// intentions: everything it adds to the TypeScript gates arrives through a
// socket the ts pack defined, over a dependency edge declared right here.
//
// The edge is load-bearing in the type system, not just in the prose. Remove
// `"ts"` from `dependsOnPacks` and every contribution below stops compiling,
// naming the pack whose socket it was reaching for (agent/src/socket-registry.ts).
//
// The pack's DATA-only content stays in `contrib.json` beside this file —
// intake nouns, component return types, dependency pins — because the host
// reads those without executing pack code. This file is its CODE: rules and
// config blocks, which JSON cannot hold.

import { definePack } from "../../src/socket-registry.ts";
import { TS_PACK } from "../ts/pack.ts";

/** This pack's name, as a literal — see the note on `TS_PACK`. */
export const TS_WEB_PACK = "ts-web";

export const tsWebPack = definePack({
  name: TS_WEB_PACK,
  dependsOnPacks: [TS_PACK],
  // EMPTY BY POLICY, not by accident. The socket vocabulary is closed and
  // curated (TN-26-005, "Rules going forward"): a socket is born together with
  // the gate or generator machinery that consumes it, as core or
  // foundational-pack design work with its own ADR. Ordinary packs — ts-web,
  // and every file-handling or data-table pack after it — are
  // contribution-only. The registry's owner typing makes that a compile-time
  // fact rather than a review convention: nothing in the harness could fill a
  // ts-web socket without declaring an edge to ts-web, and no such pack exists.
  //
  // The MECHANISM is the open one all the same — any pack can own sockets,
  // typed identically — so opening the vocabulary for third-party packs later
  // is a policy change with zero rework here.
  defines: [],
  // Filled in Phase B2: the FSD directional lints and the ratified primitives
  // relaxation for the generic UI layer.
  contributes: [],
});
