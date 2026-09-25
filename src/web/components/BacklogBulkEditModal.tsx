import { useMemo, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import type { TaskDependencyInput } from "@shared/protocol.ts";
import { dependencyInputKey } from "@shared/task-bulk.ts";
import {
  BACKLOG_TASK_KINDS,
  PRIORITY_LABELS,
  TASK_KIND_INFO,
  TASK_PRIORITIES,
} from "@shared/task.ts";
import {
  AGENT_TYPES,
  type AgentType,
  type Session,
  type Task,
  type TaskKind,
  type TaskPriority,
  type ThinkingLevel,
} from "@shared/types.ts";
import type { WorkflowSummary } from "@shared/workflow.ts";
import { api } from "../lib/api.ts";
import {
  EMPTY_BULK_DRAFT,
  bulkEditRequest,
  changedFieldCount,
  dependencyCounts,
  labelCounts,
  resultingAgent,
  valueSummary,
  type BulkEditDraft,
} from "../lib/backlog-selection.ts";
import { ModelCatalogOptions, useHarnessModelCatalogs } from "../model-catalog.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** The `<select>` value for "leave each task as it is". Never a real value of any field. */
const LEAVE = "__leave";
/** The `<select>` value for "clear it back to the default" on a nullable field. */
const CLEAR = "__clear";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Edit the fixed-choice fields of several backlog tasks at once.
 *
 * Every field opens on "leave as is", and the hint beside it says what the selected tasks
 * hold now, so a change never lands on a value the operator did not know was there. Only
 * the fields they touch are sent. Labels and prerequisites are add/remove edits against
 * each task's own list, never a replacement, because a selection rarely shares one list.
 *
 * The daemon writes the change to every task or to none (`POST /api/tasks/bulk-update`).
 * A refusal keeps the dialog open with the reason, which names the task that caused it.
 *
 * Model and effort are only offered against ONE harness: the agent being set here, or the
 * one every selected task already shares. A model id means nothing to a different harness,
 * so with mixed agents the only choices are "leave" and "back to the default".
 */
export function BacklogBulkEditModal({
  taskIds,
  tasks,
  allTasks,
  sessions,
  workflowSummaries,
  onClose,
}: {
  /**
   * The ids the dialog was opened over, frozen when it opened. The request always names all
   * of them, so a task that left the backlog meanwhile makes the daemon refuse the edit rather
   * than letting it land on the rest.
   */
  taskIds: string[];
  /** The rows behind `taskIds` that still exist, in the same order. */
  tasks: Task[];
  /** Every task, for the prerequisite picker. */
  allTasks: Task[];
  /** Live sessions, which can also be prerequisites. */
  sessions: Session[];
  workflowSummaries: WorkflowSummary[];
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<BulkEditDraft>(EMPTY_BULK_DRAFT);
  const [labelInput, setLabelInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { resolve: resolveModels } = useHarnessModelCatalogs();

  const update = (patch: Partial<BulkEditDraft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setError(null);
  };

  const n = taskIds.length;
  /** Opened-over tasks that are gone, or no longer in the backlog. Apply will be refused. */
  const departed = n - tasks.filter((task) => task.status === "backlog").length;
  const agent = resultingAgent(tasks, draft);
  const changed = changedFieldCount(draft);
  const selectedIds = useMemo(() => new Set(taskIds), [taskIds]);
  const labels = useMemo(() => labelCounts(tasks), [tasks]);
  const prerequisites = useMemo(() => dependencyCounts(tasks), [tasks]);
  const published = useMemo(
    () => workflowSummaries.filter((w) => w.archivedAt === null && w.currentVersionId !== null),
    [workflowSummaries],
  );
  const workflowName = (id: string | null): string =>
    id === null ? "none" : (workflowSummaries.find((w) => w.id === id)?.name ?? "unavailable");

  /**
   * Prerequisites that can be added: backlog tasks OUTSIDE the selection, and live sessions.
   * A selected task is left out because the daemon refuses it - two selected tasks that each
   * gained the other would deadlock.
   */
  const prerequisiteChoices = useMemo(() => {
    const out = new Map<string, { input: TaskDependencyInput; label: string; group: "backlog" | "session" }>();
    for (const task of allTasks) {
      if (task.status !== "backlog" || selectedIds.has(task.id)) continue;
      out.set(`task:${task.id}`, {
        input: { type: "task", taskId: task.id },
        label: `${task.title} (${task.kind})`,
        group: "backlog",
      });
    }
    for (const session of sessions) {
      if (session.state === "exited" || !session.hooksSeen) continue;
      if (session.task && selectedIds.has(session.task.id)) continue;
      const input: TaskDependencyInput = session.task
        ? { type: "task", taskId: session.task.id }
        : { type: "session", sessionId: session.id };
      const key = dependencyInputKey(input);
      if (!out.has(key)) {
        out.set(key, { input, label: session.task?.title ?? session.name, group: "session" });
      }
    }
    for (const input of draft.dependenciesAdd) out.delete(dependencyInputKey(input));
    return [...out.entries()];
  }, [allTasks, draft.dependenciesAdd, selectedIds, sessions]);

  async function apply(): Promise<void> {
    const body = bulkEditRequest(taskIds, draft);
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.bulkUpdateTasks(body);
    setBusy(false);
    if (!r.ok) {
      setError(
        // The daemon cannot name a task that no longer exists, so say what that means here.
        r.error === "no such task"
          ? "A selected task was deleted while this dialog was open, so nothing was changed. Close it and select again."
          : (r.error ?? "could not edit those tasks"),
      );
      return;
    }
    onClose();
  }

  function addLabel(): void {
    const label = labelInput.trim();
    if (!label) return;
    const key = label.toLowerCase();
    setLabelInput("");
    // Adding a label that was marked for removal takes the removal back instead.
    const removal = draft.labelsRemove.find((l) => l.toLowerCase() === key);
    if (removal) {
      update({ labelsRemove: draft.labelsRemove.filter((l) => l !== removal) });
      return;
    }
    if (draft.labelsAdd.some((l) => l.toLowerCase() === key)) return;
    update({ labelsAdd: [...draft.labelsAdd, label] });
  }

  const toggleLabelRemoval = (label: string): void => {
    const on = draft.labelsRemove.includes(label);
    update({
      labelsRemove: on
        ? draft.labelsRemove.filter((l) => l !== label)
        : [...draft.labelsRemove, label],
    });
  };

  const toggleDependencyRemoval = (input: TaskDependencyInput): void => {
    const key = dependencyInputKey(input);
    const on = draft.dependenciesRemove.some((d) => dependencyInputKey(d) === key);
    update({
      dependenciesRemove: on
        ? draft.dependenciesRemove.filter((d) => dependencyInputKey(d) !== key)
        : [...draft.dependenciesRemove, input],
    });
  };

  const agentResets =
    draft.agent !== undefined &&
    tasks.some((task) => task.agent !== draft.agent) &&
    (draft.model === undefined || draft.effort === undefined);

  const priorityWord = (p: TaskPriority | null): string => (p ? PRIORITY_LABELS[p] : "unset");

  return (
    <Overlay
      id={OVERLAY_IDS.backlogBulkEdit}
      onClose={onClose}
      className="modal bulk-edit-modal"
      role="dialog"
      ariaLabel={`Edit ${plural(n, "backlog task")}`}
      closable={!busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <header className="modal-head">
          <h2>Edit {plural(n, "backlog task")}</h2>
          <Tooltip label="Close without changing anything (Escape)">
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
              ✕
            </button>
          </Tooltip>
        </header>

        <div className="modal-bleed bulk-edit-body">
          <p className="bulk-edit-lead">
            Only the fields you change are written. Everything else stays as each task has it.
          </p>
          <ul className="bulk-edit-titles" aria-label="Selected tasks">
            {tasks.map((task) => (
              <li key={task.id}>{task.title}</li>
            ))}
          </ul>
          {departed > 0 && (
            <p className="bulk-edit-warn bulk-edit-departed" role="alert">
              {departed === 1 ? "1 selected task has" : `${departed} selected tasks have`} left the
              backlog since this opened. Apply will be refused and nothing will change. Close this
              and select again.
            </p>
          )}

          <h3 className="bulk-edit-group">Triage</h3>
          <BulkRow
            label="Priority"
            changed={draft.priority !== undefined}
            hint={valueSummary(tasks.map((task) => priorityWord(task.priority)))}
          >
            <Tooltip label="Set one priority on every selected task, or clear it">
              <select
                aria-label="Priority"
                className="field-input"
                value={draft.priority === undefined ? LEAVE : (draft.priority ?? CLEAR)}
                onChange={(e) => {
                  const v = e.target.value;
                  update({ priority: v === LEAVE ? undefined : v === CLEAR ? null : (v as TaskPriority) });
                }}
              >
                <option value={LEAVE}>Leave as is</option>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
                <option value={CLEAR}>Clear priority</option>
              </select>
            </Tooltip>
          </BulkRow>

          <BulkRow
            label="Labels"
            changed={draft.labelsAdd.length + draft.labelsRemove.length > 0}
            hint={labels.length === 0 ? "none yet" : "click a label to remove it from every task"}
            wide
          >
            <span className="bulk-edit-chips" role="group" aria-label="Labels">
              {labels.map(({ label, count }) => {
                const removing = draft.labelsRemove.includes(label);
                return (
                  <Tooltip
                    key={label}
                    label={
                      removing
                        ? `Keep "${label}" on the tasks that have it`
                        : `Remove "${label}" from every selected task that has it`
                    }
                  >
                    <button
                      type="button"
                      className={`bulk-chip${removing ? " is-removing" : ""}`}
                      aria-pressed={removing}
                      aria-label={`Remove label ${label}`}
                      onClick={() => toggleLabelRemoval(label)}
                    >
                      {label} <span className="bulk-chip-n">{count}/{n}</span>
                    </button>
                  </Tooltip>
                );
              })}
              {draft.labelsAdd.map((label) => (
                <Tooltip key={`add:${label}`} label={`Don't add "${label}" after all`}>
                  <button
                    type="button"
                    className="bulk-chip is-adding"
                    aria-label={`Don't add label ${label}`}
                    onClick={() => update({ labelsAdd: draft.labelsAdd.filter((l) => l !== label) })}
                  >
                    + {label}
                  </button>
                </Tooltip>
              ))}
              <input
                className="field-input bulk-label-input"
                aria-label="Add a label"
                placeholder="+ label"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  addLabel();
                }}
                onBlur={addLabel}
              />
            </span>
          </BulkRow>

          <BulkRow
            label="Autopilot"
            changed={draft.enabled !== undefined}
            hint={valueSummary(tasks.map((task) => (task.enabled ? "on" : "off")))}
          >
            <span className="bulk-seg" role="radiogroup" aria-label="Autopilot">
              {([
                ["Leave", undefined],
                ["On", true],
                ["Off", false],
              ] as const).map(([text, value]) => (
                <Tooltip
                  key={text}
                  label={
                    value === undefined
                      ? "Leave each task's autopilot switch as it is"
                      : value
                        ? "Let Foreman's autopilot schedule every selected task"
                        : "Park every selected task: the autopilot skips it"
                  }
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.enabled === value}
                    className={draft.enabled === value ? "is-on" : ""}
                    onClick={() => update({ enabled: value })}
                  >
                    {text}
                  </button>
                </Tooltip>
              ))}
            </span>
          </BulkRow>

          <h3 className="bulk-edit-group">Crew</h3>
          <BulkRow
            label="Kind"
            changed={draft.kind !== undefined}
            hint={valueSummary(tasks.map((task) => task.kind))}
          >
            <Tooltip label="Set one task kind on every selected task">
              <select
                aria-label="Kind"
                className="field-input"
                value={draft.kind ?? LEAVE}
                onChange={(e) => {
                  const v = e.target.value;
                  update({ kind: v === LEAVE ? undefined : (v as TaskKind) });
                }}
              >
                <option value={LEAVE}>Leave as is</option>
                {BACKLOG_TASK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TASK_KIND_INFO[k].label}
                  </option>
                ))}
              </select>
            </Tooltip>
          </BulkRow>

          <BulkRow
            label="Agent"
            changed={draft.agent !== undefined}
            hint={valueSummary(tasks.map((task) => task.agent))}
          >
            <Tooltip label="Set which agent runs every selected task">
              <select
                aria-label="Agent"
                className="field-input"
                value={draft.agent ?? LEAVE}
                onChange={(e) => {
                  const v = e.target.value;
                  const next = v === LEAVE ? undefined : (v as AgentType);
                  // A model or effort picked for one harness means nothing to another, so a
                  // harness switch drops them. "Back to the default" is harness-neutral and stays.
                  update({
                    agent: next,
                    model: draft.model === null ? null : undefined,
                    effort: draft.effort === null ? null : undefined,
                  });
                }}
              >
                <option value={LEAVE}>Leave as is</option>
                {AGENT_TYPES.map((a) => (
                  <option key={a} value={a}>
                    {AGENT_IDENTITY[a].label}
                  </option>
                ))}
              </select>
            </Tooltip>
          </BulkRow>
          {agentResets && (
            <p className="bulk-edit-warn" role="note">
              Changing the agent resets each moved task's model and effort to the new agent's
              defaults unless you set them here.
            </p>
          )}

          <BulkRow
            label="Model"
            changed={draft.model !== undefined}
            hint={valueSummary(tasks.map((task) => task.model ?? "default"))}
          >
            <Tooltip label="Pin one model on every selected task, or put them back on the harness default">
              <select
                aria-label="Model"
                className="field-input"
                value={draft.model === undefined ? LEAVE : (draft.model ?? CLEAR)}
                onChange={(e) => {
                  const v = e.target.value;
                  update({ model: v === LEAVE ? undefined : v === CLEAR ? null : v });
                }}
              >
                <option value={LEAVE}>Leave as is</option>
                <option value={CLEAR}>Harness default</option>
                {agent && <ModelCatalogOptions catalog={resolveModels(agent, draft.model ?? null)} />}
              </select>
            </Tooltip>
          </BulkRow>

          <BulkRow
            label="Effort"
            changed={draft.effort !== undefined}
            hint={valueSummary(tasks.map((task) => task.effort ?? "default"))}
          >
            <Tooltip label="Pin one reasoning effort on every selected task, or put them back on the harness default">
              <select
                aria-label="Effort"
                className="field-input"
                value={draft.effort === undefined ? LEAVE : (draft.effort ?? CLEAR)}
                onChange={(e) => {
                  const v = e.target.value;
                  update({ effort: v === LEAVE ? undefined : v === CLEAR ? null : (v as ThinkingLevel) });
                }}
              >
                <option value={LEAVE}>Leave as is</option>
                <option value={CLEAR}>Harness default</option>
                {agent &&
                  capabilitiesFor(agent).effort?.levels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
              </select>
            </Tooltip>
          </BulkRow>
          {agent === null && (
            <p className="bulk-edit-note">
              These tasks use different agents, so a specific model or effort can't apply to all
              of them. Set the agent above to choose one.
            </p>
          )}

          <h3 className="bulk-edit-group">Flow</h3>
          <BulkRow
            label="After work"
            changed={draft.workflowId !== undefined}
            hint={valueSummary(tasks.map((task) => workflowName(task.workflowId)))}
          >
            <Tooltip label="Choose the Workflow that runs after each selected task finishes">
              <select
                aria-label="After work"
                className="field-input"
                value={draft.workflowId === undefined ? LEAVE : (draft.workflowId ?? CLEAR)}
                onChange={(e) => {
                  const v = e.target.value;
                  update({ workflowId: v === LEAVE ? undefined : v === CLEAR ? null : v });
                }}
              >
                <option value={LEAVE}>Leave as is</option>
                <option value={CLEAR}>None (finish without a Workflow)</option>
                {published.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name} · v{workflow.publishedVersion}
                  </option>
                ))}
              </select>
            </Tooltip>
          </BulkRow>

          <BulkRow
            label="Depends on"
            changed={draft.dependenciesAdd.length + draft.dependenciesRemove.length > 0}
            hint={prerequisites.length === 0 ? "none yet" : "click one to remove it from every task"}
            wide
          >
            <span className="bulk-edit-chips" role="group" aria-label="Prerequisites">
              {prerequisites.map(({ input, title, count }) => {
                const key = dependencyInputKey(input);
                const removing = draft.dependenciesRemove.some((d) => dependencyInputKey(d) === key);
                return (
                  <Tooltip
                    key={key}
                    label={
                      removing
                        ? `Keep "${title}" as a prerequisite`
                        : `Stop every selected task waiting for "${title}"`
                    }
                  >
                    <button
                      type="button"
                      className={`bulk-chip${removing ? " is-removing" : ""}`}
                      aria-pressed={removing}
                      aria-label={`Remove prerequisite ${title}`}
                      onClick={() => toggleDependencyRemoval(input)}
                    >
                      {title} <span className="bulk-chip-n">{count}/{n}</span>
                    </button>
                  </Tooltip>
                );
              })}
              {draft.dependenciesAdd.map((input) => {
                const key = dependencyInputKey(input);
                const title =
                  input.type === "task"
                    ? (allTasks.find((t) => t.id === input.taskId)?.title ?? input.taskId)
                    : (sessions.find((s) => s.id === input.sessionId)?.name ?? input.sessionId);
                return (
                  <Tooltip key={`add:${key}`} label={`Don't add "${title}" as a prerequisite after all`}>
                    <button
                      type="button"
                      className="bulk-chip is-adding"
                      aria-label={`Don't add prerequisite ${title}`}
                      onClick={() =>
                        update({
                          dependenciesAdd: draft.dependenciesAdd.filter((d) => dependencyInputKey(d) !== key),
                        })
                      }
                    >
                      + {title}
                    </button>
                  </Tooltip>
                );
              })}
              <Tooltip label="Add a prerequisite every selected task waits for">
                <select
                  aria-label="Add a prerequisite"
                  className="field-input bulk-dep-add"
                  value=""
                  onChange={(e) => {
                    const choice = prerequisiteChoices.find(([key]) => key === e.target.value);
                    if (choice) update({ dependenciesAdd: [...draft.dependenciesAdd, choice[1].input] });
                  }}
                >
                  <option value="">+ prerequisite</option>
                  {(["backlog", "session"] as const).map((group) => {
                    const options = prerequisiteChoices.filter(([, c]) => c.group === group);
                    if (options.length === 0) return null;
                    return (
                      <optgroup key={group} label={group === "backlog" ? "Backlog" : "Live sessions"}>
                        {options.map(([key, c]) => (
                          <option key={key} value={key}>
                            {c.label}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </Tooltip>
            </span>
          </BulkRow>

          {error && (
            <p className="bulk-edit-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="modal-foot">
          <span className="bulk-edit-sum">
            {changed === 0 ? "Nothing changed yet" : `${plural(changed, "field")} on ${plural(n, "task")}`}
          </span>
          <span className="actions-spacer" />
          <Tooltip label="Close without changing anything">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </Tooltip>
          <Tooltip label="Write these changes to every selected task. If any task refuses, none change.">
            <button type="submit" className="btn btn-primary" disabled={busy || changed === 0}>
              {busy ? "Applying…" : `Apply to ${plural(n, "task")}`}
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}

/** One field: a changed mark, its name, its control, and what the selection holds now. */
function BulkRow({
  label,
  changed,
  hint,
  wide = false,
  children,
}: {
  label: string;
  changed: boolean;
  hint: string;
  wide?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`bulk-row${changed ? " is-changed" : ""}${wide ? " has-chips" : ""}`}>
      <span className="bulk-row-mark" aria-hidden>
        {changed ? "✓" : ""}
      </span>
      <span className="bulk-row-name">{label}</span>
      <span className="bulk-row-control">{children}</span>
      <span className="bulk-row-hint">{hint}</span>
    </div>
  );
}
