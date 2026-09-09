# 2026-022: Two model tiers, named per project

**Status:** accepted

## Decision

The developer stage has four seats and two kinds of work, so it gets two model
parameters, not four. `<project>/.pi/dev-stage-models.json` names them:

```json
{ "designModel": "<pi model pattern>", "workerModel": "<pi model pattern>" }
```

`designModel` runs the judgment seats — architect and reviewer. `workerModel`
runs the production seats — test-writer and builder. pi's model pattern carries
the thinking level as a `:suffix`, so one string sets both the model and how
hard it thinks; that is why the tier is the whole setting.

The role→tier mapping is **harness-owned** (it is a statement about what a seat
does, which does not vary by project); the values are **per-project** (which
model is worth its price depends on the codebase and the budget). A `tool_call`
hook injects the tier's pattern onto a pipeline-role spawn, and logs a
`model-tier` guard event so the transcript proves which seat ran on what.

**Never fatal.** Missing file, missing key, unreadable, malformed, unknown
model: all mean "no override", with a warning at most. A gate refuses when
proceeding would produce a *wrong* result; running a seat on the session
default produces a right result more slowly, which is not a reason to stop.
Unknown keys warn rather than pass silently — `design_model` doing nothing at
all, invisibly, is the realistic failure.

## Why

Runs 10–12 measured design quality tracking the model, and run duration
tracking the volume seats. Paying design prices for volume is how a 35-minute
run happens; paying volume prices for design is how a bad contract gets frozen.
The knob has to exist per project, and it has to be small enough that setting
it is one decision per side rather than four.

Model choice is not enforcement — it buys quality rather than guaranteeing it —
so it is configuration with a log line, not a gate.

## Consequences

Two gaps are deliberate, not oversights:

- **The root architect session is not tiered by this mechanism.** A session
  launched into a bound role was never spawned through the `subagent` tool, so
  nothing can patch its model; it is tiered at launch instead
  (`pi --model <designModel>`, which `pi-ticket` passes through).
- **`workflowScript` children are moot.** Such a spawn names its children
  inside a JavaScript string, so no role is readable and no tier can be chosen
  — and the phase gate refuses those spawns for pipeline roles anyway.

Adding a fifth seat forces a tier decision: a drift test pins `TIER_BY_ROLE`'s
keys to the path policy's roster. Supersedes the framing of issue #5 ("model
tiering", closed), which assumed a per-role model list.
