import { envVar } from "@shared/harness-runtime.mjs";
import { LlmConfigSchema } from "@shared/protocol.ts";
import type { LlmConfig, LlmConfigPatch } from "@shared/protocol.ts";
import { LLM_JOB_IDS, LLM_JOB_SPECS, resolveLlmJobModel, resolveLlmJobModels } from "@shared/llm-jobs.ts";
import type { LlmJobId, ResolvedLlmJobModel } from "@shared/llm-jobs.ts";
import {
  CLAUDE_TRANSPORT_ENV,
  CODEX_TRANSPORT_ENV,
  DEFAULT_CLAUDE_TRANSPORT,
  DEFAULT_CODEX_TRANSPORT,
  isClaudeTransport,
  isCodexTransport,
  isLlmRunnerId,
  LLM_RUNNER_ENV,
  resolveLlmRunner,
} from "@shared/llm.ts";
import type {
  ClaudeTransport,
  CodexTransport,
  LlmRunnerId,
  ResolvedLlmRunner,
} from "@shared/llm.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// The LLM config: a schema-validated blob over the `app_config` KV, mirroring
// `foreman/config.ts` and `inspector/config.ts`, so a new key needs no migration - Zod's
// defaults are applied on every read, and a blob written by an older build gains new fields
// for free.
//
// What it holds is the answers `@shared/llm.ts` separates: WHO does the app's offline work
// (the runner), HOW Claude's daemon-side tool-less calls reach that provider (the
// transport), and, for the daemon's own background jobs, on WHICH MODEL. Foreman's four
// roles and the Inspector's one keep their own blobs, because each is edited by the panel
// that owns that subsystem and a single writer per blob is what makes a per-key merge enough
// concurrency control.
//
// The env lookups are on this side of the shared/server line for the usual reason: `envVar`
// reads `node:os`, and the dashboard imports the resolvers.
//
// What is deliberately NOT here is `llmStatus`, which lives in `./status.ts`. It is the only
// thing that needs `allLlmRunners()`, and that one import pulls in every provider adapter -
// including `claude-cli.ts`, which freezes `MISSION_CLAUDE_BIN` at module load. This file is
// read by the Inspector's and Foreman's configs to resolve the app-wide rung of their
// ladders, and through `settings-status.ts` that reaches `registry.ts`; carrying the adapters
// along would put the operator's real `claude` binary into the module graph of anything that
// asks what provider a subsystem inherits. Reading a preference should not load a spawner.

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
    // Same per-key merge, same argument. Two tabs setting different jobs' providers commute,
    // and the panel never has to round-trip the whole map to change one row.
    runners: { ...before.runners, ...pinOutgoingProvider(before, patch), ...patch.runners },
  });
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/**
 * When the APP-WIDE provider moves, first write the outgoing one onto every job that has a
 * model and no provider of its own.
 *
 * Why here and why only then. Until this change a saved `models[job]` was implicitly bound
 * to the app-wide runner, because the panel wiped the whole map whenever that radio moved.
 * Afterwards a model means whatever `runners` says, and a legacy config says nothing - so the
 * next app-wide switch would carry a deliberate Claude model over to Codex. The moment the
 * radio moves is the moment that provenance is both needed and still knowable; a job with no
 * model has nothing to preserve, and a job with its own provider has already said so.
 *
 * The RESOLVED outgoing provider, not the raw stored field, so an installation driven by
 * `MISSION_LLM_RUNNER` pins the provider its models actually belong to rather than the empty
 * string sitting in the blob.
 *
 * This is a convenience - it preserves an operator's choice - and deliberately NOT what keeps
 * a pair valid. `guardProviderModel`, at resolution, is that; see its comment. A rule enforced
 * only where the config is written has as many back doors as it has writers, and this blob
 * already has a route, a second dashboard tab, and an env var that moves the answer with no
 * write at all. It writes only within `llm`: Foreman's blob has one writer of its own, and
 * reaching across would be what turns a per-key merge into a lost update.
 */
function pinOutgoingProvider(before: LlmConfig, patch: LlmConfigPatch): Record<string, string> {
  if (patch.runner === undefined) return {};
  const env = envVar(LLM_RUNNER_ENV);
  const outgoing = resolveLlmRunner(before.runner, env);
  // A write that lands on the same resolved provider is not a change, and pinning through it
  // would quietly convert every Inherit row into a pinned one for no reason - the provenance
  // is unchanged and still knowable at the next real change. Clearing the field IS a change,
  // because the effective provider then moves to the environment or the shipped default.
  if (resolveLlmRunner(patch.runner, env).id === outgoing.id) return {};
  const pins: Record<string, string> = {};
  for (const job of LLM_JOB_IDS) {
    if (!before.models[job]?.trim()) continue;
    if (before.runners[job]?.trim()) continue;
    pins[job] = outgoing.id;
  }
  return pins;
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

/**
 * Which wire protocol a daemon-side, tool-less Claude call uses.
 *
 * Resolved per call so a config edit reaches the next run. The stored choice wins, then
 * the environment chain, then the shipped default. Unknown values fall through to that
 * default; unknown stored values have already degraded to empty in the read schema above.
 */
export function claudeTransportChoice(cfg: LlmConfig = getLlmConfig()): ClaudeTransport {
  const configured = cfg.claudeTransport.trim();
  if (isClaudeTransport(configured)) return configured;
  const environment = envVar(CLAUDE_TRANSPORT_ENV)?.trim() ?? "";
  return isClaudeTransport(environment) ? environment : DEFAULT_CLAUDE_TRANSPORT;
}

/**
 * Which wire protocol a daemon-side Codex call uses. Same ladder as `claudeTransportChoice`.
 *
 * Resolved per call so a config edit reaches the next run rather than the next restart.
 */
export function codexTransportChoice(cfg: LlmConfig = getLlmConfig()): CodexTransport {
  const configured = cfg.codexTransport.trim();
  if (isCodexTransport(configured)) return configured;
  const environment = envVar(CODEX_TRANSPORT_ENV)?.trim() ?? "";
  return isCodexTransport(environment) ? environment : DEFAULT_CODEX_TRANSPORT;
}

/**
 * Which provider ONE background job spawns through, and which layer chose it.
 *
 * The persona rule, mirrored rather than reinvented (`resolvePersonaExecution`): the job's
 * own override, else the app-wide resolution. That is why this is written out instead of
 * delegating to `resolveLlmRunner(cfg.runners[job], undefined)` - that function bottoms out
 * at `DEFAULT_LLM_RUNNER_ID`, which is the right floor for the app-wide field and the wrong
 * one here. Beneath a per-job override sits the REST of the ladder, not the end of it.
 *
 * An unreadable override is reported through `unknown` and then inherits, because "I cannot
 * read your choice here" is much closer to "you did not choose here" than to "use whatever
 * ships" - and a silent replacement would read back as the operator's own pick.
 */
export function llmJobRunner(job: LlmJobId, cfg: LlmConfig = getLlmConfig()): ResolvedLlmRunner {
  const asked = cfg.runners[job]?.trim() ?? "";
  if (!asked) return llmRunnerChoice(cfg);
  if (isLlmRunnerId(asked)) return { id: asked, source: "config", unknown: null };
  return { ...llmRunnerChoice(cfg), unknown: asked };
}

/**
 * What one background job will spawn with, and why. Per call, for the reason above.
 *
 * `runnerId` is taken rather than re-derived when the caller already has it - `runJob`
 * resolves the provider once and hands the same answer to the registry and to this, so the
 * model it spawns with and the provider it spawns through cannot disagree.
 */
export function llmJobModel(
  job: LlmJobId,
  cfg: LlmConfig = getLlmConfig(),
  runnerId: LlmRunnerId = llmJobRunner(job, cfg).id,
): ResolvedLlmJobModel {
  return resolveLlmJobModel(job, cfg.models, envVar(LLM_JOB_SPECS[job].envKey), runnerId);
}
