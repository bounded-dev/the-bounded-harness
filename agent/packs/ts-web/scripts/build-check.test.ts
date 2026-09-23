import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  BOOTSTRAP_RELATIVE,
  BUILD_COMMAND,
  CHECK_BUILD_SCRIPT,
  buildCheckScript,
  importSpecifiers,
  isWebTarget,
  resolvesToFile,
  runBuildCheck,
  unresolvedBootstrapImports,
} from "./build-check.ts";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temp tree from a { relativePath: contents } map. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-build-check-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** The generated bootstrap: mounts <App/> from ./app.js and pulls in ./app.css. */
const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./app.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
`;

describe("importSpecifiers", () => {
  test("extracts from-imports, bare imports, and dynamic imports", () => {
    const src = `import { A } from "./a.js";\nimport "./styles.css";\nconst m = await import("./lazy.js");\nimport X from "react";`;
    expect(importSpecifiers(src).sort()).toEqual(["./a.js", "./lazy.js", "./styles.css", "react"]);
  });
});

describe("resolvesToFile", () => {
  test("a .js specifier resolves to a .tsx source sibling", () => {
    const dir = tree({ "src/ui/app.tsx": "export const App = () => null;" });
    expect(resolvesToFile(join(dir, "src/ui"), "./app.js")).toBe(true);
  });

  test("a .js specifier with no source sibling does not resolve", () => {
    const dir = tree({ "src/ui/main.tsx": MAIN_TSX });
    expect(resolvesToFile(join(dir, "src/ui"), "./app.js")).toBe(false);
  });

  test("a non-code extension must exist verbatim", () => {
    const dir = tree({ "src/ui/app.css": "body{}" });
    expect(resolvesToFile(join(dir, "src/ui"), "./app.css")).toBe(true);
    expect(resolvesToFile(join(dir, "src/ui"), "./missing.css")).toBe(false);
  });

  test("an extensionless specifier resolves via a directory index", () => {
    const dir = tree({ "src/ui/shared/index.ts": "export {};" });
    expect(resolvesToFile(join(dir, "src/ui"), "./shared")).toBe(true);
  });
});

describe("isWebTarget", () => {
  test("true when the bootstrap exists, false otherwise", () => {
    expect(isWebTarget(tree({ [BOOTSTRAP_RELATIVE]: MAIN_TSX }))).toBe(true);
    expect(isWebTarget(tree({ "src/service/api.ts": "export {};" }))).toBe(false);
  });
});

describe("runBuildCheck", () => {
  // Keyed on the tree: a service delivered by a ts-web-composed harness has no
  // bootstrap and must pass with nothing to build.
  test("a non-web target passes with nothing to build", () => {
    const r = runBuildCheck(tree({ "src/service/api.ts": "export {};" }));
    expect(r.verdict).toBe("pass");
    expect(r.summary).toMatch(/not a web target/);
  });

  // The building case (Run 29 fixed): every bootstrap import resolves.
  test("a bootstrap whose imports all resolve passes", () => {
    const dir = tree({
      [BOOTSTRAP_RELATIVE]: MAIN_TSX,
      "src/ui/app.tsx": "export function App() { return null; }",
      "src/ui/app.css": "body{}",
    });
    const r = runBuildCheck(dir);
    expect(r.verdict).toBe("pass");
  });

  // The Run 29 Arm 1 shape exactly: main.tsx imports an app.tsx nobody wrote.
  test("a bootstrap importing a missing app module is BLOCKED, naming the import", () => {
    const dir = tree({
      [BOOTSTRAP_RELATIVE]: MAIN_TSX,
      "src/ui/app.css": "body{}",
      // no src/ui/app.tsx
    });
    expect(unresolvedBootstrapImports(dir)).toEqual(["./app.js"]);
    const r = runBuildCheck(dir);
    expect(r.verdict).toBe("block");
    expect(r.summary).toMatch(/cannot build/);
    expect((r.detail ?? []).join("\n")).toContain("./app.js");
  });
});

describe("buildCheckScript", () => {
  test("folds check:build → vite build for a web target only", () => {
    expect(buildCheckScript(tree({ [BOOTSTRAP_RELATIVE]: MAIN_TSX }))).toEqual({
      name: CHECK_BUILD_SCRIPT,
      command: BUILD_COMMAND,
    });
    expect(buildCheckScript(tree({ "src/service/api.ts": "export {};" }))).toBeUndefined();
  });
});
