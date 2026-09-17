import { afterAll, describe, expect, it, test } from "vitest";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { tokensOnlyStyling, untokenizedClasses, utilityPart } from "./tokens-only-styling.ts";
import { webAppPlan } from "../../scripts/new-web-app.ts";
import { lintSrcText } from "../../../ts/scripts/lint-src.ts";

// TN-26-006: every colour on screen came through a token name, so a theme swap
// is total.
//
// THE VALID LIST IS THE LOAD-BEARING HALF, twice over. This rule reads every
// string in a `src/ui/**` file — not only the ones in a `className` — because
// the kit's own tone tables are module constants a lint rule cannot follow to
// their use. That width is only safe if the pattern is narrow, so the cases
// below are mostly the shapes that MUST pass: the whole semantic token set,
// sizes in brackets, token references in brackets, prose that happens to
// contain a colour word, and every file outside the UI tree.

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const UI_FILE = "src/ui/entities/reading/card.tsx";

ruleTester.run("tokens-only-styling", tokensOnlyStyling, {
  valid: [
    // --- the semantic tokens: the entire point ----------------------------
    {
      code: `const c = <div className="bg-primary text-primary-foreground" />;`,
      filename: UI_FILE,
    },
    {
      code: `const c = <div className="bg-muted text-muted-foreground border-border ring-ring" />;`,
      filename: UI_FILE,
    },
    // The tones. `neutral` is ALSO a Tailwind palette name, and the scale is
    // the only thing that tells the two apart — which is why this case exists.
    {
      code: `const c = <span className="bg-neutral text-neutral-foreground" />;`,
      filename: UI_FILE,
    },
    {
      code: `const c = <span className="bg-positive bg-caution bg-critical rounded-card" />;`,
      filename: UI_FILE,
    },
    // The kit's own shape: a tone table hoisted to a module constant. The rule
    // reads it, and it must find nothing.
    {
      code: `const TONE = { positive: "bg-positive text-positive-foreground" } as const;`,
      filename: "src/ui/shared/ui/badge.tsx",
    },

    // --- sizes and layout stay free (v1) ----------------------------------
    { code: `const c = <div className="w-[42ch] grid-cols-[1fr_auto] top-[3px]" />;`, filename: UI_FILE },
    { code: `const c = <div className="max-w-5xl px-6 py-10 gap-1.5 text-2xl" />;`, filename: UI_FILE },
    { code: `const c = <div className="supports-[display:grid]:block" />;`, filename: UI_FILE },

    // A token reference wearing brackets is a token, not a hand-picked colour.
    { code: `const c = <div className="bg-[var(--color-primary)]" />;`, filename: UI_FILE },
    { code: `const c = <div className="[color:var(--color-foreground)]" />;`, filename: UI_FILE },

    // Tailwind's scale-less keywords: not part of the swappable palette.
    { code: `const c = <div className="bg-transparent text-current border-inherit" />;`, filename: UI_FILE },
    { code: `const c = <div className="text-white bg-black" />;`, filename: UI_FILE },

    // --- not styling at all ------------------------------------------------
    // Prose that contains a colour word. The scale is what makes the pattern a
    // class rather than a sentence.
    { code: `const label = "the red zone starts at 500";`, filename: UI_FILE },
    { code: `const help = "text-red is not a class";`, filename: UI_FILE },
    // Imports are strings too.
    { code: `import { cn } from "../../shared/lib/cn.js";`, filename: UI_FILE },

    // --- outside the UI tree ----------------------------------------------
    // The domain has no classes in it, and a fixture is not a screen.
    { code: `const sample = "bg-red-500";`, filename: "src/heating/heating.ts" },
    { code: `const sample = "bg-red-500";`, filename: "tests/ui/card.test.tsx" },
  ],
  invalid: [
    // The archetype: one element keeps yesterday's brand and nothing fails.
    {
      code: `const c = <div className="bg-blue-600 text-white" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "bg-blue-600" } }],
    },
    {
      code: `const c = <p className="text-slate-300" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "text-slate-300" } }],
    },
    // Every colour-carrying utility, not just bg and text.
    {
      code: `const c = <div className="border-zinc-200 ring-sky-400 divide-gray-100" />;`,
      filename: UI_FILE,
      errors: [
        { messageId: "rawColor", data: { token: "border-zinc-200" } },
        { messageId: "rawColor", data: { token: "ring-sky-400" } },
        { messageId: "rawColor", data: { token: "divide-gray-100" } },
      ],
    },
    // Side-qualified borders and gradient stops.
    {
      code: `const c = <div className="border-t-rose-500 from-emerald-400" />;`,
      filename: UI_FILE,
      errors: [
        { messageId: "rawColor", data: { token: "border-t-rose-500" } },
        { messageId: "rawColor", data: { token: "from-emerald-400" } },
      ],
    },
    // Variants do not launder a palette class — including arbitrary variants,
    // whose own colons are why the utility is split at bracket depth zero.
    {
      code: `const c = <div className="hover:bg-red-500 dark:text-zinc-400/50" />;`,
      filename: UI_FILE,
      errors: [
        { messageId: "rawColor", data: { token: "hover:bg-red-500" } },
        { messageId: "rawColor", data: { token: "dark:text-zinc-400/50" } },
      ],
    },
    {
      code: `const c = <div className="data-[state=open]:bg-amber-200" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "data-[state=open]:bg-amber-200" } }],
    },
    // Arbitrary colour values, in every spelling a model reaches for.
    {
      code: `const c = <div className="bg-[#0ea5e9]" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "bg-[#0ea5e9]" } }],
    },
    {
      code: `const c = <div className="text-[oklch(0.7_0.2_20)]" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "text-[oklch(0.7_0.2_20)]" } }],
    },
    {
      code: `const c = <div className="[color:rebeccapurple]" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "[color:rebeccapurple]" } }],
    },
    {
      code: `const c = <div className="shadow-[0_1px_2px_rgba(0,0,0,0.2)]" />;`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "shadow-[0_1px_2px_rgba(0,0,0,0.2)]" } }],
    },
    // Through `cn(...)`, which is how the kit composes.
    {
      code: `const c = cn("rounded-md", "bg-indigo-500", className);`,
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "bg-indigo-500" } }],
    },
    // Hoisted into a constant — the shape a className-only rule would miss,
    // and the shape the kit itself teaches.
    {
      code: `const BASE = "inline-flex bg-violet-600";`,
      filename: "src/ui/shared/ui/thing.tsx",
      errors: [{ messageId: "rawColor", data: { token: "bg-violet-600" } }],
    },
    // The static chunks of a template literal are class strings too.
    {
      code: "const c = <div className={`bg-teal-500 ${extra}`} />;",
      filename: UI_FILE,
      errors: [{ messageId: "rawColor", data: { token: "bg-teal-500" } }],
    },
  ],
});

// --- the pure core, at the edges ---------------------------------------------

describe("utilityPart", () => {
  test("strips variants, and only at bracket depth zero", () => {
    expect(utilityPart("bg-red-500")).toBe("bg-red-500");
    expect(utilityPart("hover:bg-red-500")).toBe("bg-red-500");
    expect(utilityPart("dark:md:hover:bg-red-500")).toBe("bg-red-500");
    expect(utilityPart("data-[state=open]:bg-red-500")).toBe("bg-red-500");
    expect(utilityPart("supports-[display:grid]:block")).toBe("block");
    expect(utilityPart("[&>svg]:text-red-500")).toBe("text-red-500");
  });
});

describe("untokenizedClasses", () => {
  test("finds every offender in a multi-class string, in order", () => {
    expect(untokenizedClasses("rounded-md bg-red-500 p-4 text-slate-50")).toEqual([
      "bg-red-500",
      "text-slate-50",
    ]);
  });

  test("an empty or whitespace-only string finds nothing", () => {
    expect(untokenizedClasses("")).toEqual([]);
    expect(untokenizedClasses("   \n  ")).toEqual([]);
  });

  // The one distinction the whole rule rests on.
  test("the scale is the difference between a token and the palette", () => {
    expect(untokenizedClasses("bg-neutral")).toEqual([]);
    expect(untokenizedClasses("bg-neutral-500")).toEqual(["bg-neutral-500"]);
  });
});

// --- the kit must satisfy its own rule ---------------------------------------
//
// A styling rule the reference kit itself violates is a rule every project
// starts out failing, and the fix would be to weaken the rule. Running the real
// gate over every emitted file is the cheapest way to keep that from ever being
// true: `lintSrcText` is the src gate's own config, contributed rules included,
// so this asserts the rule as the builder will actually meet it.

describe("the generated kit lints clean under its own rule", () => {
  test("no emitted .ts or .tsx file uses a colour a theme cannot reach", async () => {
    const plan = webAppPlan({ routerSpecifier: "../../../api/api.js" });
    const offenders: string[] = [];
    for (const emitted of plan) {
      if (!/\.tsx?$/.test(emitted.path)) continue;
      const problems = await lintSrcText(emitted.content, emitted.path);
      for (const problem of problems) {
        if (problem.ruleId?.includes("tokens-only-styling") === true) {
          offenders.push(`${emitted.path}: ${problem.message}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
