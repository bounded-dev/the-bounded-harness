// The theme gate (TN-26-006, "Styling: anatomy enforced, identity free"),
// contributed to the ts pack's `deliverChecks` socket (ADR 2026-033).
//
//   node theme-check.ts [targetDir]
//
// Exit 0 pass · 1 block. Also callable as a delivery step, which is how it
// actually runs (packs/ts-web/pack.ts → deliver's last step).
//
// WHAT IT PROMISES. The styling design gives a project TOTAL freedom over
// `src/ui/theme.css` — it is the one file the generator writes once and never
// touches again — and pays for that freedom with two mechanical fences. The
// `tokens-only-styling` lint is the first: every colour on screen came through
// a token name. This is the second: those names are all still defined, and the
// colours behind them are READABLE.
//
//   any look — never an unreadable or incomplete one.
//
// WHY BOTH HALVES ARE BLOCKS AND NOT WARNINGS. A missing token does not fail
// loudly: Tailwind emits no utility for a name nothing defines, so the element
// renders with no background at all — white text on white, and a suite that
// keys on roles and text (which is what blind UI testing keys on) stays green
// through it. Unreadable colours are the same story with the compiler further
// away. Neither is visible to any other gate in the pipeline, and visual
// quality has no gate and never will (TN-26-006) — so these two, which are
// arithmetic rather than taste, are the only mechanical thing standing between
// a delivered repo and a screen nobody can read.
//
// WHY THE CONTRAST MATH LIVES HERE AND NOT IN A LIBRARY. It is thirty lines of
// published arithmetic — the OKLab matrix, sRGB's transfer function, WCAG's
// luminance weights — and the harness does not add a dependency to a target's
// toolchain it can write once and pin with a table of known ratios. Every
// number below is checked against a fixture in theme-check.test.ts.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_CONTRAST_RATIO,
  themeContract,
  type ContrastPair,
  type ThemeContract,
} from "../theme-contract.ts";
import type { DeliverCheckResult } from "../../ts/pack.ts";

/** Where a web target's identity lives. The generator seeds it; nothing ever
 *  overwrites it; this gate reads it. */
export const THEME_RELATIVE = "src/ui/theme.css";

// --- parsing the theme -------------------------------------------------------

/** One resolved colour, in LINEAR-light sRGB, each channel clamped to 0..1. */
export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** One `@theme` scope: the base block, or a block inside an at-rule. */
export interface ThemeScope {
  /** How a reader should recognise it: "the base theme", or the media query. */
  readonly label: string;
  /** Token name → declared value, as written. */
  readonly tokens: ReadonlyMap<string, string>;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Every `@theme` block in the file, each labelled by the at-rule around it.
 *
 * A HAND-ROLLED SCAN, not a CSS parser, for the reason the FSD lints decide
 * everything from paths: the gate must answer identically in a target with no
 * toolchain, in the harness suite, and on a machine with no network. The
 * grammar it needs is tiny — balanced braces and `--name: value;` — and a
 * dependency that parses all of CSS to read nineteen custom properties is a
 * dependency every delivered repo would inherit.
 */
export function themeScopes(css: string): readonly ThemeScope[] {
  const source = stripComments(css);
  const scopes: ThemeScope[] = [];
  /** Preludes of the blocks we are currently inside, outermost first. */
  const open: { prelude: string; isTheme: boolean; start: number }[] = [];
  let preludeStart = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      const prelude = source.slice(preludeStart, i).trim();
      open.push({ prelude, isTheme: /^@theme\b/.test(prelude), start: i + 1 });
      preludeStart = i + 1;
    } else if (ch === "}") {
      const block = open.pop();
      preludeStart = i + 1;
      if (block === undefined || !block.isTheme) continue;
      const enclosing = open.map((b) => b.prelude).filter((p) => p.startsWith("@"));
      scopes.push({
        label: enclosing.length === 0 ? "the base theme" : enclosing.join(" / "),
        tokens: declarationsIn(source.slice(block.start, i)),
      });
    } else if (ch === ";") {
      preludeStart = i + 1;
    }
  }
  return scopes;
}

/** `--color-primary: oklch(0.55 0.18 264);` → one map entry. */
function declarationsIn(block: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim());
  }
  return tokens;
}

/**
 * The scopes a theme actually RENDERS as: the base, plus one per at-rule scope
 * with the base underneath it.
 *
 * A dark-mode block overriding five tokens is not a theme of five tokens — it
 * is the whole theme with five values replaced, and checking it any other way
 * would report fourteen missing tokens for a file that is completely correct.
 */
export function resolvedScopes(css: string): readonly ThemeScope[] {
  const scopes = themeScopes(css);
  const base = new Map<string, string>();
  for (const scope of scopes) {
    if (scope.label !== "the base theme") continue;
    for (const [name, value] of scope.tokens) base.set(name, value);
  }
  const resolved: ThemeScope[] = [{ label: "the base theme", tokens: base }];
  for (const scope of scopes) {
    if (scope.label === "the base theme") continue;
    resolved.push({ label: scope.label, tokens: new Map([...base, ...scope.tokens]) });
  }
  return resolved;
}

// --- colour, and what the eye makes of it ------------------------------------

/** sRGB's transfer function: a channel as stored → the same channel as light. */
function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The three numbers inside `name(...)`, with `%` resolved against `scale`. */
function argsOf(value: string, name: string): number[] | undefined {
  const match = new RegExp(`^${name}\\(([^)]*)\\)$`, "i").exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const parts = match[1].replace(/\//g, " ").split(/[\s,]+/).filter((p) => p !== "");
  const numbers: number[] = [];
  for (const raw of parts) {
    // `oklch(0.5 0.1 264deg)` is legal CSS and the angle unit is noise to the
    // arithmetic — an unstripped `deg` would make a correct colour unreadable.
    const part = raw.replace(/deg$/i, "");
    const asNumber = part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part);
    if (Number.isNaN(asNumber)) return undefined;
    numbers.push(asNumber);
  }
  return numbers;
}

/** OKLCH → linear-light sRGB (Björn Ottosson's OKLab matrices). The output is
 *  already linear, which is what the luminance sum wants — no transfer
 *  function on this path. */
function oklchToLinear(l: number, c: number, hDegrees: number): LinearRgb {
  const h = (hDegrees * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube),
    g: clamp01(-1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube),
    b: clamp01(-0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube),
  };
}

function hexToLinear(value: string): LinearRgb | undefined {
  const hex = value.slice(1);
  const wide = hex.length <= 4 ? hex.split("").map((d) => d + d).join("") : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(wide)) return undefined;
  const channel = (at: number): number => linearize(parseInt(wide.slice(at, at + 2), 16) / 255);
  return { r: channel(0), g: channel(2), b: channel(4) };
}

/**
 * A declared token value as light, or undefined when this gate cannot read it.
 *
 * `var(--other)` is followed, because a theme that names its brand once and
 * refers to it everywhere is a theme doing exactly the right thing. The depth
 * cap is what a cycle looks like from here: `--a: var(--b); --b: var(--a)` is
 * legal CSS, renders as nothing, and would otherwise hang the gate.
 */
export function resolveColor(
  value: string,
  tokens: ReadonlyMap<string, string>,
  depth = 0,
): LinearRgb | undefined {
  const text = value.trim();
  if (depth > 8) return undefined;

  const reference = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)$/i.exec(text);
  if (reference?.[1] !== undefined) {
    const target = tokens.get(reference[1]);
    if (target !== undefined) return resolveColor(target, tokens, depth + 1);
    // The fallback is what actually paints when the name is undefined.
    return reference[2] === undefined ? undefined : resolveColor(reference[2], tokens, depth + 1);
  }

  if (text.startsWith("#")) return hexToLinear(text);

  const oklch = argsOf(text, "oklch");
  if (oklch !== undefined && oklch.length >= 3) {
    const [l, c, h] = oklch;
    if (l !== undefined && c !== undefined && h !== undefined) return oklchToLinear(l, c, h);
  }

  const rgb = argsOf(text, "rgba") ?? argsOf(text, "rgb");
  if (rgb !== undefined && rgb.length >= 3) {
    const [r, g, b] = rgb;
    if (r !== undefined && g !== undefined && b !== undefined) {
      // `rgb(1 0 0)` is one part in 255, not full red: CSS rgb() channels are
      // 0-255 unless written as percentages, and argsOf already divided those.
      const scale = (n: number): number => linearize(clamp01(n > 1 ? n / 255 : n));
      return { r: scale(r), g: scale(g), b: scale(b) };
    }
  }
  return undefined;
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(color: LinearRgb): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/** WCAG 2.1 contrast ratio, 1:1 … 21:1. Order does not matter. */
export function contrastRatio(a: LinearRgb, b: LinearRgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

// --- the check ---------------------------------------------------------------

export interface ThemeProblem {
  /** Which rendered scope it was found in — the base theme, or a media variant. */
  readonly scope: string;
  /** One line, with the numbers in it. */
  readonly message: string;
}

/**
 * The gate's whole judgement, as a pure function of the file's text and the
 * pack's declared contract.
 *
 * Pure so the suite can put a bad theme in front of it without a temp project,
 * and so the CLI and the delivery step are two thin callers of one answer.
 */
export function checkTheme(css: string, contract: ThemeContract): readonly ThemeProblem[] {
  const scopes = resolvedScopes(css);
  return collapseAcrossSchemes(problemsPerScope(css, contract), scopes.length);
}

/**
 * One mistake, reported once.
 *
 * A base-theme token that is too pale is too pale in dark mode as well — the
 * dark block inherits it — so the naive walk finds the same message in every
 * scope and prints it twice. A reader chasing two identical lines with the same
 * numbers looks for two mistakes. So a problem present in EVERY rendered scheme
 * collapses to one line labelled "every scheme"; one present in some of them
 * keeps its scheme's name, which is the whole reason variants are checked
 * separately (dark mode is where a theme goes wrong unnoticed — nobody
 * screenshots it).
 */
function collapseAcrossSchemes(
  found: readonly ThemeProblem[],
  scopeCount: number,
): readonly ThemeProblem[] {
  const byMessage = new Map<string, ThemeProblem[]>();
  for (const problem of found) {
    byMessage.set(problem.message, [...(byMessage.get(problem.message) ?? []), problem]);
  }
  const collapsed: ThemeProblem[] = [];
  for (const [message, group] of byMessage) {
    const everywhere = scopeCount > 1 && group.length === scopeCount;
    collapsed.push({ scope: everywhere ? "every scheme" : (group[0]?.scope ?? ""), message });
    if (!everywhere) for (const extra of group.slice(1)) collapsed.push(extra);
  }
  return collapsed;
}

function problemsPerScope(css: string, contract: ThemeContract): readonly ThemeProblem[] {
  const problems: ThemeProblem[] = [];
  for (const scope of resolvedScopes(css)) {
    for (const token of contract.requiredTokens) {
      if (scope.tokens.has(token)) continue;
      problems.push({
        scope: scope.label,
        message:
          `${token} is not defined — the generated component kit styles through it, and Tailwind ` +
          `emits no utility for a name nothing defines, so the element renders with no colour at ` +
          `all rather than failing`,
      });
    }
    for (const pair of contract.contrastPairs) {
      const problem = checkPair(pair, scope);
      if (problem !== undefined) problems.push({ scope: scope.label, message: problem });
    }
  }
  return problems;
}

function checkPair(pair: ContrastPair, scope: ThemeScope): string | undefined {
  const [foreground, background] = pair;
  const declared = [scope.tokens.get(foreground), scope.tokens.get(background)];
  // A missing half is already reported as a missing token; saying it twice
  // would make one mistake look like two.
  if (declared.some((value) => value === undefined)) return undefined;

  const [fgValue, bgValue] = declared;
  const fg = fgValue === undefined ? undefined : resolveColor(fgValue, scope.tokens);
  const bg = bgValue === undefined ? undefined : resolveColor(bgValue, scope.tokens);
  if (fg === undefined || bg === undefined) {
    const unreadable = fg === undefined ? `${foreground}: ${fgValue}` : `${background}: ${bgValue}`;
    return (
      `${unreadable} — this gate cannot measure that colour, so it cannot promise the text on it ` +
      `is readable. Write it as a hex value, rgb(), oklch(), or a var() reference to one`
    );
  }

  const ratio = contrastRatio(fg, bg);
  if (ratio >= MIN_CONTRAST_RATIO) return undefined;
  return (
    `${foreground} on ${background} contrasts ${ratio.toFixed(2)}:1, below the ` +
    `${MIN_CONTRAST_RATIO}:1 WCAG AA needs for normal text (${fgValue} on ${bgValue}). ` +
    `Darken the background or lighten the foreground until the ratio clears`
  );
}

/**
 * The check as delivery runs it.
 *
 * KEYED ON THE TREE, like everything else this pack contributes: a project with
 * no `src/ui/theme.css` is a project with no frontend, and the honest verdict
 * there is "nothing to check" rather than a block for a file it was never
 * supposed to have. A harness composed without ts-web never reaches this code
 * at all; a service delivered by a harness that HAS ts-web composed must not
 * trip over a web pack's opinion.
 */
export function runThemeCheck(cwd: string, contract: ThemeContract = themeContract()): DeliverCheckResult {
  const themePath = join(cwd, THEME_RELATIVE);
  if (!existsSync(themePath)) {
    return { verdict: "pass", summary: `no ${THEME_RELATIVE} — not a web target, nothing to check` };
  }
  let css: string;
  try {
    css = readFileSync(themePath, "utf8");
  } catch (e) {
    return {
      verdict: "block",
      summary: `${THEME_RELATIVE} could not be read — ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const scopes = resolvedScopes(css);
  const problems = checkTheme(css, contract);
  if (problems.length === 0) {
    return {
      verdict: "pass",
      summary:
        `${THEME_RELATIVE}: ${contract.requiredTokens.length} tokens defined, ` +
        `${contract.contrastPairs.length} contrast pairs at or above ${MIN_CONTRAST_RATIO}:1 ` +
        `across ${scopes.length} scheme${scopes.length === 1 ? "" : "s"}`,
    };
  }
  return {
    verdict: "block",
    summary:
      `${THEME_RELATIVE} has ${problems.length} problem${problems.length === 1 ? "" : "s"} — ` +
      `the app's visual identity is the project's to choose, but not to make unreadable or ` +
      `incomplete (TN-26-006)`,
    detail: problems.map((p) => `${p.scope}: ${p.message}`),
  };
}

// --- CLI ---------------------------------------------------------------------

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = runThemeCheck(resolve(process.argv[2] ?? process.cwd()));
  const blocked = result.verdict === "block";
  const print = blocked ? console.error : console.log;
  print(`theme-check: ${blocked ? "BLOCK — " : ""}${result.summary}`);
  for (const line of result.detail ?? []) print(`  ${line}`);
  process.exit(blocked ? 1 : 0);
}
