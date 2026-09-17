import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  GENERATOR,
  isOwnArtifact,
  markerFor,
  routerSpecifierFor,
  serviceContracts,
  syncWebApp,
  webAppPlan,
  webAppSeeds,
} from "./new-web-app.ts";
import { themeContract } from "../theme-contract.ts";
import { isGeneratedArtifact } from "../../ts/scripts/scaffold-contract.ts";
import { lintSrcText } from "../../ts/scripts/lint-src.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "web-app-"));
  tmpDirs.push(dir);
  for (const [rel, source] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return dir;
}

/** A service contract in the shape router-type-reexported enforces: the
 *  inferred router type, re-exported from the implementation module. */
const SERVICE_CONTRACT = `import type { serviceRouter } from "./api.js";
export type ServiceRouter = typeof serviceRouter;
`;

const PLAN_WITH_API = webAppPlan({ routerSpecifier: "../../../api/api.js" });
const PLAN_WITHOUT_API = webAppPlan({ routerSpecifier: undefined });
const SEEDS = webAppSeeds();

function pathsOf(plan: readonly { path: string }[]): string[] {
  return plan.map((f) => f.path);
}

function contentAt(plan: readonly { path: string; content: string }[], path: string): string {
  const found = plan.find((f) => f.path === path);
  if (found === undefined) throw new Error(`plan has no ${path} (has ${pathsOf(plan).join(", ")})`);
  return found.content;
}

// --- the plan (pure) ---------------------------------------------------------

describe("the emitted layout", () => {
  test("is the FSD layers, the component kit, and the two entries", () => {
    expect(pathsOf(PLAN_WITHOUT_API)).toEqual([
      "index.html",
      "src/ui/app.css",
      "src/ui/entities/.gitkeep",
      "src/ui/features/.gitkeep",
      "src/ui/main.tsx",
      "src/ui/pages/.gitkeep",
      "src/ui/shared/api/.gitkeep",
      "src/ui/shared/lib/cn.ts",
      "src/ui/shared/ui/badge.tsx",
      "src/ui/shared/ui/button.tsx",
      "src/ui/shared/ui/card.tsx",
      "src/ui/shared/ui/data-list.tsx",
      "src/ui/shared/ui/index.ts",
      "src/ui/shared/ui/input.tsx",
      "src/ui/shared/ui/label.tsx",
      "src/ui/shared/ui/page-shell.tsx",
      "src/ui/shared/ui/stat.tsx",
      "vite.config.ts",
    ]);
  });

  // shared/ui and shared/lib hold real files, so a placeholder beside them
  // would be debris the v1 sync never prunes.
  test("the filled layers get no .gitkeep", () => {
    expect(pathsOf(PLAN_WITH_API)).not.toContain("src/ui/shared/ui/.gitkeep");
    expect(pathsOf(PLAN_WITH_API)).not.toContain("src/ui/shared/lib/.gitkeep");
  });

  // `widgets` is recognised by the lints (they place it between features and
  // pages) and emitted by nobody: a layer that exists only as an empty folder
  // invites a composition tier the project has not earned yet (TN-26-006).
  test("widgets is reserved, not emitted, and processes is gone entirely", () => {
    for (const path of pathsOf(PLAN_WITH_API)) {
      expect(path).not.toContain("widgets");
      expect(path).not.toContain("processes");
    }
  });

  test("every emitted file carries the marker as line 1", () => {
    for (const emitted of PLAN_WITH_API) {
      expect(isOwnArtifact(emitted.content), emitted.path).toBe(true);
      expect(emitted.content.startsWith(markerFor(emitted.path)), emitted.path).toBe(true);
    }
  });

  // The marker sentence is the scaffolder's, so the ts pack's sync recognises
  // a ts-web file as machine-written — which is what stops it treating one as
  // hand-written work, and what will let this generator prune its own output
  // when pruning arrives (TN-26-006 B1 widened the pack segment for exactly
  // this).
  test("the .ts and .tsx files are recognised by the scaffolder's marker too", () => {
    for (const emitted of PLAN_WITH_API) {
      if (!/\.tsx?$/.test(emitted.path)) continue;
      expect(isGeneratedArtifact(emitted.content), emitted.path).toBe(true);
    }
  });

  // `//` is a comment in TypeScript, a paragraph of visible text in HTML, and a
  // syntax error in CSS. One sentence, four wrappers.
  test("the marker is written in the syntax each language accepts", () => {
    expect(markerFor("x.ts")).toMatch(/^\/\/ GENERATED/);
    expect(markerFor("x.tsx")).toMatch(/^\/\/ GENERATED/);
    expect(markerFor("x.css")).toMatch(/^\/\* GENERATED .* \*\/$/);
    expect(markerFor("x.html")).toMatch(/^<!-- GENERATED .* -->$/);
    expect(markerFor(".gitkeep")).toMatch(/^# GENERATED/);
    expect(markerFor("x.ts")).toContain(GENERATOR);
  });

  test("a file another generator wrote is not this generator's to own", () => {
    expect(
      isOwnArtifact("// GENERATED from x.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.\n"),
    ).toBe(false);
    expect(isOwnArtifact("export const x = 1;\n")).toBe(false);
  });

  // STRUCTURE GENERATED, IDENTITY OWNED (TN-26-006). app.css is pack-owned and
  // restored on every sync, so it may not hold a single colour: every token is
  // one import away in theme.css, which the project owns outright.
  test("the Tailwind entry is CSS-first and holds structure, never identity", () => {
    const css = contentAt(PLAN_WITH_API, "src/ui/app.css");
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain('@import "./theme.css";');
    expect(css).not.toContain("@theme {");
    expect(css).not.toMatch(/--color-\w+:/);
    // v4 configures in CSS; a config file would be a second source of truth.
    expect(css).not.toContain("tailwind.config");
    // Tailwind inlines imports and builds utilities from the @theme blocks in
    // the bundle, so the theme has to arrive after the framework.
    expect(css.indexOf('@import "tailwindcss";')).toBeLessThan(css.indexOf('@import "./theme.css";'));
  });

  test("the Vite config wires React, Tailwind, and the /trpc proxy", () => {
    const config = contentAt(PLAN_WITH_API, "vite.config.ts");
    expect(config).toContain("@vitejs/plugin-react");
    expect(config).toContain("@tailwindcss/vite");
    expect(config).toContain('"/trpc"');
    expect(config).toContain("PLACEHOLDER");
  });

  test("index.html mounts the entry module at the project-rooted path Vite serves", () => {
    const html = contentAt(PLAN_WITH_API, "index.html");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/src/ui/main.tsx"');
  });

  test("each layer's .gitkeep says what belongs in that layer", () => {
    expect(contentAt(PLAN_WITH_API, "src/ui/entities/.gitkeep")).toMatch(/READ side/);
    expect(contentAt(PLAN_WITH_API, "src/ui/features/.gitkeep")).toMatch(/WRITE side/);
    expect(contentAt(PLAN_WITH_API, "src/ui/pages/.gitkeep")).toMatch(/Routes/);
  });
});

// --- the component kit (B3) --------------------------------------------------

describe("the vendored component kit", () => {
  test("is button, card, input, label, and the class merger they share", () => {
    for (const path of [
      "src/ui/shared/ui/button.tsx",
      "src/ui/shared/ui/card.tsx",
      "src/ui/shared/ui/input.tsx",
      "src/ui/shared/ui/label.tsx",
      "src/ui/shared/lib/cn.ts",
    ]) {
      expect(pathsOf(PLAN_WITH_API), path).toContain(path);
    }
  });

  test("every component is exported from the kit's index", () => {
    const index = contentAt(PLAN_WITH_API, "src/ui/shared/ui/index.ts");
    for (const name of [
      "Badge",
      "Button",
      "Card",
      "CardTitle",
      "CardContent",
      "DataList",
      "DataListItem",
      "Input",
      "Label",
      "PageShell",
      "Stat",
    ]) {
      expect(index, name).toContain(name);
    }
  });

  // The whole restyling contract: tokens in app.css, never an edit here
  // (ratified at the 2026-09-14 grill). A hex code or an `rgb()` in a component
  // is a colour the token block cannot reach.
  test("components style through the semantic tokens, never through raw colours", () => {
    for (const emitted of PLAN_WITH_API) {
      if (!emitted.path.startsWith("src/ui/shared/ui/")) continue;
      expect(emitted.content, emitted.path).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(emitted.content, emitted.path).not.toMatch(/\b(rgb|hsl|oklch)\(/);
    }
    const button = contentAt(PLAN_WITH_API, "src/ui/shared/ui/button.tsx");
    for (const token of ["bg-primary", "text-primary-foreground", "bg-destructive", "ring-ring"]) {
      expect(button, token).toContain(token);
    }
  });

  test("every token a component uses is defined in the starter theme", () => {
    const css = contentAt(SEEDS, "src/ui/theme.css");
    const used = new Set<string>();
    for (const emitted of PLAN_WITH_API) {
      if (!emitted.path.startsWith("src/ui/shared/ui/")) continue;
      for (const match of emitted.content.matchAll(
        /\b(?:bg|text|border|ring|rounded)-(primary|primary-foreground|destructive|destructive-foreground|muted|muted-foreground|background|foreground|border|ring|card|positive|positive-foreground|caution|caution-foreground|critical|critical-foreground|neutral|neutral-foreground)\b/g,
      )) {
        used.add(match[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(4);
    const missing = [...used].filter(
      (name) => !css.includes(`--color-${name}:`) && !css.includes(`--radius-${name}:`),
    );
    expect(missing).toEqual([]);
  });

  // `twMerge` is why a caller's className actually wins: two Tailwind utilities
  // for the same property have equal specificity, so without de-duplication the
  // override silently does nothing.
  test("cn merges rather than concatenating", () => {
    const cn = contentAt(PLAN_WITH_API, "src/ui/shared/lib/cn.ts");
    expect(cn).toContain("twMerge");
    expect(cn).toContain("clsx");
  });

  // Documented in the generator's own header, and pinned here: a dependency
  // nothing yet needs is one every project inherits forever.
  test("the kit takes no dependency it does not need", () => {
    for (const emitted of PLAN_WITH_API) {
      if (!emitted.path.startsWith("src/ui/shared/")) continue;
      expect(emitted.content, emitted.path).not.toContain("class-variance-authority");
      expect(emitted.content, emitted.path).not.toContain("@radix-ui/");
    }
  });

  // Blind UI testing keys on roles, labels and visible text (TN-26-006), and
  // those come from the elements the kit chooses: a real <label> is what makes
  // `getByLabelText` work, and a heading is what gives a card a name.
  test("the kit emits the elements a blind UI test can find", () => {
    expect(contentAt(PLAN_WITH_API, "src/ui/shared/ui/label.tsx")).toContain("<label");
    expect(contentAt(PLAN_WITH_API, "src/ui/shared/ui/card.tsx")).toContain("<h3");
    expect(contentAt(PLAN_WITH_API, "src/ui/shared/ui/button.tsx")).toContain("<button");
  });

  // The HTML default for a button inside a form is "submit", so a button that
  // opens a dialog submits the form instead — and the bug reads as "the form
  // submits twice", three files away.
  test("Button defaults its type, because HTML's default is a trap", () => {
    expect(contentAt(PLAN_WITH_API, "src/ui/shared/ui/button.tsx")).toContain('type = "button"');
  });
});

// --- the project-owned theme (TN-26-006) -------------------------------------
//
// The ONE unmarked file the generator emits. Everything else in the layout is
// pack-owned and restored on every run; this one is written when absent and
// then belongs to the project forever. Before the split, "the tokens are the
// restyling surface" was true in prose and false on disk — the tokens lived in
// a generated file the next sync restored.

describe("the project-owned theme", () => {
  const theme = contentAt(SEEDS, "src/ui/theme.css");

  test("is exactly one seed, at src/ui/theme.css", () => {
    expect(SEEDS.map((s) => s.path)).toEqual(["src/ui/theme.css"]);
  });

  // THE MARKER MEANS "this generator will restore this file". On a file the
  // project is invited to edit it would be a lie the next sync tells the truth
  // about, by deleting somebody's work.
  test("carries no generated marker — neither this generator's nor the scaffolder's", () => {
    expect(isOwnArtifact(theme)).toBe(false);
    expect(isGeneratedArtifact(theme)).toBe(false);
    expect(theme).not.toContain("GENERATED from");
    expect(theme).not.toContain("do not edit");
  });

  // A starter file that does not say it is yours gets treated as generated by
  // the next person to read it — which is how a restyling surface goes unused.
  test("says in its own header that it is the project's to edit", () => {
    expect(theme).toMatch(/THIS FILE IS YOURS/);
    expect(theme).toMatch(/never overwrite/i);
    expect(theme).toMatch(/fresh look/i);
  });

  test("holds the whole token block, light and dark", () => {
    expect(theme).toContain("@theme {");
    expect(theme).toContain("@media (prefers-color-scheme: dark)");
    expect(theme).not.toContain('@import "tailwindcss"');
  });

  // The contract the kit and the gate both answer to lives in contrib.json, so
  // a starter theme missing a required token would be a pack shipping a project
  // that cannot pass the pack's own delivery gate.
  test("defines every token contrib.json requires", () => {
    const { requiredTokens } = themeContract();
    expect(requiredTokens.length).toBeGreaterThan(10);
    const missing = requiredTokens.filter((token) => !theme.includes(`${token}:`));
    expect(missing).toEqual([]);
  });

  // Both halves of every declared pair, or the gate would be measuring the
  // contrast of a token nothing defines.
  test("defines both halves of every contrast pair, and requires them", () => {
    const { requiredTokens, contrastPairs } = themeContract();
    expect(contrastPairs.length).toBeGreaterThan(4);
    for (const [foreground, background] of contrastPairs) {
      for (const token of [foreground, background]) {
        expect(theme, token).toContain(`${token}:`);
        expect(requiredTokens, token).toContain(token);
      }
    }
  });
});

// --- the layout primitives (TN-26-006, "anatomy enforced, identity free") ----
//
// r24 shipped 77 green tests over a page of bare paragraphs, because the kit it
// composed had no page, no heading row, no metric and no list — only the pieces
// that go INSIDE one. These four make the styled path the default path, and the
// assertions below are the two halves of that promise: the anatomy is really
// there, and it carries no domain and no raw colour with it.

describe("the layout primitives", () => {
  const primitives = [
    "src/ui/shared/ui/page-shell.tsx",
    "src/ui/shared/ui/badge.tsx",
    "src/ui/shared/ui/stat.tsx",
    "src/ui/shared/ui/data-list.tsx",
  ];

  test("are all four of them", () => {
    for (const path of primitives) expect(pathsOf(PLAN_WITH_API), path).toContain(path);
  });

  // The page container r24 had to invent. A measure is not decoration:
  // unbounded text on a wide monitor runs to 200 characters a line, which is
  // the commonest way a correct screen reads as broken.
  test("PageShell is a centred, measured page with one h1", () => {
    const shell = contentAt(PLAN_WITH_API, "src/ui/shared/ui/page-shell.tsx");
    expect(shell).toContain("<main");
    expect(shell).toContain("<h1");
    expect(shell).toContain("mx-auto");
    expect(shell).toMatch(/max-w-\w+/);
    // Exactly one, counted by the closing tag (the prop's doc comment names
    // `<h1>` too, and a comment is not a heading).
    expect(shell.match(/<\/h1>/g)).toHaveLength(1);
  });

  // THE KIT IS `shared`, AND SHARED HAS NO DOMAIN (Law 1, enforced by
  // fsd-downward-imports from the other side). So the Badge's variants are
  // readings — "how does this value read?" — that any domain can map onto, and
  // the mapping lives in the entity slice that knows what a band is.
  test("Badge's variants are tones, never domain words", () => {
    const badge = contentAt(PLAN_WITH_API, "src/ui/shared/ui/badge.tsx");
    expect(badge).toContain(
      'export type BadgeTone = "positive" | "caution" | "critical" | "neutral";',
    );
    for (const domainWord of ["band", "grade", "severity", "status", "rating", "level"]) {
      expect(badge.toLowerCase(), domainWord).not.toContain(`"${domainWord}"`);
    }
  });

  // Colour alone is not a signal: a colour-blind reader, a greyscale print and
  // a screen reader all get nothing from a green pill. `children` is typed
  // REQUIRED, so a wordless Badge is a compile error rather than a review
  // finding — and the tsc test below compiles a Badge that has words.
  test("Badge requires visible text, by type", () => {
    expect(contentAt(PLAN_WITH_API, "src/ui/shared/ui/badge.tsx")).toContain(
      "readonly children: ReactNode;",
    );
  });

  // Found by the FIRST real screenshot (TN-26-006 slice 4), with every test
  // green: a Badge inside a `flex flex-col` CardHeader is a flex item, and flex
  // items stretch — the chip rendered as a full-width red bar. `inline-flex`
  // governs its own children and says nothing about its width.
  test("Badge shrink-wraps, so a flex parent cannot stretch it into a bar", () => {
    expect(contentAt(PLAN_WITH_API, "src/ui/shared/ui/badge.tsx")).toContain("w-fit");
  });

  test("every tone has a background token and a foreground token, both defined", () => {
    const badge = contentAt(PLAN_WITH_API, "src/ui/shared/ui/badge.tsx");
    const css = contentAt(SEEDS, "src/ui/theme.css");
    for (const tone of ["positive", "caution", "critical", "neutral"]) {
      expect(badge, tone).toContain(`bg-${tone} text-${tone}-foreground`);
      expect(css, tone).toContain(`--color-${tone}:`);
      expect(css, tone).toContain(`--color-${tone}-foreground:`);
    }
  });

  // The unit is its own element rather than glued into the value string, so a
  // blind test can assert the number and the unit independently — and so the
  // unit can be typeset quieter than the number it belongs to.
  test("Stat is label + value + optional unit, each its own element", () => {
    const stat = contentAt(PLAN_WITH_API, "src/ui/shared/ui/stat.tsx");
    expect(stat).toContain("readonly label: string;");
    expect(stat).toContain("readonly value: string;");
    expect(stat).toContain("readonly unit?: string;");
    expect(stat).toContain("{label}");
    expect(stat).toContain("{value}");
    expect(stat).toContain("{unit}");
    // a column of readings must line up digit for digit
    expect(stat).toContain("tabular-nums");
  });

  // Tailwind's preflight removes the list marker, and a marker-less list loses
  // its list semantics in Safari's accessibility tree — so the role is written
  // back, and `getAllByRole("listitem")` keeps working for a test-writer who
  // cannot see the screen.
  test("DataList is a titled, real list with an empty state", () => {
    const list = contentAt(PLAN_WITH_API, "src/ui/shared/ui/data-list.tsx");
    expect(list).toContain("<h2");
    expect(list).toContain('<ul role="list"');
    expect(list).toContain("<li");
    expect(list).toContain("aria-labelledby");
    expect(list).toContain("readonly empty?: ReactNode;");
  });

  // The identity-free half of the promise, over the WHOLE kit: a domain noun in
  // `shared/ui` is a kit no second project can use, and it is the exact defect
  // Law 1 cannot catch (naming is not importing).
  //
  // CODE, not prose: `Label`'s doc comment names "Meter reading" as an EXAMPLE
  // of an accessible name, which teaches the reader something and couples
  // nothing. A domain noun in an identifier, a type or a class string is the
  // defect; one in a sentence is a sentence.
  test("nothing in the kit knows a domain", () => {
    const DOMAIN_NOUNS = ["building", "heating", "meter", "invoice", "report", "tenant"];
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const emitted of PLAN_WITH_API) {
      if (!emitted.path.startsWith("src/ui/shared/ui/")) continue;
      const code = stripComments(emitted.content).toLowerCase();
      for (const noun of DOMAIN_NOUNS) {
        expect(code, `${emitted.path} names '${noun}'`).not.toContain(noun);
      }
    }
  });
});

// --- the one door, keyed on the tree ----------------------------------------

describe("the typed client is emitted only once there is a router to type it", () => {
  test("no service contract: the api layer is a placeholder, and main.tsx has no provider", () => {
    expect(pathsOf(PLAN_WITHOUT_API)).toContain("src/ui/shared/api/.gitkeep");
    expect(pathsOf(PLAN_WITHOUT_API)).not.toContain("src/ui/shared/api/client.tsx");
    expect(contentAt(PLAN_WITHOUT_API, "src/ui/main.tsx")).not.toContain("TrpcProvider");
  });

  test("with a service contract: the client lands and main.tsx wraps the tree", () => {
    const client = contentAt(PLAN_WITH_API, "src/ui/shared/api/client.tsx");
    expect(client).toContain('import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";');
    expect(client).toContain('from "@tanstack/react-query"');
    expect(client).toContain('import type { ServiceRouter } from "../../../api/api.js";');
    expect(client).toContain("export function TrpcProvider");
    expect(contentAt(PLAN_WITH_API, "src/ui/main.tsx")).toContain("<TrpcProvider>");
  });

  // The router type is reached through the IMPLEMENTATION module, never through
  // the contract: a contract's ambient declarations are a second identity for
  // everything they declare (ADR 2026-023).
  test("the router specifier points at the implementation module", () => {
    const dir = project({ "src/api/api.contract.ts": SERVICE_CONTRACT });
    expect(routerSpecifierFor(dir, join(dir, "src/api/api.contract.ts"))).toBe("../../../api/api.js");
  });

  test("a service contract is found by the re-export the purity gate already demands", () => {
    const dir = project({
      "src/api/api.contract.ts": SERVICE_CONTRACT,
      "src/money/money.contract.ts": "export interface Money { readonly cents: number }\n",
    });
    expect(serviceContracts(dir).map((p) => p.slice(dir.length + 1))).toEqual([
      join("src", "api", "api.contract.ts"),
    ]);
  });
});

// --- the sync ----------------------------------------------------------------

describe("syncWebApp", () => {
  test("writes the whole layout into an empty tree", () => {
    const dir = project();
    const run = syncWebApp(dir);
    expect(run.code).toBe(0);
    for (const emitted of PLAN_WITHOUT_API) {
      expect(existsSync(join(dir, emitted.path)), emitted.path).toBe(true);
      expect(readFileSync(join(dir, emitted.path), "utf8")).toBe(emitted.content);
    }
    // the generated layout plus the one seed (theme.css)
    expect(run.lines.at(-1)).toBe(
      `new-web-app: wrote ${PLAN_WITHOUT_API.length + SEEDS.length} files`,
    );
  });

  test("a second run over an untouched tree writes nothing", () => {
    const dir = project();
    expect(syncWebApp(dir).code).toBe(0);
    const second = syncWebApp(dir);
    expect(second.code).toBe(0);
    expect(second.lines.at(-1)).toMatch(/already in sync/);
    expect(second.lines.filter((l) => l.includes("wrote "))).toEqual([]);
  });

  // The inverse of every other file in the layout, and the whole point of the
  // seed: a hand-edited theme.css is the project HAVING a visual identity.
  test("a hand-edited theme.css survives every re-run, unchanged", () => {
    const dir = project();
    syncWebApp(dir);
    const theme = join(dir, "src/ui/theme.css");
    const mine = "/* my brand */\n@theme {\n  --color-primary: oklch(0.4 0.2 20);\n}\n";
    writeFileSync(theme, mine);
    const run = syncWebApp(dir);
    expect(run.code).toBe(0);
    expect(readFileSync(theme, "utf8")).toBe(mine);
    expect(run.lines.join("\n")).toMatch(/kept src\/ui\/theme\.css/);
    // and it does NOT block: an edited theme is the desired state, not drift
    expect(run.lines.join("\n")).not.toContain("BLOCK");
  });

  test("the starter theme is written once, and the run says it is the project's", () => {
    const dir = project();
    const run = syncWebApp(dir);
    expect(existsSync(join(dir, "src/ui/theme.css"))).toBe(true);
    expect(run.lines.join("\n")).toMatch(/wrote src\/ui\/theme\.css — a STARTER theme/);
    expect(readFileSync(join(dir, "src/ui/theme.css"), "utf8")).toBe(
      contentAt(SEEDS, "src/ui/theme.css"),
    );
  });

  // A project that DELETED its theme gets the starter back rather than a build
  // with no tokens in it — the app.css import would otherwise dangle.
  test("a deleted theme.css is re-seeded", () => {
    const dir = project();
    syncWebApp(dir);
    rmSync(join(dir, "src/ui/theme.css"));
    expect(syncWebApp(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/ui/theme.css"))).toBe(true);
  });

  test("a hand-edited generated file is restored — the layout is pack-owned", () => {
    const dir = project();
    syncWebApp(dir);
    const css = join(dir, "src/ui/app.css");
    writeFileSync(css, `${readFileSync(css, "utf8")}\n/* a local tweak */\n`);
    expect(syncWebApp(dir).code).toBe(0);
    expect(readFileSync(css, "utf8")).not.toContain("a local tweak");
  });

  // The one thing a generator must never do. r15 cost 28 minutes of a builder's
  // work to a sync that overwrote what it found; nothing about re-running a
  // generator should be able to cost that again.
  test("an unmarked file at a pack-owned path blocks, and NOTHING is written", () => {
    const dir = project({ "vite.config.ts": "// mine, hand-written\nexport default {};\n" });
    const run = syncWebApp(dir);
    expect(run.code).toBe(1);
    expect(run.lines.join("\n")).toContain("vite.config.ts");
    expect(run.lines.join("\n")).toContain("Nothing was written");
    expect(readFileSync(join(dir, "vite.config.ts"), "utf8")).toContain("mine, hand-written");
    // the block happened before any other path was touched
    expect(existsSync(join(dir, "index.html"))).toBe(false);
    expect(existsSync(join(dir, "src/ui/main.tsx"))).toBe(false);
  });

  test("another pack's generated file at a pack-owned path blocks too", () => {
    const dir = project({
      "src/ui/main.tsx":
        "// GENERATED from x.contract.ts by packs/ts/scripts/scaffold-contract.ts — do not edit.\n",
    });
    expect(syncWebApp(dir).code).toBe(1);
  });

  test("two service contracts is a block — the one door cannot point at two services", () => {
    const dir = project({
      "src/api/api.contract.ts": SERVICE_CONTRACT,
      "src/admin/admin.contract.ts": SERVICE_CONTRACT,
    });
    const run = syncWebApp(dir);
    expect(run.code).toBe(1);
    expect(run.lines.join("\n")).toMatch(/cannot point at two/);
    expect(existsSync(join(dir, "index.html"))).toBe(false);
  });

  test("a tree that grows a service contract gains the client on the next run", () => {
    const dir = project();
    syncWebApp(dir);
    expect(existsSync(join(dir, "src/ui/shared/api/client.tsx"))).toBe(false);
    mkdirSync(join(dir, "src/api"), { recursive: true });
    writeFileSync(join(dir, "src/api/api.contract.ts"), SERVICE_CONTRACT);
    expect(syncWebApp(dir).code).toBe(0);
    expect(existsSync(join(dir, "src/ui/shared/api/client.tsx"))).toBe(true);
    expect(readFileSync(join(dir, "src/ui/main.tsx"), "utf8")).toContain("<TrpcProvider>");
  });

  test("the run is recorded in the guard log, pass and block alike", () => {
    const dir = project();
    syncWebApp(dir);
    const blocked = project({ "index.html": "<!-- mine -->\n" });
    syncWebApp(blocked);
    expect(readGuardLog(dir).map((e) => e.verdict)).toEqual(["pass"]);
    expect(readGuardLog(blocked).map((e) => e.verdict)).toEqual(["block"]);
  });
});

// --- the emitted code answers to the harness's own gates ---------------------

describe("the emitted TypeScript passes the src gate", () => {
  // The generated frontend is `src/**` like any other implementation: the four
  // escape hatches are banned there too (TN-26-006 A1), and a generator that
  // emitted `as any` would be handing the builder a licence the gate refuses.
  test("no emitted .ts or .tsx file trips lint-src", async () => {
    for (const emitted of PLAN_WITH_API) {
      if (!/\.tsx?$/.test(emitted.path)) continue;
      const problems = await lintSrcText(emitted.content, emitted.path);
      expect(problems.map((p) => `${emitted.path}: ${p.ruleId}`)).toEqual([]);
    }
  });
});

// --- the emitted tree actually compiles --------------------------------------
//
// The shadow-project trick the red gate uses, pointed at a generator: emit the
// layout into a temp project, symlink the harness's node_modules (which is why
// the web stack is pinned here at all), write the tsconfig a web target uses,
// and run the real tsc. Structural assertions can say the client imports
// `TRPCClient`; only the compiler can say that name exists in the version we
// pinned, that `createRoot` takes what main.tsx gives it, and that the router
// type threads through the client generic.

const WEB_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      types: ["node"],
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"],
  },
  null,
  2,
);

/** What the architect's own `src/ui/app.contract.ts` eventually produces —
 *  the generator deliberately does not emit it (see template.ts).
 *
 *  It COMPOSES THE KIT rather than returning a bare element, and that is the
 *  point of the fixture: structural assertions can say a Badge exists, but only
 *  the compiler can say that `<Badge tone="critical">` accepts that tone, that
 *  a wordless Badge would not have compiled, that `Stat`'s unit is genuinely
 *  optional, and that `PageShell`'s `actions` slot takes a Button. This is the
 *  shape the SKILL tells a builder to write, typechecked. */
const APP_TSX = `import type { ReactElement } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  DataList,
  DataListItem,
  PageShell,
  Stat,
} from "./shared/ui/index.js";

export function App(): ReactElement {
  return (
    <PageShell
      title="Overview"
      description="Everything at a glance."
      actions={<Button tone="secondary">Refresh</Button>}
    >
      <DataList title="Readings" empty="Nothing to show yet.">
        <DataListItem>
          <Card>
            <CardTitle>North wing</CardTitle>
            <CardContent>
              <Stat label="Flow temperature" value="21.5" unit="°C" />
              <Stat label="Open actions" value="3" />
              <Badge tone="critical">Act now</Badge>
            </CardContent>
          </Card>
        </DataListItem>
      </DataList>
    </PageShell>
  );
}
`;

describe("the emitted tree compiles", () => {
  test("tsc is clean over the full layout, client and all", () => {
    const dir = project({
      "src/ui/app.tsx": APP_TSX,
      // A REAL tRPC router, not a stand-in shaped like one: `TRPCClient<R>`
      // constrains R to an actual router, so a hand-written object here would
      // prove the client compiles against something no service ever produces.
      "src/api/api.contract.ts": SERVICE_CONTRACT,
      "src/api/api.ts": `import { initTRPC } from "@trpc/server";

export type * from "./api.contract.js";

const t = initTRPC.create();

export const serviceRouter = t.router({
  buildingStatus: t.procedure.query((): string => "ok"),
});
`,
      // ESM, like every web target: under NodeNext a CommonJS vite.config.ts
      // resolves plugin defaults through the require-interop shape and stops
      // compiling. Worth pinning — it is exactly the kind of failure that would
      // otherwise land on an architect's first run.
      "package.json": JSON.stringify({ name: "web-fixture", private: true, type: "module" }, null, 2),
      "tsconfig.json": WEB_TSCONFIG,
    });
    expect(syncWebApp(dir).code).toBe(0);
    symlinkSync(join(import.meta.dirname, "..", "..", "..", "node_modules"), join(dir, "node_modules"));
    const tsc = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "..", "..", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(`${tsc.stdout}${tsc.stderr}`.trim()).toBe("");
    expect(tsc.status).toBe(0);
  });
});
