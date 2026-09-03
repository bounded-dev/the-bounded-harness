import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SRC_RULE_IDS, TEST_RULE_IDS } from "../packs/ts/scripts/lint-src.ts";
import { CONTRACT_RULE_IDS } from "../packs/ts/scripts/contract-purity.ts";

// The deterministic-check principle runs both ways. Forward: every rule that
// must hold is enforced by a guard, because prose executes unreliably (the
// whole dogfood record). Backward — THIS file: everything a guard enforces on
// a role must also be TOLD to that role in its brief, so the agent can get it
// right the first time instead of learning the rule from a block. A guard the
// agent has never heard of is a bounce tax paid on every run.
//
// The check is presence-by-name: the rule id (or its distinctive tail) must
// appear in the role's .md. Wording is free; silence is not.

const agents = join(import.meta.dirname, "..", "agents");
const builder = readFileSync(join(agents, "builder.md"), "utf8");
const testWriter = readFileSync(join(agents, "test-writer.md"), "utf8");
const architect = readFileSync(join(agents, "architect.md"), "utf8");

/** Match by the id's distinctive tail so prose may write `no-explicit-any`
 *  without the plugin prefix. */
function names(doc: string, ruleId: string): boolean {
  const tail = ruleId.split("/").pop()!;
  return doc.includes(tail);
}

describe("every enforced rule is named in the brief of the role it binds", () => {
  test("src rules → builder.md", () => {
    const missing = SRC_RULE_IDS.filter((r) => !names(builder, r));
    expect(missing).toEqual([]);
  });

  test("test rules → test-writer.md", () => {
    const missing = TEST_RULE_IDS.filter((r) => !names(testWriter, r));
    expect(missing).toEqual([]);
  });

  test("contract rules → architect.md", () => {
    const missing = CONTRACT_RULE_IDS.filter((r) => !names(architect, r));
    expect(missing).toEqual([]);
  });
});

describe("the obligations and orderings are named too", () => {
  test("test-writer is told about reachability, boundaries, and collection-time throws", () => {
    expect(testWriter).toMatch(/boundaries/);
    expect(testWriter).toMatch(/— boundaries/); // the exact describe fingerprint, em dash
    expect(testWriter).toMatch(/top level of a test file|during import/);
    expect(testWriter).toMatch(/must be CALLED|reachab/i);
  });

  test("builder is told about surface conformance and the ceilings' remedy", () => {
    expect(builder).toMatch(/match the\ncontract exactly|match the contract exactly/);
    expect(builder).toMatch(/CONTRACT-DISPUTE/);
  });

  test("architect is told green requires a red after the last freeze", () => {
    expect(architect).toMatch(/red_gate. pass exists\nAFTER|pass exists AFTER|after the most recent/i);
  });
});
