import { describe, expect, test } from "vitest";
import { gitPolicy } from "./git-policy.ts";

describe("architect Git policy", () => {
  test.each([
    ["status", "--short"],
    ["log", "--oneline", "-10"],
    ["show", "HEAD:src/example.ts"],
    ["diff", "--cached", "--stat"],
    ["grep", "-n", "symbol", "--", "src"],
    ["ls-files", "-s", "src"],
    ["rev-parse", "--show-toplevel"],
  ])("allows read-only Git %s", (...args) => {
    expect(gitPolicy(args)).toBeUndefined();
  });

  test.each([
    ["add", "-f", ".bounded/harness/scripts/bounded"],
    ["update-index", "--chmod=+x", ".bounded/harness/scripts/bounded"],
    ["checkout-index", "-f", "--", ".bounded/harness/scripts/bounded"],
    ["rm", "--cached", ".bounded/harness/scripts/bounded"],
    ["reset", "--hard"],
    ["commit", "-m", "change"],
    ["diff", "--output=src/crm/model.ts"],
    ["grep", "-O", "sh", "pattern"],
    ["-c", "alias.x=!sh", "status"],
    ["__proto__"],
  ])("refuses a mutating or executable Git form", (...args) => {
    expect(gitPolicy(args)).toBeDefined();
  });
});
