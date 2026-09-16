import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The blessed web stack is exact-pinned by the pack (ADR 2026-029, TN-26-006),
// and there are two places a version can be written down: the harness's own
// package.json, which is what the generator's emitted tree is compiled against,
// and `packs/ts-web/contrib.json`, which is the record deliver will read when
// Phase C wires it. Two copies of a version number drift — silently, and in the
// worst possible way, because the emitted app would then be verified against a
// version no delivered project runs.
//
// So they are one source of truth held together by this file rather than by
// indirection. Bumping a pin means editing both and watching this pass.

const root = join(import.meta.dirname, "..", "..");

interface Pins {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

function contribPins(): Pins {
  const parsed: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "contrib.json"), "utf8"),
  );
  const pins = (parsed as { pins?: Pins }).pins;
  if (pins === undefined) throw new Error("packs/ts-web/contrib.json has no `pins`");
  return pins;
}

function harnessDevDependencies(): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return (parsed as { devDependencies?: Record<string, string> }).devDependencies ?? {};
}

describe("the ts-web pins", () => {
  const pins = contribPins();
  const installed = harnessDevDependencies();
  const all = { ...pins.dependencies, ...pins.devDependencies };

  test("name the whole blessed web stack", () => {
    for (const name of [
      "react",
      "react-dom",
      "@types/react",
      "@types/react-dom",
      "vite",
      "@vitejs/plugin-react",
      "tailwindcss",
      "@tailwindcss/vite",
      "@tanstack/react-query",
      "@trpc/client",
    ]) {
      expect(all[name], `${name} is not pinned`).toBeDefined();
    }
  });

  test("are exact — a range is a different app on a different day", () => {
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });

  test("match the versions the harness itself runs", () => {
    const drifted = Object.entries(all)
      .filter(([name, version]) => installed[name] !== version)
      .map(([name, version]) => `${name}: contrib.json ${version}, package.json ${installed[name]}`);
    expect(drifted).toEqual([]);
  });

  // A target's runtime bundle needs the first group; only the build needs the
  // second. Getting this backwards ships a bundler into production or leaves
  // React out of it.
  test("split runtime dependencies from build-time ones", () => {
    expect(Object.keys(pins.dependencies)).toContain("react");
    expect(Object.keys(pins.dependencies)).toContain("@trpc/client");
    expect(Object.keys(pins.devDependencies)).toContain("vite");
    expect(Object.keys(pins.devDependencies)).toContain("@types/react");
    // Nothing is in both.
    const both = Object.keys(pins.dependencies).filter((n) => n in pins.devDependencies);
    expect(both).toEqual([]);
  });

  // The client is the frontend half of a wire whose server half the ts pack
  // pins. Two tRPC majors in one project is a typed client that is not typed.
  test("@trpc/client matches the @trpc/server the ts pack ships against", () => {
    expect(all["@trpc/client"]).toBe(installed["@trpc/server"]);
  });
});
