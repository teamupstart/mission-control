import { PipelinesConfigSchema, type PipelinesConfig } from "@shared/pipeline.ts";
import type { PipelinesConfigPatch } from "@shared/protocol.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// Which repositories an operator has consented to, and how. A schema-validated blob over
// the `app_config` KV - the same pattern as `task-sources/config.ts`, `harnesses.ts` and
// `inspector/config.ts` - so a new key needs no migration: zod's defaults apply on every
// read, and a blob written by an older build gains new fields for free.

const CONFIG_KEY = "pipelines";

/** The consent config, with schema defaults applied over whatever was stored. */
export function getPipelinesConfig(): PipelinesConfig {
  return PipelinesConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/** Replace it, persist, and return the result. */
export function setPipelinesConfig(patch: PipelinesConfigPatch): PipelinesConfig {
  const next = PipelinesConfigSchema.parse(patch);
  setAppConfig(CONFIG_KEY, next);
  return next;
}
