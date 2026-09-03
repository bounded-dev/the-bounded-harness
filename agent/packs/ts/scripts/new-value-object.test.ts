import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  ValueObjectError,
  addValueObjects,
  parseArgv,
  parseSpec,
  renderValueObject,
} from "./new-value-object.ts";
import { lintContractSource } from "./contract-purity.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

const CONTRACT = "src/reading-list/book.contract.ts";

// --- rendering ------------------------------------------------------------------

// The canonical shape (ts-contract-authoring, "The canonical shape is a nominal
// class"). Written out literally here rather than built from the generator's own
// helpers: a test that renders the thing it is checking checks nothing.
const ISBN = [
  "/** Isbn: state what makes it valid. */",
  "export declare class Isbn {",
  '  private readonly __brand: "Isbn";',
  "  private constructor();",
  "  readonly value: string;",
  "  static parse(raw: unknown): Isbn | undefined;",
  "  equals(other: Isbn): boolean;",
  "}",
].join("\n");

const clsFor = (name: string, base = "string"): string =>
  ISBN.replace(/Isbn/g, name).replace("readonly value: string", `readonly value: ${base}`);

describe("renderValueObject", () => {
  test("emits the nominal class, brand included", () => {
    expect(renderValueObject({ name: "Isbn", base: "string" })).toBe(ISBN);
  });

  test("the brand string always matches the type name (the typo that silently splits a type)", () => {
    const out = renderValueObject({ name: "PagesRead", base: "number" });
    expect(out).toContain('private readonly __brand: "PagesRead";');
    expect(out).toBe(clsFor("PagesRead", "number"));
  });

  test("a number base carries a number, under the same field name", () => {
    expect(renderValueObject({ name: "PagesRead", base: "number" })).toContain(
      "readonly value: number;",
    );
  });

  test("every member the shape depends on is present", () => {
    const out = renderValueObject({ name: "Currency", base: "string" });
    // private constructor: no `new Currency("usd")` past validation.
    expect(out).toContain("private constructor();");
    // unknown: parse faces parsed JSON directly.
    expect(out).toContain("static parse(raw: unknown): Currency | undefined;");
    // behaviour lives on the class — the whole reason to prefer it to an alias.
    expect(out).toContain("equals(other: Currency): boolean;");
    expect(out.startsWith("/** Currency: state what makes it valid. */")).toBe(true);
  });
});

// --- pure core ------------------------------------------------------------------

describe("addValueObjects", () => {
  test("declares the value object after the imports, before the rest", () => {
    const out = addValueObjects(
      'import type { Money } from "../shared/money.contract.js";\n' +
        "\n" +
        "export interface Book { isbn: string; price: Money }\n",
      CONTRACT,
      [{ name: "Isbn", base: "string" }],
    );
    expect(out.source).toBe(
      'import type { Money } from "../shared/money.contract.js";\n' +
        "\n" +
        ISBN +
        "\n\n" +
        "export interface Book { isbn: string; price: Money }\n",
    );
    expect(out.added).toEqual(["Isbn"]);
  });

  test("lands after the value objects already there, not on top of them", () => {
    const out = addValueObjects(ISBN + "\n\nexport interface Book { isbn: Isbn }\n", CONTRACT, [
      { name: "AuthorName", base: "string" },
    ]);
    expect(out.source).toBe(
      ISBN + "\n\n" + clsFor("AuthorName") + "\n\n" + "export interface Book { isbn: Isbn }\n",
    );
  });

  test("keeps a file header comment at the top", () => {
    const out = addValueObjects(
      "// src/reading-list/book.contract.ts\n" +
        "// The reading list's public surface.\n" +
        "\n" +
        "export interface Book { isbn: string }\n",
      CONTRACT,
      [{ name: "Isbn", base: "string" }],
    );
    expect(out.source).toBe(
      "// src/reading-list/book.contract.ts\n" +
        "// The reading list's public surface.\n" +
        "\n" +
        ISBN +
        "\n\n" +
        "export interface Book { isbn: string }\n",
    );
  });

  test("declares several in the order given", () => {
    const out = addValueObjects("export interface Book { isbn: string }\n", CONTRACT, [
      { name: "Isbn", base: "string" },
      { name: "AuthorName", base: "string" },
      { name: "PagesRead", base: "number" },
    ]);
    expect(out.added).toEqual(["Isbn", "AuthorName", "PagesRead"]);
    expect(out.source).toBe(
      [ISBN, clsFor("AuthorName"), clsFor("PagesRead", "number")].join("\n\n") +
        "\n\nexport interface Book { isbn: string }\n",
    );
  });

  test("is idempotent: an already-canonical value object is left alone", () => {
    const source = ISBN + "\n\nexport interface Book { isbn: Isbn }\n";
    const out = addValueObjects(source, CONTRACT, [{ name: "Isbn", base: "string" }]);
    expect(out.source).toBe(source);
    expect(out.added).toEqual([]);
    expect(out.unchanged).toEqual(["Isbn"]);
  });

  test("idempotent through a full round trip, batch included", () => {
    const specs = [
      { name: "Isbn", base: "string" as const },
      { name: "PagesRead", base: "number" as const },
    ];
    const once = addValueObjects("export interface Book { isbn: string }\n", CONTRACT, specs);
    const twice = addValueObjects(once.source, CONTRACT, specs);
    expect(twice.source).toBe(once.source);
    expect(twice.added).toEqual([]);
    expect(twice.unchanged).toEqual(["Isbn", "PagesRead"]);
  });

  test("leaves a class the architect has extended alone — the body is theirs", () => {
    const extended =
      "/** ISO-4217: exactly three uppercase letters. */\n" +
      "export declare class Currency {\n" +
      '  private readonly __brand: "Currency";\n' +
      "  private constructor();\n" +
      "  readonly code: string;\n" +
      "  static parse(raw: unknown): Currency | undefined;\n" +
      "  static of(code: string): Currency;\n" +
      "  equals(other: Currency): boolean;\n" +
      "}\n";
    const out = addValueObjects(extended, CONTRACT, [{ name: "Currency", base: "string" }]);
    expect(out.source).toBe(extended);
    expect(out.unchanged).toEqual(["Currency"]);
  });

  test("upgrades a bare alias in place — the primitiveAlias violation, fixed", () => {
    const out = addValueObjects(
      "export type Isbn = string;\n\nexport interface Book { isbn: Isbn }\n",
      CONTRACT,
      [{ name: "Isbn", base: "string" }],
    );
    expect(out.source).toBe(ISBN + "\n\nexport interface Book { isbn: Isbn }\n");
    expect(out.upgraded).toEqual(["Isbn"]);
    expect(out.added).toEqual([]);
  });

  test("upgrades a branded alias in place — this generator's own old output", () => {
    const out = addValueObjects(
      'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
        "\nexport interface Book { isbn: Isbn }\n",
      CONTRACT,
      [{ name: "Isbn", base: "string" }],
    );
    expect(out.source).toBe(ISBN + "\n\nexport interface Book { isbn: Isbn }\n");
    expect(out.upgraded).toEqual(["Isbn"]);
    // Upgraded, not duplicated: exactly one declaration of the name survives.
    expect(out.source.match(/Isbn =/g)).toBe(null);
    expect(out.source.match(/class Isbn/g)).toHaveLength(1);
  });

  test("an upgrade keeps a doc comment the architect already wrote", () => {
    const out = addValueObjects(
      "/** ISBN-13: exactly thirteen digits. */\nexport type Isbn = string;\n",
      CONTRACT,
      [{ name: "Isbn", base: "string" }],
    );
    expect(out.source).toBe(
      "/** ISBN-13: exactly thirteen digits. */\n" +
        ISBN.split("\n").slice(1).join("\n") +
        "\n",
    );
    expect(out.source).not.toContain("state what makes it valid");
  });

  test("exports an unexported alias while upgrading it", () => {
    const out = addValueObjects("type Isbn = string;\n", CONTRACT, [
      { name: "Isbn", base: "string" },
    ]);
    expect(out.source).toBe(ISBN + "\n");
  });

  test("refuses to clobber a name that is already something else", () => {
    expect(() =>
      addValueObjects("export interface Isbn { value: string }\n", CONTRACT, [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/'Isbn' is already declared/);
  });

  test("refuses a class that is not a value object — no brand, not ours to overwrite", () => {
    expect(() =>
      addValueObjects("export declare class Isbn { readonly value: string; }\n", CONTRACT, [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/already declared .* as a class without the private brand/);
  });

  test("refuses to rebase an existing value object", () => {
    expect(() =>
      addValueObjects('export type Isbn = number & { readonly __brand: "Isbn" };\n', CONTRACT, [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/already a value object over 'number'/);
    expect(() =>
      addValueObjects("export type Isbn = number;\n", CONTRACT, [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/already an alias for 'number'/);
  });

  test("refuses a path that is not a contract", () => {
    expect(() =>
      addValueObjects("export interface Book {}\n", "src/reading-list/book.ts", [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/not a \*\.contract\.ts path/);
  });

  // The round trip that matters: what this writes must satisfy the gate that
  // sent the architect here.
  test("everything it generates passes contract-purity", async () => {
    const out = addValueObjects(
      'import type { Money } from "../shared/money.contract.js";\n' +
        "\nexport interface Book { readonly price: Money }\n",
      CONTRACT,
      [
        { name: "Isbn", base: "string" },
        { name: "PagesRead", base: "number" },
      ],
    );
    expect(await lintContractSource(out.source, CONTRACT)).toEqual([]);
  });
});

// --- argv -------------------------------------------------------------------------

describe("parseArgv", () => {
  test("names and bases", () => {
    expect(parseArgv([CONTRACT, "Isbn", "PagesRead=number"])).toEqual({
      contractPath: CONTRACT,
      specs: [
        { name: "Isbn", base: "string" },
        { name: "PagesRead", base: "number" },
      ],
      retired: [],
    });
  });

  test("--parse is accepted and ignored — static parse is part of the shape now", () => {
    const out = parseArgv([CONTRACT, "Isbn", "--parse"]);
    expect(out.specs).toEqual([{ name: "Isbn", base: "string" }]);
    expect(out.retired).toEqual(["--parse"]);
  });
});

// --- CLI ------------------------------------------------------------------------

const SCRIPT = join(import.meta.dirname, "new-value-object.ts");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixture(prefix: string, source: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  const path = join(dir, "book.contract.ts");
  writeFileSync(path, source);
  return { dir, path };
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

describe("new-value-object CLI", () => {
  test("writes the declarations and logs a pass", () => {
    const { dir, path } = fixture("vo-ok-", "export interface Book { isbn: string }\n");
    const r = runCli(dir, [path, "Isbn=string", "PagesRead=number"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/new-value-object: declared Isbn, PagesRead in/);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("export declare class Isbn {");
    expect(written).toContain('private readonly __brand: "PagesRead";');
    expect(written).toContain("readonly value: number;");
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "new-value-object", verdict: "pass" });
  });

  test("--parse still works, and says why it no longer does anything", () => {
    const { dir, path } = fixture("vo-parse-", "export interface Book { isbn: string }\n");
    const r = runCli(dir, [path, "Isbn", "--parse"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ignoring --parse/);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("static parse(raw: unknown): Isbn | undefined;");
    expect(written).not.toContain("export declare function parseIsbn");
  });

  test("upgrades an old branded alias on disk, without duplicating it", () => {
    const { dir, path } = fixture(
      "vo-upgrade-",
      'export type Isbn = string & { readonly __brand: "Isbn" };\n',
    );
    const r = runCli(dir, [path, "Isbn"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/upgraded Isbn/);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("export declare class Isbn {");
    expect(written).not.toContain("export type Isbn");
  });

  test("re-running changes nothing (safe to repeat)", () => {
    const { dir, path } = fixture("vo-idem-", "export interface Book { isbn: string }\n");
    runCli(dir, [path, "Isbn"]);
    const first = readFileSync(path, "utf8");
    const r = runCli(dir, [path, "Isbn"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already declared/);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("exit 1 and a block event when it refuses", () => {
    const { dir, path } = fixture("vo-bad-", "export interface Isbn { value: string }\n");
    const r = runCli(dir, [path, "Isbn"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/'Isbn' is already declared/);
    expect(readGuardLog(dir)[0]).toMatchObject({ guard: "new-value-object", verdict: "block" });
  });

  test("exit 2 on usage error", () => {
    const { dir } = fixture("vo-usage-", "export interface Book {}\n");
    const r = runCli(dir, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: node new-value-object\.ts/);
  });

  test("runs when invoked through a symlink (the ~/.pi/agent case)", () => {
    const { dir, path } = fixture("vo-symlink-", "export interface Book { isbn: string }\n");
    const link = join(dir, "new-value-object.link.ts");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link, path, "Isbn"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("__brand");
  });
});
