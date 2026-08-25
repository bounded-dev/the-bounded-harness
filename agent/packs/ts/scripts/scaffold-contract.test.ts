import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { transform } from "esbuild";
import ts from "typescript";
import { ScaffoldError, scaffoldContract, skeletonPathFor } from "./scaffold-contract.js";

const TESTDATA = join(import.meta.dirname, "testdata");
const fixture = (name: string) => readFileSync(join(TESTDATA, name), "utf8");
const contractOf = (name: string) => fixture(`${name}.contract.ts`);
const goldenOf = (name: string) => fixture(`${name}.golden.ts`);

const PAIRS = ["functions", "queue", "types", "values"] as const;

// --- golden files ------------------------------------------------------------

describe("golden files", () => {
  for (const name of PAIRS) {
    test(`${name}.contract.ts → skeleton matches ${name}.golden.ts`, () => {
      expect(scaffoldContract(contractOf(name), `${name}.contract.ts`)).toBe(goldenOf(name));
    });
  }
});

// --- output compiles against the contract (strict, NodeNext) -----------------

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function typecheck(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-test-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const program = ts.createProgram(
    Object.keys(files).map((f) => join(dir, f)),
    {
      strict: true,
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

describe("skeletons compile against their contracts", () => {
  test("functions", () => {
    expect(
      typecheck({
        "functions.contract.ts": contractOf("functions"),
        "functions.ts": goldenOf("functions"),
      }),
    ).toEqual([]);
  });

  test("class (with cross-contract type import)", () => {
    expect(
      typecheck({
        "queue/queue.contract.ts": contractOf("queue"),
        "queue/queue.ts": goldenOf("queue"),
        "shared/money.contract.ts": MONEY_CONTRACT,
      }),
    ).toEqual([]);
  });

  test("types-only contract", () => {
    expect(
      typecheck({ "types.contract.ts": contractOf("types"), "types.ts": goldenOf("types") }),
    ).toEqual([]);
  });

  test("declare const values", () => {
    expect(
      typecheck({ "values.contract.ts": contractOf("values"), "values.ts": goldenOf("values") }),
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
    });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.join("\n")).toMatch(/identity/);
  });
});

// --- every export throws NotImplementedError ---------------------------------

async function importModule(source: string): Promise<Record<string, unknown>> {
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
  return import("data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64"));
}

describe("skeletons throw NotImplementedError at runtime", () => {
  test("functions: module imports cleanly; every call throws NotImplementedError", async () => {
    const mod = await importModule(goldenOf("functions"));
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
    const mod = await importModule(goldenOf("queue"));
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
    await expect(importModule(goldenOf("values"))).rejects.toThrowError(
      /NotImplemented: DEFAULT_PAGE_SIZE/,
    );
    await importModule(goldenOf("values")).then(
      () => expect.unreachable(),
      (e: Error) => expect(e.name).toBe("NotImplementedError"),
    );
  });

  test("types-only skeleton imports as an empty module", async () => {
    const mod = await importModule(goldenOf("types"));
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
      "export declare function throwNotImplemented(): void;",
      /collides with scaffold internals/,
    ],
  ];
  for (const [label, source, pattern] of cases) {
    test(label, () => {
      expect(() => scaffoldContract(source, "x.contract.ts")).toThrowError(ScaffoldError);
      expect(() => scaffoldContract(source, "x.contract.ts")).toThrowError(pattern);
    });
  }
});
