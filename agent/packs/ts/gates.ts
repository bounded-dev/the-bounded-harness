// The TypeScript pack's gate registry (ADR 2026-029).
//
// Every artifact gate this pack contributes, as one list the root discovers by
// convention (`packs/*/gates.ts`) and never by name. `pi-gates` reads it for
// its command line; the pi extensions read it for their tool roster; a second
// host reads it for whatever it binds. A gate's name, tool name, description,
// flags and prompt guidance therefore live HERE and nowhere else — the
// descriptions were lifted verbatim from the extensions that used to hold
// them, and the drift tests still pin their phrases.
//
// Each `run` is the same function the pack's own script calls from its `main`,
// so a gate cannot differ by how it was invoked. Runners that still answer in
// the bare `{code, lines}` shape are lifted onto the contract by
// `toGateResult`; their own return types are left alone.
//
// The runners are imported inside `run`, not at the top: the table itself is
// what `pi-gates --list`, a usage message and a tool roster need, and loading
// every gate's machinery (eslint, ts-morph, …) to print a table cost a second
// per invocation. A gate's cost is paid when it runs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  argBoolean,
  argJson,
  argNumber,
  argString,
  argStrings,
  type FlagSpec,
  type GateArgs,
  type GateCommand,
} from "../../src/gate-command.ts";
import { guardVerdictOf, toGateResult, type GateResult } from "../../src/gate-result.ts";
import { logGuardEvent } from "../../src/guard-log.ts";

// --- shared pieces ----------------------------------------------------------------

const PATTERN_FLAG: FlagSpec = {
  name: "pattern",
  kind: "string",
  repeatable: true,
  description:
    "Glob patterns for the contract files. Defaults to src/**/*.contract.ts — you rarely need to pass this.",
};

const FINDINGS_FLAGS: readonly FlagSpec[] = [
  {
    name: "findings",
    kind: "json",
    description: "The findings as a JSON array. Pass [] to record that you found nothing.",
  },
  {
    name: "findings-file",
    kind: "string",
    description: "A file holding the findings as a JSON array — for a payload too long for a shell line.",
  },
];

/** A gate that could not run because of how it was called. Logged like any
 *  other error verdict: a misused gate is still a gate that did not pass. */
function misuse(name: string, cwd: string, message: string): GateResult {
  const result: GateResult = {
    code: 2,
    verdict: "error",
    summary: message,
    lines: [`${name}: ERROR — ${message}`],
    detail: { reason: "bad-invocation" },
  };
  logGuardEvent(cwd, { guard: name, verdict: "error", summary: message, detail: result.detail });
  return result;
}

/** Exactly one of `--findings` / `--findings-file`, parsed. An empty list is a
 *  claim the log keeps, so neither flag is not "no findings" — it is misuse. */
function findingsOf(
  name: string,
  cwd: string,
  args: GateArgs,
): { readonly ok: true; readonly findings: unknown } | { readonly ok: false; readonly result: GateResult } {
  const inline = argJson(args, "findings");
  const file = argString(args, "findings-file");
  if ((inline === undefined) === (file === undefined)) {
    return { ok: false, result: misuse(name, cwd, "pass exactly one of --findings <json> or --findings-file <path>") };
  }
  if (file === undefined) return { ok: true, findings: inline };
  let raw: string;
  try {
    raw = readFileSync(resolve(cwd, file), "utf8");
  } catch {
    return { ok: false, result: misuse(name, cwd, `cannot read --findings-file ${file}`) };
  }
  try {
    return { ok: true, findings: JSON.parse(raw) };
  } catch {
    return { ok: false, result: misuse(name, cwd, `--findings-file ${file} is not valid JSON`) };
  }
}

/** A `--flag` that must be a positive integer, or misuse. */
function positiveInteger(
  name: string,
  cwd: string,
  args: GateArgs,
  flag: string,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly result: GateResult } {
  const value = argNumber(args, flag);
  if (value === undefined) return { ok: true, value };
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, result: misuse(name, cwd, `--${flag} needs a positive integer (got ${value})`) };
  }
  return { ok: true, value };
}

const patternsOf = (args: GateArgs): readonly string[] | undefined => {
  const patterns = argStrings(args, "pattern");
  return patterns.length > 0 ? patterns : undefined;
};

// --- the registry ------------------------------------------------------------------

export const gates: readonly GateCommand[] = [
  {
    name: "contract-purity",
    tool: "contract_purity",
    description:
      "Run the contract-purity gate over the project's *.contract.ts files: contracts must be declaration-only AND free of naked primitives on their public surface. The cheap single check while you are still iterating on a contract; when the design is settled, run design_gate instead — it starts with this and carries the phase through freeze.",
    flags: [PATTERN_FLAG],
    async run(cwd, args) {
      const { runContractPurity } = await import("./scripts/contract-purity.ts");
      return toGateResult("contract-purity", await runContractPurity(cwd, patternsOf(args)));
    },
  },
  {
    name: "design-gate",
    tool: "design_gate",
    description:
      "The one design-phase call: contract-purity → scaffold → project typecheck → design-review → freeze, stopping at the first failure and returning one verdict. Run it once the contract is written and the reviewer has recorded its review; on a failure, fix what it names and re-run it. There are no separate scaffold or freeze tools — they are steps of this sequence, and the sequence has only one legal order. On a RE-freeze (a manifest already exists) the review is checked first, and the typecheck step lets worker-owned drift through, printed and attributed — a contract revision over existing code freezes first and the workers repair after; a diagnostic in a contract, config, or generated skeleton still blocks.",
    flags: [PATTERN_FLAG],
    promptGuidelines: [
      "It will not freeze a design nobody has challenged: commission the `reviewer` subagent once first. A review covers the SET of contract files it saw, so editing one you revised in answer to it does not un-review the design — only adding or removing a contract file does, and then the step names the file.",
      "The reviewer's findings are advisory and blockers do not fail this gate — you keep authority over the design and may freeze over any finding, blocker included. The passing line prints the blocker count so an unsettled one stays visible.",
      "Re-run it after every contract revision to re-scaffold and re-freeze — that is the only way to do the last two — but do NOT re-commission the reviewer to chase findings; a fresh review is owed only when a contract file is added or removed.",
      "Every failure it reports is yours to fix — at DESIGN there is no test-writer or builder output for a defect to live in.",
      "While you are still iterating on a contract, `contract_purity` alone is the cheap check; `design_gate` is how the phase advances.",
    ],
    async run(cwd, args) {
      const { runDesignGate } = await import("./scripts/design-gate.ts");
      return await runDesignGate(cwd, patternsOf(args));
    },
  },
  {
    name: "check-drift",
    tool: "check_drift",
    description:
      "Verify the contracts are byte-for-byte unchanged since design_gate froze them. A contract that moves mid-loop drifts the tests and the implementation apart underneath you. Run any time you suspect the contract has moved.",
    flags: [
      {
        name: "write",
        kind: "boolean",
        description: "Record the manifest instead of verifying it — the freeze step. design_gate does this for you.",
      },
    ],
    async run(cwd, args) {
      const { runChecksumGate } = await import("./scripts/checksum-gate.ts");
      return toGateResult("check-drift", runChecksumGate(cwd, argBoolean(args, "write")));
    },
  },
  {
    name: "red-gate",
    tool: "red_gate",
    description:
      "Run the red gate after the test-writer finishes. A VALID red means the project typechecks, the suite runs, and every failure is NotImplementedError. Wrong-reason red — import/type/config errors, ordinary assertion failures, or a fully green suite — is rejected. The gate prints one `route → <role>` line naming who must fix what it found.",
    flags: [],
    async run(cwd) {
      const { runRedGate } = await import("./scripts/red-gate.ts");
      return await runRedGate(cwd);
    },
  },
  {
    name: "green-gate",
    tool: "green_gate",
    description:
      "Run the green gate after the builder finishes. GREEN means every test passes AND the project typechecks — a passing suite on a project that does not compile is a false green, not a pass. The gate prints one `route → <role>` line naming who must fix what it found.",
    flags: [],
    async run(cwd) {
      const { runGreenGate } = await import("./scripts/green-gate.ts");
      const r = await runGreenGate(cwd);
      // Green is not the terminal verdict. Run 7's architect found a real
      // defect in its closing turn and shipped anyway, because a gate verdict
      // was the only way the loop could end.
      if (r.code !== 0) return r;
      return {
        ...r,
        lines: [
          ...r.lines,
          "green-gate: GREEN is not the terminal verdict — call sign_off with what you saw reading the code (an empty list is a valid answer).",
        ],
      };
    },
  },
  {
    name: "sign-off",
    tool: "sign_off",
    description:
      "End the loop. After a passing green gate, record what you saw reading the implementation and the tests — you are the only role that can read both. An EMPTY findings list is a valid and expected answer; recording it explicitly is the point, because a silence cannot be audited later. This gate never judges a finding, it records the claim. Refuses if no green gate has passed.",
    flags: FINDINGS_FLAGS,
    promptGuidelines: [
      "Call this after green_gate passes and before telling the user the work is done.",
      "Record anything the gates could not see: a type-system escape hatch, an untested export, behaviour the spec left unstated, an ordering two roles agreed on only by luck.",
      "severity: 'blocker' means do not ship it as clean; 'concern' means worth a look; 'note' is an observation.",
    ],
    async run(cwd, args) {
      const findings = findingsOf("sign-off", cwd, args);
      if (!findings.ok) return findings.result;
      const { runSignOff } = await import("./scripts/sign-off.ts");
      return runSignOff(cwd, findings.findings);
    },
  },
  {
    name: "deliver",
    tool: "deliver",
    description:
      "Run the delivery pass after sign_off: strip red-phase scaffolding (unused shared errors module, __conformance blobs), write the src/index.ts barrel, ship scripts/surface-check.ts into the project with a check:surface npm script (installing the ts-morph it needs), gitignore .pi/, and add the README Contracts section. Then prints where the run's minutes went — design/tests/build/wrap durations and bounces, read back from the guard log — and finally runs the project's own `npm run check` as the last word on whether the repo satisfies its own definition of done. Idempotent — a second run applies nothing. Blocks if an unimplemented export still imports NotImplementedError, if the surface checker's dependency cannot be installed, or if the project's own check is red.",
    flags: [],
    async run(cwd) {
      const { runDeliver } = await import("./scripts/deliver.ts");
      return toGateResult("deliver", runDeliver(cwd));
    },
  },
  {
    name: "mutation-score",
    tool: "mutation_score",
    description:
      "Measure how much of the delivered logic the suite actually holds down: mutate src/ one site at a time (comparison flips, &&/|| swaps, if-negation, dropped early-return guards), run the suite against each mutant, and report which were KILLED and which SURVIVED. ADVISORY — it never blocks: exit 0 means the measurement ran, whatever the score. Each surviving mutant names a file, a line and an edit the suite did not notice, which is where an untested rule lives. Run it after green_gate and before sign_off, and put what survived in your findings.",
    flags: [
      {
        name: "max-mutants",
        kind: "number",
        description:
          "Cap on mutants run (default 40). Each one costs a full suite run, so raise it only on a fast suite.",
      },
      {
        name: "timeout-ms",
        kind: "number",
        description: "Per-mutant suite timeout in milliseconds; a mutant that outlives it counts as timed out.",
      },
    ],
    promptGuidelines: [
      "A survivor is not automatically a defect — it is a question. Read the line it names and decide whether the rule it broke is one the spec actually requires.",
      "The measurement costs one full suite run per mutant (40 by default), so run it once, late, on a green suite — not between builder bounces.",
      "Findings from it belong in sign_off: 'the suite does not hold down X' is exactly the kind of thing only you can see, and the gates cannot.",
    ],
    async run(cwd, args) {
      const maxMutants = positiveInteger("mutation-score", cwd, args, "max-mutants");
      if (!maxMutants.ok) return maxMutants.result;
      const timeoutMs = positiveInteger("mutation-score", cwd, args, "timeout-ms");
      if (!timeoutMs.ok) return timeoutMs.result;
      const { runMutationScore } = await import("./scripts/mutation-score.ts");
      const r = await runMutationScore(cwd, {
        ...(maxMutants.value !== undefined ? { maxMutants: maxMutants.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
      });
      return toGateResult("mutation-score", r, {
        sites: r.sites,
        killed: r.killed,
        survived: r.survived,
        timedOut: r.timedOut,
        score: r.score ?? null,
      });
    },
  },
  {
    name: "typecheck",
    tool: "typecheck",
    description:
      "Run `tsc --noEmit` on the project and return pass/fail plus type-error diagnostics. Absolute machine paths are redacted. Diagnostics are SCOPED TO YOUR ROLE: errors in your own zone and in the shared interface (contracts, spec, config) are shown in full; errors in another role's zone are reported as a count and an owner only — no paths, no messages, no symbol names.",
    flags: [
      {
        name: "role",
        kind: "string",
        description:
          "Scope the diagnostics to this pipeline role (architect | test-writer | builder | reviewer). Unscoped when absent.",
      },
    ],
    promptGuidelines: [
      "Use typecheck to confirm your implementation compiles before relying on run_tests.",
      "Errors reported as another role's are not yours to fix and do not block you — never redesign your code around them, and never ask for their content; report them to the architect if they seem to block the ticket.",
      "'clean in your zone' is not 'the project compiles': it means nothing is left for YOU to fix.",
    ],
    async run(cwd, args) {
      const { parseRole, typecheckGate } = await import("./scripts/typecheck-gate.ts");
      const raw = argString(args, "role");
      const role = parseRole(raw);
      if (raw !== undefined && role === undefined) {
        return misuse("typecheck", cwd, `--role must be one of architect | test-writer | builder | reviewer (got '${raw}')`);
      }
      return await typecheckGate(cwd, role);
    },
  },
  {
    name: "run-tests",
    tool: "run_tests",
    description:
      "Run the project's vitest suite and return sanitized results: failing test names and assertion diffs only. Code frames, stack traces, file paths, and console output are stripped — you cannot see test source, only outcomes.",
    flags: [],
    promptGuidelines: [
      "Use run_tests to check whether your implementation satisfies the suite; it never reveals test source.",
    ],
    async run(cwd) {
      const { runTestsGate } = await import("./scripts/run-tests.ts");
      return await runTestsGate(cwd);
    },
  },
  {
    name: "record-design-review",
    tool: "record_design_review",
    description:
      "Record the challenges you raise reading spec + contracts. Findings are claims for the architect to weigh, not verdicts — a blocker included — and an empty list is a valid review. You review the whole design once; the architect may revise a file in answer and it stays covered, so only a contract file added or removed later re-requires a review.",
    flags: FINDINGS_FLAGS,
    promptGuidelines: [
      "Call this once, at the end of the review, with everything you found — it is the only output of the role, and you are not re-run to re-check.",
      "severity: 'blocker' is the challenge you would stake most on — the pipeline looks set to jam (an operation nobody can call, a type nobody can construct, two requirements that contradict) — still advisory, the architect may freeze over it; 'concern' means two careful implementers could read it differently; 'note' is everything else.",
      "Pass [] when you found nothing. A clean review that is recorded can be audited later; a silence cannot.",
    ],
    async run(cwd, args) {
      const findings = findingsOf("record-design-review", cwd, args);
      if (!findings.ok) return findings.result;
      const { runRecordDesignReview } = await import("./scripts/design-review.ts");
      return runRecordDesignReview(cwd, findings.findings);
    },
  },
  // CLI-only from here: no pi tool. surface-check ships INTO the delivered
  // project (deliver.ts) and so must stay free of harness imports, which is why
  // it logs nothing itself — the event is written here, at the boundary.
  {
    name: "surface-check",
    description:
      "Check every src/**/*.contract.ts against its implementation sibling: exported signatures must match the contract exactly. The same check `deliver` ships into the project as `npm run check:surface`.",
    flags: [],
    async run(cwd) {
      const { checkProjectSurfaces } = await import("./scripts/surface-check.ts");
      const r = checkProjectSurfaces(cwd);
      const result = toGateResult("surface-check", r, { violations: r.violations.length });
      logGuardEvent(cwd, {
        guard: "surface-check",
        verdict: guardVerdictOf(r.code),
        summary: result.summary,
        detail: { violations: r.violations },
      });
      return result;
    },
  },
  // A step of design_gate, not a tool (ADR 2026-019): exposed on the command
  // line for a person regenerating skeletons by hand, never to a role.
  {
    name: "scaffold",
    description:
      "Generate (or re-sync) the throwing skeleton beside every src/**/*.contract.ts. Non-destructive: writes only over absence or another skeleton, and removes only generated files whose contract is gone. A step of design_gate — run it alone only to regenerate skeletons by hand.",
    flags: [],
    async run(cwd) {
      const { runScaffold } = await import("./scripts/scaffold-contract.ts");
      return toGateResult("scaffold", runScaffold(cwd));
    },
  },
];
