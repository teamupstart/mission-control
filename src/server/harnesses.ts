import { HarnessesConfigSchema } from "@shared/protocol.ts";
import type { HarnessesConfig, HarnessesConfigPatch } from "@shared/protocol.ts";
import { resolveSessionRuntime } from "@shared/harness-capabilities.ts";
import type { AgentType, SessionRuntime, ThinkingLevel } from "@shared/types.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// The "Harnesses" SETTINGS section, mirroring foreman/config.ts and skills/config.ts:
// a schema-validated blob over the `app_config` KV, so a new key needs no migration.
//
// Not the harness registry, despite the neighbouring name: what an agent CAN DO lives in
// `src/server/harness/` (`HARNESSES`, and one spec per capability). This is what the
// operator chose in the panel of the same name.
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
 * Per-agent maps merge rather than being replaced wholesale, so a panel that only
 * changed the Claude default cannot clear the Codex one it never showed the operator.
 * Scalar keys use the shallow spread.
 */
export function setHarnessesConfig(patch: HarnessesConfigPatch): HarnessesConfig {
  const cur = getHarnessesConfig();
  const next = HarnessesConfigSchema.parse({
    ...cur,
    ...patch,
    defaultModel: { ...cur.defaultModel, ...(patch.defaultModel ?? {}) },
    defaultEffort: { ...cur.defaultEffort, ...(patch.defaultEffort ?? {}) },
    sessionRuntime: { ...cur.sessionRuntime, ...(patch.sessionRuntime ?? {}) },
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
 * mean for it to be worth setting.
 *
 * Three tiers, narrowest first:
 *  - `taskModel`, the task's own pin. An explicit operator choice in the dispatch modal,
 *    so it always wins.
 *  - `launchModel`, a model supplied for THIS LAUNCH ONLY. Foreman's per-harness backlog
 *    model arrives here. Deliberately not persisted anywhere: it is a property of one
 *    launch, and writing it onto the task row (which is what `TaskManager.dispatch` used
 *    to do) pinned the task permanently, since `reschedule` does not clear `model`.
 *  - the Harnesses panel default for this agent, else null.
 */
export function resolveDispatchModel(
  agent: AgentType,
  taskModel: string | null,
  launchModel: string | null = null,
): string | null {
  return taskModel ?? launchModel ?? getHarnessesConfig().defaultModel[agent];
}

/** The task override, then the launch-time harness default, else no effort override. */
export function resolveDispatchEffort(
  agent: AgentType,
  taskEffort: ThinkingLevel | null,
): ThinkingLevel | null {
  return taskEffort ?? getHarnessesConfig().defaultEffort[agent];
}

/**
 * How a freshly-dispatched `agent` should be DRIVEN: through a terminal pane, or embedded.
 *
 * Read at dispatch time for the same reason the model and effort are, and there is no
 * per-task override on purpose - one per-harness default read at launch is the whole
 * consent surface for this (a resolved decision on the plan). A stored value this build
 * cannot read, or one naming a runtime the harness has no driver behind, falls back to
 * `"terminal"` and says so out loud rather than dispatching something the operator did not
 * ask for; `resolveSessionRuntime` is the shared gate the settings panel narrows through
 * too, so the card and the daemon cannot disagree about which runtime is in force.
 */
export function resolveDispatchRuntime(agent: AgentType): SessionRuntime {
  const resolved = resolveSessionRuntime(agent, getHarnessesConfig().sessionRuntime[agent]);
  if (resolved.unknown) {
    console.warn(
      `[mission-control] the stored session runtime ${JSON.stringify(resolved.unknown)} for ` +
        `${agent} is not one this build knows - dispatching into a terminal instead`,
    );
  }
  if (resolved.unsupported) {
    console.warn(
      `[mission-control] ${agent} is configured to dispatch over the ${resolved.unsupported} ` +
        "runtime, but this build has no driver for it - dispatching into a terminal instead",
    );
  }
  return resolved.runtime;
}
