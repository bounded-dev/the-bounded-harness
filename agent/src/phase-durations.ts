// Phase-duration telemetry (issue #13): where a run's minutes actually went.
//
// Every gate already timestamps itself into the guard log, so the shape of a
// run — how long DESIGN took, how many times TEST bounced, whether BUILD was
// the expensive part — is already recorded. It was simply never read back.
// "Measure before optimizing further" needs that read-back to exist, and it
// needs it to come from logged data rather than from anyone's recollection of
// the session.
//
// This module is the read-back: pure analysis over `readonly LoggedGuardEvent[]`,
// no I/O, no logging. It lives beside guard-log.ts rather than in packs/ts
// because a guard log is language-agnostic — a Python pack would emit the same
// event stream and deserve the same report. The caller supplies the events
// (`deliver` reads the target project's log and prints the block).
//
// ---------------------------------------------------------------------------
// The four phases and the markers that end them
// ---------------------------------------------------------------------------
//
// Phases are contiguous: each begins where the previous one ended, and each is
// closed by a marker that already exists in the log. The vocabulary is the
// phase gate's (`phase-gate.ts`) and green-gate's, deliberately — a second
// spelling of "the contract is frozen" would be a second, drifting definition
// of the DESIGN boundary.
//
//   DESIGN  first event                 → the freeze
//   TESTS   the freeze                   → the first `red-gate` pass
//   BUILD   the first `red-gate` pass    → the first `green-gate` pass after it
//   WRAP    the first `green-gate` pass  → the last `sign-off`/`deliver` event
//
// "The freeze" is a `checksum-gate` pass whose summary says it wrote the
// manifest, or a `design-gate` pass (ADR 2026-019's composite, whose final
// step IS that write). Both fire on a composite run, milliseconds apart; taking
// the LAST freeze collapses them to one boundary. A `checksum-gate` pass that
// merely VERIFIED ("no drift") is not a freeze and must not be mistaken for
// one — that is the `check_drift` tool, which the architect may run at any
// point in the run.
//
// ---------------------------------------------------------------------------
// Edge semantics — every one of these is a decision, not an accident
// ---------------------------------------------------------------------------
//
// * PHASES THAT NEVER COMPLETED report `ms: undefined`, never 0. A run that
//   died in TEST did not spend zero minutes building; nothing is known about
//   its BUILD, and a zero would be a measurement it never made. Each such
//   phase carries `incomplete`, naming the earliest marker that is missing, so
//   the report says which step never happened rather than just "unknown".
//
// * MULTIPLE FREEZES (contract revised mid-loop, re-frozen, ADR 2026-019's
//   re-run path): DESIGN extends to the LAST freeze that precedes the first
//   `red-gate` pass. A revision means the design was not finished at the first
//   freeze — the minutes spent revising are design minutes, and the freeze the
//   eventual red actually validated is the one that ended the phase. A freeze
//   AFTER the first red pass (Run 10's mid-loop revision) does not extend
//   DESIGN: by then TEST and BUILD are underway, and stretching DESIGN over
//   them would double-count the same wall clock. With no red pass at all,
//   DESIGN ends at the last freeze in the log — there is nothing downstream to
//   pin it against.
//
// * MARKERS ARE FOUND IN APPEND ORDER, NOT TIMESTAMP ORDER. The log is an
//   append-only file written by one gate at a time, so its order is the causal
//   truth of what ran; a system clock can be adjusted mid-run and a timestamp
//   cannot be trusted to sequence anything. Timestamps are used only to
//   measure spans whose endpoints append order has already fixed, and a span
//   that comes out negative (a clock that went backwards) is clamped to 0
//   rather than reported as a negative duration.
//
// * EVENTS WITH NO USABLE TIMESTAMP are dropped and counted (`skipped`).
//   `readGuardLog` already drops unparseable LINES; a parseable line whose
//   `ts` is missing or not a date is corrupt in the same way, and an event
//   that cannot be placed on the clock cannot bound a span.
//
// * MORE THAN ONE RUN IN A LOG: taken as one run, because nothing in the log
//   marks where a run begins. The guard log is per-project and append-only,
//   and no guard emits a run-start event — the first event of a run is
//   whichever gate the architect happened to call first, which is not
//   distinguishable from any other event. So a project that puts two tickets
//   through the pipeline without clearing `.pi/` gets one merged report, and
//   the honest fix is a run-start event in the log, not a heuristic here. In
//   practice the DESIGN rule above absorbs the common case (revision inside
//   one ticket); a genuine second ticket would show as an implausible total,
//   which is a visible symptom rather than a silent wrong answer.
//
// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------
//
// A bounce is a hand-back to a role, and the log's own marker for that is the
// `route` a gate records in its event detail — the machine-readable twin of
// the single `route → <role>` line it prints. So: a BOUNCE is a `block` event
// carrying `detail.route`.
//
// Counting every `block` instead would double-count, because composite gates
// and their steps both log: a design-gate failure writes a `contract-purity`
// block AND a `design-gate` block, and a green-gate escape-hatch failure
// writes a `lint-src` block AND a `green-gate` block. One hand-back, two
// events. Those inner blocks — and `path-gate` denials, which refuse a single
// tool call rather than returning work to anyone — are still counted, as
// `unroutedBlocks`, so nothing disappears from the report.
//
// A block lands in a phase by INDEX, not by timestamp, for the same reason
// markers do. A block that falls in a stretch no pair of markers delimits is
// `unattributedBlocks`: with the boundary unknown it genuinely is not known
// which phase it belongs to, and guessing would put TEST's bounces on DESIGN's
// line.

import type { LoggedGuardEvent } from "./guard-log.ts";

export type PhaseName = "design" | "tests" | "build" | "wrap";

/** The four phases, in the only order a run passes through them. */
export const PHASES: readonly PhaseName[] = ["design", "tests", "build", "wrap"];

export interface RouteCount {
  /** The role a gate handed the work back to (`detail.route`). */
  readonly route: string;
  readonly count: number;
}

export interface PhaseSpan {
  readonly phase: PhaseName;
  /** Wall clock in milliseconds. Undefined when the phase never completed. */
  readonly ms?: number;
  /** ISO timestamp of the event that opened the phase, when known. */
  readonly startedAt?: string;
  /** ISO timestamp of the marker that closed it, when known. */
  readonly endedAt?: string;
  /** Why `ms` is undefined: the earliest missing marker, named. */
  readonly incomplete?: string;
  /** Blocks in this phase that named a bounce target. */
  readonly bounces: number;
  /** Bounce targets, most-bounced first, then alphabetical. */
  readonly byRoute: readonly RouteCount[];
  /** Blocks in this phase that named no target (composite inner steps, path-gate denials). */
  readonly unroutedBlocks: number;
}

export interface PhaseDurations {
  /** Always all four phases, in order. */
  readonly phases: readonly PhaseSpan[];
  /** First event → last event. The LOG's span, not the sum of the phases:
   *  they agree when every phase completed and diverge when one did not,
   *  which is exactly the signal worth seeing. */
  readonly totalMs?: number;
  /** Events analysed (after dropping unusable ones). */
  readonly events: number;
  /** Events dropped for having no usable timestamp. */
  readonly skipped: number;
  /** Bounces across all phases, including unattributed ones. */
  readonly bounces: number;
  /** Blocks in a stretch no pair of markers delimits. */
  readonly unattributedBlocks: number;
  /** Set when nothing could be measured at all; the report degrades to this line. */
  readonly unavailable?: string;
}

// --- markers --------------------------------------------------------------------

function summaryOf(e: LoggedGuardEvent): string {
  return typeof e.summary === "string" ? e.summary : "";
}

/**
 * The event that ends DESIGN: the contract is frozen.
 *
 * Same test green-gate's `redPassStandsForCurrentContracts` uses for the
 * checksum half — a manifest WRITE, not a drift verification — plus the
 * composite `design-gate` pass whose final step is that write (ADR 2026-019).
 */
function isFreeze(e: LoggedGuardEvent): boolean {
  if (e.verdict !== "pass") return false;
  if (e.guard === "design-gate") return true;
  return e.guard === "checksum-gate" && summaryOf(e).includes("wrote manifest");
}

const isRedPass = (e: LoggedGuardEvent): boolean => e.guard === "red-gate" && e.verdict === "pass";
const isGreenPass = (e: LoggedGuardEvent): boolean => e.guard === "green-gate" && e.verdict === "pass";
/** WRAP's closing activity: the terminal verdict and the delivery pass. */
const isWrapEvent = (e: LoggedGuardEvent): boolean => e.guard === "sign-off" || e.guard === "deliver";

/** The bounce target a gate recorded, or undefined when it named none. */
export function routeOf(e: LoggedGuardEvent): string | undefined {
  const route = (e.detail as { route?: unknown } | undefined)?.route;
  return typeof route === "string" && route !== "" ? route : undefined;
}

// --- analysis -------------------------------------------------------------------

/** Milliseconds between two logged timestamps, never negative (see header). */
function spanMs(from: LoggedGuardEvent, to: LoggedGuardEvent): number {
  return Math.max(0, Date.parse(to.ts) - Date.parse(from.ts));
}

interface Bounds {
  /** Index of the event that opens the phase; -1 when unknown. */
  readonly startIdx: number;
  /** Index of the marker that closes it; -1 when it never fired. */
  readonly endIdx: number;
  /** Named for the report when a bound is missing. */
  readonly missing: string;
}

/**
 * Reduce a guard log to per-phase wall clock and bounce counts.
 *
 * Pure. See the module header for every edge decision — completion, revision
 * re-freezes, ordering, and what counts as one run.
 */
export function phaseDurations(all: readonly LoggedGuardEvent[]): PhaseDurations {
  const events: LoggedGuardEvent[] = [];
  let skipped = 0;
  for (const e of all) {
    if (
      e === null ||
      typeof e !== "object" ||
      typeof e.guard !== "string" ||
      typeof e.ts !== "string" ||
      Number.isNaN(Date.parse(e.ts))
    ) {
      skipped += 1;
      continue;
    }
    events.push(e);
  }

  if (events.length === 0) {
    return {
      phases: PHASES.map((phase) => ({
        phase,
        incomplete: "no events",
        bounces: 0,
        byRoute: [],
        unroutedBlocks: 0,
      })),
      events: 0,
      skipped,
      bounces: 0,
      unattributedBlocks: 0,
      unavailable:
        skipped > 0
          ? `no usable guard events (${skipped} unreadable) — the log is corrupt`
          : "the guard log is empty or absent (PI_GUARD_LOG=off, or no gate ran here)",
    };
  }

  // Markers, in append order. Each is searched only in the stretch its phase
  // can occupy, so a later re-freeze cannot pull DESIGN over TEST and BUILD.
  const redIdx = events.findIndex(isRedPass);
  const freezeIdx = lastIndexBefore(events, isFreeze, redIdx === -1 ? events.length : redIdx);
  const greenIdx = firstIndexAfter(events, isGreenPass, redIdx);
  const wrapEndIdx = lastIndexAfter(events, isWrapEvent, greenIdx);

  const bounds: Record<PhaseName, Bounds> = {
    design: { startIdx: 0, endIdx: freezeIdx, missing: "no contract freeze (design_gate never passed)" },
    tests: {
      startIdx: freezeIdx,
      endIdx: redIdx,
      missing: freezeIdx === -1 ? "no contract freeze (design_gate never passed)" : "no red_gate pass",
    },
    build: {
      startIdx: redIdx,
      endIdx: greenIdx,
      missing: redIdx === -1 ? "no red_gate pass" : "no green_gate pass",
    },
    wrap: {
      startIdx: greenIdx,
      endIdx: wrapEndIdx,
      missing: greenIdx === -1 ? "no green_gate pass" : "no sign_off or deliver event",
    },
  };

  // Block regions, by index. WRAP owns everything after green — a block logged
  // after the last sign-off/deliver is still wrap-phase work, even though it
  // falls outside the measured span.
  const regions: Record<PhaseName, [number, number] | undefined> = {
    design: freezeIdx === -1 ? undefined : [0, freezeIdx],
    tests: freezeIdx === -1 || redIdx === -1 ? undefined : [freezeIdx, redIdx],
    build: redIdx === -1 || greenIdx === -1 ? undefined : [redIdx, greenIdx],
    wrap: greenIdx === -1 ? undefined : [greenIdx, events.length],
  };

  const routed: Record<PhaseName, Map<string, number>> = {
    design: new Map(),
    tests: new Map(),
    build: new Map(),
    wrap: new Map(),
  };
  const unrouted: Record<PhaseName, number> = { design: 0, tests: 0, build: 0, wrap: 0 };
  let unattributedBlocks = 0;
  let bounces = 0;

  for (const [i, e] of events.entries()) {
    if (e.verdict !== "block") continue;
    const route = routeOf(e);
    if (route !== undefined) bounces += 1;
    const phase = PHASES.find((p) => {
      const region = regions[p];
      return region !== undefined && i >= region[0] && i < region[1];
    });
    if (phase === undefined) {
      unattributedBlocks += 1;
      continue;
    }
    if (route === undefined) unrouted[phase] += 1;
    else routed[phase].set(route, (routed[phase].get(route) ?? 0) + 1);
  }

  const phases: PhaseSpan[] = PHASES.map((phase) => {
    const { startIdx, endIdx, missing } = bounds[phase];
    const byRoute = [...routed[phase]]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || (a.route < b.route ? -1 : 1));
    const base = {
      phase,
      bounces: byRoute.reduce((n, r) => n + r.count, 0),
      byRoute,
      unroutedBlocks: unrouted[phase],
    };
    if (startIdx === -1 || endIdx === -1) return { ...base, incomplete: missing };
    const from = events[startIdx]!;
    const to = events[endIdx]!;
    return { ...base, ms: spanMs(from, to), startedAt: from.ts, endedAt: to.ts };
  });

  return {
    phases,
    totalMs: spanMs(events[0]!, events[events.length - 1]!),
    events: events.length,
    skipped,
    bounces,
    unattributedBlocks,
  };
}

/** Last index strictly before `limit` matching `pred`, or -1. */
function lastIndexBefore(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
  limit: number,
): number {
  for (let i = Math.min(limit, events.length) - 1; i >= 0; i--) if (pred(events[i]!)) return i;
  return -1;
}

/** First index strictly after `after` matching `pred`, or -1. `after: -1` searches all. */
function firstIndexAfter(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
  after: number,
): number {
  for (let i = after + 1; i < events.length; i++) if (pred(events[i]!)) return i;
  return -1;
}

/** Last index strictly after `after` matching `pred`, or -1. `after: -1` searches all. */
function lastIndexAfter(
  events: readonly LoggedGuardEvent[],
  pred: (e: LoggedGuardEvent) => boolean,
  after: number,
): number {
  for (let i = events.length - 1; i > after; i--) if (pred(events[i]!)) return i;
  return -1;
}

// --- formatting -----------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `47s` · `4m12s` · `1h04m12s`. Fixed shape so the column stays greppable. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
  if (minutes > 0) return `${minutes}m${pad2(seconds)}s`;
  return `${seconds}s`;
}

const NAME_WIDTH = 6; // "design" is the longest phase name
const TIME_WIDTH = 8; // "1h04m12s"

function bounceText(span: PhaseSpan): string | undefined {
  if (span.bounces === 0) return undefined;
  const targets = span.byRoute.map((r) => `${r.count} → ${r.route}`).join(", ");
  return `${span.bounces} bounce${span.bounces === 1 ? "" : "s"}: ${targets}`;
}

/**
 * The human block a delivery prints.
 *
 * Line 0 is the headline (the house convention every gate follows); the rest
 * are indented and each carries the `timing:` tag, so one phase's line can be
 * grepped out of a whole run's output on its own.
 */
export function formatPhaseDurations(durations: PhaseDurations): string[] {
  if (durations.unavailable !== undefined) return [`unavailable — ${durations.unavailable}`];

  const row = (name: string, time: string, note?: string): string =>
    `  timing: ${name.padEnd(NAME_WIDTH)} ${time.padStart(TIME_WIDTH)}${note !== undefined ? `  (${note})` : ""}`;

  const lines = durations.phases.map((span) => {
    const notes = [
      span.incomplete !== undefined ? `incomplete: ${span.incomplete}` : undefined,
      bounceText(span),
      span.unroutedBlocks > 0
        ? `${span.unroutedBlocks} unrouted block${span.unroutedBlocks === 1 ? "" : "s"}`
        : undefined,
    ].filter((n): n is string => n !== undefined);
    return row(
      span.phase,
      span.ms === undefined ? "—" : formatDuration(span.ms),
      notes.length > 0 ? notes.join("; ") : undefined,
    );
  });

  const incomplete = durations.phases.some((p) => p.ms === undefined);
  lines.push(
    row(
      "total",
      durations.totalMs === undefined ? "—" : formatDuration(durations.totalMs),
      incomplete ? "log span; the phases above do not sum to it" : undefined,
    ),
  );
  if (durations.unattributedBlocks > 0) {
    lines.push(
      `  timing: ${durations.unattributedBlocks} block${durations.unattributedBlocks === 1 ? "" : "s"} outside any measurable phase`,
    );
  }

  const counted = `${durations.events} guard event${durations.events === 1 ? "" : "s"}`;
  const unreadable = durations.skipped > 0 ? `, ${durations.skipped} unreadable` : "";
  return [`where the minutes went (${counted}${unreadable}, taken as one run)`, ...lines];
}
