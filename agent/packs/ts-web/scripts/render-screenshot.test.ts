import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  renderOutputPath,
  renderScreenshot,
  resolveRequestPath,
  RENDER_DIR,
  serveBuild,
  type CommandOutcome,
  type RunCommand,
} from "./render-screenshot.ts";

// The driver's eye (TN-26-006): advisory pixels, never a verdict.
//
// The contract this file pins is mostly about FAILURE. Every way this can go
// wrong — no frontend, a red build, no browser on the machine — must produce
// one honest line and exit 0, because a wrap step that can block a run is a
// gate, and visual quality does not get one.

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "render-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const OK: CommandOutcome = { code: 0, stdout: "", stderr: "" };
const FIXED_CLOCK = (): Date => new Date("2026-09-17T16:42:05.123Z");

interface FakeOptions {
  /** What `npx vite build` does (default: writes dist/index.html). */
  readonly build?: CommandOutcome;
  /** What `npx playwright screenshot` returns (default: writes the PNG). */
  readonly shot?: CommandOutcome;
  /** Should a "successful" screenshot actually produce the file? */
  readonly materialize?: boolean;
}

function fakeTools(options: FakeOptions = {}): { calls: string[][]; run: RunCommand } {
  const calls: string[][] = [];
  const run: RunCommand = async (command, args, cwd) => {
    calls.push([command, ...args]);
    if (args[0] === "vite") {
      const outcome = options.build ?? OK;
      if (outcome.code === 0) {
        mkdirSync(join(cwd, "dist"), { recursive: true });
        writeFileSync(join(cwd, "dist", "index.html"), "<!doctype html><title>built</title>\n");
        writeFileSync(join(cwd, "dist", "app.js"), "export const x = 1;\n");
      }
      return outcome;
    }
    const outcome = options.shot ?? OK;
    if (outcome.code === 0 && (options.materialize ?? true)) {
      const out = args[args.length - 1] ?? "";
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, "PNG");
    }
    return outcome;
  };
  return { calls, run };
}

// --- the pure parts ----------------------------------------------------------

describe("renderOutputPath", () => {
  test("is an ISO stamp with nothing in it a filesystem dislikes", () => {
    expect(renderOutputPath(new Date("2026-09-17T16:42:05.123Z"))).toBe(
      `${RENDER_DIR}/2026-09-17T16-42-05-123Z.png`,
    );
  });

  test("two renders a second apart do not collide", () => {
    const first = renderOutputPath(new Date("2026-09-17T16:42:05.000Z"));
    const second = renderOutputPath(new Date("2026-09-17T16:42:06.000Z"));
    expect(first).not.toBe(second);
  });
});

// `..` in a URL is the oldest bug in static file serving, and the only part of
// this script with a way to be quietly wrong.
describe("resolveRequestPath", () => {
  const dir = project({
    "dist/index.html": "<!doctype html>\n",
    "dist/assets/app.css": "body{}\n",
  });
  const root = join(dir, "dist");

  test("serves the file asked for", () => {
    expect(resolveRequestPath(root, "/assets/app.css")).toBe(join(root, "assets/app.css"));
    expect(resolveRequestPath(root, "/assets/app.css?v=2")).toBe(join(root, "assets/app.css"));
  });

  // Unknown paths fall back to index.html, the way every static host serves a
  // single-page app.
  test("an unknown path is the app's own route, not a 404", () => {
    expect(resolveRequestPath(root, "/dashboard/3")).toBe(join(root, "index.html"));
    expect(resolveRequestPath(root, "/?x=1#y")).toBe(join(root, "index.html"));
  });

  test("never hands back a path outside the build directory", () => {
    for (const url of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc", "../x"]) {
      const resolved = resolveRequestPath(root, url);
      expect(
        resolved === undefined || resolved.startsWith(root + sep),
        `${url} → ${String(resolved)}`,
      ).toBe(true);
    }
  });
});

// A built Vite app loads its JS as a module from an absolute path, and file://
// refuses module scripts cross-origin — so the screenshot needs a real origin.
describe("serveBuild", () => {
  test("serves the build over loopback, with the content types a browser needs", async () => {
    const dir = project({
      "dist/index.html": "<!doctype html><title>hi</title>\n",
      "dist/app.js": "export const x = 1;\n",
    });
    const served = await serveBuild(join(dir, "dist"));
    try {
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await fetch(served.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("<title>hi</title>");

      const script = await fetch(`${served.url}app.js`);
      expect(script.headers.get("content-type")).toContain("javascript");
    } finally {
      await served.close();
    }
  });
});

// --- the whole thing, with the tools faked -----------------------------------

describe("renderScreenshot", () => {
  test("builds, serves, shoots, and writes the PNG under .pi/render", async () => {
    const dir = project({ "index.html": "<!doctype html>\n" });
    const tools = fakeTools();
    const result = await renderScreenshot(dir, { run: tools.run, now: FIXED_CLOCK });

    expect(result.code).toBe(0);
    expect(result.artifact).toBe(`${RENDER_DIR}/2026-09-17T16-42-05-123Z.png`);
    expect(existsSync(join(dir, result.artifact ?? ""))).toBe(true);
    expect(tools.calls[0]).toEqual(["npx", "vite", "build"]);

    const shot = tools.calls[1] ?? [];
    expect(shot).toContain("playwright");
    expect(shot).toContain("--browser=chromium");
    // it photographs the SERVED build, not a file:// path
    expect(shot.some((a) => a.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  // Advisory means advisory. Every one of these is exit 0.
  test("a project with no index.html is unavailable, not an error", async () => {
    const result = await renderScreenshot(project(), { run: fakeTools().run });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("unavailable — no index.html");
  });

  test("a failing build is unavailable, with the tail and a zero exit", async () => {
    const dir = project({ "index.html": "<!doctype html>\n" });
    const result = await renderScreenshot(dir, {
      run: fakeTools({ build: { code: 1, stdout: "", stderr: "error: Could not resolve './app'" } })
        .run,
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("vite build` failed");
    expect(result.lines.join("\n")).toContain("Could not resolve");
    expect(result.artifact).toBeUndefined();
  });

  // The case the whole degrade path exists for: a machine with no browser in
  // its cache. It must say which of the three failures this was — the remedy
  // is the machine's, not the project's.
  test("a missing browser names itself and the install command", async () => {
    const dir = project({ "index.html": "<!doctype html>\n" });
    const result = await renderScreenshot(dir, {
      run: fakeTools({
        shot: {
          code: 1,
          stdout: "",
          stderr:
            "browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium",
        },
      }).run,
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("playwright or its chromium build is not available");
    expect(result.lines.join("\n")).toContain("npx playwright install chromium");
  });

  test("npx failing to find playwright at all degrades the same way", async () => {
    const dir = project({ "index.html": "<!doctype html>\n" });
    const result = await renderScreenshot(dir, {
      run: fakeTools({ shot: { code: 1, stdout: "", stderr: "npm ERR! could not determine executable to run" } }).run,
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("not available on this machine");
  });

  // A screenshot command that claims success and produces nothing is a failure,
  // and reporting a path to a file that is not there is the one outcome worse
  // than saying so.
  test("a silent no-op screenshot is still unavailable", async () => {
    const dir = project({ "index.html": "<!doctype html>\n" });
    const result = await renderScreenshot(dir, {
      run: fakeTools({ materialize: false }).run,
    });
    expect(result.code).toBe(0);
    expect(result.artifact).toBeUndefined();
    expect(result.lines.join("\n")).toContain("unavailable");
  });

  test("a target that is not a directory is misuse, and the only non-zero exit", async () => {
    const result = await renderScreenshot(join(tmpdir(), "no-such-project-xyz"), {
      run: fakeTools().run,
    });
    expect(result.code).toBe(2);
    expect(result.lines.join("\n")).toContain("is not a directory");
  });

  // The header of the emitted PNG is nobody's business here, but the line the
  // driver reads is: it must say the picture is evidence, not a verdict.
  test("the success line says the picture is evidence, not a gate", async () => {
    const dir = project({ "index.html": "<!doctype html>\n" });
    const result = await renderScreenshot(dir, { run: fakeTools().run, now: FIXED_CLOCK });
    expect(result.lines.join("\n")).toMatch(/no gate and never will/);
    expect(readFileSync(join(dir, result.artifact ?? ""), "utf8")).toBe("PNG");
  });
});
