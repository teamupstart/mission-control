import { getAppConfig, setAppConfig } from "../db.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { INSPECTOR_MODEL_ENV, resolveInspectorModel } from "@shared/inspector.ts";
import { isLlmRunnerId } from "@shared/llm.ts";
import type { ResolvedLlmRunner } from "@shared/llm.ts";
import { InspectorConfigSchema } from "@shared/protocol.ts";
import type { ResolvedModel } from "@shared/model-choice.ts";
import type { InspectorConfig, InspectorConfigPatch } from "@shared/protocol.ts";
import { llmRunnerChoice } from "../llm/config.ts";

// The Inspector's config: a schema-validated blob over the `app_config` KV, so a new
// key needs no migration - Zod's defaults are applied on every read, and a blob written
// by an older build gains new fields for free.

const CONFIG_KEY = "inspector";

/** The current config, with schema defaults applied over whatever was stored. */
export function getInspectorConfig(): InspectorConfig {
  return InspectorConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/** Merge a patch over the current config, persist, and return the result. */
export function setInspectorConfig(patch: InspectorConfigPatch): InspectorConfig {
  const next = InspectorConfigSchema.parse({ ...getInspectorConfig(), ...patch });
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/**
 * What the Inspector will spawn with, and which layer chose it.
 *
 * Here rather than in the worker because the ROUTE needs it too - the settings panel
 * cannot resolve the env layer itself - and a status route reaching into the worker to
 * ask would make the review loop a dependency of rendering a text box. The env lookup is
 * this side of the shared/server line for the usual reason: `envVar` reads `node:os`.
 *
 * Resolved per call, never captured: the config is editable at runtime through
 * `PUT /api/inspector/config`, and a value read at module load would need a restart.
 */
export function inspectorModel(cfg: InspectorConfig = getInspectorConfig()): ResolvedModel {
  return resolveInspectorModel(cfg, envVar(INSPECTOR_MODEL_ENV), inspectorRunner(cfg).id);
}

/**
 * Which provider the Inspector spawns through, and which layer chose it.
 *
 * Two rungs: the Inspector's own choice, then the app-wide ladder. This used to bottom out
 * at a literal `"claude"`, which is not the same thing at all - it made the Inspector the one
 * subsystem in the app that ignored `MISSION_LLM_RUNNER` and the app-wide setting whenever
 * its own provider was unset. An operator who had pinned the whole app to a provider got a
 * Claude review anyway, with nothing on screen saying so.
 *
 * An unreadable stored id is reported through `unknown` and then inherits, exactly as
 * `llmJobRunner` and `resolveForemanRunner` do: a silent replacement reads back as the
 * operator's own pick.
 *
 * Resolved per call, never captured - the config is editable at runtime through
 * `PUT /api/inspector/config`, and a value read at module load would need a restart.
 */
export function inspectorRunner(cfg: InspectorConfig = getInspectorConfig()): ResolvedLlmRunner {
  const asked = cfg.runner?.trim() ?? "";
  if (!asked) return llmRunnerChoice();
  if (isLlmRunnerId(asked)) return { id: asked, source: "config", unknown: null };
  return { ...llmRunnerChoice(), unknown: asked };
}
