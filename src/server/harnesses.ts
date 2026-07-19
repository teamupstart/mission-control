import { HarnessesConfigSchema } from "@shared/protocol.ts";
import type { HarnessesConfig, HarnessesConfigPatch } from "@shared/protocol.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// The "Harnesses" settings section, mirroring foreman/config.ts and skills/config.ts:
// a schema-validated blob over the `app_config` KV, so a new key needs no migration.
//
// This is the only durable home for dispatch-time defaults. The dispatcher reads it
// at dispatch time (not construction), so a toggle mid-batch is honoured by the next
// session it launches without a restart.

const CONFIG_KEY = "harnesses";

/** The current config, with schema defaults applied over whatever was stored. */
export function getHarnessesConfig(): HarnessesConfig {
  return HarnessesConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/** Merge a patch over the current config, persist, and return the result. */
export function setHarnessesConfig(patch: HarnessesConfigPatch): HarnessesConfig {
  const next = HarnessesConfigSchema.parse({ ...getHarnessesConfig(), ...patch });
  setAppConfig(CONFIG_KEY, next);
  return next;
}
