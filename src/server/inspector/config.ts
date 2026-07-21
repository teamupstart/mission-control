import { getAppConfig, setAppConfig } from "../db.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { INSPECTOR_MODEL_ENV, resolveInspectorModel } from "@shared/inspector.ts";
import { InspectorConfigSchema } from "@shared/protocol.ts";
import type { ResolvedModel } from "@shared/model-choice.ts";
import type { InspectorConfig, InspectorConfigPatch } from "@shared/protocol.ts";

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
  return resolveInspectorModel(cfg, envVar(INSPECTOR_MODEL_ENV), cfg.runner ?? "claude");
}
