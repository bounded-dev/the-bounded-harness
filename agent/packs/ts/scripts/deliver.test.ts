import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { barrelFor, runDeliver, stripConformance } from "./deliver.ts";
import { readGuardLog } from "../../../src/guard-log.ts";
import type { PhaseDurations } from "../../../src/phase-durations.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ERRORS_TS = `export class NotImplementedError extends Error {
  constructor(what: string) {
    super(\`NotImplemented: \${what}\`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}
`;

const CONTRACT_TS = `export interface Order {
  readonly id: string;
}

export declare function placeOrder(id: string): Order;
`;

const IMPL_TS = `import type { Order } from "./orders.contract.js";
import type * as __Contract from "./orders.contract.js";

export type * from "./orders.contract.js";

export function placeOrder(id: string): Order {
  return { id };
}

// Compile-time conformance: every scaffoldable value export of the contract
// exists above, with the signature the contract declared.
const __conformance: typeof __Contract = { placeOrder };
void __conformance;
`;

const PACKAGE_JSON = `{
  "name": "fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit && vitest run",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
`;

const SURFACE_STUB = "// stub surface checker (the real one ships from the pack)\n";

/** A finished run's worth of guard events, as the gates would have appended
 *  them: design froze at +4m, red passed at +20m, green at +48m, with one
 *  bounce to the test-writer inside TEST. Timestamps are fixed so the block
 *  the timing step prints is exact rather than approximately right. */
const SEEDED_GUARD_LOG = [
  { ts: "2026-03-01T09:00:00.000Z", guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" },
  { ts: "2026-03-01T09:04:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" },
  {
    ts: "2026-03-01T09:12:00.000Z",
    guard: "red-gate",
    verdict: "block",
    summary: "2 wrong-reason failures (route: test-writer)",
    detail: { reason: "wrong-reason", route: "test-writer" },
  },
  { ts: "2026-03-01T09:20:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" },
  { ts: "2026-03-01T09:48:00.000Z", guard: "green-gate", verdict: "pass", summary: "GREEN (5/5 passed, typecheck clean)" },
]
  .map((e) => JSON.stringify(e))
  .join("\n") + "\n";

/** The same run, plus the refusals r14 spent its afternoon on. */
const FRICTION_GUARD_LOG = [
  { ts: "2026-03-01T09:00:00.000Z", guard: "contract-purity", verdict: "pass", summary: "OK (1 file)" },
  { ts: "2026-03-01T09:01:00.000Z", guard: "path-gate", verdict: "block", summary: "architect may not write src/x.ts" },
  { ts: "2026-03-01T09:02:00.000Z", guard: "phase-gate", verdict: "block", summary: "test-writer may not spawn yet" },
  { ts: "2026-03-01T09:04:00.000Z", guard: "checksum-gate", verdict: "pass", summary: "wrote manifest (1 contract file)" },
  { ts: "2026-03-01T09:20:00.000Z", guard: "red-gate", verdict: "pass", summary: "RED OK (5 NotImplemented failures, 0 passed)" },
  { ts: "2026-03-01T09:30:00.000Z", guard: "path-gate", verdict: "block", summary: "builder may not write tests/y.test.ts" },
  {
    ts: "2026-03-01T09:40:00.000Z",
    guard: "green-gate",
    verdict: "block",
    summary: "1 failing test (route: builder)",
    detail: { route: "builder" },
  },
  { ts: "2026-03-01T09:48:00.000Z", guard: "green-gate", verdict: "pass", summary: "GREEN (5/5 passed, typecheck clean)" },
]
  .map((e) => JSON.stringify(e))
  .join("\n") + "\n";

/** A minimal finished-run-shaped project: package.json + one contract pair. */
function proj(extra: Record<string, string> = {}, base: Record<string, string> | null = null): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-"));
  tmpDirs.push(dir);
  const files: Record<string, string> = base ?? {
    "package.json": PACKAGE_JSON,
    ".gitignore": "node_modules/\n",
    "src/orders/orders.contract.ts": CONTRACT_TS,
    "src/orders/orders.ts": IMPL_TS,
    "src/shared/errors.ts": ERRORS_TS,
  };
  for (const [rel, content] of Object.entries({ ...files, ...extra })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** Every test injects the surface-checker source: the real pack file is a
 *  concurrent workstream and may not exist yet. */
function surfaceStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-deliver-stub-"));
  tmpDirs.push(dir);
  const path = join(dir, "surface-check.ts");
  writeFileSync(path, SURFACE_STUB);
  return path;
}

function deliver(cwd: string) {
  return runDeliver(cwd, { surfaceCheckSource: surfaceStub() });
}

describe("stripConformance (pure)", () => {
  test("removes the blob, its comment, and the __Contract import — nothing else", () => {
    const out = stripConformance(IMPL_TS, "orders.ts");
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/__conformance|__Contract|Compile-time conformance/);
    expect(out).toContain('export type * from "./orders.contract.js";');
    expect(out).toContain('import type { Order } from "./orders.contract.js";');
    expect(out).toContain("export function placeOrder");
    expect(out?.endsWith("\n")).toBe(true);
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("a file with nothing to strip returns null", () => {
    expect(stripConformance('export type * from "./x.contract.js";\nexport const a = 1;\n', "x.ts")).toBeNull();
  });
});

describe("barrelFor (pure)", () => {
  test("one line per implementation module, src-relative, .js specifiers", () => {
    const out = barrelFor(["shared/money.ts", "subscription-billing/subscription-billing.ts"]);
    expect(out).toContain('export * from "./shared/money.js";');
    expect(out).toContain('export * from "./subscription-billing/subscription-billing.js";');
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("runDeliver", () => {
  test("full pass on a clean project: all steps fire, exit 0, summary line", () => {
    const dir = proj();
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toMatch(/^deliver: OK — \d+ steps applied$/);

    // 1. dead scaffolding gone (nothing imports it), shared/ dir cleaned up
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/shared"))).toBe(false);
    // 2. conformance blob stripped, load-bearing re-export kept
    const impl = readFileSync(join(dir, "src/orders/orders.ts"), "utf8");
    expect(impl).not.toContain("__conformance");
    expect(impl).toContain('export type * from "./orders.contract.js";');
    // 3. barrel
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain('export * from "./orders/orders.js";');
    // 4. surface check shipped and wired
    expect(readFileSync(join(dir, "scripts/surface-check.ts"), "utf8")).toBe(SURFACE_STUB);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts["check:surface"]).toBe("node --experimental-strip-types scripts/surface-check.ts");
    expect(pkg.scripts.check).toContain("npm run check:surface");
    expect(pkg.devDependencies["ts-morph"]).toMatch(/^\d+\.\d+\.\d+$/);
    // 5. .pi/ ignored
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\.pi\/$/m);
    // 6. README
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("## Contracts");
    expect(readme).not.toMatch(/TN-\d+|harness|red-phase|scaffold/i);

    // each step logged a guard event
    const events = readGuardLog(dir).filter((e) => e.guard === "deliver");
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events.every((e) => e.verdict === "pass")).toBe(true);
  });

  test("ts-morph pin matches the version the pack itself uses", () => {
    const dir = proj();
    deliver(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const agentPkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["ts-morph"]).toBe(agentPkg.devDependencies["ts-morph"]);
  });

  test("BLOCK when a src file still imports NotImplementedError — names the file", () => {
    const dir = proj({
      "src/orders/orders.ts": `import { NotImplementedError } from "../shared/errors.js";
export type * from "./orders.contract.js";
export function placeOrder(id: string): never {
  throw new NotImplementedError("placeOrder");
}
`,
    });
    const r = deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/BLOCK/);
    expect(r.lines.join("\n")).toContain("src/orders/orders.ts");
    expect(r.lines.join("\n")).toMatch(/NotImplementedError/);
    // nothing was deleted
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
    const events = readGuardLog(dir).filter((e) => e.guard === "deliver");
    expect(events.some((e) => e.verdict === "block")).toBe(true);
  });

  test("errors module is KEPT (not a block) when only tests/ import it", () => {
    const dir = proj({
      "tests/orders.test.ts": `import { NotImplementedError } from "../src/shared/errors.js";
void NotImplementedError;
`,
    });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
    expect(r.lines.join("\n")).toMatch(/kept/i);
  });

  test("BLOCK on a hand-written src/index.ts — merge is not a delivery step", () => {
    const dir = proj({ "src/index.ts": "export { placeOrder } from './orders/orders.js';\n" });
    const r = deliver(dir);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(/index\.ts/);
    // untouched
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain("export { placeOrder }");
  });

  test("appends to an existing README rather than clobbering it", () => {
    const dir = proj({ "README.md": "# fixture\n\nHand-written intro.\n" });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Hand-written intro.");
    expect(readme).toContain("## Contracts");
  });

  test("idempotent: the second run applies 0 steps and changes no file", () => {
    const dir = proj();
    const stub = surfaceStub();
    expect(runDeliver(dir, { surfaceCheckSource: stub }).code).toBe(0);
    const snapshot = new Map<string, string>();
    for (const rel of [
      "package.json",
      ".gitignore",
      "README.md",
      "src/index.ts",
      "src/orders/orders.ts",
      "scripts/surface-check.ts",
    ]) {
      snapshot.set(rel, readFileSync(join(dir, rel), "utf8"));
    }
    const r2 = runDeliver(dir, { surfaceCheckSource: stub });
    expect(r2.code).toBe(0);
    expect(r2.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
    for (const [rel, content] of snapshot) {
      expect(readFileSync(join(dir, rel), "utf8")).toBe(content);
    }
    // .pi/ not duplicated in .gitignore
    const ignoreLines = readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter((l) => l === ".pi/");
    expect(ignoreLines).toHaveLength(1);
  });

  test("misuse: missing surface checker source is exit 2, before any mutation", () => {
    const dir = proj();
    const r = runDeliver(dir, { surfaceCheckSource: join(dir, "does-not-exist.ts") });
    expect(r.code).toBe(2);
    // step 1 did not run
    expect(existsSync(join(dir, "src/shared/errors.ts"))).toBe(true);
  });

  test("misuse: target without src/ or package.json is exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-deliver-empty-"));
    tmpDirs.push(dir);
    const r = runDeliver(dir, { surfaceCheckSource: surfaceStub() });
    expect(r.code).toBe(2);
  });
});

// Issue #13: every run should report where its minutes went. The measurement
// was already in the guard log — delivery is where it finally gets read back.
describe("runDeliver: phase timing", () => {
  test("prints the phase block from the project's own guard log", () => {
    const dir = proj({ ".pi/guard-log.jsonl": SEEDED_GUARD_LOG });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    const out = r.lines.join("\n");
    expect(out).toMatch(/^deliver: timing — where the minutes went \(\d+ guard events, taken as one run\)$/m);
    expect(r.lines).toContain("  timing: design    4m00s");
    expect(r.lines).toContain("  timing: tests    16m00s  (1 bounce: 1 → test-writer)");
    expect(r.lines).toContain("  timing: build    28m00s");
    // WRAP is closed by this very delivery's own events, so its span is live
    // wall clock — assert it was measured, not what it measured to.
    expect(out).toMatch(/^ {2}timing: wrap\s+\d+[hms]/m);
    // A clean run still says so: zero is the target, and a line that appears
    // only when there is friction makes "clean" and "unmeasured" look alike.
    expect(r.lines).toContain("  friction: 0 unrouted blocks — target 0");
  });

  // Bounces are the pipeline working; unrouted blocks are the harness getting
  // in the way, and r14 ended a run with 17 of them without any single line
  // ever saying so. The guard breakdown is what points at the fix.
  test("the friction line totals the unrouted blocks and names the guards", () => {
    const dir = proj({ ".pi/guard-log.jsonl": FRICTION_GUARD_LOG });
    const r = deliver(dir);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("  friction: 3 unrouted blocks (path-gate 2, phase-gate 1) — target 0");
    // ...and the same numbers ride in the event detail, not a second tally.
    const event = readGuardLog(dir).find(
      (e) => e.guard === "deliver" && (e.detail as { step?: string } | undefined)?.step === "timing",
    );
    const timing = (event!.detail as { timing?: PhaseDurations }).timing!;
    expect(timing.friction).toEqual({
      unroutedBlocks: 3,
      byGuard: [
        { guard: "path-gate", count: 2 },
        { guard: "phase-gate", count: 1 },
      ],
    });
  });

  test("the structured summary rides along in the deliver guard event's detail", () => {
    const dir = proj({ ".pi/guard-log.jsonl": SEEDED_GUARD_LOG });
    deliver(dir);
    const event = readGuardLog(dir).find(
      (e) => e.guard === "deliver" && (e.detail as { step?: string } | undefined)?.step === "timing",
    );
    expect(event).toBeDefined();
    const timing = (event!.detail as { timing?: PhaseDurations }).timing!;
    expect(timing.phases.map((p) => p.phase)).toEqual(["design", "tests", "build", "wrap"]);
    expect(timing.phases[0]!.ms).toBe(4 * 60_000);
    expect(timing.phases[1]!.byRoute).toEqual([{ route: "test-writer", count: 1 }]);
    expect(timing.bounces).toBe(1);
  });

  test("timing is read-only: it applies no step and the second run reports again", () => {
    const dir = proj({ ".pi/guard-log.jsonl": SEEDED_GUARD_LOG });
    const stub = surfaceStub();
    runDeliver(dir, { surfaceCheckSource: stub });
    const second = runDeliver(dir, { surfaceCheckSource: stub });
    expect(second.lines.at(-1)).toBe("deliver: OK — 0 steps applied");
    expect(second.lines).toContain("  timing: design    4m00s");
  });

  test("an unavailable log costs one line, never the delivery", () => {
    // PI_GUARD_LOG=off is the real way a project ends up with no log at all:
    // nothing was ever written, including this delivery's own events.
    const dir = proj();
    process.env["PI_GUARD_LOG"] = "off";
    try {
      const r = deliver(dir);
      expect(r.code).toBe(0);
      expect(r.lines).toContain(
        "deliver: timing — unavailable — the guard log is empty or absent (PI_GUARD_LOG=off, or no gate ran here)",
      );
      expect(r.lines.at(-1)).toMatch(/^deliver: OK — \d+ steps applied$/);
    } finally {
      delete process.env["PI_GUARD_LOG"];
    }
    // the repo was still delivered
    expect(existsSync(join(dir, "src/index.ts"))).toBe(true);
  });
});
