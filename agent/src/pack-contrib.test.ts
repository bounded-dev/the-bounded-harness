import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { mergedContribution, specTechNouns } from "./pack-contrib.ts";

// TN-26-005: the core owns sockets, packs own content. This module is the
// merge point — a harness composed without a pack simply lacks that pack's
// contributions, and nothing here ever throws a run off the road.

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

describe("mergedContribution", () => {
  test("merges across packs, deduplicates, sorts", () => {
    const dir = packsDir({
      ts: '{"specTechNouns": ["graphql", "ajv"]}',
      py: '{"specTechNouns": ["flask", "graphql"]}',
    });
    expect(mergedContribution("specTechNouns", dir)).toEqual(["ajv", "flask", "graphql"]);
  });

  test("a pack without a manifest, or with a malformed one, contributes nothing", () => {
    const dir = packsDir({
      ts: '{"specTechNouns": ["graphql"]}',
      bare: undefined,
      broken: "{not json",
      wrongType: '{"specTechNouns": "graphql"}',
    });
    expect(mergedContribution("specTechNouns", dir)).toEqual(["graphql"]);
  });

  test("no packs directory at all contributes nothing — never a throw", () => {
    expect(mergedContribution("specTechNouns", "/nonexistent/packs")).toEqual([]);
  });

  test("non-string and empty entries are dropped", () => {
    const dir = packsDir({ ts: '{"specTechNouns": ["graphql", 4, "", null]}' });
    expect(mergedContribution("specTechNouns", dir)).toEqual(["graphql"]);
  });
});

describe("the real installed packs", () => {
  test("the ts pack contributes the non-blessed stack nouns", () => {
    const nouns = specTechNouns();
    expect(nouns).toContain("graphql");
    expect(nouns).toContain("ajv");
    // The blessed stacks are NOT on the list — they are policy, not a leak.
    expect(nouns).not.toContain("zod");
    expect(nouns).not.toContain("trpc");
  });
});

describe("the ts-web pack manifest", () => {
  test("contributes the component return types the scaffolder consumes", () => {
    const names = mergedContribution("componentReturnTypes");
    expect(names).toContain("ReactElement");
    expect(names).toContain("JSX.Element");
  });

  test("contributes web-framework nouns to the intake denylist", () => {
    const nouns = specTechNouns();
    expect(nouns).toContain("vue");
    expect(nouns).toContain("styled-components");
    // The blessed web stack is policy, not a leak.
    expect(nouns).not.toContain("react");
    expect(nouns).not.toContain("tailwind");
  });
});
