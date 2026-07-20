import { HarnessesConfigSchema } from "@shared/protocol.ts";
import type { HarnessesConfig, HarnessesConfigPatch } from "@shared/protocol.ts";
import type { AgentType } from "@shared/types.ts";
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

/**
 * Merge a patch over the current config, persist, and return the result.
 *
 * `defaultModel` merges per-agent rather than being replaced wholesale, so a panel
 * that only changed the Claude default cannot clear the Codex one it never showed
 * the operator. Every other key is a scalar, for which the shallow spread is right.
 */
export function setHarnessesConfig(patch: HarnessesConfigPatch): HarnessesConfig {
  const cur = getHarnessesConfig();
  const next = HarnessesConfigSchema.parse({
    ...cur,
    ...patch,
    defaultModel: { ...cur.defaultModel, ...(patch.defaultModel ?? {}) },
  });
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/**
 * The model a freshly-dispatched `agent` should launch on, or null to launch it
 * without a `--model` flag (deferring to the harness's own configuration).
 *
 * Read at dispatch time, not at task creation: a task shelved in the backlog before
 * the default changed launches on the new default, which is what "default" has to
 * mean for it to be worth setting. An explicit per-task `model` always wins.
 */
export function resolveDispatchModel(agent: AgentType, taskModel: string | null): string | null {
  return taskModel ?? getHarnessesConfig().defaultModel[agent];
}
