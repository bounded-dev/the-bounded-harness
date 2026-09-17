import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { MIN_CONTRAST_RATIO, themeContract } from "./theme-contract.ts";

// The pack's own typed reader for its own manifest (TN-26-006). Two things
// matter here and nothing else does: the REAL manifest parses into a contract
// with content in it, and a broken manifest degrades to an empty contract
// instead of taking a gate down with it.

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function packWith(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "theme-contract-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "contrib.json"), manifest);
  return dir;
}

describe("the real manifest", () => {
  const contract = themeContract();

  // The empty-set pass is the failure this whole file exists to notice: a
  // reader that silently returns nothing makes every downstream check green
  // over no tokens at all.
  test("carries a real contract, not an empty one", () => {
    expect(contract.requiredTokens.length).toBeGreaterThan(10);
    expect(contract.contrastPairs.length).toBeGreaterThan(4);
  });

  test("every required token is a custom property name", () => {
    for (const token of contract.requiredTokens) expect(token, token).toMatch(/^--[a-z][a-z0-9-]*$/);
  });

  test("every contrast pair is two token names the contract also requires", () => {
    for (const pair of contract.contrastPairs) {
      expect(pair).toHaveLength(2);
      for (const token of pair) expect(contract.requiredTokens, token).toContain(token);
    }
  });

  // AA for normal text. Large text is allowed 3:1, but a kit that cannot tell
  // which is which must assume the stricter number.
  test("the threshold is WCAG AA for normal text", () => {
    expect(MIN_CONTRAST_RATIO).toBe(4.5);
  });
});

describe("a manifest the pack did not write", () => {
  test("no manifest at all is an empty contract, not a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "theme-contract-"));
    tmpDirs.push(dir);
    expect(themeContract(dir)).toEqual({ requiredTokens: [], contrastPairs: [] });
  });

  test("malformed JSON is an empty contract", () => {
    expect(themeContract(packWith("{ not json"))).toEqual({
      requiredTokens: [],
      contrastPairs: [],
    });
  });

  test("wrong-typed fields contribute nothing", () => {
    const contract = themeContract(
      packWith(JSON.stringify({ requiredThemeTokens: "--color-primary", contrastPairs: 7 })),
    );
    expect(contract).toEqual({ requiredTokens: [], contrastPairs: [] });
  });

  // A three-name "pair" is a typo, and the honest answer is to drop it: keeping
  // it would mean measuring a pair somebody never declared, and inventing which
  // two of the three they meant.
  test("only two-name pairs are pairs", () => {
    const contract = themeContract(
      packWith(
        JSON.stringify({
          contrastPairs: [["--a", "--b"], ["--c"], ["--d", "--e", "--f"], "not-a-pair", [1, 2]],
        }),
      ),
    );
    expect(contract.contrastPairs).toEqual([["--a", "--b"]]);
  });

  test("non-string entries are filtered out of the token list", () => {
    const contract = themeContract(
      packWith(JSON.stringify({ requiredThemeTokens: ["--a", 3, "", null, "--b"] })),
    );
    expect(contract.requiredTokens).toEqual(["--a", "--b"]);
  });
});
