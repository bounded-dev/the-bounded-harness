import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import { classifyDesignGate, DESIGN_STEPS, type StepOutcome } from "./design-gate.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import { checkSpawnPrecondition } from "../../../src/phase-gate.ts";

// --- pure core: classifyDesignGate --------------------------------------------

function step(name: StepOutcome["step"], code: number, ms = 1200, lines: string[] = []): StepOutcome {
  return { step: name, code, lines, ms };
}

describe("classifyDesignGate", () => {
  test("every step passing → exit 0 and ONE final verdict", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0, 3200, ["contract-purity: OK (1 file)"]),
      step("scaffold", 0, 400),
      step("typecheck", 0, 2100),
      step("freeze", 0, 100),
    ]);
    expect(r.code).toBe(0);
    expect(r.verdict).toBe("pass");
    expect(r.lines).toContain("contract-purity: OK (1 file)");
    expect(r.lines).toContain("contract-purity: PASS (3.2s)");
    expect(r.lines).toContain("typecheck: PASS (2.1s)");
    // Exactly one line is the gate's own verdict — the round-trip this gate
    // exists to remove is the architect reading four of them.
    expect(r.lines.filter((l) => l.startsWith("design-gate:"))).toEqual([
      "design-gate: OK — contract-purity → scaffold → typecheck → freeze (5.8s)",
    ]);
  });

  test("a blocked step names itself, the steps that did not run, and the route", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0),
      step("scaffold", 1, 500, ["scaffold: BLOCK — declares only types"]),
    ]);
    expect(r.code).toBe(1);
    expect(r.verdict).toBe("block");
    expect(r.lines).toContain("scaffold: BLOCK (0.5s)");
    expect(r.lines).toContain("design-gate: FAIL — scaffold blocked; typecheck, freeze did not run");
    expect(r.lines).toContain("design-gate: route → architect");
    expect(r.summary).toBe("scaffold blocked (route: architect)");
  });

  test("a step that could not run at all is misuse (exit 2), still routed", () => {
    const r = classifyDesignGate([step("contract-purity", 2, 100, ["contract-purity: no files matched"])]);
    expect(r.code).toBe(2);
    expect(r.verdict).toBe("error");
    expect(r.lines).toContain("contract-purity: ERROR (0.1s)");
    expect(r.lines).toContain(
      "design-gate: FAIL — contract-purity could not run; scaffold, typecheck, freeze did not run",
    );
    expect(r.lines).toContain("design-gate: route → architect");
  });

  test("the failing last step reports nothing skipped", () => {
    const r = classifyDesignGate([
      step("contract-purity", 0),
      step("scaffold", 0),
      step("typecheck", 0),
      step("freeze", 1),
    ]);
    expect(r.lines).toContain("design-gate: FAIL — freeze blocked");
  });
});

// --- CLI (fixture repos) ------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "design-gate.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A value object that satisfies contract-purity and scaffolds. */
const CURRENCY = `/** Currency: ISO-4217 alphabetic code — exactly three uppercase letters. */
export declare class Currency {
  private readonly __brand: "Currency";
  private constructor();
  readonly value: string;
  static parse(raw: unknown): Currency | undefined;
}
`;

/** A contract that passes purity, scaffolds and typechecks. */
const CLEAN_CONTRACT = `${CURRENCY}
export interface Money {
  readonly currency: Currency;
}

export declare function format(money: Money): Currency;
`;

/** Passes purity (no naked primitives) but declares nothing that exists at
 *  runtime, so the scaffolder blocks. */
const TYPES_ONLY_CONTRACT = `export type Kind = "deposit" | "withdrawal";

export interface Ledger {
  post(kind: Kind): Kind;
}
`;

/** A naked \`string\` on the public surface: the purity gate's own failure. */
const IMPURE_CONTRACT = `export interface Book {
  isbn: string;
}

export declare function shelve(book: Book): Book;
`;

function fixtureRepo(prefix: string, contract: string, tscOutput = ""): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "src", "money"), { recursive: true });
  writeFileSync(join(dir, "src", "money", "money.contract.ts"), contract);
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  // tsc stand-in: replay a captured diagnostics file with tsc's exit code.
  writeFileSync(join(dir, "tsc.txt"), tscOutput);
  return dir;
}

function runGate(dir: string, typeErrors = false) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_GATE_TSC_CMD: "sh",
      PI_GATE_TSC_ARGS: JSON.stringify(["-c", `cat tsc.txt; exit ${typeErrors ? 2 : 0}`]),
    },
  });
}

const MANIFEST = join(".pi", "contract-checksums.json");
const SKELETON = join("src", "money", "money.ts");

const CONTRACT_TYPE_ERR = "src/money/money.contract.ts(3,1): error TS2304: Cannot find name 'Iso'.";
const SKELETON_TYPE_ERR = "src/money/money.ts(9,3): error TS2322: Type 'string' is not assignable.";

describe("design-gate CLI: the whole design phase in one call", () => {
  test("all four steps pass → exit 0, timed steps, one verdict, a frozen manifest", () => {
    const dir = fixtureRepo("design-ok-", CLEAN_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/contract-purity: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/scaffold: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/typecheck: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(/freeze: PASS \(\d+\.\d+s\)/);
    expect(r.stdout).toMatch(
      /design-gate: OK — contract-purity → scaffold → typecheck → freeze \(\d+\.\d+s\)/,
    );
    // Each step's own output survives into the aggregate.
    expect(r.stdout).toMatch(/contract-purity: OK \(1 file\)/);
    expect(r.stdout).toMatch(/scaffold: wrote .*money\.ts/);
    expect(r.stdout).toMatch(/typecheck: OK — no type errors/);
    expect(r.stdout).toMatch(/checksum-gate: wrote \.pi\/contract-checksums\.json/);
    expect(existsSync(join(dir, SKELETON))).toBe(true);
    expect(existsSync(join(dir, MANIFEST))).toBe(true);
  });

  test("the composite event records every step's outcome and duration", () => {
    const dir = fixtureRepo("design-log-", CLEAN_CONTRACT);
    expect(runGate(dir).status).toBe(0);
    const composite = readGuardLog(dir).filter((e) => e.guard === "design-gate");
    expect(composite).toHaveLength(1);
    expect(composite[0]).toMatchObject({ guard: "design-gate", verdict: "pass" });
    const detail = composite[0].detail as { steps: { step: string; verdict: string; ms: number }[] };
    expect(detail.steps.map((s) => s.step)).toEqual([...DESIGN_STEPS]);
    expect(detail.steps.every((s) => s.verdict === "pass")).toBe(true);
    expect(detail.steps.every((s) => typeof s.ms === "number")).toBe(true);
  });

  // The phase gate derives the DESIGN ordering from the INNER guard names, so
  // wrapping the steps must not stop them being logged — a composite that
  // swallowed its own steps would silently lock the pipeline at COMMISSION.
  test("the inner guard events still flow, so the phase gate still opens", () => {
    const dir = fixtureRepo("design-phase-", CLEAN_CONTRACT);
    expect(runGate(dir).status).toBe(0);
    const events = readGuardLog(dir);
    for (const guard of ["contract-purity", "scaffold", "checksum-gate"]) {
      expect(
        events.some((e) => e.guard === guard && e.verdict === "pass"),
        `${guard} must still reach the guard log`,
      ).toBe(true);
    }
    expect(
      checkSpawnPrecondition("test-writer", {
        contracts: ["src/money/money.contract.ts"],
        specBytes: 4000,
        events,
      }).allow,
    ).toBe(true);
  });

  test("re-running is idempotent: the same manifest, the same verdict", () => {
    const dir = fixtureRepo("design-idem-", CLEAN_CONTRACT);
    expect(runGate(dir).status).toBe(0);
    const first = readFileSync(join(dir, MANIFEST), "utf8");
    const second = runGate(dir);
    expect(second.status).toBe(0);
    expect(readFileSync(join(dir, MANIFEST), "utf8")).toBe(first);
    expect(second.stdout).toMatch(/design-gate: OK/);
    expect(readGuardLog(dir).filter((e) => e.guard === "design-gate")).toHaveLength(2);
  });
});

// A failure at any step must halt the sequence. The assertion that matters is
// not the exit code — it is that the LATER steps left no trace: a skeleton
// generated from a contract that failed purity, or a manifest freezing a
// contract that does not compile, is exactly the ordering fumble this gate
// replaces.
describe("design-gate CLI: the first failure halts the sequence", () => {
  test("purity blocks → nothing is scaffolded and nothing is frozen", () => {
    const dir = fixtureRepo("design-impure-", IMPURE_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/no-naked-primitives/);
    expect(r.stdout).toMatch(/contract-purity: BLOCK \(\d+\.\d+s\)/);
    expect(r.stdout).toContain(
      "design-gate: FAIL — contract-purity blocked; scaffold, typecheck, freeze did not run",
    );
    expect(r.stdout).toContain("design-gate: route → architect");
    expect(existsSync(join(dir, SKELETON))).toBe(false);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
    expect(readGuardLog(dir).some((e) => e.guard === "checksum-gate")).toBe(false);
  });

  test("scaffold blocks → the typecheck never runs and nothing is frozen", () => {
    const dir = fixtureRepo("design-typesonly-", TYPES_ONLY_CONTRACT);
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/declares only types/);
    expect(r.stdout).toMatch(/scaffold: BLOCK \(\d+\.\d+s\)/);
    expect(r.stdout).toContain("design-gate: FAIL — scaffold blocked; typecheck, freeze did not run");
    expect(r.stdout).toContain("design-gate: route → architect");
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });

  test("typecheck blocks → the contract is NOT frozen", () => {
    const dir = fixtureRepo(
      "design-typedirty-",
      CLEAN_CONTRACT,
      `${CONTRACT_TYPE_ERR}\n${SKELETON_TYPE_ERR}\nFound 2 errors.\n`,
    );
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/typecheck: 2 type errors/);
    expect(r.stdout).toMatch(/typecheck: BLOCK \(\d+\.\d+s\)/);
    expect(r.stdout).toContain("design-gate: FAIL — typecheck blocked; freeze did not run");
    // The skeleton was generated (scaffold passed) but the manifest was not:
    // freezing a contract that does not compile is the fumble to prevent.
    expect(existsSync(join(dir, SKELETON))).toBe(true);
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
    expect(readGuardLog(dir).find((e) => e.guard === "design-gate")).toMatchObject({
      verdict: "block",
      detail: { failed: "typecheck", route: "architect" },
    });
  });

  // typecheck-routing attributes each diagnostic to the role whose write zone
  // owns the file, and a skeleton lives in the builder's zone. At DESIGN the
  // builder does not exist yet, so the attribution is shown and the route is
  // still the architect's.
  test("a diagnostic attributed to another role still routes to the architect", () => {
    const dir = fixtureRepo("design-route-", CLEAN_CONTRACT, `${SKELETON_TYPE_ERR}\nFound 1 error.\n`);
    const r = runGate(dir, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("  builder (1):");
    expect(r.stdout).toContain(SKELETON_TYPE_ERR);
    expect(r.stdout).toContain("design-gate: route → architect");
    expect(r.stdout).not.toContain("design-gate: route → builder");
  });

  test("tsc failing without a parseable diagnostic is misuse, not a design defect", () => {
    const dir = fixtureRepo("design-tscbroken-", CLEAN_CONTRACT, "sh: tsc: command not found\n");
    const r = runGate(dir, true);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/typecheck: ERROR — tsc failed without a parseable diagnostic/);
    expect(r.stdout).toContain("design-gate: FAIL — typecheck could not run; freeze did not run");
    expect(existsSync(join(dir, MANIFEST))).toBe(false);
  });
});
