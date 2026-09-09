import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import installAmbientPathGate from "../extensions/path-gate.ts";
import installArchitectPathGate from "../extensions/path-gate/architect.ts";
import installBuilderPathGate from "../extensions/path-gate/builder.ts";
import { readGuardLog, RUN_START_GUARD } from "./guard-log.ts";
import { makeRunStartRecorder, resetPathGateRegistry } from "./path-gate.ts";
import { phaseDurations } from "./phase-durations.ts";
import type { Role } from "./path-policy.ts";

// THE MEASUREMENT THIS EXISTS FOR (dogfood r15, both arms)
//
// A provider outage sat between the session opening and the prompt actually
// landing — about fourteen minutes in which nothing was asked of the model.
// The timing block billed all of it to DESIGN: 55m and 80m reported for
// phases that really took ~33m and ~58m, and nothing in the output said the
// clock had started before the run did.
//
// The first event in the log is the path gate's session-start tool strip,
// stamped when the session opened. The gate is also the component that sees
// the first moment the session does work — the first tool call it evaluates —
// so it stamps a `run-start` event there, and the analysis starts its clock at
// that marker instead of at whatever happened to be logged first.

/** Minimal ExtensionAPI stub: enough to install the gate and fire tool calls. */
interface FakePi {
  readonly pi: unknown;
  /** Fire a tool_call as the host does. */
  call(cwd: string, toolName: string, input?: Record<string, unknown>): Promise<unknown>;
}

function fakePi(): FakePi {
  const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "tool_call") handlers.push(handler);
    },
    getActiveTools: (): string[] => [],
    setActiveTools() {},
  };
  return {
    pi,
    async call(cwd, toolName, input = {}) {
      let last: unknown;
      for (const h of handlers) last = await h({ type: "tool_call", toolName, input }, { cwd });
      return last;
    },
  };
}

const dirs: string[] = [];
function project(role?: Role): string {
  const dir = mkdtempSync(join(tmpdir(), "path-gate-run-start-"));
  dirs.push(dir);
  if (role !== undefined) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "dev-stage-role"), `${role}\n`);
  }
  return dir;
}

const runStarts = (cwd: string) => readGuardLog(cwd).filter((e) => e.guard === RUN_START_GUARD);

beforeEach(() => {
  resetPathGateRegistry();
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("the run-start marker", () => {
  test("the first gated tool call stamps one, naming the role and the tool", () => {
    const cwd = project();
    const fake = fakePi();
    installArchitectPathGate(fake.pi as never);
    return fake.call(cwd, "read", { path: "spec.md" }).then(() => {
      const events = runStarts(cwd);
      expect(events).toHaveLength(1);
      expect(events[0]!.verdict).toBe("pass");
      expect(events[0]!.summary).toBe("first gated tool call (architect: read)");
      expect(events[0]!.detail).toMatchObject({ kind: "run-start", role: "architect", tool: "read" });
    });
  });

  test("once per session, however many calls follow", async () => {
    const cwd = project();
    const fake = fakePi();
    installArchitectPathGate(fake.pi as never);
    for (const path of ["spec.md", "src/a.contract.ts", "spec.md"]) {
      await fake.call(cwd, "read", { path });
    }
    expect(runStarts(cwd)).toHaveLength(1);
  });

  test("a REFUSED first call still starts the run — the session was working", async () => {
    // The marker is about when the run began, not about whether it went well.
    const cwd = project();
    const fake = fakePi();
    installBuilderPathGate(fake.pi as never);
    const blocked = await fake.call(cwd, "write", { path: "tests/x.test.ts" });
    expect((blocked as { block?: boolean } | undefined)?.block).toBe(true);
    expect(runStarts(cwd)).toHaveLength(1);
  });

  test("a session with no role marks nothing — the gate is inactive, not silent", async () => {
    const cwd = project(); // no role file, no bound loader
    const fake = fakePi();
    installAmbientPathGate(fake.pi as never);
    await fake.call(cwd, "read", { path: "spec.md" });
    expect(runStarts(cwd)).toHaveLength(0);
  });

  test("the ambient hook marks a role bound through .pi/dev-stage-role", async () => {
    const cwd = project("architect");
    const fake = fakePi();
    installAmbientPathGate(fake.pi as never);
    await fake.call(cwd, "read", { path: "spec.md" });
    expect(runStarts(cwd)).toHaveLength(1);
  });

  test("two hooks in one subagent process still produce ONE marker", async () => {
    // A subagent loads its bound loader AND the ambient extension, which
    // stands down (dogfood Run 6). A marker from the stood-down hook would be
    // a second run-start for one session — and the analysis would take the
    // later of the two as the start of the run.
    const cwd = project("architect"); // the PARENT's role file, shared with the child
    const fake = fakePi();
    installBuilderPathGate(fake.pi as never);
    installAmbientPathGate(fake.pi as never);
    await fake.call(cwd, "write", { path: "src/money.ts" });
    const events = runStarts(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ role: "builder" }); // the bound role, not the parent's
  });

  test("the latch is per session, so a second session in the same project marks again", async () => {
    // Each pi process installs its own hook; a run-start per session is what
    // lets the analysis find the last restart before the run's first marker.
    const cwd = project();
    for (const _ of [1, 2]) {
      resetPathGateRegistry();
      const fake = fakePi();
      installArchitectPathGate(fake.pi as never);
      await fake.call(cwd, "read", { path: "spec.md" });
    }
    expect(runStarts(cwd)).toHaveLength(2);
  });

  test("the recorder writes once and then stops, whatever it is handed", () => {
    const cwd = project();
    const note = makeRunStartRecorder();
    note(cwd, "architect", "read");
    note(cwd, "architect", "grep");
    note(cwd, "builder", "write");
    expect(runStarts(cwd)).toHaveLength(1);
    expect(runStarts(cwd)[0]!.summary).toBe("first gated tool call (architect: read)");
  });

  // The whole point of the marker, end to end: the gate writes it and the
  // analysis reads it, so the two halves cannot drift apart on the spelling.
  test("the marker the gate writes is the one the clock starts from", async () => {
    const cwd = project();
    const fake = fakePi();
    installArchitectPathGate(fake.pi as never);
    await fake.call(cwd, "read", { path: "spec.md" });
    const d = phaseDurations(readGuardLog(cwd));
    expect(d.runStartedAt).toBe(runStarts(cwd)[0]!.ts);
  });
});
