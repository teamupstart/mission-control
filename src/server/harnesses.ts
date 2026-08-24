import {
  HarnessesConfigSchema,
  type HarnessesConfig,
  type HarnessesConfigPatch,
} from "@shared/protocol.ts";
import { resolveSessionRuntime } from "@shared/harness-capabilities.ts";
import {
  launchEffortFor,
  launchModelFor,
  taskKindAgent,
  taskKindDefaultFor,
} from "@shared/kind-defaults.ts";
import type { TaskKindDefault } from "@shared/protocol.ts";
import type { AgentType, SessionRuntime, TaskKind, ThinkingLevel } from "@shared/types.ts";
import { modelBelongsToAnotherHarness } from "@shared/model.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
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

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.harnesses;
const LEGACY_SESSION_RUNTIMES: HarnessesConfig["sessionRuntime"] = {
  claude: "terminal",
  codex: "terminal",
  pi: "terminal",
};

function isPreRuntimeHarnessesConfig(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, "sessionRuntime")
  );
}

/** The current config, with schema defaults applied over whatever was stored. */
export function getHarnessesConfig(): HarnessesConfig {
  const stored = getAppConfig(CONFIG_ENTRY);
  // A config row without this key predates runtime selection. It was created while terminal
  // was the only shipped behavior, so preserve that behavior for upgrades. An absent row is a
  // new installation and receives the schema's current Agent SDK defaults.
  const input = isPreRuntimeHarnessesConfig(stored)
    ? { ...stored, sessionRuntime: LEGACY_SESSION_RUNTIMES }
    : (stored ?? {});
  return HarnessesConfigSchema.parse(input);
}

/**
 * Merge a patch over the current config, persist, and return the result.
 *
 * Per-agent maps merge rather than being replaced wholesale, so a panel that only
 * changed the Claude default cannot clear the Codex one it never showed the operator.
 * Scalar keys use the shallow spread.
 */
export class HarnessesConfigError extends Error {}

export function setHarnessesConfig(patch: HarnessesConfigPatch): HarnessesConfig {
  const cur = getHarnessesConfig();
  const merged = mergeKindDefaults(cur.kindDefaults, patch.kindDefaults);
  // Judged on the MERGE, which is the only place it can be judged. The patch schema catches
  // the contradiction stated in one write (`agent: null` beside a model), but a patch naming
  // only a model is not contradictory on its own - it depends entirely on what the row it
  // lands on already holds. Refused rather than silently dropped by the read transform: an
  // API client that saved a model and got a 200 back has been told it worked.
  for (const [kind, row] of Object.entries(merged)) {
    if (row.model && row.agent === null) {
      throw new HarnessesConfigError(
        `the ${kind} kind inherits its agent, so it cannot pin the model ${row.model}`,
      );
    }
    // The other half of "a model belongs to one harness", which the browser enforces by
    // narrowing its Model select and stranding a model an agent change orphaned - and which a
    // direct `PUT` therefore does not get for free. Without this a row can be saved as
    // `{ agent: "codex", model: "claude-opus-4-8" }`, and because the agent MATCHES the task
    // it launches, `taskKindModel` hands that id to Codex as a `--model` flag rather than
    // dropping it.
    //
    // Positively-belongs-elsewhere, not absent-from-this-catalog: a model id is free text, so
    // a newer build's id and every model Pi mirrors from its account are legitimate values
    // this build has never heard of, and refusing those would refuse the honest case to catch
    // the impossible one.
    if (row.model && row.agent && modelBelongsToAnotherHarness(row.agent, row.model)) {
      throw new HarnessesConfigError(
        `the model ${row.model} belongs to another harness, so the ${kind} kind cannot run it on ${row.agent}`,
      );
    }
  }
  const next = HarnessesConfigSchema.parse({
    ...cur,
    ...patch,
    defaultModel: { ...cur.defaultModel, ...(patch.defaultModel ?? {}) },
    defaultEffort: { ...cur.defaultEffort, ...(patch.defaultEffort ?? {}) },
    sessionRuntime: { ...cur.sessionRuntime, ...(patch.sessionRuntime ?? {}) },
    kindDefaults: merged,
  });
  setAppConfig(CONFIG_ENTRY, next);
  return next;
}

/**
 * The kind rows, merged by KIND and then by FIELD within a kind.
 *
 * One level deeper than the per-agent maps above, because the value is itself a record and
 * the same lost-update argument applies inside it: the panel writes one cell at a time, so
 * a patch naming only `plan`'s effort must not replace `plan`'s whole row and take the
 * agent beside it with it.
 *
 * Mirrored in the browser by `mergeHarnessesPatch` - if this rule changes, that one follows.
 */
function mergeKindDefaults(
  cur: HarnessesConfig["kindDefaults"],
  patch: HarnessesConfigPatch["kindDefaults"],
): HarnessesConfig["kindDefaults"] {
  if (!patch) return cur;
  const next = { ...cur };
  for (const [kind, row] of Object.entries(patch) as [
    keyof HarnessesConfig["kindDefaults"],
    NonNullable<HarnessesConfigPatch["kindDefaults"]>[keyof HarnessesConfig["kindDefaults"]],
  ][]) {
    if (row) next[kind] = { ...next[kind], ...row };
  }
  return next;
}

/** This kind's stored launch defaults, read from the config in force right now. */
export function taskKindDefaults(kind: TaskKind): TaskKindDefault | null {
  return taskKindDefaultFor(getHarnessesConfig(), kind);
}

/**
 * The agent a task of this kind is FILED with, when its creator did not name one.
 *
 * The asymmetry that shapes this whole feature lives here. `tasks.agent` is `TEXT NOT
 * NULL`, so unlike the model and the effort there is no "unset" to resolve at launch: a
 * task must be created holding an agent, so the kind default is read ONCE, at creation, and
 * from then on the row carries an ordinary pin. An operator who changes a kind's agent
 * reaches the next task filed, never a task already shelved - which is the opposite of how
 * the model behaves, and is why the panel says so out loud.
 *
 * Called at the single convergence point every creator passes through
 * (`TaskManager.create`), plus the dispatch route, which needs the answer a few lines
 * earlier to run its capability checks against the agent the task will actually get.
 */
export function resolveTaskAgent(kind: TaskKind, requested?: AgentType | null): AgentType {
  return requested ?? taskKindAgent(getHarnessesConfig(), kind);
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
 *  - the KIND's model, when this task's agent matches the agent that row names.
 *  - the Harnesses panel default for this agent, else null.
 *
 * The tiers themselves live in `@shared/kind-defaults.ts`, so the dispatch form can label
 * its "Default - …" option with the answer this will actually give rather than a second
 * guess at it.
 */
export function resolveDispatchModel(
  agent: AgentType,
  taskModel: string | null,
  launchModel: string | null = null,
  kind: TaskKind | null = null,
): string | null {
  return launchModelFor(getHarnessesConfig(), agent, kind, taskModel, launchModel);
}

/**
 * The task override, then the kind's effort, then the launch-time harness default.
 *
 * The kind tier is guarded differently from the model tier above - a capability check rather
 * than an agent match - and `launchEffortFor` is where that reasoning is written down. What
 * matters at this seam is the ORDERING it forces on the caller: `model` is a parameter, so
 * the effort has to be resolved AFTER the model and against the answer that came back, not
 * beside it.
 */
export function resolveDispatchEffort(
  agent: AgentType,
  taskEffort: ThinkingLevel | null,
  kind: TaskKind | null = null,
  model: string | null = null,
): ThinkingLevel | null {
  return launchEffortFor(getHarnessesConfig(), agent, kind, taskEffort, model);
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
