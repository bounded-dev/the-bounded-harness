// Pack contributions (TN-26-005): the core owns sockets, packs own content.
//
// A pack contributes content to a core mechanism through a `contrib.json` at
// its root (`packs/<name>/contrib.json`). The core never names a technology:
// this module enumerates the installed packs' manifests and merges what they
// contribute, so a harness composed without a pack simply lacks that pack's
// content — no ghost dependencies from packs a project does not use.
//
// Never fatal: a missing packs directory, an unreadable or malformed
// manifest, or a wrong-typed field all contribute nothing. A pack's content
// is policy, not plumbing — its absence weakens a check, never breaks a run.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The harness's packs/ directory (this file lives in agent/src/). */
function defaultPacksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
}

/** String-array field `key` merged across every installed pack's
 *  contrib.json, deduplicated, sorted. */
export function mergedContribution(key: string, packsDir = defaultPacksDir()): string[] {
  const out = new Set<string>();
  let packs: string[];
  try {
    packs = readdirSync(packsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const pack of packs) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(packsDir, pack, "contrib.json"), "utf8"));
      const value = (parsed as Record<string, unknown> | null)?.[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) if (typeof item === "string" && item !== "") out.add(item);
    } catch {
      // No manifest, or a malformed one: this pack contributes nothing.
    }
  }
  return [...out].sort();
}

/** The spec tech-noun denylist for the phase gate's Intake check
 *  (ADR 2026-032): non-blessed stack nouns contributed by installed packs. */
export function specTechNouns(packsDir?: string): string[] {
  return mergedContribution("specTechNouns", packsDir);
}
