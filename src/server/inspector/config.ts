import { getAppConfig, setAppConfig } from "../db.ts";
import { InspectorConfigSchema } from "@shared/protocol.ts";
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
