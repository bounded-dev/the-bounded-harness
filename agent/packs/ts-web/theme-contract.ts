// The theme contract (TN-26-006, "Styling: anatomy enforced, identity free").
//
// The generated component kit styles through semantic token names, and
// `src/ui/theme.css` — the one file a project owns — defines them. That is a
// CONTRACT between a pack and a project, and this module is where the pack
// states it: which token names must exist, and which foreground/background
// pairs must be readable.
//
// WHY IT LIVES IN contrib.json AND NOT IN CODE. It is data about a project's
// obligations, and TN-26-005 puts that half of a pack's contributions in the
// manifest: a host — or a human, or a future theme editor — can read what a
// theme must satisfy without executing pack code. The kit's class strings and
// the gate's checks then both answer to one list instead of two that drift.
//
// This module is the pack's own typed reader for its own manifest. It is
// deliberately not `agent/src/pack-contrib.ts`: that is the CORE's merged view
// of every pack's string-array fields, and a core that learned the shape of
// `contrastPairs` would be a core that knows what a colour is.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A [foreground, background] pair of token names, measured for contrast. */
export type ContrastPair = readonly [foreground: string, background: string];

export interface ThemeContract {
  /** Token names (`--color-…`, `--radius-…`) a theme must define. */
  readonly requiredTokens: readonly string[];
  /** Pairs whose contrast the theme gate measures. */
  readonly contrastPairs: readonly ContrastPair[];
}

/** WCAG 2.1 AA for normal-size text. Large text is allowed 3:1, but a kit that
 *  cannot tell which is which must assume the stricter number — and a Badge's
 *  `text-xs` is about as far from "large" as text gets. */
export const MIN_CONTRAST_RATIO = 4.5;

/** This pack's root — `packs/ts-web/`, where `contrib.json` sits. */
function defaultPackDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** One field of a parsed JSON object, without a cast: `Object.entries` gives
 *  the value at its honest `unknown`, which the readers below narrow. */
function fieldOf(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  for (const [name, value] of Object.entries(source)) if (name === key) return value;
  return undefined;
}

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

function pairsOf(value: unknown): readonly ContrastPair[] {
  if (!Array.isArray(value)) return [];
  const pairs: ContrastPair[] = [];
  for (const entry of value) {
    const [foreground, background] = stringsOf(entry);
    // Exactly two names, or it is not a pair. A three-element entry is a typo
    // somebody would otherwise discover as a silently unchecked colour.
    if (foreground !== undefined && background !== undefined && stringsOf(entry).length === 2) {
      pairs.push([foreground, background]);
    }
  }
  return pairs;
}

/**
 * The contract, read from `contrib.json`.
 *
 * Never throws. A missing or malformed manifest yields an EMPTY contract, and
 * the gate that reads it says "nothing to check" rather than dying: this is
 * policy content, and the harness's rule for policy content is that its absence
 * weakens a check but never breaks a run (agent/src/pack-contrib.ts). The
 * emptiness is visible — the gate prints the count it checked — and the suite
 * pins that the real manifest is not empty, which is the failure mode that
 * would otherwise pass silently.
 */
export function themeContract(packDir: string = defaultPackDir()): ThemeContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packDir, "contrib.json"), "utf8"));
  } catch {
    return { requiredTokens: [], contrastPairs: [] };
  }
  return Object.freeze({
    requiredTokens: stringsOf(fieldOf(parsed, "requiredThemeTokens")),
    contrastPairs: pairsOf(fieldOf(parsed, "contrastPairs")),
  });
}
