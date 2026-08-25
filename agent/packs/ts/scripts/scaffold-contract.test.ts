import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import ts from "typescript";
import { readGuardLog } from "../../../src/guard-log.ts";
import {
  ERRORS_MODULE_SOURCE,
  ScaffoldError,
  errorsModuleFor,
  scaffoldContract,
  skeletonPathFor,
} from "./scaffold-contract.ts";

const TESTDATA = join(import.meta.dirname, "testdata");
const fixture = (name: string) => readFileSync(join(TESTDATA, name), "utf8");
const contractOf = (name: string) => fixture(`${name}.contract.ts`);
const goldenOf = (name: string) => fixture(`${name}.golden.ts`);

const PAIRS = ["functions", "queue", "types", "values"] as const;

// --- golden files ------------------------------------------------------------

// The path passed for each fixture reflects its assumed project layout
// (the errors-module specifier is derived from it): queue lives one level
// down because its contract imports '../shared/money.contract.js'.
const LAYOUT: Record<(typeof PAIRS)[number], string> = {
  functions: "functions.contract.ts",
  queue: "queue/queue.contract.ts",
  types: "types.contract.ts",
  values: "values.contract.ts",
};

describe("golden files", () => {
  for (const name of PAIRS) {
    test(`${name}.contract.ts → skeleton matches ${name}.golden.ts`, () => {
      expect(scaffoldContract(contractOf(name), LAYOUT[name])).toBe(goldenOf(name));
    });
  }
});

// --- output compiles against the contract (strict, NodeNext) -----------------

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function writeTmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-test-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function typecheck(files: Record<string, string>): string[] {
  const dir = writeTmp(files);
  const program = ts.createProgram(
    Object.keys(files).map((f) => join(dir, f)),
    {
      // Very strict, per the harness TS philosophy: inference-first,
      // no implicit anything. noUnusedParameters stays off deliberately —
      // a throwing skeleton's parameters are unused by design.
      strict: true,
      noUnusedLocals: true,
      noImplicitReturns: true,
      noImplicitOverride: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: [],
    },
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? "<global>"}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

const MONEY_CONTRACT = "export interface Money {\n  cents: number;\n  currency: string;\n}\n";

// Every skeleton project has the template's shared errors module.
const SHARED = { "shared/errors.ts": ERRORS_MODULE_SOURCE };

describe("skeletons compile against their contracts", () => {
  test("functions", () => {
    expect(
      typecheck({
        "functions.contract.ts": contractOf("functions"),
        "functions.ts": goldenOf("functions"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("class (with cross-contract type import)", () => {
    expect(
      typecheck({
        "queue/queue.contract.ts": contractOf("queue"),
        "queue/queue.ts": goldenOf("queue"),
        "shared/money.contract.ts": MONEY_CONTRACT,
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("types-only contract", () => {
    expect(
      typecheck({
        "types.contract.ts": contractOf("types"),
        "types.ts": goldenOf("types"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("declare const values", () => {
    expect(
      typecheck({
        "values.contract.ts": contractOf("values"),
        "values.ts": goldenOf("values"),
        ...SHARED,
      }),
    ).toEqual([]);
  });

  test("a skeleton missing a contract value export fails to compile (conformance block works)", () => {
    const broken = goldenOf("functions").replace(
      "const __conformance: typeof __Contract = { createOrder, find, identity };",
      "const __conformance: typeof __Contract = { createOrder, find };",
    );
    const diags = typecheck({
      "functions.contract.ts": contractOf("functions"),
      "functions.ts": broken,
      ...SHARED,
    });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.join("\n")).toMatch(/identity/);
  });
});

// --- every export throws NotImplementedError ---------------------------------

// Skeletons import the shared errors module at runtime, so runtime tests
// bundle from a real tmp project (esbuild resolves the .js→.ts specifiers).
async function importModule(
  files: Record<string, string>,
  entry: string,
): Promise<Record<string, unknown>> {
  const dir = writeTmp(files);
  const result = await build({
    entryPoints: [join(dir, entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const code = result.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64"));
}

describe("skeletons throw NotImplementedError at runtime", () => {
  test("functions: module imports cleanly; every call throws NotImplementedError", async () => {
    const mod = await importModule({ "functions.ts": goldenOf("functions"), ...SHARED }, "functions.ts");
    for (const name of ["createOrder", "find", "identity"]) {
      expect(() => (mod[name] as (...a: unknown[]) => unknown)("x")).toThrowError(/NotImplemented/);
      try {
        (mod[name] as (...a: unknown[]) => unknown)("x");
        expect.unreachable();
      } catch (e) {
        expect((e as Error).name).toBe("NotImplementedError");
      }
    }
  });

  test("class: constructor and statics throw NotImplementedError", async () => {
    const mod = await importModule(
      { "queue/queue.ts": goldenOf("queue"), ...SHARED },
      "queue/queue.ts",
    );
    const Queue = mod["Queue"] as {
      new (n: number): unknown;
      create(n: number): unknown;
      instances: number;
    };
    expect(() => new Queue(3)).toThrowError(/NotImplemented: Queue\.constructor/);
    expect(() => Queue.create(3)).toThrowError(/NotImplemented: Queue\.create/);
    expect(() => Queue.instances).toThrowError(/NotImplemented: Queue\.instances/);
    try {
      new Queue(3);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).name).toBe("NotImplementedError");
    }
  });

  test("declare const: the throw happens at module evaluation (documented behavior)", async () => {
    const files = { "values.ts": goldenOf("values"), ...SHARED };
    await expect(importModule(files, "values.ts")).rejects.toThrowError(
      /NotImplemented: DEFAULT_PAGE_SIZE/,
    );
    await importModule(files, "values.ts").then(
      () => expect.unreachable(),
      (e: Error) => expect(e.name).toBe("NotImplementedError"),
    );
  });

  test("types-only skeleton imports as an empty module", async () => {
    const mod = await importModule({ "types.ts": goldenOf("types") }, "types.ts");
    expect(Object.keys(mod)).toHaveLength(0);
  });
});

// --- path mapping -------------------------------------------------------------

describe("skeletonPathFor (foo.contract.ts → sibling foo.ts)", () => {
  test("maps the fixed naming rule", () => {
    expect(skeletonPathFor("src/orders/orders.contract.ts")).toBe("src/orders/orders.ts");
    expect(skeletonPathFor("a.contract.ts")).toBe("a.ts");
  });

  test("rejects non-contract paths", () => {
    expect(() => skeletonPathFor("src/orders/orders.ts")).toThrowError(ScaffoldError);
    expect(() => skeletonPathFor("src/orders/orders.ts")).toThrowError(/not a \*\.contract\.ts path/);
  });

  test("scaffoldContract insists on a *.contract.ts filename", () => {
    expect(() => scaffoldContract("export type T = string;", "x.ts")).toThrowError(
      /not a \*\.contract\.ts path/,
    );
  });

  test("errorsModuleFor: shared errors module lives at <root>/shared/errors", () => {
    expect(errorsModuleFor("src/orders/orders.contract.ts")).toBe("src/shared/errors");
    expect(errorsModuleFor("src/x.contract.ts")).toBe("src/shared/errors");
    expect(errorsModuleFor("x.contract.ts")).toBe("shared/errors");
  });
});

// --- unsupported constructs fail loudly (never silently wrong output) ---------

describe("unsupported or non-declaration constructs → ScaffoldError", () => {
  const cases: [label: string, source: string, pattern: RegExp][] = [
    ["enum", "export enum Level { Low, High }", /enum/],
    ["declare enum", "export declare enum Level { Low, High }", /enum/],
    ["value import", 'import { Pool } from "pg";', /value import/],
    ["side-effect import", 'import "pg";', /side-effect import/],
    ["function body", "export function f() { return 1; }", /function body/],
    ["value binding", "export const X = 1;", /value binding/],
    ["namespace value", "export declare namespace N { function f(): void; }", /namespace/],
    ["default export", "export default function f(): void;", /default export/],
    ["export =", "export = {};", /export =/],
    ["destructuring declare", "export declare const { a }: { a: string };", /destructur/],
    [
      "scaffold-internal name collision",
      "export declare function notImplemented(): void;",
      /collides with scaffold internals/,
    ],
    [
      "public-surface type must be exported",
      "type Hidden = string;\nexport declare function f(): Hidden;",
      /'Hidden' is part of the public surface but not exported/,
    ],
    [
      "overloaded method",
      "export declare class C {\n  m(a: string): void;\n  m(a: number): void;\n}",
      /overloaded method 'C\.m'/,
    ],
    [
      "overloaded constructor",
      "export declare class C {\n  constructor(a: string);\n  constructor(a: number);\n}",
      /overloaded constructor/,
    ],
    [
      "declare const without a type",
      "export declare const X;",
      /needs an explicit type/,
    ],
  ];
  for (const [label, source, pattern] of cases) {
    test(label, () => {
      expect(() => scaffoldContract(source, "x.contract.ts")).toThrowError(ScaffoldError);
      expect(() => scaffoldContract(source, "x.contract.ts")).toThrowError(pattern);
    });
  }
});

// --- CLI: thin wiring + guard-log events --------------------------------------

const SCRIPT = join(import.meta.dirname, "scaffold-contract.ts");

describe("scaffold-contract CLI", () => {
  test("success: writes skeleton, creates shared errors module, logs pass", () => {
    const dir = writeTmp({ "src/orders/orders.contract.ts": contractOf("functions") });
    const r = spawnSync(process.execPath, [SCRIPT, "src/orders/orders.contract.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/scaffold: created src\/shared\/errors\.ts/);
    expect(r.stdout).toMatch(/scaffold: wrote src\/orders\/orders\.ts/);
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      guard: "scaffold",
      verdict: "pass",
      summary: "wrote src/orders/orders.ts",
    });
    expect(events[0].detail).toMatchObject({
      contract: "src/orders/orders.contract.ts",
      skeleton: "src/orders/orders.ts",
      createdErrorsModule: true,
    });
  });

  test("failure: ScaffoldError exits 1 with the reason and logs a block", () => {
    const dir = writeTmp({ "src/bad/bad.contract.ts": "export enum Level { Low, High }\n" });
    const r = spawnSync(process.execPath, [SCRIPT, "src/bad/bad.contract.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/enum 'Level' is not scaffoldable/);
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "scaffold", verdict: "block" });
    expect(events[0].summary).toMatch(/enum 'Level' is not scaffoldable/);
  });
});
