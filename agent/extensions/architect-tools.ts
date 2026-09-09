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
      "The one design-phase call: contract-purity → scaffold → project typecheck → design-review → freeze, stopping at the first failure and returning one verdict. Run it once the contract is written and the reviewer has recorded its review; on a failure, fix what it names and re-run it. There are no separate scaffold or freeze tools — they are steps of this sequence, and the sequence has only one legal order.",
    promptSnippet: "Run the design phase: purity, scaffold, typecheck, review freshness, freeze.",
    promptGuidelines: [
      "It will not freeze a design nobody has read: commission the `reviewer` subagent first, and again after any edit to the spec or a contract — an edited design is an unreviewed design, and the step names the files that moved.",
      "The reviewer's findings are advisory and blockers do not fail this gate — settling them is yours. The passing line prints the blocker count so an unsettled one stays visible.",
      "Re-run it after every contract revision: a revised contract must be re-reviewed, re-scaffolded and re-frozen, and this is the only way to do the last two.",
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
