// Data contributions are read only from the project's selected packs.
// Missing or malformed selected manifests refuse the check rather than
// silently weakening policy. An absent optional field contributes nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectPacks } from "./project-composition.ts";

function defaultPacksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
}

/** Merge a data field from an explicit composition, without executing packs. */
export function mergedContribution(
  key: string,
  packs: readonly string[],
  packsDir = defaultPacksDir(),
): string[] {
  const out = new Set<string>();
  const selected = new Set(packs);
  for (const pack of packs) {
    if (!/^[a-z][a-z0-9-]*$/.test(pack)) throw new Error(`Invalid pack name '${pack}'`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(packsDir, pack, "contrib.json"), "utf8"));
    } catch {
      throw new Error(`Selected pack '${pack}' has a missing or malformed contrib.json`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Selected pack '${pack}' must have an object contrib.json`);
    }
    const manifest = parsed as Record<string, unknown>;
    const dependencies = manifest.dependsOnPacks;
    if (dependencies !== undefined &&
        (!Array.isArray(dependencies) || dependencies.some((dep) => typeof dep !== "string" || !selected.has(dep)))) {
      throw new Error(`Selected pack '${pack}' has an invalid or unselected dependsOnPacks edge`);
    }
    const value = manifest[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`Selected pack '${pack}' field '${key}' must be an array of nonempty strings`);
    }
    for (const item of value) out.add(item);
  }
  return [...out].sort();
}

/** Intake policy comes from this project's composition, never installed peers. */
export function specTechNouns(cwd: string, packsDir?: string): string[] {
  return mergedContribution("specTechNouns", readProjectPacks(cwd), packsDir);
}
