import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  checkTheme,
  contrastRatio,
  relativeLuminance,
  resolveColor,
  resolvedScopes,
  runThemeCheck,
  themeScopes,
  THEME_RELATIVE,
} from "./theme-check.ts";
import { themeContract, MIN_CONTRAST_RATIO } from "../theme-contract.ts";
import { webAppSeeds } from "./new-web-app.ts";

// The theme gate (TN-26-006, ADR 2026-033): any look, never an unreadable or
// incomplete one.
//
// The starter theme the generator seeds is the fixture that matters most — a
// pack whose own starter cannot pass the pack's own delivery gate would be
// shipping every project a block on day one.

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CONTRACT = themeContract();
const STARTER = webAppSeeds().find((s) => s.path === THEME_RELATIVE)?.content ?? "";

function projectWithTheme(css?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "theme-check-"));
  tmpDirs.push(dir);
  if (css !== undefined) {
    const path = join(dir, THEME_RELATIVE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, css);
  }
  return dir;
}

/** The starter theme with one declaration rewritten — the shape of every
 *  realistic failure: a project repainted itself and went one shade too far. */
function starterWith(token: string, value: string): string {
  const pattern = new RegExp(`(${token}):\\s*[^;]+;`);
  const replaced = STARTER.replace(pattern, `$1: ${value};`);
  expect(replaced, `fixture did not replace ${token}`).not.toBe(STARTER);
  return replaced;
}

// --- the arithmetic ----------------------------------------------------------
//
// Thirty lines of published maths, pinned against numbers anyone can check:
// WCAG's own worked examples are black on white (21:1) and a colour against
// itself (1:1), and the sRGB primaries' luminances are the coefficients.

describe("the contrast arithmetic", () => {
  const white = { r: 1, g: 1, b: 1 };
  const black = { r: 0, g: 0, b: 0 };

  test("black on white is 21:1, and any colour on itself is 1:1", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // order is irrelevant — contrast is a relationship, not a direction
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
  });

  test("relative luminance uses WCAG's weights", () => {
    expect(relativeLuminance({ r: 1, g: 0, b: 0 })).toBeCloseTo(0.2126, 6);
    expect(relativeLuminance({ r: 0, g: 1, b: 0 })).toBeCloseTo(0.7152, 6);
    expect(relativeLuminance({ r: 0, g: 0, b: 1 })).toBeCloseTo(0.0722, 6);
  });

  test("the same colour in four spellings resolves to the same light", () => {
    const tokens = new Map([["--brand", "#ffffff"]]);
    const spellings = ["#fff", "#ffffff", "rgb(255 255 255)", "var(--brand)"];
    const measured = spellings.map((s) => relativeLuminance(resolveColor(s, tokens) ?? black));
    for (const value of measured) expect(value).toBeCloseTo(1, 6);
  });

  test("oklch resolves, including percentage lightness and an angle unit", () => {
    const tokens = new Map<string, string>();
    const plain = resolveColor("oklch(0.55 0.18 264)", tokens);
    const spelled = resolveColor("oklch(55% 0.18 264deg)", tokens);
    expect(plain).toBeDefined();
    expect(relativeLuminance(spelled ?? black)).toBeCloseTo(relativeLuminance(plain ?? white), 6);
  });

  // The escape hatch the design WANTS: a theme that names its brand once and
  // refers to it everywhere is doing exactly the right thing.
  test("var() references are followed, and a cycle is unreadable rather than a hang", () => {
    const tokens = new Map([
      ["--a", "var(--b)"],
      ["--b", "#000000"],
      ["--loop", "var(--loop)"],
    ]);
    expect(resolveColor("var(--a)", tokens)).toEqual({ r: 0, g: 0, b: 0 });
    expect(resolveColor("var(--loop)", tokens)).toBeUndefined();
  });

  test("a colour this gate cannot read is undefined, not a guess", () => {
    const tokens = new Map<string, string>();
    expect(resolveColor("color-mix(in oklch, red, blue)", tokens)).toBeUndefined();
    expect(resolveColor("inherit", tokens)).toBeUndefined();
  });
});

// --- reading the file --------------------------------------------------------

describe("themeScopes", () => {
  test("finds the base block and labels a media-nested one by its query", () => {
    const scopes = themeScopes(`@theme { --color-a: #fff; }
@media (prefers-color-scheme: dark) { @theme { --color-a: #000; } }`);
    expect(scopes.map((s) => s.label)).toEqual([
      "the base theme",
      "@media (prefers-color-scheme: dark)",
    ]);
  });

  test("comments are not declarations", () => {
    const scopes = themeScopes(`/* --color-ghost: #fff; */ @theme { --color-a: #fff; }`);
    expect([...(scopes[0]?.tokens.keys() ?? [])]).toEqual(["--color-a"]);
  });

  // A dark block overriding five tokens is not a theme of five tokens — it is
  // the whole theme with five values replaced. Checking it any other way would
  // report fourteen missing tokens for a file that is completely correct.
  test("a variant scope inherits everything the base defined", () => {
    const resolved = resolvedScopes(`@theme { --color-a: #fff; --color-b: #eee; }
@media (prefers-color-scheme: dark) { @theme { --color-a: #000; } }`);
    const dark = resolved.find((s) => s.label.includes("dark"));
    expect(dark?.tokens.get("--color-a")).toBe("#000");
    expect(dark?.tokens.get("--color-b")).toBe("#eee");
  });

  test("a file with no @theme block has one empty base scope", () => {
    expect(resolvedScopes("body { color: red; }")).toEqual([
      { label: "the base theme", tokens: new Map() },
    ]);
  });
});

// --- the verdict -------------------------------------------------------------

describe("the starter theme the generator seeds", () => {
  test("passes its own gate, in every scheme", () => {
    expect(checkTheme(STARTER, CONTRACT)).toEqual([]);
  });

  test("and the delivery step says so with the numbers", () => {
    const result = runThemeCheck(projectWithTheme(STARTER), CONTRACT);
    expect(result.verdict).toBe("pass");
    expect(result.summary).toContain(`${CONTRACT.requiredTokens.length} tokens`);
    expect(result.summary).toContain(`${CONTRACT.contrastPairs.length} contrast pairs`);
    // base + dark
    expect(result.summary).toMatch(/across 2 schemes/);
  });
});

describe("a theme that would ship an unreadable screen", () => {
  // The realistic failure: a project picked a lighter brand colour, and white
  // text on it is now a rumour. Nothing else in the pipeline can see this —
  // the suite keys on roles and text, and both still pass.
  test("a low-contrast pair is a block, with the pair and the ratio in the message", () => {
    const css = starterWith("--color-primary", "oklch(0.9 0.05 264)");
    const problems = checkTheme(css, CONTRACT);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("--color-primary-foreground on --color-primary");
    expect(problems[0]?.message).toMatch(/contrasts \d+\.\d+:1/);
    expect(problems[0]?.message).toContain(`${MIN_CONTRAST_RATIO}:1`);
    // The base value is inherited by the dark block, so the defect is in both
    // rendered schemes — one mistake, one line.
    expect(problems[0]?.scope).toBe("every scheme");
  });

  // Tailwind emits no utility for a name nothing defines, so the element
  // renders with NO colour rather than failing — white on white, green suite.
  test("a deleted token is a block naming it", () => {
    const css = STARTER.replace(/--color-critical:[^;]+;/, "");
    const problems = checkTheme(css, CONTRACT);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("--color-critical is not defined");
  });

  // A pair whose halves are missing is ONE mistake; reporting the absence and
  // then the unmeasurable contrast would make it look like two.
  test("a missing token is reported once, not twice", () => {
    const css = STARTER.replace(/--color-critical-foreground:[^;]+;/, "");
    const problems = checkTheme(css, CONTRACT);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("not defined");
    expect(problems[0]?.scope).toBe("every scheme");
  });

  // Dark mode is where a theme goes wrong unnoticed: nobody screenshots it.
  test("a variant scheme is measured on its own", () => {
    const css = STARTER.replace(
      "--color-muted-foreground: oklch(0.71 0.02 264);",
      "--color-muted-foreground: oklch(0.32 0.02 264);",
    );
    expect(css).not.toBe(STARTER);
    const problems = checkTheme(css, CONTRACT);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.scope).toContain("dark");
    expect(problems[0]?.message).toContain("--color-muted-foreground on --color-muted");
  });

  // Silence is not a pass. A colour the gate cannot read is a promise it cannot
  // keep, and the message says how to make it readable.
  test("an unmeasurable colour blocks rather than passing quietly", () => {
    const css = starterWith("--color-primary", "color-mix(in oklch, blue, white)");
    const problems = checkTheme(css, CONTRACT);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("cannot measure that colour");
    expect(problems[0]?.message).toContain("oklch()");
  });

  test("the delivery step turns them into a block with every line kept", () => {
    const result = runThemeCheck(
      projectWithTheme(starterWith("--color-critical", "oklch(0.95 0.02 27)")),
      CONTRACT,
    );
    expect(result.verdict).toBe("block");
    expect(result.summary).toContain(THEME_RELATIVE);
    expect(result.detail?.join("\n")).toContain("--color-critical");
  });
});

// KEYED ON THE TREE, like everything else this pack emits. A harness with
// ts-web composed still delivers pure services, and a service has no theme.
describe("a project that is not a web target", () => {
  test("passes, saying there was nothing to check", () => {
    const result = runThemeCheck(projectWithTheme(undefined), CONTRACT);
    expect(result.verdict).toBe("pass");
    expect(result.summary).toContain("not a web target");
  });
});

// The empty-contract pass: a gate checking nothing goes green over anything.
describe("an empty contract", () => {
  test("checks nothing and says nothing was checked", () => {
    const result = runThemeCheck(projectWithTheme("@theme { }"), {
      requiredTokens: [],
      contrastPairs: [],
    });
    expect(result.verdict).toBe("pass");
    expect(result.summary).toContain("0 tokens defined");
  });

  test("but the real contract is not empty", () => {
    expect(CONTRACT.requiredTokens.length).toBeGreaterThan(10);
  });
});
