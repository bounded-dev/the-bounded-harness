import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

// TN-26-006 zone rule, src/ui/**: components style through SEMANTIC TOKENS.
//
// Banned: Tailwind's raw default palette (`bg-red-500`, `text-slate-300`,
// `hover:border-zinc-200/50`, …) and colour-carrying arbitrary values
// (`bg-[#0ea5e9]`, `text-[oklch(0.7_0.2_20)]`, `[color:rebeccapurple]`).
// Allowed: every semantic token the project's `src/ui/theme.css` defines —
// `bg-primary`, `text-muted-foreground`, `bg-positive`, `rounded-card` — and
// `bg-[var(--color-primary)]`, which is a token reference wearing brackets.
//
// WHY THIS IS THE STYLING TWIN OF `no-naked-primitives`. The styling design
// (TN-26-006, "anatomy enforced, identity free") makes exactly one promise: a
// fresh look for a project is a fresh `theme.css` and nothing else. One
// `bg-blue-600` in one component breaks that promise silently — the theme swap
// runs, every other surface changes, and one element keeps yesterday's brand
// with nothing failing anywhere. Same shape as a naked `string` on a contract:
// it compiles, it runs, and the design decision it quietly reverses is only
// visible to somebody reading that one line.
//
// It is also what makes the freedom SAFE to grant. The theme gate can promise
// "any look, never an unreadable one" only because every colour on screen came
// through a token name it can find and measure. A raw palette class is a colour
// no gate can see.
//
// WHAT IS DELIBERATELY NOT BANNED IN v1:
//
//   · NON-COLOUR arbitrary values. `w-[42ch]`, `grid-cols-[1fr_auto]`,
//     `top-[3px]` are sizes and layout, not identity, and a project genuinely
//     needs the occasional one. Spacing RELATIONSHIPS are anatomy and belong to
//     the kit, but nothing about a one-off measure breaks a theme swap. If the
//     design tightens later, it tightens with a note; today the rule is about
//     COLOUR, which is what the promise is about.
//
//   · CSS named colours outside brackets (`text-white`, `bg-black`). Tailwind's
//     `white`/`black`/`transparent`/`current`/`inherit` carry no scale and are
//     not part of the swappable palette in the way `blue-600` is. `bg-[white]`
//     IS caught — inside brackets it is a hand-written colour like any other.
//
// HOW THE STRINGS ARE FOUND, and why it is wider than `className=`. The rule
// checks every string literal and template chunk in a `src/ui/**` file, not
// only the ones sitting in a `className` attribute or a `cn(...)` argument. The
// kit's own components are the reason: their tone and size tables are
// module-level constants (`const TONE: Record<BadgeTone, string> = { … }`) that
// reach `className` through a variable, and a lint rule has no dataflow. A rule
// that missed those would miss the exact shape the reference kit teaches — and
// the shape a builder copies from it. The pattern it matches is specific enough
// to make that safe: a utility prefix, one of Tailwind's 22 palette names, and
// a numeric scale is not a sentence anybody writes by accident.

const createRule = ESLintUtils.RuleCreator.withoutDocs;

/** Tailwind's default palette. The names a theme swap cannot reach. */
const PALETTE = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

/**
 * `<utility>-<palette>-<scale>`, with an optional `/opacity` suffix.
 *
 * The SCALE is what makes the match safe. `bg-neutral` is a semantic token in
 * this reference set (the Badge's fourth tone) and `bg-neutral-500` is
 * Tailwind's palette; one digit group is the entire difference, and requiring
 * it is why a rule that scans every string in the file does not fire on prose.
 */
const RAW_PALETTE = new RegExp(`^-?[a-z][a-z-]*-(?:${PALETTE.join("|")})-(?:\\d{2,3})(?:/\\d{1,3})?$`);

/** CSS colour functions. `var()` is deliberately absent — that is the token
 *  path, and `bg-[var(--color-primary)]` is exactly what good looks like.
 *
 *  The boundary is spelled `(?:^|[^a-z])` rather than `\b`, because Tailwind
 *  writes spaces as UNDERSCORES inside an arbitrary value
 *  (`shadow-[0_1px_2px_rgba(0,0,0,0.2)]`) and an underscore is a word
 *  character, so `\b` finds no boundary there at all — the one spelling most
 *  likely to carry a hand-written colour would have been the one that slipped
 *  through. */
const COLOR_FUNCTION = /(?:^|[^a-z])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;

/** A CSS property whose value IS a colour: `[color:…]`, `[border-color:…]`. */
const COLOR_PROPERTY = /(^|[\s;[])(?:-{2}[a-z0-9-]*color|[a-z-]*color)\s*:/i;

/** The named colours a hand-written arbitrary value reaches for. Not the full
 *  148 — the common ones, which is what a model under time pressure types. */
const NAMED_COLORS = new Set([
  "aqua", "beige", "black", "blue", "brown", "coral", "crimson", "cyan", "fuchsia", "gold",
  "gray", "green", "grey", "indigo", "ivory", "khaki", "lavender", "lime", "magenta", "maroon",
  "navy", "olive", "orange", "orchid", "pink", "plum", "purple", "red", "salmon", "silver",
  "tan", "teal", "tomato", "turquoise", "violet", "wheat", "white", "yellow", "rebeccapurple",
]);

/**
 * The utility part of a class token, with its variants stripped:
 * `hover:focus:bg-red-500` → `bg-red-500`.
 *
 * The split is on the last `:` at BRACKET DEPTH ZERO, because an arbitrary
 * variant carries colons of its own (`data-[state=open]:bg-red-500`,
 * `supports-[display:grid]:block`) and a naive `split(":").pop()` would hand
 * back `grid]:block`.
 */
export function utilityPart(token: string): string {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) lastColon = i;
  }
  return token.slice(lastColon + 1);
}

/** The bracketed part of an arbitrary value, `bg-[#fff]` → `#fff`, or
 *  undefined when the token has none. */
function arbitraryValue(utility: string): string | undefined {
  const open = utility.indexOf("[");
  const close = utility.lastIndexOf("]");
  if (open === -1 || close < open) return undefined;
  return utility.slice(open + 1, close);
}

/** Does this arbitrary value carry a colour a theme cannot reach? */
function isHandWrittenColor(value: string): boolean {
  // A token reference is the SUPPORTED escape hatch, not a violation: it names
  // a custom property, which is what the whole design asks for.
  if (value.includes("var(--")) return false;
  if (value.startsWith("#") && /^#[0-9a-f]{3,8}$/i.test(value)) return true;
  if (COLOR_FUNCTION.test(value)) return true;
  if (COLOR_PROPERTY.test(value)) return true;
  return NAMED_COLORS.has(value.toLowerCase());
}

/**
 * Every offending class in one string, in source order.
 *
 * PURE and exported: the rule is one caller, the suite is the other, and a
 * class-string analysis that can only be reached through an ESLint fixture is
 * one nobody ever tests at the edges.
 */
export function untokenizedClasses(source: string): string[] {
  const found: string[] = [];
  for (const token of source.split(/\s+/)) {
    if (token === "") continue;
    const utility = utilityPart(token);
    if (RAW_PALETTE.test(utility)) {
      found.push(token);
      continue;
    }
    const arbitrary = arbitraryValue(utility);
    if (arbitrary !== undefined && isHandWrittenColor(arbitrary)) found.push(token);
  }
  return found;
}

/** Only the frontend's own tree. The domain has no classes in it, and a test
 *  fixture outside `src/ui/` is not styling anything. */
function isUiFile(filename: string): boolean {
  return filename.replace(/\\/g, "/").includes("src/ui/");
}

export const tokensOnlyStyling = createRule<[], "rawColor">({
  name: "tokens-only-styling",
  meta: {
    type: "problem",
    schema: [],
    messages: {
      rawColor:
        "'{{token}}' is a hand-picked colour, so a theme swap cannot reach it — every other surface " +
        "would change and this one would keep yesterday's brand, with nothing failing. Style through a " +
        "semantic token instead (bg-primary, text-muted-foreground, bg-positive/caution/critical/neutral, " +
        "border-border, ring-ring), or add a token to src/ui/theme.css and use that. " +
        "`bg-[var(--color-x)]` is fine — it is a token reference. Sizes in brackets (w-[42ch]) are fine " +
        "too; this rule is about colour (TN-26-006).",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isUiFile(context.filename)) return {};

    const check = (node: TSESTree.Node, text: string): void => {
      for (const token of untokenizedClasses(text)) {
        context.report({ node, messageId: "rawColor", data: { token } });
      }
    };

    return {
      Literal(node: TSESTree.Literal): void {
        if (typeof node.value === "string") check(node, node.value);
      },
      // The static chunks of a template literal. The `${…}` holes are somebody
      // else's expression and are checked wherever they were written — a
      // literal inside one is a Literal node in its own right.
      TemplateElement(node: TSESTree.TemplateElement): void {
        check(node, node.value.raw);
      },
    };
  },
});
