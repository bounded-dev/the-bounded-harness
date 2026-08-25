// Typecheck routing (TN-26-001, issue #7).
//
// A passing suite with tsc errors is a FALSE GREEN (dogfood Run 3: green-gate
// said 22/22 while two `noUncheckedIndexedAccess` errors sat in the test
// file). Type errors are therefore a phase-gate failure — but "the project
// does not compile" is only actionable if the gate also says WHO can fix it:
// the builder is blind to `tests/**` and the path gate would refuse its edit
// anyway, so a test-file type error must bounce to the test-writer, not to
// whoever happens to be running.
//
// Pure: parses redacted tsc diagnostics (see typecheck.ts), attributes each to
// the role whose write zone owns the file, and picks one bounce target.

import { ownerOfPath, type Role } from "../../../src/path-policy.ts";

/** Who repairs a diagnostic. `orchestrator` = no pipeline role may write the file. */
export type FixOwner = Role | "orchestrator";

// Furthest-upstream first: infrastructure nobody may touch, then the pipeline's
// own production order (contract → tests → implementation). Fixing downstream
// of a broken upstream artifact is wasted work, so the earliest owner in this
// order gets the bounce.
export const OWNERS_UPSTREAM_FIRST: readonly FixOwner[] = [
  "orchestrator",
  "architect",
  "test-writer",
  "builder",
];

export interface TypecheckRouting {
  readonly errorCount: number;
  /** The single bounce target: the furthest-upstream owner. Undefined when clean. */
  readonly route?: FixOwner;
  /** Owners with at least one error, upstream-first. */
  readonly owners: readonly FixOwner[];
  /** Diagnostic lines (with their continuation lines) grouped by owner, in tsc order. */
  readonly byOwner: Readonly<Partial<Record<FixOwner, readonly string[]>>>;
}

// `--pretty false` diagnostics: `path(line,col): error TS1234: message`, or a
// path-less global error (`error TS18003: No inputs were found…`). The leading
// `[^\s(]` keeps indented continuation lines out — they belong to the
// diagnostic above them.
const LOCATED_ERROR = /^([^\s(][^(]*)\(\d+,\d+\):\s+error TS\d+/;
const GLOBAL_ERROR = /^error TS\d+/;

/** The furthest-upstream owner of the given set, or undefined if empty. */
export function mostUpstream(owners: readonly FixOwner[]): FixOwner | undefined {
  return OWNERS_UPSTREAM_FIRST.find((o) => owners.includes(o));
}

/** Attribute redacted tsc diagnostics to the roles that may fix them. */
export function routeTypecheck(diagnostics: readonly string[]): TypecheckRouting {
  const groups = new Map<FixOwner, string[]>();
  let errorCount = 0;
  let current: FixOwner | undefined;

  for (const line of diagnostics) {
    const located = LOCATED_ERROR.exec(line);
    if (located) {
      current = ownerOfPath(located[1]) ?? "orchestrator";
      errorCount += 1;
    } else if (GLOBAL_ERROR.test(line)) {
      current = "orchestrator";
      errorCount += 1;
    } else if (current === undefined || !/^\s/.test(line)) {
      // Not a diagnostic and not a continuation of one (summaries such as
      // "Found 2 errors."): attribute nothing.
      current = undefined;
      continue;
    }
    const bucket = groups.get(current);
    if (bucket) bucket.push(line);
    else groups.set(current, [line]);
  }

  const owners = OWNERS_UPSTREAM_FIRST.filter((o) => groups.has(o));
  const byOwner: Partial<Record<FixOwner, readonly string[]>> = {};
  for (const o of owners) byOwner[o] = groups.get(o);
  return { errorCount, route: mostUpstream(owners), owners, byOwner };
}

/** Indented gate-output lines for a failing typecheck. Empty when clean. */
export function typecheckLines(routing: TypecheckRouting): string[] {
  if (routing.errorCount === 0) return [];
  const lines = [
    `  typecheck: ${routing.errorCount} type error${routing.errorCount === 1 ? "" : "s"} — route to ${routing.route}`,
  ];
  for (const owner of routing.owners) {
    const group = routing.byOwner[owner] ?? [];
    const count = group.filter((l) => LOCATED_ERROR.test(l) || GLOBAL_ERROR.test(l)).length;
    lines.push(`  ${owner} (${count}):`);
    for (const line of group) lines.push(`    ${line}`);
  }
  return lines;
}
