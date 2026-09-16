// Feature-Sliced Design, as the two directional lints see it (TN-26-006).
//
// FSD is the enforceable form of the dumb-vs-domain-aware split, and the reason
// the harness picked it over a house convention is that its two core laws are
// LINT MATERIAL: imports flow strictly downward, and each slice is reached
// through its public API. Its vocabulary is also in every model's training
// data, so the names below cost a worker nothing to learn.
//
// Both laws are decided from the FILE PATH and the import SPECIFIER, with no
// type information and no module resolution. That is deliberate: a rule that
// needed the project's resolved types would need node_modules and a tsconfig to
// answer, and these two must answer identically in the gate, in an editor, and
// in a RuleTester with no project at all.

import { posix } from "node:path";

/**
 * The layers, LOWEST first. The order IS the law: a module may import from its
 * own layer or any layer to the left, never to the right.
 *
 * `widgets` is recognised and sits between features and pages, though the
 * generator does not emit it (TN-26-006): a project that grows composite blocks
 * adds the directory and is policed correctly from its first file, rather than
 * discovering the rule after the fact.
 *
 * `processes` is absent because FSD deprecated it itself.
 */
export const LAYER_ORDER = ["shared", "entities", "features", "widgets", "pages"] as const;

export type Layer = (typeof LAYER_ORDER)[number];

/**
 * The layers made of SLICES — one directory per entity, per feature, per page.
 *
 * `shared` is the exception and has to be: it is not domain-partitioned at all,
 * so `shared/ui`, `shared/api` and `shared/lib` are segments, not slices, and
 * a "public API of a slice" rule would have nothing to talk about there.
 */
export const SLICED_LAYERS: readonly Layer[] = ["entities", "features", "widgets", "pages"];

function isLayer(name: string): name is Layer {
  return (LAYER_ORDER as readonly string[]).includes(name);
}

/** How far right a layer sits. Higher may import lower; never the reverse. */
export function layerRank(layer: Layer): number {
  return LAYER_ORDER.indexOf(layer);
}

/**
 * The part of `filename` inside the UI root — `src/ui/entities/building/index.ts`
 * becomes `entities/building/index.ts` — or undefined for a file outside it.
 *
 * The LAST occurrence of `src/ui/` wins, so an absolute path through a checkout
 * that itself contains those segments still resolves to the project's own UI
 * root. Backslashes are normalised, because a rule that behaved differently on
 * Windows would be a rule that is off on Windows.
 */
export function uiRelativePath(filename: string): string | undefined {
  const normalized = filename.replace(/\\/g, "/");
  const marker = "src/ui/";
  const at = normalized.lastIndexOf(marker);
  if (at === -1) return undefined;
  const rel = normalized.slice(at + marker.length);
  return rel === "" ? undefined : rel;
}

/** The layer a UI-relative path belongs to, or undefined if its first segment
 *  is not a layer name (a stray file directly under `src/ui/`, like main.tsx). */
export function layerOf(uiRelative: string): Layer | undefined {
  const first = uiRelative.split("/")[0];
  return first !== undefined && isLayer(first) ? first : undefined;
}

/**
 * Where a relative import lands, as a UI-relative path — or undefined when the
 * specifier is not relative, or resolves outside the UI root.
 *
 * Both of those are "not this rule's business", and saying so with one value
 * is the point: `@tanstack/react-query` is a package, `../../../domain/money.js`
 * is the domain layer these rules deliberately do not police (the layering law
 * is about the UI's own internal direction), and neither is a violation.
 */
export function resolveWithinUi(uiRelativeFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(uiRelativeFile), specifier));
  return resolved.startsWith("..") || resolved === "." ? undefined : resolved;
}

/**
 * The slice a UI-relative path belongs to (`entities/building`), or undefined
 * when the path is not inside a sliced layer.
 *
 * A bare `entities/building` with nothing after it is still a slice — that is
 * the slice ROOT, which is exactly the form the public-API rule wants imports
 * to take.
 */
export function sliceOf(uiRelative: string): string | undefined {
  const [layer, slice] = uiRelative.split("/");
  if (layer === undefined || !isLayer(layer) || !SLICED_LAYERS.includes(layer)) return undefined;
  if (slice === undefined || slice === "") return undefined;
  return `${layer}/${withoutExtension(slice)}`;
}

/** `button.tsx` → `button`; `button` → `button`. */
export function withoutExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
}

/**
 * Does this UI-relative path address a slice's public API rather than a file
 * inside it?
 *
 * Three spellings are the same door: the slice directory itself
 * (`entities/building`), and its index written either way
 * (`entities/building/index`, with or without an extension). Anything deeper is
 * a reach past the door.
 */
export function isSliceRoot(uiRelative: string): boolean {
  const segments = withoutExtension(uiRelative).split("/");
  if (segments.length === 2) return true;
  return segments.length === 3 && segments[2] === "index";
}
