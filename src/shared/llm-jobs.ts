import { resolveModelChoice } from "./model-choice.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";

// The daemon's own background model calls - which model each of them runs as.
//
// The third set of ROLES on one ladder, beside `@shared/foreman-models.ts` (Foreman's
// four) and `@shared/inspector.ts` (the Inspector's one). Not a fourth resolver and not a
// second list under `llm.ts`: `resolveModelChoice` ranks the layers, a runner answers "how
// is a model called", and a role answers "which model". These three are the roles nobody
// owned - `task-title.ts`, `goal/refiner.ts` and `away/digest.ts` each held a bare
// `envVar(…) ?? "claude-haiku-4-5"`, with no config key and nothing surfacing them
// anywhere, so "what is the titler running as?" had no answer short of reading the source.
//
// They are grouped by SUBSYSTEM the same way the other two are - these are the daemon's
// own housekeeping calls, all of them cheap, all of them degrading silently to a
// deterministic tier when the model cannot be reached. Foreman's roles stay with Foreman
// and the Inspector's with the Inspector; a panel that edited all three sets would be one
// surface writing three different config blobs.
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
export const LLM_JOB_IDS = ["task-title", "goal", "away-digest"] as const;

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
 * unanswerable from inside this app. These three are the narrowest things a model does
 * here (name a task, summarise a prompt into one sentence, write three sentences over a
 * list), each with a deterministic tier standing behind it, so the cheap tier is the right
 * one - but the reason they are written down is that "nobody chose this" is not an
 * acceptable answer to what the app spawns with.
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

export interface ResolvedLlmJobModel extends ResolvedModel {
  job: LlmJobId;
}

/** Resolve one job: config, then env, then the shipped fallback. */
export function resolveLlmJobModel(
  job: LlmJobId,
  models: LlmJobModelConfig | null | undefined,
  envValue: string | null | undefined,
): ResolvedLlmJobModel {
  return { job, ...resolveModelChoice(LLM_JOB_SPECS[job], models?.[job], envValue) };
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
): Record<LlmJobId, ResolvedLlmJobModel> {
  return Object.fromEntries(
    LLM_JOB_IDS.map((job) => [job, resolveLlmJobModel(job, models, envValues[job])]),
  ) as Record<LlmJobId, ResolvedLlmJobModel>;
}
