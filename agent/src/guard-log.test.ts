import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  GUARD_LOG_RELATIVE,
  guardLogPath,
  logGuardEvent,
  readGuardLog,
} from "./guard-log.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "guard-log-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env["PI_GUARD_LOG"];
});

describe("guard log (TN-26-001: a deterministic system that is opaque when it jams is just a deterministic jam)", () => {
  test("writes one JSON line per event, creating .pi/ in the target project", () => {
    const cwd = tmp();
    logGuardEvent(cwd, {
      guard: "contract-purity",
      verdict: "block",
      summary: "1 problem in 1 file",
      detail: { file: "src/x.contract.ts", ruleId: "pi-harness-ts/declaration-only" },
    });
    const raw = readFileSync(guardLogPath(cwd), "utf8");
    expect(GUARD_LOG_RELATIVE).toBe(".pi/guard-log.jsonl");
    const event = JSON.parse(raw.trim());
    expect(event.guard).toBe("contract-purity");
    expect(event.verdict).toBe("block");
    expect(event.summary).toBe("1 problem in 1 file");
    expect(event.detail.file).toBe("src/x.contract.ts");
    expect(typeof event.ts).toBe("string"); // ISO timestamp
  });

  test("appends across guards — the log is a timeline", () => {
    const cwd = tmp();
    logGuardEvent(cwd, { guard: "scaffold", verdict: "pass", summary: "wrote src/orders/orders.ts" });
    logGuardEvent(cwd, { guard: "contract-purity", verdict: "pass", summary: "OK (2 files)" });
    const events = readGuardLog(cwd);
    expect(events.map((e) => `${e.guard}:${e.verdict}`)).toEqual([
      "scaffold:pass",
      "contract-purity:pass",
    ]);
  });

  test("readGuardLog skips unparseable lines rather than dying", () => {
    const cwd = tmp();
    logGuardEvent(cwd, { guard: "scaffold", verdict: "pass", summary: "ok" });
    writeFileSync(guardLogPath(cwd), readFileSync(guardLogPath(cwd), "utf8") + "not json\n");
    expect(readGuardLog(cwd)).toHaveLength(1);
  });

  test("PI_GUARD_LOG=off opts out", () => {
    const cwd = tmp();
    process.env["PI_GUARD_LOG"] = "off";
    logGuardEvent(cwd, { guard: "scaffold", verdict: "pass", summary: "ok" });
    expect(readGuardLog(cwd)).toEqual([]);
  });

  test("logging never breaks the caller (unwritable path is swallowed)", () => {
    expect(() =>
      logGuardEvent("/proc/definitely-not-writable", {
        guard: "scaffold",
        verdict: "pass",
        summary: "ok",
      }),
    ).not.toThrow();
  });
});
