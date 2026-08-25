import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";
import {
  ValueObjectError,
  addValueObjects,
  parseSpec,
  renderValueObject,
} from "./new-value-object.ts";
import { lintContractSource } from "./contract-purity.ts";
import { readGuardLog } from "../../../src/guard-log.ts";

const CONTRACT = "src/reading-list/book.contract.ts";

// --- spec parsing ---------------------------------------------------------------

describe("parseSpec", () => {
  test("Name=base, with string as the default base", () => {
    expect(parseSpec("Isbn=string")).toEqual({ name: "Isbn", base: "string" });
    expect(parseSpec("PagesRead=number")).toEqual({ name: "PagesRead", base: "number" });
    expect(parseSpec("Isbn")).toEqual({ name: "Isbn", base: "string" });
  });

  test("rejects a non-PascalCase name (type names are PascalCase)", () => {
    expect(() => parseSpec("isbn")).toThrow(ValueObjectError);
    expect(() => parseSpec("isbn")).toThrow(/PascalCase/);
  });

  test("rejects a base the value-object rule does not police", () => {
    expect(() => parseSpec("Active=boolean")).toThrow(/boolean/);
  });
});

// --- rendering ------------------------------------------------------------------

describe("renderValueObject", () => {
  test("the brand string always matches the type name (the typo that silently splits a type)", () => {
    expect(renderValueObject({ name: "Isbn", base: "string" })).toBe(
      'export type Isbn = string & { readonly __brand: "Isbn" };',
    );
    expect(renderValueObject({ name: "PagesRead", base: "number" })).toBe(
      'export type PagesRead = number & { readonly __brand: "PagesRead" };',
    );
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
        'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
        "\n" +
        "export interface Book { isbn: string; price: Money }\n",
    );
    expect(out.added).toEqual(["Isbn"]);
  });

  test("groups with the existing value objects when there are already some", () => {
    const out = addValueObjects(
      'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
        "\n" +
        "export interface Book { isbn: Isbn }\n",
      CONTRACT,
      [{ name: "AuthorName", base: "string" }],
    );
    expect(out.source).toBe(
      'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
        'export type AuthorName = string & { readonly __brand: "AuthorName" };\n' +
        "\n" +
        "export interface Book { isbn: Isbn }\n",
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
        'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
        "\n" +
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
    expect(out.source.split("\n").slice(0, 3)).toEqual([
      'export type Isbn = string & { readonly __brand: "Isbn" };',
      'export type AuthorName = string & { readonly __brand: "AuthorName" };',
      'export type PagesRead = number & { readonly __brand: "PagesRead" };',
    ]);
  });

  test("is idempotent: an already-branded value object is left alone", () => {
    const source =
      'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
      "\n" +
      "export interface Book { isbn: Isbn }\n";
    const out = addValueObjects(source, CONTRACT, [{ name: "Isbn", base: "string" }]);
    expect(out.source).toBe(source);
    expect(out.added).toEqual([]);
    expect(out.unchanged).toEqual(["Isbn"]);
  });

  test("upgrades a bare alias in place — the primitiveAlias violation, fixed", () => {
    const out = addValueObjects(
      "export type Isbn = string;\n\nexport interface Book { isbn: Isbn }\n",
      CONTRACT,
      [{ name: "Isbn", base: "string" }],
    );
    expect(out.source).toBe(
      'export type Isbn = string & { readonly __brand: "Isbn" };\n' +
        "\n" +
        "export interface Book { isbn: Isbn }\n",
    );
    expect(out.upgraded).toEqual(["Isbn"]);
    expect(out.added).toEqual([]);
  });

  test("exports an unexported alias while upgrading it", () => {
    const out = addValueObjects("type Isbn = string;\n", CONTRACT, [
      { name: "Isbn", base: "string" },
    ]);
    expect(out.source).toBe('export type Isbn = string & { readonly __brand: "Isbn" };\n');
  });

  test("refuses to clobber a name that is already something else", () => {
    expect(() =>
      addValueObjects("export interface Isbn { value: string }\n", CONTRACT, [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/'Isbn' is already declared/);
  });

  test("refuses to rebase an existing value object", () => {
    expect(() =>
      addValueObjects('export type Isbn = number & { readonly __brand: "Isbn" };\n', CONTRACT, [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/already a value object over 'number'/);
  });

  test("refuses a path that is not a contract", () => {
    expect(() =>
      addValueObjects("export interface Book {}\n", "src/reading-list/book.ts", [
        { name: "Isbn", base: "string" },
      ]),
    ).toThrow(/not a \*\.contract\.ts path/);
  });

  test("--parse adds the smart constructor: the rule's parse boundary, declared", () => {
    const out = addValueObjects("export interface Book { isbn: string }\n", CONTRACT, [
      { name: "Isbn", base: "string", parse: true },
    ]);
    expect(out.source).toContain(
      "export declare function parseIsbn(raw: string): Isbn | undefined;",
    );
  });

  test("--parse is idempotent too", () => {
    const once = addValueObjects("export interface Book { isbn: Isbn }\n", CONTRACT, [
      { name: "Isbn", base: "string", parse: true },
    ]);
    const twice = addValueObjects(once.source, CONTRACT, [
      { name: "Isbn", base: "string", parse: true },
    ]);
    expect(twice.source).toBe(once.source);
  });

  // The round trip that matters: what this writes must satisfy the gate that
  // sent the architect here.
  test("everything it generates passes contract-purity", async () => {
    const out = addValueObjects(
      'import type { Money } from "../shared/money.contract.js";\n' +
        "\nexport interface Book { readonly price: Money }\n",
      CONTRACT,
      [
        { name: "Isbn", base: "string", parse: true },
        { name: "PagesRead", base: "number", parse: true },
      ],
    );
    expect(await lintContractSource(out.source, CONTRACT)).toEqual([]);
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
    expect(readFileSync(path, "utf8")).toContain(
      'export type Isbn = string & { readonly __brand: "Isbn" };',
    );
    const events = readGuardLog(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ guard: "new-value-object", verdict: "pass" });
  });

  test("--parse declares the smart constructor as well", () => {
    const { dir, path } = fixture("vo-parse-", "export interface Book { isbn: string }\n");
    const r = runCli(dir, [path, "Isbn", "--parse"]);
    expect(r.status).toBe(0);
    expect(readFileSync(path, "utf8")).toContain(
      "export declare function parseIsbn(raw: string): Isbn | undefined;",
    );
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
