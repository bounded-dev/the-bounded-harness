import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { mergedContribution, specTechNouns } from "./pack-contrib.ts";
import { writeProjectPacks } from "./project-composition.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function packsDir(packs: Record<string, string | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), "contrib-"));
  tmpDirs.push(dir);
  for (const [name, manifest] of Object.entries(packs)) {
    mkdirSync(join(dir, name), { recursive: true });
    if (manifest !== undefined) writeFileSync(join(dir, name, "contrib.json"), manifest);
  }
  return dir;
}

describe("selected data contributions", () => {
  test("merges selected packs, deduplicates, sorts, ignores installed peers", () => {
    const dir = packsDir({
      language: '{"nouns":["b","a"]}',
      stack: '{"nouns":["b","c"]}',
      unused: '{"nouns":["leak"]}',
    });
    expect(mergedContribution("nouns", ["language", "stack"], dir)).toEqual(["a", "b", "c"]);
    expect(mergedContribution("nouns", ["language"], dir)).toEqual(["a", "b"]);
  });
  test.each([undefined, "{bad json", "null", "[]", '{"nouns":"x"}', '{"nouns":["x",4]}', '{"nouns":[""]}'])(
    "refuses invalid selected manifest %s", (manifest) => {
      const dir = packsDir({ selected: manifest });
      expect(() => mergedContribution("nouns", ["selected"], dir)).toThrow(/Selected pack/);
    },
  );
  test("an absent optional field contributes nothing", () => {
    expect(mergedContribution("nouns", ["selected"], packsDir({ selected: "{}" }))).toEqual([]);
  });
  test("malformed unselected manifests have zero effect", () => {
    const dir = packsDir({ selected: '{"nouns":["x"]}', unused: "{bad json" });
    expect(mergedContribution("nouns", ["selected"], dir)).toEqual(["x"]);
  });
  test("rejects paths masquerading as names", () => {
    expect(() => mergedContribution("nouns", ["../outside"])).toThrow(/Invalid pack name/);
  });
  test("unknown selected pack cannot silently weaken policy", () => {
    expect(() => mergedContribution("nouns", ["missing"], packsDir({}))).toThrow(/missing/);
  });
  test("a selected data pack cannot leave its dependency uncomposed", () => {
    const dir = packsDir({ web: '{"dependsOnPacks":["language"],"nouns":["web"]}' });
    expect(() => mergedContribution("nouns", ["web"], dir)).toThrow(/dependsOnPacks/);
  });
});

describe("real pack content follows project composition", () => {
  test("intake nouns change with selection, without a process-wide cache", () => {
    const cwd = packsDir({});
    writeProjectPacks(cwd, ["ts"]);
    expect(specTechNouns(cwd)).toContain("graphql");
    expect(specTechNouns(cwd)).not.toContain("vue");
    writeProjectPacks(cwd, ["ts", "ts-web"]);
    expect(specTechNouns(cwd)).toContain("vue");
    expect(specTechNouns(cwd)).not.toContain("react");
  });
  test("component names exist only when web is selected", () => {
    expect(mergedContribution("componentReturnTypes", ["ts"])).toEqual([]);
    expect(mergedContribution("componentReturnTypes", ["ts", "ts-web"])).toContain("ReactElement");
  });
  test("missing selection refuses intake", () => {
    expect(() => specTechNouns(packsDir({}))).toThrow(/bounded compose/);
  });
  test("web declares its project-init script", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "packs", "ts-web", "contrib.json"), "utf8"));
    expect(manifest.projectInitScripts).toEqual(["scripts/new-web-app.ts"]);
  });
});
