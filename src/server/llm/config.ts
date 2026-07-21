import { envVar } from "@shared/harness-runtime.mjs";
import { LlmConfigSchema } from "@shared/protocol.ts";
import type { LlmConfig, LlmConfigPatch } from "@shared/protocol.ts";
import { LLM_JOB_IDS, LLM_JOB_SPECS, resolveLlmJobModel, resolveLlmJobModels } from "@shared/llm-jobs.ts";
import type { LlmJobId, ResolvedLlmJobModel } from "@shared/llm-jobs.ts";
import { LLM_RUNNER_ENV, resolveLlmRunner } from "@shared/llm.ts";
import type { ResolvedLlmRunner } from "@shared/llm.ts";
import type { LlmStatus } from "@shared/types.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { allLlmRunners } from "./index.ts";

// The LLM config: a schema-validated blob over the `app_config` KV, mirroring
// `foreman/config.ts` and `inspector/config.ts`, so a new key needs no migration - Zod's
// defaults are applied on every read, and a blob written by an older build gains new fields
// for free.
//
// What it holds is the two answers `@shared/llm.ts` separates: WHO does the app's offline
// work (the runner) and, for the daemon's own background jobs, on WHICH MODEL. Foreman's
// four roles and the Inspector's one keep their own blobs, because each is edited by the
// panel that owns that subsystem and a single writer per blob is what makes a per-key merge
// enough concurrency control.
//
// The env lookups are on this side of the shared/server line for the usual reason: `envVar`
// reads `node:os`, and the dashboard imports the resolvers.

const CONFIG_KEY = "llm";

/** The current config, with schema defaults applied over whatever was stored. */
export function getLlmConfig(): LlmConfig {
  return LlmConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/**
 * Merge a patch over the current config and persist it.
 *
 * `models` merges PER KEY - it does not replace the map - the one place this parts from
 * `setForemanConfig`'s plain spread, and for `setSkillsConfig`'s reason. Replacement would
 * make `{models: {goal: "…"}}` mean "goal set, and every other job cleared", so the panel
 * would have to round-trip the whole map on every commit. Which sounds survivable until two
 * dashboards are open: the second tab's field carries a map from its last poll and silently
 * clears an override the first tab just typed. A per-key merge makes edits to different jobs
 * commute, and there is nothing to lose by it - an empty string and an absent key are the
 * same fact to `resolveModelChoice`, so nothing needs deleting.
 */
export function setLlmConfig(patch: LlmConfigPatch): LlmConfig {
  const before = getLlmConfig();
  const next = LlmConfigSchema.parse({
    ...before,
    ...patch,
    models: { ...before.models, ...patch.models },
  });
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/**
 * Which runner the app's offline work spawns through, and which layer chose it.
 *
 * Resolved per call, never captured at module load: the config is editable at runtime
 * through `PUT /api/llm/config`, and a value read once would need a daemon restart to take
 * effect. Same rule `inspectorModel` follows.
 */
export function llmRunnerChoice(cfg: LlmConfig = getLlmConfig()): ResolvedLlmRunner {
  return resolveLlmRunner(cfg.runner, envVar(LLM_RUNNER_ENV));
}

/** What one background job will spawn with, and why. Per call, for the reason above. */
export function llmJobModel(job: LlmJobId, cfg: LlmConfig = getLlmConfig()): ResolvedLlmJobModel {
  return resolveLlmJobModel(job, cfg.models, envVar(LLM_JOB_SPECS[job].envKey));
}

/** Every job at once, plus the runner and the providers this build has - the panel's read. */
export function llmStatus(cfg: LlmConfig = getLlmConfig()): LlmStatus {
  const envValues = Object.fromEntries(
    LLM_JOB_IDS.map((job) => [job, envVar(LLM_JOB_SPECS[job].envKey)]),
  ) as Partial<Record<LlmJobId, string | undefined>>;
  return {
    runner: llmRunnerChoice(cfg),
    models: resolveLlmJobModels(cfg.models, envValues),
    // Ids AND labels, because a label lives on the implementation and the browser cannot
    // import one - see `LlmStatus.runners`.
    runners: allLlmRunners().map((r) => ({ id: r.id, label: r.label })),
  };
}
