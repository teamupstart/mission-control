// The per-task-kind tier of the dispatch ladder, as pure functions over a config value.
//
// Shared rather than server-only because the dispatch form has to NAME what it is about to
// do - "Default for plan - GPT-5.6 Sol" rather than a bare "Default" that quietly means
// something else on this kind. A form that computed that answer with its own copy of the
// rules is a form that eventually disagrees with the daemon about which model a task will
// launch on, and the operator would have no way to tell which of the two was lying.
//
// So the ladder lives here, once. `src/server/harnesses.ts` supplies the stored config and
// exposes these as the resolvers the dispatcher calls; the browser supplies the config it
// already fetched for its "Default - …" labels. Neither reimplements a tier.

import { launchEffortLevels } from "./harness-capabilities.ts";
import { taskKindLaunchesHarness } from "./task.ts";
import type { HarnessesConfig, TaskKindDefault } from "./protocol.ts";
import type { AgentType, TaskKind, ThinkingLevel } from "./types.ts";

/**
 * The agent a task inherits when neither its creator nor its kind names one.
 *
 * A built-in constant, and deliberately not a setting: unlike the model and the effort, which
 * fall through to a per-harness default an operator can edit on Settings → Harnesses, there is
 * no app-wide "default agent" anywhere to fall through TO. A harness card cannot supply one
 * either, since the question is which card to use. Anything that names this value to an
 * operator has to say so rather than point at a page that cannot change it.
 */
export const INHERITED_TASK_AGENT: AgentType = "claude";

/**
 * This kind's stored row, or null when it has none it could ever use.
 *
 * The one door onto `kindDefaults`, because the key set is a RUNTIME filter over
 * `TASK_KINDS`: `pipeline` has no row at all - Conductor owns its downstream launch - and
 * asking for one has to answer "there is none" rather than read `undefined` off a record the
 * types describe as total.
 */
export function taskKindDefaultFor(
  config: HarnessesConfig,
  kind: TaskKind,
): TaskKindDefault | null {
  return taskKindLaunchesHarness(kind) ? config.kindDefaults[kind] ?? null : null;
}

/**
 * The agent a task of this kind is FILED with when its creator did not name one.
 *
 * Read once, at creation, and this is the asymmetry the whole feature turns on: `tasks.agent`
 * is `TEXT NOT NULL`, so unlike the model and the effort there is no "unset" for a row to
 * carry until launch. Changing a kind's agent therefore reaches the next task filed and
 * leaves the backlog exactly as it stands - the opposite of how the model below behaves.
 */
export function taskKindAgent(config: HarnessesConfig, kind: TaskKind): AgentType {
  return taskKindDefaultFor(config, kind)?.agent ?? INHERITED_TASK_AGENT;
}

/**
 * A kind's configured model, but only for the harness it was configured against.
 *
 * A model id is agent-namespaced - `claude-opus-4-8` is not something Codex can be launched
 * on - so the row's model applies only when the task's agent MATCHES the agent that row
 * names. A `plan` row set to Codex, dispatched on a task someone pinned to Claude, falls
 * through to Claude's own harness default rather than handing a CLI an id it will reject.
 *
 * There is no case where a configured model silently never applies: the write schema refuses
 * a model on a row that inherits its agent, so a row holding one always names its harness.
 */
export function taskKindModel(
  config: HarnessesConfig,
  agent: AgentType,
  kind: TaskKind,
): string | null {
  const row = taskKindDefaultFor(config, kind);
  return row && row.agent === agent ? row.model : null;
}

/**
 * A kind's configured effort, if the harness this launch is actually using offers it.
 *
 * Guarded DIFFERENTLY from the model above, and conflating the two would be the mistake.
 * Effort is one shared vocabulary (`THINKING_LEVELS`) rather than an agent-namespaced id:
 * "plan with high" is meaningful on any harness, and a row is deliberately allowed to set an
 * effort while inheriting its agent. So the level crosses the agent boundary, and what stops
 * it is a CAPABILITY check - does this harness, on the model this launch resolved, offer that
 * level at all?
 *
 * `model` is a parameter rather than something read from the row because `levelsFor` narrows
 * per model (Codex drops `max` on every model but its newest two), so the effort has to be
 * resolved AFTER the model and against the answer that actually came back.
 */
export function taskKindEffort(
  config: HarnessesConfig,
  agent: AgentType,
  kind: TaskKind,
  model: string | null,
): ThinkingLevel | null {
  const wanted = taskKindDefaultFor(config, kind)?.effort ?? null;
  if (!wanted) return null;
  return launchEffortLevels(agent, model).includes(wanted) ? wanted : null;
}

/**
 * The whole model ladder, narrowest tier first.
 *
 *  - `taskModel`, the task's own pin - an explicit operator choice, so it always wins.
 *  - `launchModel`, a model supplied for THIS LAUNCH ONLY (Foreman's backlog model).
 *  - the kind's model, when the task's agent matches the row's.
 *  - the per-harness default, else null - launch with no `--model` at all.
 */
export function launchModelFor(
  config: HarnessesConfig,
  agent: AgentType,
  kind: TaskKind | null,
  taskModel: string | null,
  launchModel: string | null,
): string | null {
  return (
    taskModel ??
    launchModel ??
    (kind ? taskKindModel(config, agent, kind) : null) ??
    config.defaultModel[agent]
  );
}

/** The whole effort ladder: the task's pin, the kind's offered level, the harness default. */
export function launchEffortFor(
  config: HarnessesConfig,
  agent: AgentType,
  kind: TaskKind | null,
  taskEffort: ThinkingLevel | null,
  model: string | null,
): ThinkingLevel | null {
  return (
    taskEffort ??
    (kind ? taskKindEffort(config, agent, kind, model) : null) ??
    config.defaultEffort[agent]
  );
}
