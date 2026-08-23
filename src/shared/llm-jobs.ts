import { resolveModelChoice } from "./model-choice.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
import { guardProviderModel, providerModelDefault } from "./model.ts";
import type { LlmRunnerId } from "./llm.ts";

// The daemon's own background model calls - which model each of them runs as.
//
// The third set of ROLES on one ladder, beside `@shared/foreman-models.ts` (Foreman's
// four) and `@shared/inspector.ts` (the Inspector's one). Not a fourth resolver and not a
// second list under `llm.ts`: `resolveModelChoice` ranks the layers, a runner answers "how
// is a model called", and a role answers "which model". The original three were roles
// nobody owned: `task-title.ts`, `goal/refiner.ts` and `away/digest.ts` each held a bare
// `envVar(…) ?? "claude-haiku-4-5"`, with no config key and nothing surfacing them
// anywhere. Workflow context joined the same registry before its first caller, so its
// persisted key and operator-visible choice exist from the workflow foundation onward.
//
// They are grouped by SUBSYSTEM the same way the other two are - these are the daemon's
// operator-configurable jobs. Most are best-effort housekeeping calls; ensemble comparison
// is the review-shaped exception, still cheap by default but durably failed rather than
// replaced when the model cannot be reached. Foreman's roles stay with Foreman and the
// Inspector's with the Inspector; a panel that edited all three sets would be one surface
// writing three different config blobs.
//
// Pure, and in `shared`, for the reason `foreman-models.ts` is: the daemon SPAWNS with
// these answers and the settings panel DISPLAYS them, and a panel that renders a default
// the daemon does not use is a confident wrong answer to "what is this running as?".
// `process.env` is read by the CALLER and passed in - the web bundle imports this file and
// has no `process`.

/**
 * The daemon's background model calls, in display order.
 *
 * **APPEND-ONLY.** These ids are persisted as the KEYS of the `models` map inside the
 * `llm` blob in `app_config`, so renaming one does not migrate an operator's override - it
 * orphans it. The stored key stops matching a declared job, the job silently falls back to
 * its shipped default, and that is indistinguishable from never having set it.
 */
export const LLM_JOB_IDS = [
  "task-title",
  "goal",
  "away-digest",
  "workflow-context",
  "ensemble-comparison",
] as const;

export type LlmJobId = (typeof LLM_JOB_IDS)[number];

export interface LlmJobSpec extends ModelChoiceSpec {
  /**
   * The `envVar()` SUFFIX the daemon looks the override up by, which is not the string
   * `envVar` in `ModelChoiceSpec` - that one is the `MISSION_`-prefixed spelling the panel
   * PRINTS. Both are needed and they must agree; see `INSPECTOR_MODEL_ENV` for the same
   * split and the same reason.
   */
  envKey: string;
}

/**
 * Every job's spec. `Record<LlmJobId, LlmJobSpec>` is the enforcement: an id appended above
 * does not compile until it has said what it is for, what it defaults to, and how an
 * operator overrides it without the dashboard.
 *
 * Every fallback is Haiku, and every one is NAMED rather than left unset. That is not a
 * cost preference dressed up as a default - an unset `--model` inherits whatever the local
 * CLI happens to be logged in as, which is both the priciest tier available and
 * unanswerable from inside this app. These are scoped calls (name a task, summarise a
 * prompt, narrate a short digest, compact workflow context, compare a bounded candidate
 * set), so the cheap tier is the right one - but the reason they are written down is that
 * "nobody chose this" is not an acceptable answer to what the app spawns with.
 */
export const LLM_JOB_SPECS: Record<LlmJobId, LlmJobSpec> = {
  "task-title": {
    envKey: "TASK_TITLE_MODEL",
    envVar: "MISSION_TASK_TITLE_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Task title",
    blurb: "Names a dispatched task whose Title was left blank, for the card and the branch.",
  },
  goal: {
    envKey: "GOAL_MODEL",
    envVar: "MISSION_GOAL_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Goal",
    blurb: "Rewrites each session's raw prompt into the sentence its card shows.",
  },
  "away-digest": {
    envKey: "AWAY_DIGEST_MODEL",
    envVar: "MISSION_AWAY_DIGEST_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Away digest",
    blurb: "Narrates what the fleet did while you were away, over the deterministic rollup.",
  },
  "workflow-context": {
    envKey: "WORKFLOW_CONTEXT_MODEL",
    envVar: "MISSION_WORKFLOW_CONTEXT_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Workflow context",
    blurb: "Compacts user goals, decisions, and rationale for Persona review.",
  },
  // The one job that is a REVIEW rather than housekeeping, and it sits here for the reason
  // the header gives: it resolves through the same config -> env -> shipped-default ladder so
  // an operator's Settings edit lands on the next evaluation, not the next restart. The
  // shipped tier is deliberately the cheap one every other job uses - an evaluation the
  // operator has not tuned should not silently spend the priciest tier - and it is exactly
  // what a judging Persona's own model override, or a Settings value, replaces.
  //
  // It covers EVERY ensemble evaluator, not only Best-of-N's ranking: the consensus strategy's
  // divergence pass is the same cost class over the same evidence, and a second job id would be
  // a second Settings row an operator has to keep in step with the first for no gain. The id
  // itself is append-only - it is a persisted key in the `models` map - so the wording moves and
  // the spelling does not.
  "ensemble-comparison": {
    envKey: "ENSEMBLE_COMPARISON_MODEL",
    envVar: "MISSION_ENSEMBLE_COMPARISON_MODEL",
    fallback: "claude-haiku-4-5",
    label: "Ensemble evaluation",
    blurb:
      "Ranks Best-of-N candidates, and mines a Consensus run's divergences, in one tool-less call. A judging Persona's own model wins.",
  },
};

/**
 * The operator's per-job overrides, keyed by job id.
 *
 * A map rather than one field per job (which is how `ForemanModelConfig` does it) because
 * the ids are already a declared list and the panel writes one key at a time: a per-key
 * merge makes two tabs editing different jobs commute, the same argument `SkillsConfig`
 * makes for its own map. Unknown keys are ignored on read rather than rejected - a blob
 * written by a newer build must not stop this one resolving the jobs it does have.
 */
export type LlmJobModelConfig = Record<string, string | undefined>;

/**
 * The operator's per-job PROVIDER overrides, keyed by job id. Empty means inherit.
 *
 * The sibling of `LlmJobModelConfig` and stored the same way, for the same reason: the panel
 * writes one key at a time and a per-key merge makes two tabs commute. Typed as loose
 * strings rather than `LlmRunnerId` because it is read straight off a persisted blob - a
 * value a downgrade cannot resolve has to arrive intact so it can be REPORTED rather than
 * silently sanitised. `llmJobRunner` ranks it.
 */
export type LlmJobRunnerConfig = Record<string, string | undefined>;

export interface ResolvedLlmJobModel extends ResolvedModel {
  job: LlmJobId;
  /**
   * A model id that was asked for, belongs to a different provider, and was therefore
   * dropped in favour of this job's provider's own cheap default - or null.
   *
   * Carried out to the panel rather than swallowed, so a row can say the pair it was given
   * could not be honoured instead of presenting the substitute as the operator's choice.
   */
  unsupported: string | null;
}

/**
 * Resolve one job: config, then env, then the shipped fallback - all against ITS provider.
 *
 * `runner` is the provider this job actually resolved to, which after per-job overrides is
 * no longer the same answer for every job. It does two things: it picks the
 * provider-appropriate fallback, and it is what `guardProviderModel` refuses a mismatched
 * pair against. The guard runs LAST, over the winner of the ladder, because a mismatch can
 * enter at any rung - a legacy config value, an env var, or a provider that moved underneath
 * a saved id between restarts.
 */
export function resolveLlmJobModel(
  job: LlmJobId,
  models: LlmJobModelConfig | null | undefined,
  envValue: string | null | undefined,
  runner: LlmRunnerId = "claude",
): ResolvedLlmJobModel {
  const chosen = resolveModelChoice(
    { ...LLM_JOB_SPECS[job], fallback: providerModelDefault(runner, "cheap") },
    models?.[job],
    envValue,
  );
  const guarded = guardProviderModel(runner, chosen.id);
  return {
    job,
    id: guarded.id,
    // A substituted id came from the shipped provider default, not from the layer that asked
    // for the one that was dropped. Saying `config` here would credit the operator with a
    // choice the app declined to honour.
    source: guarded.unsupported === null ? chosen.source : "default",
    unsupported: guarded.unsupported,
  };
}

/**
 * Every job at once - what the daemon reports and the panel renders.
 *
 * Takes the env VALUES already looked up, never an env map or the var names: this module is
 * imported by the dashboard, and the daemon's `envVar()` reaches for `node:os`. Whoever
 * holds a real environment does the lookup; this only ranks the answers.
 */
export function resolveLlmJobModels(
  models: LlmJobModelConfig | null | undefined,
  envValues: Partial<Record<LlmJobId, string | undefined>>,
  /**
   * One provider for every job, or - now that a job can carry its own - a function asked per
   * job. A bare id stays accepted because most callers still have one answer, and because
   * the two forms mean the same thing when no override is set.
   */
  runner: LlmRunnerId | ((job: LlmJobId) => LlmRunnerId) = "claude",
): Record<LlmJobId, ResolvedLlmJobModel> {
  const runnerFor = typeof runner === "function" ? runner : (): LlmRunnerId => runner;
  return Object.fromEntries(
    LLM_JOB_IDS.map((job) => [job, resolveLlmJobModel(job, models, envValues[job], runnerFor(job))]),
  ) as Record<LlmJobId, ResolvedLlmJobModel>;
}
