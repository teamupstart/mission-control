import {
  PipelinesConfigSchema,
  type PipelinesConfig,
  type PipelinesConfigInput,
} from "@shared/pipeline.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// Which repositories an operator has consented to, and how. A schema-validated blob over
// the `app_config` KV - the same pattern as `task-sources/config.ts`, `harnesses.ts` and
// `inspector/config.ts` - so a new key needs no migration: zod's defaults apply on every
// read, and a blob written by an older build gains new fields for free.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.pipelines;

/** The consent config, with schema defaults applied over whatever was stored. */
export function getPipelinesConfig(): PipelinesConfig {
  return PipelinesConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/** Replace it, persist, and return the result. */
export function setPipelinesConfig(patch: PipelinesConfigInput): PipelinesConfig {
  const next = PipelinesConfigSchema.parse(patch);
  setAppConfig(CONFIG_ENTRY, next);
  return next;
}
