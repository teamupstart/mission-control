import { AGENT_IDENTITY } from "@shared/agent.ts";
import { launchEffortLevels } from "@shared/harness-capabilities.ts";
import { INHERITED_TASK_AGENT } from "@shared/kind-defaults.ts";
import { HARNESS_LAUNCHED_TASK_KINDS } from "@shared/task.ts";
import { TASK_KIND_INFO } from "@shared/task.ts";
import type { HarnessLaunchedTaskKind } from "@shared/task.ts";
import type { HarnessesConfig, TaskKindDefault } from "@shared/protocol.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import type { AgentType, ThinkingLevel } from "@shared/types.ts";
import {
  ModelCatalogOptions,
  useHarnessModelCatalogs,
  type ResolveHarnessModelCatalog,
} from "../model-catalog.tsx";
import type { HarnessesState } from "../useHarnesses.ts";
import { SettingsMatrix, type SettingsMatrixRow } from "./SettingsMatrix.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Task kinds grid: which harness files a `plan`, and what that harness launches on -
// asked once here instead of overridden by hand on every dispatch.
//
// Rendered through the SHARED `SettingsMatrix` with a fourth column declared, which is what
// that component's own comment asks for: extend by adding columns, never by forking a second
// table that drifts on the first fix.
//
// The row set is DERIVED (`HARNESS_LAUNCHED_TASK_KINDS`), so `pipeline` has no row - Conductor
// owns its downstream agent, model and effort - and a kind added later appears here by
// answering `TASK_KIND_BEHAVIOR` rather than by editing this file.
//
// NO `data-testid`: every control carries its own accessible name, which is what a spec selects.

/** The agent whose catalog and effort levels a row's cells are drawn from. */
function agentForRow(row: TaskKindDefault): AgentType {
  return row.agent ?? INHERITED_TASK_AGENT;
}

/**
 * Whether an agent change would strand the model pinned beside it.
 *
 * The task-kind transposition of `modelSurvivesProviderChange`: a dispatch model is pinned to
 * an AGENT rather than to a provider, so a row's own Agent select is a statement about that
 * row and its model has to follow. Stricter than the provider rule on purpose, and the reason
 * is the namespace: an LLM model id may be custom free text no catalog can disprove, while a
 * harness launch model is an id that harness's own catalog reports - so "this agent does not
 * offer it" is a positive answer here rather than an absence of evidence, and it is the same
 * answer the dispatch form has always given by resetting on every agent switch.
 *
 * Going back to Inherit never survives: an inheriting row may not hold a model at all.
 */
export function modelSurvivesAgentChange(
  model: string,
  agent: AgentType | null,
  resolveModels: ResolveHarnessModelCatalog,
): boolean {
  const pinned = model.trim();
  if (!pinned) return true;
  if (!agent) return false;
  return resolveModels(agent).choices.some((choice) => choice.id === pinned);
}

/**
 * What a row falls back to, NAMED - the same honesty the sibling matrix keeps, and the same
 * reason: an option reading only "Inherit" makes an operator open another panel to find out
 * what this row is actually running on.
 *
 * "Harness default" is the honest name for the unset case rather than a hedge. It is exactly
 * what the fallback does - pass no `--model` and let the CLI's own configuration decide - and
 * it is short enough to be READ inside a cell in a four-column grid, which the sentence it
 * replaced ("whatever Claude Code is set to") was not: it ran under the select's chevron and
 * lost its last word on every inheriting row at once.
 */
function inheritedModelLabel(
  agent: AgentType,
  defaults: HarnessesConfig["defaultModel"] | null,
  resolveModels: ResolveHarnessModelCatalog,
): string {
  if (!defaults) return "Inherit";
  const id = defaults[agent];
  if (!id) return "Inherit - harness default";
  const label = resolveModels(agent, id).choices.find((m) => m.id === id)?.label ?? id;
  return `Inherit - ${label}`;
}

function inheritedEffortLabel(
  agent: AgentType,
  defaults: HarnessesConfig["defaultEffort"] | null,
): string {
  if (!defaults) return "Inherit";
  const level = defaults[agent];
  return level ? `Inherit - ${level}` : "Inherit - harness default";
}

/**
 * The reason the Model cell is unavailable, or null when it is not.
 *
 * Carried as the control's `Tooltip` label, which is also its accessible description - never
 * as a native `title`, which this codebase has replaced everywhere (it does not fire on focus,
 * so a keyboard user would never meet the one sentence that explains the disabled box). A
 * control
 * disabled without a reason reads as a bug, and the rule behind this one is not guessable -
 * a model id is agent-namespaced, so a model stored against no agent could never apply to
 * anything, and the write schema refuses the pair rather than saving a control that silently
 * does nothing.
 */
function modelUnavailableWhy(row: TaskKindDefault): string | null {
  return row.agent === null
    ? "Choose an agent for this kind first - a model belongs to one harness, so a kind that inherits its agent can't pin one."
    : null;
}

/**
 * An Inherit OPTION's label, as the top row's plain reading of it.
 *
 * The same string either way, deliberately: the muted row states what the rows below inherit,
 * so a second phrasing there would be a second vocabulary for one fact. It loses the "Inherit
 * - " prefix, which is a thing you can choose rather than a thing this row is, and takes a
 * capital because it now starts a cell rather than continuing an option.
 */
function reading(optionLabel: string): string {
  const value = optionLabel.replace(/^Inherit - /, "");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function TaskKindDefaultsGroup({ state }: { state: HarnessesState }): React.JSX.Element {
  const { config, update, error } = state;
  const { resolve: resolveModels } = useHarnessModelCatalogs();
  const rows: SettingsMatrixRow[] = [
    {
      key: "kind-inherited",
      // "Inherited" and not "Every other kind", which was quietly false: every kind this app
      // launches has a row of its own below, so there is no other kind for this to be about.
      // What it IS about is the value an inheriting row resolves to.
      label: "Inherited",
      blurb: "What a row below resolves to while it is left on Inherit.",
      inherited: true,
      cells: {
        agent: <span className="settings-matrix-inherited-value">{AGENT_IDENTITY[INHERITED_TASK_AGENT].label}</span>,
        model: (
          <span className="settings-matrix-inherited-value">
            {reading(inheritedModelLabel(INHERITED_TASK_AGENT, config?.defaultModel ?? null, resolveModels))}
          </span>
        ),
        effort: (
          <span className="settings-matrix-inherited-value">
            {reading(inheritedEffortLabel(INHERITED_TASK_AGENT, config?.defaultEffort ?? null))}
          </span>
        ),
      },
      // Muted rather than the matrix's amber `settings-matrix-reset`, which is reserved for a
      // value that was DROPPED. This row states where an inherited value comes from -
      // information, not a warning, and colouring it as one would make an untouched
      // installation look like it had a problem.
      //
      // The three do NOT share a provenance, and saying they did sent the operator to a
      // Settings page that cannot change an inherited agent. Only the model and the effort
      // have a per-harness default behind them; the agent's fallback is
      // `INHERITED_TASK_AGENT`, a constant with no setting anywhere, so the honest answer is
      // that this row's own Agent cell is the only place to change it.
      note: (
        <span className="settings-matrix-inherited-note">
          The model and effort come from Settings → Harnesses, which is per harness rather than per
          kind. The agent has no setting behind it: {AGENT_IDENTITY[INHERITED_TASK_AGENT].label} is
          built in, so a row's own Agent is the only way to change it.
        </span>
      ),
    },
    ...HARNESS_LAUNCHED_TASK_KINDS.map((kind) => kindRow(kind)),
  ];

  function kindRow(kind: HarnessLaunchedTaskKind): SettingsMatrixRow {
    const row = config?.kindDefaults[kind] ?? { agent: null, model: null, effort: null };
    const agent = agentForRow(row);
    const modelWhy = modelUnavailableWhy(row);
    const levels = launchEffortLevels(agent, row.model);
    // A stored level this row's CURRENT model does not offer. It is not dropped - the row's
    // model can change back, and `max` on `gpt-5.6-sol` is a real setting the moment it does -
    // so it stays stored, stays selected, and says out loud that it is not applying right now.
    // Rendered as an option rather than left to fall off the list: a `<select>` whose value
    // matches no option draws its FIRST option instead, which here is "Inherit" - the panel
    // would be showing an inherited effort while the daemon held a pinned one.
    const strandedEffort = row.effort && !levels.includes(row.effort) ? row.effort : null;
    const commit = (patch: Partial<TaskKindDefault>): void => {
      void update({ kindDefaults: { [kind]: patch } });
    };
    return {
      key: `kind-${kind}`,
      label: TASK_KIND_INFO[kind].label,
      blurb: TASK_KIND_INFO[kind].purpose,
      anchor: `models/kind-${kind}`,
      cells: {
        agent: (
          <Tooltip label={`Which harness a ${TASK_KIND_INFO[kind].label} task is filed on when nobody picks one`}>
            <select
              aria-label={`Agent for ${TASK_KIND_INFO[kind].label} tasks`}
              className="field-input settings-matrix-provider"
              value={row.agent ?? ""}
              disabled={!config}
              onChange={(event) => {
                const next = (event.target.value || null) as AgentType | null;
                // One write, both halves. A model that the newly chosen agent does not offer
                // is stranded rather than merely mismatched, and landing the two as separate
                // states would show the operator a pair the daemon is about to refuse.
                commit(
                  modelSurvivesAgentChange(row.model ?? "", next, resolveModels)
                    ? { agent: next }
                    : { agent: next, model: null },
                );
              }}
            >
              <option value="">Inherit - {AGENT_IDENTITY[INHERITED_TASK_AGENT].label}</option>
              {AGENT_TYPES.map((a) => (
                <option key={a} value={a}>
                  {AGENT_IDENTITY[a].label}
                </option>
              ))}
            </select>
          </Tooltip>
        ),
        model: (
          <Tooltip
            label={
              modelWhy ??
              `Pin the model a ${TASK_KIND_INFO[kind].label} task launches on, read at launch`
            }
          >
            <select
              aria-label={`Model for ${TASK_KIND_INFO[kind].label} tasks`}
              className="field-input"
              value={row.model ?? ""}
              disabled={!config || modelWhy !== null}
              onChange={(event) => commit({ model: event.target.value || null })}
            >
              <option value="">
                {inheritedModelLabel(agent, config?.defaultModel ?? null, resolveModels)}
              </option>
              <ModelCatalogOptions catalog={resolveModels(agent, row.model)} />
            </select>
          </Tooltip>
        ),
        effort: (
          <Tooltip
            label={
              strandedEffort
                ? `${strandedEffort} is kept but not applying: the model this row launches on does not offer it, so the launch falls back to the harness default. Choose a model that offers it, or pick another level.`
                : `How much reasoning a ${TASK_KIND_INFO[kind].label} task launches with. Kept even when this row inherits its agent - the levels mean the same thing on any harness.`
            }
          >
            <select
              aria-label={`Effort for ${TASK_KIND_INFO[kind].label} tasks`}
              className="field-input"
              value={row.effort ?? ""}
              disabled={!config}
              onChange={(event) =>
                commit({ effort: (event.target.value || null) as ThinkingLevel | null })
              }
            >
              <option value="">{inheritedEffortLabel(agent, config?.defaultEffort ?? null)}</option>
              {/* Disabled, unlike the off-catalog MODEL option beside it, and the difference is
                  deliberate: an unknown model id may well be one this build has not heard of
                  and is legitimately choosable, while a level the harness does not offer for
                  this model is one nothing can act on. It can be kept and read; it cannot be
                  newly chosen. */}
              {strandedEffort && (
                <option value={strandedEffort} disabled>
                  {strandedEffort} - not offered for this model
                </option>
              )}
              {levels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Tooltip>
        ),
      },
    };
  }

  return (
    <div className="foreman-models" data-anchor="models/task-kinds">
      <p className="settings-group-label">Task kinds</p>
      <p className="settings-hint foreman-models-hint">
        A dispatched <strong>plan</strong> can run on a different harness and model from a{" "}
        <strong>ship</strong>, chosen once here instead of overridden by hand on every dispatch.
        A row left on Inherit takes the per-harness default shown in it, and the dispatch form
        can still override any of this for one task.
      </p>
      {/* The asymmetry, stated. An operator who expects a shelved task to pick up a changed
          agent has no other way to find out they are wrong: the model and effort are stored
          nullable on the task row and read at launch, while the agent is `NOT NULL` and has
          to be written when the task is filed. */}
      <p className="settings-hint foreman-models-hint">
        The <strong>model</strong> and <strong>effort</strong> are read when a task launches, so
        changing one reaches a task already waiting in the backlog. The <strong>agent</strong> is
        written when a task is created, so changing it reaches the next task filed and leaves
        the backlog as it stands.
      </p>
      <SettingsMatrix
        caption="Task kinds, and what each one dispatches on"
        columns={[
          { key: "agent", label: "Agent" },
          { key: "model", label: "Model" },
          { key: "effort", label: "Effort" },
        ]}
        rows={rows}
      />
      <p className="settings-hint foreman-models-hint">
        Pipeline tasks have no row: Conductor owns their downstream agent, model and effort.
      </p>
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}
