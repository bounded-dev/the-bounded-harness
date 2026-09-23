import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { composedPacks } from "./installed.ts";
import { selectPacks } from "./compose.ts";
import { deliverChecks } from "./ts/pack.ts";
import { runWebObligation } from "./ts-web/scripts/web-obligation.ts";
import { runServiceCheck } from "./ts-service/service-check.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "obligations-"));
  dirs.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}
const WEB = {
  "src/ui/main.tsx": 'import "./app.js";',
  "src/ui/app.tsx": 'export { Page } from "./pages/page.js";',
  "src/ui/pages/page.tsx": 'import "../../domain/domain.js"; export const Page = 1;',
  "src/domain/domain.ts": "export const domain = 1;",
  "src/domain/domain.contract.ts": "export declare const domain: number;",
};
const SERVICE = {
  "src/api/api.contract.ts": 'import type { serviceRouter } from "./api.js"; export type ServiceRouter = typeof serviceRouter;',
  "src/api/api.ts": 'const service = { router: (value: object) => value }; export const serviceRouter = service.router({}); export type * from "./api.contract.js";',
};
const CLIENT = 'import { createTRPCClient } from "@trpc/client"; import type { ServiceRouter } from "../../../api/api.js"; export const client = createTRPCClient<ServiceRouter>({});';

describe("explicit per-project selection", () => {
  test("missing, malformed, unknown, empty and incomplete dependency selections fail closed", () => {
    const cwd = project();
    expect(() => composedPacks(cwd)).toThrow(/bounded compose/);
    for (const value of ['{}', '[]', '["unknown"]', '["ts-web"]', '["ts","ts"]']) {
      mkdirSync(join(cwd, ".bounded"), { recursive: true });
      writeFileSync(join(cwd, ".bounded/composed-packs.json"), value);
      expect(() => composedPacks(cwd)).toThrow();
    }
  });
  test("selection changes in one process and never leaks between projects", () => {
    const domain = project(); const web = project();
    selectPacks(domain, ["ts"]); selectPacks(web, ["ts", "ts-web"]);
    expect(composedPacks(domain).read(deliverChecks)).toEqual([]);
    expect(composedPacks(web).read(deliverChecks).map((check) => check.name)).toContain("web-obligation");
    selectPacks(web, ["ts", "ts-service"]);
    expect(composedPacks(web).read(deliverChecks).map((check) => check.name)).toEqual(["service-obligation"]);
    expect(composedPacks(domain).read(deliverChecks)).toEqual([]);
  });
});

describe("UI obligation", () => {
  test("missing UI, orphan kit, comments, type-only and disconnected pages cannot satisfy wiring", () => {
    expect(runWebObligation(project()).verdict).toBe("block");
    for (const source of ['export const App = 1;', '// import "./pages/page.js";', 'import type { Page } from "./pages/page.js";']) {
      expect(runWebObligation(project({ ...WEB, "src/ui/app.tsx": source })).verdict).toBe("block");
    }
  });
  test("a connected local UI is valid without a service", () => {
    expect(runWebObligation(project(WEB)).verdict).toBe("pass");
  });
});

describe("service and pair obligations", () => {
  test("service alone must exist, but requires no client", () => {
    expect(runServiceCheck(project(), ["ts", "ts-service"]).verdict).toBe("block");
    expect(runServiceCheck(project(SERVICE), ["ts", "ts-service"]).verdict).toBe("pass");
    expect(runServiceCheck(project({ ...SERVICE, "src/api/api.contract.ts": 'export type ServiceRouter = any;' }), ["ts-service"]).verdict).toBe("block");
  });
  test("UI + service requires this router, a real client call and runtime reachability", () => {
    const pair = ["ts", "ts-web", "ts-service"];
    expect(runServiceCheck(project({ ...WEB, ...SERVICE }), pair).verdict).toBe("block");
    const files = { ...WEB, ...SERVICE, "src/ui/shared/api/client.tsx": CLIENT };
    expect(runServiceCheck(project(files), pair).verdict).toBe("block");
    const connected = { ...files, "src/ui/app.tsx": WEB["src/ui/app.tsx"] + ' import "./shared/api/client.js";' };
    expect(runServiceCheck(project(connected), pair).verdict).toBe("pass");
    for (const client of [CLIENT.replace('ServiceRouter>(', 'any>('), '// ' + CLIENT, CLIENT.replace('../../../api/api.js', '../../../other/api.js')]) {
      expect(runServiceCheck(project({ ...connected, "src/ui/shared/api/client.tsx": client }), pair).verdict).toBe("block");
    }
  });
});
