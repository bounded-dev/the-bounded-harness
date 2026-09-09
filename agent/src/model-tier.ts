// Model-tier injection: the point where a seat's tier becomes the model that
// actually runs (issue #13, "Speed the seats").
//
// dev-stage-models.ts decides WHAT each seat should run on. This module is the
// trust boundary that makes it happen and records that it happened. Pure cores
// never log; the wiring layer does — the same split guard-log.ts,
// path-gate.ts and dev-tools.ts already follow.
//
// ── The mechanism, and why this one ──────────────────────────────────────
//
// Subagents are launched by the `subagent` tool from pi-subagents@0.52.1. Its
// top-level parameter schema (src/extension/schemas.ts) carries an optional
// `model`: "Default child model override. Full provider/id values are
// accepted." That value reaches
// `resolveEffectiveSubagentModel(params.model, agentConfig.model, parentModel,
// …)` (src/runs/foreground/subagent-executor.ts), where an explicit parameter
// beats agent frontmatter, which beats `subagents.agentOverrides`, which beats
// `subagents.defaultModel`, which beats the parent session's model. A `:high`
// style suffix on that string sets the child's thinking level
// (src/shared/model-info.ts, `splitKnownThinkingSuffix`). So one string on one
// parameter sets both halves of a tier.
//
// pi's `tool_call` extension hook makes `event.input` MUTABLE — "Mutate it in
// place to patch tool arguments before execution" (pi-coding-agent
// dist/core/extensions/types.d.ts). That is the whole mechanism: when a spawn
// names a pipeline role, put the tier's pattern on `input.model` before the
// tool runs.
//
// The alternatives were considered and rejected. Agent frontmatter `model:` is
// real and would work, but the values are per-project and the agent files are
// harness-global — one project's budget would become every project's. Settings
// `subagents.agentOverrides.<role>.model` has the same problem in the user
// settings file, and putting it in each project's `.pi/settings.json` means
// every project must know the harness's role names. The config file this reads
// keeps the role→tier mapping harness-owned and only the values per-project.
//
// ── Deliberate non-overrides ─────────────────────────────────────────────
//
// A caller that passed `model` itself keeps it. An explicit choice at the call
// site is more specific than a project default, and silently overwriting it
// would make the parameter a lie.
//
// A model the live registry does not know is NOT injected. pi-subagents throws
// `Unknown subagent model '<x>'` on an unresolvable explicit model, which would
// turn a stale config line into a dead run — precisely the failure mode the
// config's never-fatal rule exists to prevent. When the registry snapshot is
// unavailable (empty), validation is skipped rather than assumed to fail: no
// snapshot is not evidence of a bad model.
//
// ── What this cannot reach ───────────────────────────────────────────────
//
// * A `workflowScript` spawn names its children inside a JavaScript string,
//   so the target role is not visible in the tool input. The top-level `model`
//   parameter IS forwarded to workflow children as their default, but with no
//   readable role there is no tier to choose, so those spawns are left alone.
// * A ROOT session that is itself a pipeline role — `pi` in a directory whose
//   `.pi/dev-stage-role` says `architect`, which is how the dogfood harnessed
//   arm runs — was never spawned through this tool, so its model is whatever
//   the session was launched with. Only spawned seats are tiered.

import { logGuardEvent } from "./guard-log.ts";
import {
  patternForTier,
  readDevStageModels,
  tierForAgent,
  TIER_KEY,
  type DevStageModels,
  type ModelTier,
  type TierKey,
} from "./dev-stage-models.ts";

/** The guard name every event from this module carries. */
export const MODEL_TIER_GUARD = "model-tier";

/** Enough of a registry model to check a pattern against. */
export interface KnownModel {
  readonly provider: string;
  readonly id: string;
}

/** What was decided for one `subagent` call. */
export type TierPlan =
  | {
      readonly kind: "inject";
      readonly role: string;
      readonly tier: ModelTier;
      readonly key: TierKey;
      /** The pi model pattern, thinking suffix included. */
      readonly model: string;
    }
  | { readonly kind: "skip"; readonly why: SkipReason; readonly note?: string };

export type SkipReason =
  /** Not a `subagent` launch that names an agent. */
  | "not-a-spawn"
  /** A spawn, but of scout / product-expert / delegate / anything unmapped. */
  | "not-a-pipeline-role"
  /** No config, or this tier unset in it. */
  | "no-pattern"
  /** The caller passed `model` explicitly; their choice stands. */
  | "caller-chose"
  /** The pattern names no model the live registry knows. */
  | "unknown-model";

const SKIP = (why: SkipReason, note?: string): TierPlan =>
  note === undefined ? { kind: "skip", why } : { kind: "skip", why, note };

/**
 * The agent a `subagent` call is trying to start, if it names one.
 *
 * Deliberately the same shape as the phase gate's spawn detection: only a
 * launch is a spawn, and the agent name may arrive under any of four keys. The
 * two live in different modules because they answer different questions (may
 * this spawn happen / what should it run on) and the phase gate is a frozen
 * enforcement surface; a drift test pins the key lists together.
 */
export const SPAWN_AGENT_KEYS: readonly string[] = ["agent", "agentName", "name", "type"];

export function spawnTarget(input: Readonly<Record<string, unknown>>): string | undefined {
  const action = input["action"];
  if (typeof action === "string" && action !== "launch" && action !== "run") return undefined;
  for (const key of SPAWN_AGENT_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/**
 * Does the live registry know this pattern?
 *
 * A deliberately small matcher: exact `provider/id`, or a bare id that exactly
 * one available model offers. pi-subagents matches far more loosely (separator
 * and case variants, trailing date stamps), so anything this accepts it
 * accepts too — the asymmetry costs a missed override on an exotic spelling,
 * never a thrown spawn. An empty snapshot means "cannot tell", which is
 * treated as known.
 */
export function patternIsKnown(pattern: string, known: readonly KnownModel[]): boolean {
  if (known.length === 0) return true; // no snapshot ⇒ no evidence ⇒ do not block
  const base = stripThinkingSuffix(pattern);
  if (known.some((m) => `${m.provider}/${m.id}` === base)) return true;
  return known.filter((m) => m.id === base).length === 1;
}

/** pi's thinking levels, as pi-subagents' `splitKnownThinkingSuffix` knows them. */
const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** `provider/model:high` → `provider/model`. An unknown suffix is part of the id. */
export function stripThinkingSuffix(pattern: string): string {
  const colon = pattern.lastIndexOf(":");
  if (colon === -1) return pattern;
  return THINKING_LEVELS.includes(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
}

/**
 * Decide what one `subagent` call should run on. Pure.
 *
 * Every "no" is a named reason rather than a bare undefined, so the caller can
 * log the one case worth logging (a configured model the registry rejects)
 * and stay silent about the four that are ordinary.
 */
export function planModelTier(
  input: Readonly<Record<string, unknown>>,
  models: DevStageModels,
  known: readonly KnownModel[] = [],
): TierPlan {
  const role = spawnTarget(input);
  if (role === undefined) return SKIP("not-a-spawn");

  const tier = tierForAgent(role);
  if (tier === undefined) return SKIP("not-a-pipeline-role", role);

  const model = patternForTier(models, tier);
  if (model === undefined) return SKIP("no-pattern", TIER_KEY[tier]);

  const existing = input["model"];
  if (typeof existing === "string" && existing.trim() !== "") {
    return SKIP("caller-chose", existing);
  }

  if (!patternIsKnown(model, known)) return SKIP("unknown-model", model);

  return { kind: "inject", role, tier, key: TIER_KEY[tier], model };
}

/** The one-line summary a `model-tier` event carries. */
export function tierSummary(plan: Extract<TierPlan, { kind: "inject" }>): string {
  return `${plan.role} → ${plan.key} (${plan.model})`;
}

export interface ModelTierInput {
  readonly toolName: string;
  /** The tool's arguments. MUTATED in place when a tier applies. */
  readonly input: Record<string, unknown>;
  /** Target project root — the config is read from it, the event logged to it. */
  readonly cwd: string;
  /** Snapshot of the session's available models; empty when unavailable. */
  readonly known?: readonly KnownModel[];
}

// Warnings are per-process and per-project, not per-spawn: a malformed config
// is one mistake, and repeating it at every spawn buries the run's real output.
const warned = new Set<string>();

/** Test-only: forget which warnings this process has already emitted. */
export function resetModelTierWarnings(): void {
  warned.clear();
}

/**
 * Apply the project's tier to a `subagent` spawn, in place, and record it.
 *
 * Returns the plan so the caller (and the tests) can see what was decided.
 * Never throws: a failure here must cost a run its speed, never its life.
 */
export function applyModelTier(ev: ModelTierInput): TierPlan {
  if (ev.toolName !== "subagent") return SKIP("not-a-spawn");
  if (spawnTarget(ev.input) === undefined) return SKIP("not-a-spawn");

  const models = readDevStageModels(ev.cwd);
  reportWarnings(ev.cwd, models.warnings);

  const plan = planModelTier(ev.input, models, ev.known ?? []);

  if (plan.kind === "skip") {
    // Four of the five skips are ordinary and stay silent. A configured model
    // the registry does not know is a config error the run should be able to
    // see, so it is logged and warned exactly once.
    if (plan.why === "unknown-model") {
      reportWarnings(ev.cwd, [
        `model-tier: model "${plan.note}" is not in this session's model registry — ` +
          "the seat runs on the session default (a spawn with it would have failed outright)",
      ]);
    }
    return plan;
  }

  ev.input["model"] = plan.model;
  logGuardEvent(ev.cwd, {
    guard: MODEL_TIER_GUARD,
    verdict: "pass",
    summary: tierSummary(plan),
    detail: { role: plan.role, tier: plan.tier, key: plan.key, model: plan.model },
  });
  return plan;
}

/** One stderr line and one guard event per distinct warning, per project. */
function reportWarnings(cwd: string, warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (warned.has(`${cwd} ${warning}`)) continue;
    warned.add(`${cwd} ${warning}`);
    console.warn(`[model-tier] ${warning}`);
    logGuardEvent(cwd, {
      guard: MODEL_TIER_GUARD,
      verdict: "error",
      summary: warning,
      detail: { kind: "config-ignored" },
    });
  }
}
