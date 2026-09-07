import { describe, expect, test } from "vitest";
import { formatDuration, formatPhaseDurations, phaseDurations, type PhaseName } from "./phase-durations.ts";
import type { GuardVerdict, LoggedGuardEvent } from "./guard-log.ts";

// WHY THIS EXISTS
//
// Every gate already stamps itself into the guard log, so a run's shape —
// which phase cost the minutes, how often it bounced and to whom — has been
// recorded since the log existed and was never read back. "Measure before
// optimizing further" (issue #13) needs that read-back, and it needs it to
// come from logged data rather than anyone's memory of the session.
//
// The interesting part is not the arithmetic; it is the edges. A contract
// revised mid-loop freezes twice. A run that dies in TEST never has a BUILD.
// A composite gate and its failing step both log a block, so counting blocks
// naively counts one hand-back twice. Each of those has a decided answer in
// the module header, and each has a test here that fails if the answer
// silently changes.

const T0 = Date.parse("2026-03-01T09:00:00.000Z");

/** An event `minutes` into the run. Timestamps are the only thing spans read. */
function at(
  minutes: number,
  guard: string,
  verdict: GuardVerdict,
  summary = "",
  detail?: Record<string, unknown>,
): LoggedGuardEvent {
  return {
    ts: new Date(T0 + minutes * 60_000).toISOString(),
    guard,
    verdict,
    summary,
    ...(detail !== undefined ? { detail } : {}),
  };
}

const FREEZE = "wrote manifest (1 contract file)";
const minutes = (n: number): number => n * 60_000;

function phase(events: readonly LoggedGuardEvent[], name: PhaseName) {
  const found = phaseDurations(events).phases.find((p) => p.phase === name);
  if (found === undefined) throw new Error(`no ${name} phase in the summary`);
  return found;
}

/** A complete run: design bounced once, test once, build once. */
const FULL_RUN: readonly LoggedGuardEvent[] = [
  at(0, "contract-purity", "pass", "OK (1 file)"),
  at(2, "contract-purity", "block", "1 problem in 1 file"),
  at(2, "design-gate", "block", "contract-purity blocked (route: architect)", { route: "architect" }),
  at(4, "checksum-gate", "pass", FREEZE),
  at(4, "design-gate", "pass", "OK (contract-purity → scaffold → typecheck → freeze, 3.1s)"),
  at(12, "red-gate", "block", "2 wrong-reason failures (route: test-writer)", { route: "test-writer" }),
  at(20, "red-gate", "pass", "RED OK (5 NotImplemented failures, 0 passed)"),
  at(35, "green-gate", "block", "1 failing test (route: builder)", { route: "builder" }),
  at(48, "green-gate", "pass", "GREEN (5/5 passed, typecheck clean)"),
  at(50, "sign-off", "pass", "signed off (0 findings)"),
  at(52, "deliver", "pass", "OK — 6 steps applied"),
];

describe("phase spans", () => {
  test("a complete run: each phase spans its own markers, not the whole log", () => {
    const d = phaseDurations(FULL_RUN);
    expect(d.phases.map((p) => [p.phase, p.ms])).toEqual([
      ["design", minutes(4)], // first event → the freeze
      ["tests", minutes(16)], // the freeze → the first red pass
      ["build", minutes(28)], // the red pass → the first green pass
      ["wrap", minutes(4)], // the green pass → the last sign-off/deliver
    ]);
    expect(d.totalMs).toBe(minutes(52));
    expect(d.phases.every((p) => p.incomplete === undefined)).toBe(true);
  });

  test("the two freezes a composite logs collapse to one boundary", () => {
    // design-gate's final step IS the checksum write, so both fire. Taking the
    // later one must not push DESIGN past the freeze into TEST's minutes.
    const d = phaseDurations(FULL_RUN);
    expect(d.phases[0]!.endedAt).toBe(new Date(T0 + minutes(4)).toISOString());
  });

  test("a design-gate pass alone is a freeze (a pack may log only the composite)", () => {
    const p = phase(
      [at(0, "contract-purity", "pass"), at(6, "design-gate", "pass", "OK (…)"), at(9, "red-gate", "pass", "RED OK")],
      "design",
    );
    expect(p.ms).toBe(minutes(6));
  });

  test("a checksum-gate VERIFY is not a freeze — check_drift may run at any time", () => {
    // "OK (1 contract file, no drift)" is the verify wording; only "wrote
    // manifest" ends DESIGN. Mistaking the two would end DESIGN wherever the
    // architect last checked for drift.
    const events = [
      at(0, "contract-purity", "pass"),
      at(3, "checksum-gate", "pass", "OK (1 contract file, no drift)"),
      at(7, "checksum-gate", "pass", FREEZE),
      at(11, "red-gate", "pass", "RED OK"),
    ];
    expect(phase(events, "design").ms).toBe(minutes(7));
  });

  test("total is the log's span, not the sum of the phases", () => {
    // They agree on a complete run and diverge when a phase never completed —
    // which is the point: the divergence is the signal.
    const d = phaseDurations(FULL_RUN);
    const sum = d.phases.reduce((n, p) => n + (p.ms ?? 0), 0);
    expect(sum).toBe(d.totalMs);
  });
});

describe("a contract revised mid-loop (ADR 2026-019's re-run path)", () => {
  // Revising means the design was not finished at the first freeze, so those
  // minutes are design minutes. But a freeze AFTER the red pass belongs to a
  // loop already in flight; stretching DESIGN over it would double-count TEST
  // and BUILD's wall clock.
  const REVISED: readonly LoggedGuardEvent[] = [
    at(0, "contract-purity", "pass"),
    at(3, "checksum-gate", "pass", FREEZE), // first freeze
    at(9, "checksum-gate", "pass", "wrote manifest (2 contract files)"), // re-freeze after revision
    at(15, "red-gate", "pass", "RED OK"),
    at(30, "checksum-gate", "pass", "wrote manifest (2 contract files)"), // revision mid-BUILD
    at(40, "green-gate", "pass", "GREEN"),
  ];

  test("DESIGN extends to the LAST freeze before the first red pass", () => {
    expect(phase(REVISED, "design").ms).toBe(minutes(9));
  });

  test("a freeze after the red pass does not extend DESIGN over TEST and BUILD", () => {
    const d = phaseDurations(REVISED);
    expect(d.phases[1]!.ms).toBe(minutes(6)); // tests: 9 → 15
    expect(d.phases[2]!.ms).toBe(minutes(25)); // build: 15 → 40
  });

  test("with no red pass at all, DESIGN ends at the last freeze in the log", () => {
    const events = [at(0, "contract-purity", "pass"), at(3, "checksum-gate", "pass", FREEZE), at(11, "checksum-gate", "pass", FREEZE)];
    expect(phase(events, "design").ms).toBe(minutes(11));
  });
});

describe("phases that never completed", () => {
  const DIED_IN_TEST: readonly LoggedGuardEvent[] = [
    at(0, "contract-purity", "pass"),
    at(5, "checksum-gate", "pass", FREEZE),
    at(15, "red-gate", "pass", "RED OK"),
  ];

  test("report undefined, never zero — nothing is known, and 0 would be a claim", () => {
    const d = phaseDurations(DIED_IN_TEST);
    expect(d.phases[0]!.ms).toBe(minutes(5));
    expect(d.phases[1]!.ms).toBe(minutes(10));
    expect(d.phases[2]!.ms).toBeUndefined();
    expect(d.phases[3]!.ms).toBeUndefined();
  });

  test("name the earliest missing marker, so the report says which step never ran", () => {
    const d = phaseDurations(DIED_IN_TEST);
    expect(d.phases[2]!.incomplete).toContain("green_gate");
    expect(d.phases[3]!.incomplete).toContain("green_gate"); // not "sign_off" — green is missing first
  });

  test("no freeze at all leaves DESIGN and TESTS unmeasurable", () => {
    const d = phaseDurations([at(0, "contract-purity", "pass"), at(4, "contract-purity", "pass")]);
    expect(d.phases[0]!.incomplete).toContain("freeze");
    expect(d.phases[1]!.incomplete).toContain("freeze");
    expect(d.totalMs).toBe(minutes(4)); // the log's span is still measurable
  });

  test("BUILD is still measured when its own markers exist but the freeze is missing", () => {
    // red → green needs no freeze; refusing to measure it would throw away a
    // real number because a different phase's marker was absent.
    const events = [at(0, "red-gate", "pass", "RED OK"), at(21, "green-gate", "pass", "GREEN")];
    expect(phase(events, "build").ms).toBe(minutes(21));
  });
});

describe("bounces", () => {
  test("a bounce is a block that names a route, counted into its own phase", () => {
    const d = phaseDurations(FULL_RUN);
    expect(d.phases.map((p) => [p.phase, p.bounces, p.byRoute])).toEqual([
      ["design", 1, [{ route: "architect", count: 1 }]],
      ["tests", 1, [{ route: "test-writer", count: 1 }]],
      ["build", 1, [{ route: "builder", count: 1 }]],
      ["wrap", 0, []],
    ]);
    expect(d.bounces).toBe(3);
  });

  test("a composite and its failing step are ONE hand-back, not two", () => {
    // design-gate logs a block AND its contract-purity step logs one. Counting
    // every block would report two bounces for one round trip.
    const d = phaseDurations(FULL_RUN);
    expect(d.phases[0]!.bounces).toBe(1);
    expect(d.phases[0]!.unroutedBlocks).toBe(1); // the inner contract-purity block, still visible
  });

  test("several bounces to the same role aggregate, most-bounced role first", () => {
    const events = [
      at(0, "contract-purity", "pass"),
      at(2, "checksum-gate", "pass", FREEZE),
      at(4, "red-gate", "pass", "RED OK"),
      at(9, "green-gate", "block", "1 failing test", { route: "builder" }),
      at(14, "green-gate", "block", "1 failing test", { route: "builder" }),
      at(19, "green-gate", "block", "the same test has failed twice", { route: "test-writer" }),
      at(25, "green-gate", "pass", "GREEN"),
    ];
    const build = phase(events, "build");
    expect(build.bounces).toBe(3);
    expect(build.byRoute).toEqual([
      { route: "builder", count: 2 },
      { route: "test-writer", count: 1 },
    ]);
  });

  test("a path-gate denial is not a bounce — it refuses a call, it hands back nothing", () => {
    const events = [
      at(0, "contract-purity", "pass"),
      at(1, "path-gate", "block", "builder may not write tests/x.test.ts", { role: "builder", tool: "write" }),
      at(3, "checksum-gate", "pass", FREEZE),
      at(6, "red-gate", "pass", "RED OK"),
    ];
    const design = phase(events, "design");
    expect(design.bounces).toBe(0);
    expect(design.unroutedBlocks).toBe(1);
  });

  test("blocks in a stretch no markers delimit are unattributed, not guessed onto a phase", () => {
    // No freeze, so nothing separates DESIGN from TESTS. Putting these blocks
    // on DESIGN's line would invent an attribution the log does not support.
    const events = [
      at(0, "contract-purity", "pass"),
      at(2, "red-gate", "block", "wrong-reason red", { route: "test-writer" }),
      at(5, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.unattributedBlocks).toBe(1);
    expect(d.phases.every((p) => p.bounces === 0)).toBe(true);
    expect(d.bounces).toBe(1); // still counted in the run total
  });

  test("WRAP owns blocks logged after the last sign-off/deliver event", () => {
    const events = [...FULL_RUN, at(60, "green-gate", "block", "1 failing test", { route: "builder" })];
    expect(phase(events, "wrap").bounces).toBe(1);
    expect(phase(events, "wrap").ms).toBe(minutes(4)); // the measured span is unchanged
  });
});

describe("corrupt, empty and out-of-order logs", () => {
  test("an empty log is unavailable, and says why rather than reporting zeros", () => {
    const d = phaseDurations([]);
    expect(d.unavailable).toMatch(/empty or absent/);
    expect(d.totalMs).toBeUndefined();
    expect(d.phases.every((p) => p.ms === undefined)).toBe(true);
  });

  test("events with no usable timestamp are dropped and counted, not crashed on", () => {
    const events = [
      { guard: "contract-purity", verdict: "pass", summary: "OK" } as unknown as LoggedGuardEvent,
      at(0, "contract-purity", "pass"),
      { ts: "not-a-date", guard: "scaffold", verdict: "pass", summary: "" } as LoggedGuardEvent,
      at(4, "checksum-gate", "pass", FREEZE),
    ];
    const d = phaseDurations(events);
    expect(d.skipped).toBe(2);
    expect(d.events).toBe(2);
    expect(d.phases[0]!.ms).toBe(minutes(4));
  });

  test("a log of only corrupt events is unavailable, and blames the corruption", () => {
    const d = phaseDurations([{ ts: "nope", guard: "x", verdict: "pass", summary: "" } as LoggedGuardEvent]);
    expect(d.unavailable).toMatch(/corrupt/);
    expect(d.skipped).toBe(1);
  });

  test("a clock that went backwards clamps to 0 rather than reporting a negative span", () => {
    // Append order sequences the run; the timestamp only measures it. A
    // negative duration is not a fact about the run.
    const events = [at(10, "contract-purity", "pass"), at(4, "checksum-gate", "pass", FREEZE)];
    expect(phase(events, "design").ms).toBe(0);
  });

  test("markers are found in append order, not by sorting timestamps", () => {
    // The second freeze is stamped EARLIER than the first but appended later;
    // append order is the causal truth, so it is the one that ends DESIGN.
    const events = [
      at(0, "contract-purity", "pass"),
      at(12, "checksum-gate", "pass", FREEZE),
      at(8, "checksum-gate", "pass", FREEZE),
      at(20, "red-gate", "pass", "RED OK"),
    ];
    const d = phaseDurations(events);
    expect(d.phases[0]!.endedAt).toBe(new Date(T0 + minutes(8)).toISOString());
    expect(d.phases[1]!.ms).toBe(minutes(12)); // 8 → 20
  });
});

describe("formatDuration", () => {
  test("one shape per magnitude, zero-padded so the column stays aligned", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(minutes(4) + 12_000)).toBe("4m12s");
    expect(formatDuration(minutes(4) + 2_000)).toBe("4m02s");
    expect(formatDuration(minutes(64) + 12_000)).toBe("1h04m12s");
  });
});

describe("formatPhaseDurations", () => {
  test("headline plus one greppable line per phase, then a total", () => {
    const lines = formatPhaseDurations(phaseDurations(FULL_RUN));
    expect(lines[0]).toBe("where the minutes went (11 guard events, taken as one run)");
    expect(lines.slice(1)).toEqual([
      "  timing: design    4m00s  (1 bounce: 1 → architect; 1 unrouted block)",
      "  timing: tests    16m00s  (1 bounce: 1 → test-writer)",
      "  timing: build    28m00s  (1 bounce: 1 → builder)",
      "  timing: wrap      4m00s",
      "  timing: total    52m00s",
    ]);
  });

  test("an incomplete phase shows an em dash and the marker that never fired", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        at(5, "checksum-gate", "pass", FREEZE),
        at(15, "red-gate", "pass", "RED OK"),
      ]),
    );
    expect(lines).toContain("  timing: build         —  (incomplete: no green_gate pass)");
    expect(lines.at(-1)).toBe("  timing: total    15m00s  (log span; the phases above do not sum to it)");
  });

  test("unattributed blocks get their own line rather than being silently dropped", () => {
    const lines = formatPhaseDurations(
      phaseDurations([
        at(0, "contract-purity", "pass"),
        at(2, "red-gate", "block", "wrong-reason red", { route: "test-writer" }),
        at(5, "red-gate", "pass", "RED OK"),
      ]),
    );
    expect(lines).toContain("  timing: 1 block outside any measurable phase");
  });

  test("an unavailable summary degrades to one line saying why", () => {
    expect(formatPhaseDurations(phaseDurations([]))).toEqual([
      "unavailable — the guard log is empty or absent (PI_GUARD_LOG=off, or no gate ran here)",
    ]);
  });

  test("unreadable events are declared in the headline, not hidden", () => {
    const lines = formatPhaseDurations(
      phaseDurations([at(0, "contract-purity", "pass"), { ts: "nope", guard: "x", verdict: "pass", summary: "" } as LoggedGuardEvent]),
    );
    expect(lines[0]).toBe("where the minutes went (1 guard event, 1 unreadable, taken as one run)");
  });
});
