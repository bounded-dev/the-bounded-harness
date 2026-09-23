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

import { contribute, definePack } from "../../src/socket-registry.ts";
import { contractPurityOverrides, deliverChecks, lintSrcRules, TS_PACK } from "../ts/pack.ts";
import { buildCheckScript, BOOTSTRAP_RELATIVE, runBuildCheck } from "./scripts/build-check.ts";
import { runThemeCheck, THEME_RELATIVE } from "./scripts/theme-check.ts";
import { clientOneDoor } from "./eslint/rules/client-one-door.ts";
import { fsdDownwardImports } from "./eslint/rules/fsd-downward-imports.ts";
import { fsdSlicePublicApi } from "./eslint/rules/fsd-slice-public-api.ts";
import { tokensOnlyStyling } from "./eslint/rules/tokens-only-styling.ts";

/** This pack's name, as a literal — see the note on `TS_PACK`. */
export const TS_WEB_PACK = "ts-web";

/** The flat-config namespace this pack's rules are registered under. A pack's
 *  rules live in the pack's own namespace, never in `bounded-ts`: two packs
 *  sharing one namespace is a name clash waiting to happen, and the rule id a
 *  block prints should say which pack to go and read. */
export const TS_WEB_PLUGIN = "bounded-ts-web";

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
  contributes: [
    // --- the directional lints (TN-26-006 B2) ---------------------------
    //
    // All three bind the BUILDER: they police `src/**`, which is the builder's
    // write zone, so the builder's brief is the one that must name them (ADR
    // 2026-018) and `guard-doc-drift.test.ts` checks exactly that — reading the
    // target brief out of this declaration, not out of a list of packs.
    //
    // The same field decides scope: a rule that binds the builder is filtered
    // out of the tests/** run, the way the ts pack's own src-only rules are.
    // A test rendering a component under a real QueryClientProvider is doing
    // its job, not smuggling a second transport in.
    contribute(lintSrcRules, [
      {
        plugin: TS_WEB_PLUGIN,
        name: "fsd-downward-imports",
        rule: fsdDownwardImports,
        namedIn: "builder",
      },
      {
        plugin: TS_WEB_PLUGIN,
        name: "fsd-slice-public-api",
        rule: fsdSlicePublicApi,
        namedIn: "builder",
      },
      { plugin: TS_WEB_PLUGIN, name: "client-one-door", rule: clientOneDoor, namedIn: "builder" },
      // The styling twin of `no-naked-primitives` (TN-26-006, "anatomy
      // enforced, identity free"). It is what makes the project's ownership of
      // theme.css worth anything: a theme swap is total only if every colour on
      // screen came through a token name, and one `bg-blue-600` breaks that
      // with nothing failing anywhere.
      {
        plugin: TS_WEB_PLUGIN,
        name: "tokens-only-styling",
        rule: tokensOnlyStyling,
        namedIn: "builder",
      },
    ]),

    // --- the ratified primitives relaxation (TN-26-006) -----------------
    //
    // The one contribution in this harness that makes a gate weaker, and the
    // only reason it is allowed is that the grill ratified it by name: a
    // Button's `label: string` IS a string. `no-naked-primitives` exists to
    // stop DOMAIN data crossing a boundary as a primitive — `isbn: string`,
    // `buildingId: string` — and the generic UI layer has no domain in it at
    // all. That is what makes it generic, and it is enforced from the other
    // side by `fsd-downward-imports`: nothing in `shared` may import a layer
    // that knows a domain.
    //
    // The scope is exactly one directory. Domain data still crosses into
    // entity and feature components as value objects, and is rendered to
    // primitives at the leaf — which is the shape this exemption exists to
    // make possible, not a hole in it.
    contribute(contractPurityOverrides, [
      {
        files: ["src/ui/shared/ui/**/*.contract.ts"],
        rules: {
          "bounded-ts/no-naked-primitives": "off",
          // The two rules that say what must be there INSTEAD of a primitive
          // go with it. Leaving them on would refuse the same contract one
          // message later, which is a relaxation that relaxes nothing.
          "bounded-ts/value-object-shape": "off",
          "bounded-ts/value-object-documented": "off",
        },
        why:
          "The generic UI layer holds no domain: a Button's `label: string` is a string, not a " +
          "stringly-typed domain value (TN-26-006, ratified at the 2026-09-14 grill). Everywhere " +
          "else the rule stands, so domain data crosses into feature components as value objects " +
          "and is rendered to primitives at the leaf.",
      },
    ]),

    // --- the theme gate (TN-26-006, ADR 2026-033) -----------------------
    //
    // The second fence around the project's styling freedom. The first is a
    // lint — every colour on screen came through a token name — and this is
    // what makes that worth having: the names are all still defined, and the
    // colours behind them are readable.
    //
    // It runs at DELIVERY rather than at a gate because it is about a file the
    // PROJECT owns, which no red/green gate has any business failing over
    // mid-run: an unreadable theme is not a broken build, it is a repo not
    // ready to hand over. Keyed on the tree like everything else this pack
    // emits — a service with no `src/ui/theme.css` is not a web target, and
    // the check says so and passes.
    contribute(deliverChecks, [
      {
        name: "theme-check",
        description:
          `every token the generated kit styles through is still defined in ${THEME_RELATIVE}, ` +
          "and every declared foreground/background pair reaches WCAG AA contrast — in the base " +
          "theme and in each colour-scheme variant",
        run: runThemeCheck,
      },
      // --- the build gate (dogfood Run 29, Fix 2) -----------------------
      //
      // "Green + delivered" shipped an app that did not build: main.tsx
      // imported an app.tsx nobody wrote, so `vite build` failed while `npm
      // run check` passed — check's scope never reached the web bootstrap.
      // Two fences: run() statically refuses a bootstrap whose imports point
      // at nothing (the missing-app.tsx shape), and checkScript folds `vite
      // build` into the delivered repo's own `check` so the definition of done
      // includes the build from then on. Both name vite only HERE, never in
      // deliver or the core (TN-26-005). Keyed on the tree like theme-check: a
      // service delivered by this harness has no bootstrap and nothing to build.
      {
        name: "build-check",
        description:
          `the web bootstrap (${BOOTSTRAP_RELATIVE}) resolves and the composed stack's build is folded ` +
          "into the project's own check, so a delivered web app that does not build cannot pass",
        run: runBuildCheck,
        checkScript: buildCheckScript,
      },
    ]),
  ],
});
