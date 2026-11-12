import { useState } from "react";
import type { WorkflowConfig, WorkflowSummary } from "@shared/workflow.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import type { SkillsState } from "../useSkills.ts";
import {
  BUILTIN_KIND_WORKFLOW_DEFAULTS,
  GRILL_FIRST_TASK_KINDS,
  HARNESS_LAUNCHED_TASK_KINDS,
  TASK_KIND_INFO,
  isGrillFirstTaskKind,
  taskDefaultWorkflowId,
} from "@shared/task.ts";
import { GRILL_SKILL } from "@shared/skills.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ConsoleCard } from "./settings-console.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { GRILL_FIRST_TIP } from "../lib/grill-first.ts";

/** Select values for a dispatch-default row that follows its built-in, or is explicitly None. */
const BUILTIN_OPTION = "__builtin";
const NONE_OPTION = "__none";

// Settings that shape what each kind of task is dispatched with.
//
// The per-kind after-work Workflow rows replace the single Dispatch default Settings ›
// Workflows used to hold. They live here because they are a property of the task kind, not of
// the Workflow subsystem's policy, and this category is where other per-kind task settings can
// land. The rows still write
// the Workflow config's `kindWorkflowDefaults`, through the same `useWorkflowSettings` state
// Settings › Workflows and Trust read, so no screen polls a second copy of that blob.
//
// Grill me first's per-kind defaults are stored in the Skills config, beside the skill they
// need, because like Plan storage they are pinned on each task at creation; they are drawn
// from the same `useSkills` state Settings › Skills reads.
export function TaskSettingsPanel({
  state,
  workflows = [],
  foremanEnabled = false,
  skills,
}: {
  state: WorkflowSettingsState;
  /** Live catalog; only active published workflows are valid dispatch defaults. */
  workflows?: WorkflowSummary[];
  /** The completion detector that turns the default into an automatic run. */
  foremanEnabled?: boolean;
  /** The Skills config and catalog, which carry the Grill me first defaults. */
  skills?: SkillsState;
}): React.JSX.Element {
  const { config, update, error } = state;
  const [busy, setBusy] = useState(false);
  const publishedWorkflows = workflows.filter(
    (workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null,
  );
  const view = skills?.view ?? null;
  const grillFirstKinds = view?.grillFirstKinds ?? [];
  const grill = view?.skills.find((row) => row.id === GRILL_SKILL);
  const grillOff = view !== null && (!view.enabled || grill?.enabled !== true);

  const save = async (next: WorkflowConfig): Promise<void> => {
    setBusy(true);
    try {
      await update(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        What each kind of task starts with when nothing names its own choice: a task from the
        dispatch form, the API, a task source or a recurring mission alike.
      </p>

      {(!config || (skills && !view)) && (
        <p className="settings-warn">
          Can't reach the daemon, so the stored defaults are unknown. The controls below are
          showing defaults, not its current state.
        </p>
      )}

      <ConsoleCard title="Dispatch defaults" anchor="tasks/dispatch-defaults">
        <p className="settings-hint">
          The Workflow each kind of task arms after its work. The dispatch form shows this
          choice inline and can override it per task. Built-in defaults follow Mission
          Control; a Workflow you choose here stays until you change it.
        </p>
        <div className="wf-default-rows">
          {HARNESS_LAUNCHED_TASK_KINDS.map((kind) => {
            const label = TASK_KIND_INFO[kind].label;
            const chosen = config?.kindWorkflowDefaults[kind];
            const builtinId = BUILTIN_KIND_WORKFLOW_DEFAULTS[kind];
            const builtinName = builtinId
              ? workflows.find((workflow) => workflow.id === builtinId)?.name ?? "unavailable Workflow"
              : "None";
            const unavailable = typeof chosen === "string"
              && !publishedWorkflows.some((workflow) => workflow.id === chosen);
            return (
              <div className="wf-default-row" key={kind}>
                <span className="wf-default-kind" aria-hidden>{label}</span>
                <Tooltip label={`Workflow preselected for every new ${label} task`}>
                  <select
                    className="field-input wf-default-select"
                    value={chosen === undefined ? BUILTIN_OPTION : chosen ?? NONE_OPTION}
                    disabled={!config || busy}
                    aria-label={`Default after-work Workflow for ${label} tasks`}
                    onChange={(event) => {
                      if (!config) return;
                      const { [kind]: _previous, ...rest } = config.kindWorkflowDefaults;
                      const value = event.target.value;
                      void save({
                        ...config,
                        kindWorkflowDefaults: value === BUILTIN_OPTION
                          ? rest
                          : { ...rest, [kind]: value === NONE_OPTION ? null : value },
                      });
                    }}
                  >
                    <option value={BUILTIN_OPTION}>Built-in default ({builtinName})</option>
                    <option value={NONE_OPTION}>None</option>
                    {publishedWorkflows.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>
                        {workflow.name} · v{workflow.publishedVersion}
                      </option>
                    ))}
                    {unavailable && <option value={chosen}>Unavailable Workflow</option>}
                  </select>
                </Tooltip>
              </div>
            );
          })}
        </div>
        {config
          && HARNESS_LAUNCHED_TASK_KINDS.some(
            (kind) => taskDefaultWorkflowId(kind, config.kindWorkflowDefaults) !== null,
          )
          && !foremanEnabled && (
          <p className="settings-warn wf-default-warning">
            Foreman is off. Turn it on before dispatching with these defaults, or choose None
            in the dispatch form.
          </p>
        )}
        {publishedWorkflows.length === 0 && (
          <p className="settings-hint wf-settings-empty">
            Publish a Workflow before choosing a dispatch default.
          </p>
        )}
      </ConsoleCard>

      <ConsoleCard title="Grill me first" anchor="tasks/grill-first">
        <p className="settings-hint">
          Whether each kind of task interviews you before it starts. The dispatch form can
          override it per task, and existing tasks keep what they were filed with.
        </p>
        <div className="wf-default-rows">
          {HARNESS_LAUNCHED_TASK_KINDS.filter(isGrillFirstTaskKind).map((kind) => {
            const label = TASK_KIND_INFO[kind].label;
            return (
              <div className="wf-default-row" key={kind}>
                <span className="wf-default-kind" aria-hidden>{label}</span>
                <Tooltip label={`Start every new ${label} task with Grill me first`}>
                  <input
                    type="checkbox"
                    checked={grillFirstKinds.includes(kind)}
                    disabled={!skills || !view}
                    aria-label={`Grill me first for ${label} tasks`}
                    onChange={(event) => {
                      if (!skills) return;
                      void skills.update({
                        grillFirstKinds: event.target.checked
                          ? GRILL_FIRST_TASK_KINDS.filter((k) => k === kind || grillFirstKinds.includes(k))
                          : grillFirstKinds.filter((k) => k !== kind),
                      });
                    }}
                  />
                </Tooltip>
                <InfoTip about="Grill me first" text={GRILL_FIRST_TIP} />
              </div>
            );
          })}
        </div>
        {grillFirstKinds.length > 0 && grillOff && (
          <p className="settings-warn wf-default-warning">
            The grill skill is off, so a task that grills first is refused at dispatch. Turn it on
            under Settings › Skills.
          </p>
        )}
      </ConsoleCard>

      {error && <p className="settings-error" role="alert">{error}</p>}
      {skills?.error && <p className="settings-error" role="alert">{skills.error}</p>}
    </section>
  );
}
