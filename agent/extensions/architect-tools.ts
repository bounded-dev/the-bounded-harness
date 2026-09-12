/**
 * Architect tools (issue #12): the gates, and git.
 *
 * The architect drives a whole ticket but holds NO `bash` — a shell defeats
 * every path rule at once, so it gets named tools for the things it
 * legitimately needs instead of a way to run anything. This file is what makes
 * that trade survivable: every capability the architect actually needs exists
 * here, or it cannot do its job.
 *
 * Each gate is thin wiring over the same `run*` function the CLI calls, so a
 * gate cannot differ by how it was invoked. That matters more than it sounds:
 * "the architect runs every gate itself and never trusts a worker's word" is
 * worth nothing if the tool is a second, drifting implementation of the gate.
 *
 * Two things this buys beyond closing the shell:
 *
 *   · The invocation guidance deletes itself. Dogfood Run 4's orchestrator
 *     spent its first ~3 minutes `find`-ing the pack and `head`-ing three gate
 *     scripts to work out how to call them, then re-read two of them mid-run.
 *     A tool schema cannot be mis-invoked that way, and `design_gate` finds
 *     the contracts itself rather than taking one path per call.
 *   · Every gate lands in the guard log by construction, so "did the architect
 *     actually run the gate" is checkable rather than trusted.
 *
 * The roster is deliberately not one tool per gate script. Where several gates
 * have exactly one legal order, they are one tool: `design_gate` is
 * purity → scaffold → typecheck → design-review → freeze in a single call with
 * a single verdict (ADR 2026-019, ADR 2026-020), because the order used to live
 * in prose and prose executes unreliably. `contract_purity` survives alongside it as the cheap
 * single check while a contract is still being iterated on.
 *
 * Two of the tools here are not gates and decide nothing.
 *
 *   · `sleep` exists because r15's architect had no way to pass time. Its
 *     reviewer stalled, and with a stalled child, no wait primitive and a
 *     standing instruction not to busy-loop, it reached for the only thing
 *     that blocked: it ran `design_gate` five times as a clock, writing four
 *     junk scaffolds, and said so out loud — "Since I have no sleep mechanism
 *     and shouldn't busy-loop, calling design_gate itself serves as a
 *     legitimate poll". A gate run is a claim about the project's state, so a
 *     run made to fill a gap corrupts the only record of what happened. The
 *     fix is not a paragraph asking it to stop; it is a primitive that waits.
 *   · `mutation_score` exists because both r15 arms' surviving mutants mapped
 *     exactly onto their prompts' headline rules — the measurement was
 *     available and nobody could run it. It is advisory by construction
 *     (exit 0 means it ran, whatever the score), so it never blocks a phase;
 *     it is here so the architect can take the measurement before it signs
 *     off rather than after the run is over.
 *
 * `git` is deliberately unrestricted. Archaeology — reflog, bisect, blame — is
 * exactly when a closed verb list becomes a cage, and it is exactly when you
 * need the tool most. The safety story is not "restrict the verb": it is that
 * the two blind roles hold no git at all (`git show HEAD:tests/x.test.ts`
 * would hand the builder the test source in one call), that args are passed as
 * an array and spawned directly so this tool is not itself an injection point,
 * and that every invocation is logged.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { runContractPurity } from "../packs/ts/scripts/contract-purity.ts";
import { runChecksumGate } from "../packs/ts/scripts/checksum-gate.ts";
import { runDesignGate } from "../packs/ts/scripts/design-gate.ts";
import { runGreenGate } from "../packs/ts/scripts/green-gate.ts";
import { runRedGate } from "../packs/ts/scripts/red-gate.ts";
import { runSignOff } from "../packs/ts/scripts/sign-off.ts";
import { runDeliver } from "../packs/ts/scripts/deliver.ts";
import { runMutationScore } from "../packs/ts/scripts/mutation-score.ts";
import { logGuardEvent } from "../src/guard-log.ts";

const CWD_PARAM = Type.Object({
  cwd: Type.Optional(
    Type.String({
      description:
        "Project directory to run in (absolute, or relative to the session cwd). Defaults to the session cwd.",
    }),
  ),
});

function targetCwd(sessionCwd: string, param?: string): string {
  if (!param) return sessionCwd;
  return isAbsolute(param) ? param : resolve(sessionCwd, param);
}

/** A gate's exit code as the verdict line the architect reads. */
function verdictOf(code: number): string {
  if (code === 0) return "PASS";
  if (code === 1) return "BLOCK";
  return "ERROR (misuse — the gate could not run)";
}

function gateOutput(name: string, code: number, lines: readonly string[]) {
  const text = [...lines, `${name}: ${verdictOf(code)}`].join("\n");
  return { content: [{ type: "text" as const, text }], details: { code, ok: code === 0 } };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "contract_purity",
    label: "Contract Purity Gate",
    description:
      "Run the contract-purity gate over the project's *.contract.ts files: contracts must be declaration-only AND free of naked primitives on their public surface. The cheap single check while you are still iterating on a contract; when the design is settled, run design_gate instead — it starts with this and carries the phase through freeze.",
    promptSnippet: "Gate the contracts: declaration-only, no naked primitives.",
    parameters: Type.Object({
      cwd: CWD_PARAM.properties.cwd,
      patterns: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Glob patterns for the contract files. Defaults to src/**/*.contract.ts — you rarely need to pass this.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = await runContractPurity(cwd, params.patterns);
      return gateOutput("contract-purity", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "design_gate",
    label: "Design Gate",
    description:
      "The one design-phase call: contract-purity → scaffold → project typecheck → design-review → freeze, stopping at the first failure and returning one verdict. Run it once the contract is written and the reviewer has recorded its review; on a failure, fix what it names and re-run it. There are no separate scaffold or freeze tools — they are steps of this sequence, and the sequence has only one legal order. On a RE-freeze (a manifest already exists) the review is checked first, and the typecheck step lets worker-owned drift through, printed and attributed — a contract revision over existing code freezes first and the workers repair after; a diagnostic in a contract, config, or generated skeleton still blocks.",
    promptSnippet: "Run the design phase: purity, scaffold, typecheck, design-review, freeze.",
    promptGuidelines: [
      "It will not freeze a design nobody has challenged: commission the `reviewer` subagent once first. A review covers the SET of contract files it saw, so editing one you revised in answer to it does not un-review the design — only adding or removing a contract file does, and then the step names the file.",
      "The reviewer's findings are advisory and blockers do not fail this gate — you keep authority over the design and may freeze over any finding, blocker included. The passing line prints the blocker count so an unsettled one stays visible.",
      "Re-run it after every contract revision to re-scaffold and re-freeze — that is the only way to do the last two — but do NOT re-commission the reviewer to chase findings; a fresh review is owed only when a contract file is added or removed.",
      "Every failure it reports is yours to fix — at DESIGN there is no test-writer or builder output for a defect to live in.",
      "While you are still iterating on a contract, `contract_purity` alone is the cheap check; `design_gate` is how the phase advances.",
    ],
    parameters: Type.Object({
      cwd: CWD_PARAM.properties.cwd,
      patterns: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Glob patterns for the contract files. Defaults to src/**/*.contract.ts — you rarely need to pass this.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = await runDesignGate(cwd, params.patterns);
      return gateOutput("design-gate", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "check_drift",
    label: "Check Contract Drift",
    description:
      "Verify the contracts are byte-for-byte unchanged since design_gate froze them. A contract that moves mid-loop drifts the tests and the implementation apart underneath you. Run any time you suspect the contract has moved.",
    promptSnippet: "Check whether any contract has moved since it was frozen.",
    parameters: CWD_PARAM,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = runChecksumGate(cwd, false);
      return gateOutput("checksum-gate", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "red_gate",
    label: "Red Gate",
    description:
      "Run the red gate after the test-writer finishes. A VALID red means the project typechecks, the suite runs, and every failure is NotImplementedError. Wrong-reason red — import/type/config errors, ordinary assertion failures, or a fully green suite — is rejected. The gate prints one `route → <role>` line naming who must fix what it found.",
    promptSnippet: "Gate the tests: is this a red for the right reason?",
    parameters: CWD_PARAM,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = await runRedGate(cwd);
      return gateOutput("red-gate", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "green_gate",
    label: "Green Gate",
    description:
      "Run the green gate after the builder finishes. GREEN means every test passes AND the project typechecks — a passing suite on a project that does not compile is a false green, not a pass. The gate prints one `route → <role>` line naming who must fix what it found.",
    promptSnippet: "Gate the build: tests pass AND the project compiles.",
    parameters: CWD_PARAM,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = await runGreenGate(cwd);
      // Green is not the terminal verdict. Run 7's architect found a real
      // defect in its closing turn and shipped anyway, because a gate verdict
      // was the only way the loop could end.
      const lines =
        r.code === 0
          ? [
              ...r.lines,
              "green-gate: GREEN is not the terminal verdict — call sign_off with what you saw reading the code (an empty list is a valid answer).",
            ]
          : r.lines;
      return gateOutput("green-gate", r.code, lines);
    },
  });

  pi.registerTool({
    name: "sign_off",
    label: "Sign Off",
    description:
      "End the loop. After a passing green gate, record what you saw reading the implementation and the tests — you are the only role that can read both. An EMPTY findings list is a valid and expected answer; recording it explicitly is the point, because a silence cannot be audited later. This gate never judges a finding, it records the claim. Refuses if no green gate has passed.",
    promptSnippet: "Sign off on the green: what did you see?",
    promptGuidelines: [
      "Call this after green_gate passes and before telling the user the work is done.",
      "Record anything the gates could not see: a type-system escape hatch, an untested export, behaviour the spec left unstated, an ordering two roles agreed on only by luck.",
      "severity: 'blocker' means do not ship it as clean; 'concern' means worth a look; 'note' is an observation.",
    ],
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          severity: Type.Union([Type.Literal("blocker"), Type.Literal("concern"), Type.Literal("note")], {
            description: "blocker | concern | note",
          }),
          summary: Type.String({ description: "One line: what is wrong." }),
          evidence: Type.Optional(
            Type.String({ description: "Where to look — a path, a symbol, a test name." }),
          ),
        }),
        { description: "What you saw. Pass [] to record that you found nothing." },
      ),
      cwd: CWD_PARAM.properties.cwd,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = runSignOff(cwd, params.findings);
      return gateOutput("sign-off", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "deliver",
    label: "Deliver",
    description:
      "Run the delivery pass after sign_off: strip red-phase scaffolding (unused shared errors module, __conformance blobs), write the src/index.ts barrel, ship scripts/surface-check.ts into the project with a check:surface npm script (installing the ts-morph it needs), gitignore .pi/, and add the README Contracts section. Then prints where the run's minutes went — design/tests/build/wrap durations and bounces, read back from the guard log — and finally runs the project's own `npm run check` as the last word on whether the repo satisfies its own definition of done. Idempotent — a second run applies nothing. Blocks if an unimplemented export still imports NotImplementedError, if the surface checker's dependency cannot be installed, or if the project's own check is red.",
    promptSnippet: "Deliver: strip scaffolding, ship the surface check, make the repo hand-off ready.",
    parameters: CWD_PARAM,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = runDeliver(cwd);
      return gateOutput("deliver", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "mutation_score",
    label: "Mutation Score",
    description:
      "Measure how much of the delivered logic the suite actually holds down: mutate src/ one site at a time (comparison flips, &&/|| swaps, if-negation, dropped early-return guards), run the suite against each mutant, and report which were KILLED and which SURVIVED. ADVISORY — it never blocks: exit 0 means the measurement ran, whatever the score. Each surviving mutant names a file, a line and an edit the suite did not notice, which is where an untested rule lives. Run it after green_gate and before sign_off, and put what survived in your findings.",
    promptSnippet: "Measure the suite's mutation score: which edits to src/ does nobody notice?",
    promptGuidelines: [
      "A survivor is not automatically a defect — it is a question. Read the line it names and decide whether the rule it broke is one the spec actually requires.",
      "The measurement costs one full suite run per mutant (40 by default), so run it once, late, on a green suite — not between builder bounces.",
      "Findings from it belong in sign_off: 'the suite does not hold down X' is exactly the kind of thing only you can see, and the gates cannot.",
    ],
    parameters: Type.Object({
      cwd: CWD_PARAM.properties.cwd,
      maxMutants: Type.Optional(
        Type.Number({
          description:
            "Cap on mutants run (default 40). Each one costs a full suite run, so raise it only on a fast suite.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const r = await runMutationScore(
        cwd,
        params.maxMutants === undefined ? {} : { maxMutants: params.maxMutants },
      );
      return gateOutput("mutation-score", r.code, r.lines);
    },
  });

  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description:
      "Wait, doing nothing, for `seconds` (1-120), then return. This is the ONLY way to pass time, and it exists so that waiting out a working subagent costs a wait instead of a junk gate run. Between `subagent { action: \"status\" }` polls on a child that is still working, call this. NEVER call a gate to pass time: a gate run is a claim about the project's state, and one made to fill a gap corrupts the only record of what actually happened.",
    promptSnippet: "Wait a few seconds for a working subagent, without polling a gate.",
    promptGuidelines: [
      "The poll loop is: `subagent { action: \"status\", id }`, then sleep, then status again. 30-60s is the useful interval for a worker mid-task; anything under 5s spends a turn to learn nothing.",
      "Prefer `subagent_wait` when you hold it and the child is a live async run — it returns the moment the child is done rather than at the end of a fixed interval. Reach for sleep when there is nothing to wait ON: a stalled child, a poll you want to space out, a retry you want to delay.",
      "It is never a substitute for doing work. If there is design or arbitration you could be doing while a worker runs, do that instead.",
    ],
    parameters: Type.Object({
      seconds: Type.Number({
        minimum: 1,
        maximum: 120,
        description: "How long to wait, in seconds. 1-120; values outside that range are clamped.",
      }),
      cwd: CWD_PARAM.properties.cwd,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const seconds = clampSleepSeconds(params.seconds);
      const waited = await sleepSeconds(seconds, signal);
      // Logged so a run's story shows the wait rather than a gap. Without this
      // line "the architect waited two minutes" and "the architect did nothing
      // for two minutes" are the same absence in the transcript.
      logGuardEvent(cwd, {
        guard: "sleep",
        verdict: "pass",
        summary: `waited ${waited}s`,
        detail: { seconds: waited, requested: params.seconds },
      });
      return {
        content: [{ type: "text" as const, text: `sleep: waited ${waited}s` }],
        details: { code: 0, ok: true, seconds: waited },
      };
    },
  });

  pi.registerTool({
    name: "git",
    label: "Git",
    description:
      "Run any git command. Args are passed as an array, exactly as git would receive them: [\"log\", \"--oneline\", \"-10\"]. Unrestricted on purpose — reflog, bisect, blame and stash archaeology are when you need git most, and a closed verb list would cage you exactly then.",
    promptSnippet: "Run a git command (args as an array).",
    promptGuidelines: [
      "Pass args as an array, not a shell string: [\"commit\", \"-m\", \"message\"] — there is no shell, so quoting and pipes do not apply.",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description:
          'Git arguments as an array, e.g. ["status", "--short"] or ["show", "abc123:path/to/file.ts"].',
      }),
      cwd: CWD_PARAM.properties.cwd,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = targetCwd(ctx.cwd, params.cwd);
      const { code, stdout, stderr } = await runGit(params.args, cwd, signal);
      logGuardEvent(cwd, {
        guard: "git",
        verdict: code === 0 ? "pass" : "block",
        summary: `git ${params.args.join(" ")} → exit ${code}`,
        detail: { args: params.args, code },
      });
      const text = [stdout, stderr].filter((s) => s.trim() !== "").join("\n") || `(exit ${code})`;
      return { content: [{ type: "text" as const, text }], details: { code, ok: code === 0 } };
    },
  });
}

/** Spawn git directly — no shell, so this tool is never itself an injection point. */
function runGit(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/** The `sleep` tool's bounds, applied rather than refused: a wait that is a
 *  little too long is not worth costing the architect a turn to re-issue. */
export const SLEEP_MIN_SECONDS = 1;
export const SLEEP_MAX_SECONDS = 120;

/** Clamp to [1, 120]; a non-finite request becomes the minimum. */
export function clampSleepSeconds(requested: number): number {
  if (!Number.isFinite(requested)) return SLEEP_MIN_SECONDS;
  return Math.min(SLEEP_MAX_SECONDS, Math.max(SLEEP_MIN_SECONDS, Math.round(requested)));
}

/** Wait `seconds`, returning early (and reporting the truth) if aborted. */
function sleepSeconds(seconds: number, signal?: AbortSignal): Promise<number> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolvePromise(Math.round((Date.now() - started) / 1000));
    };
    const timer = setTimeout(done, seconds * 1000);
    signal?.addEventListener("abort", done, { once: true });
  });
}
