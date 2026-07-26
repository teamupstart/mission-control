import { useEffect, useMemo, useState } from "react";
import type { AgentType, TaskKind, TaskPriority, ThinkingLevel } from "@shared/types.ts";
import type {
  MissionSchedule,
  ScheduleMissedPolicy,
  ScheduleOverlapPolicy,
  ScheduleValidationField,
} from "@shared/schedules.ts";
import { SCHEDULE_CATCHUP_CREATE_CAP } from "@shared/schedules.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { MAX_LABELS, PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import { modelChoicesFor } from "@shared/model.ts";
import {
  createSchedule,
  fetchRepos,
  previewSchedule,
  setScheduleEnabled,
  updateSchedule,
  type ScheduleDefinitionPayload,
} from "../../lib/api.ts";
import { parseLabelInput } from "../../lib/task-draft.ts";
import {
  CADENCE_PRESET_LABELS,
  availableTimezones,
  browserTimezone,
  expressionToForm,
  presetToExpression,
  scheduleDefinitionFingerprint,
  weekdayName,
  type CadenceForm,
  type CadencePreset,
} from "../../lib/schedules.ts";
import { RepoCombobox } from "../RepoCombobox.tsx";
import { LabelChips } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { SchedulePreview } from "./SchedulePreview.tsx";

/**
 * Create or edit a recurring mission. Configuration, not a compose surface: no
 * `DraftKind`, no attachment box, no send chord, no reset nonce - just local component
 * state that survives while the overlay is mounted (see the Recurring Missions plan).
 *
 * Every semantic judgement is still the daemon's. The presets assemble a five-field cron
 * STRING deterministically, but whether that string is valid, what instants it produces,
 * and whether Save & enable may proceed all come back from `POST /api/schedules/preview` -
 * the same route the save uses, so the browser can never preview a cadence the save
 * refuses. Save & enable re-previews the exact definition being saved before enabling it,
 * so a stale preview can never approve changed data.
 */

interface EditorDraft {
  name: string;
  intent: string;
  title: string;
  repoRoot: string;
  kind: TaskKind;
  agent: AgentType;
  priority: TaskPriority | "";
  labels: string;
  model: string;
  effort: ThinkingLevel | "";
  cadence: CadenceForm;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
}

function emptyDraft(): EditorDraft {
  return {
    name: "",
    intent: "",
    title: "",
    repoRoot: "",
    kind: "ship",
    agent: "claude",
    priority: "",
    labels: "",
    model: "",
    effort: "",
    cadence: { preset: "weekly", weekday: 1, monthday: 1, time: "08:00", expression: "0 8 * * 1" },
    timezone: browserTimezone(),
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
  };
}

/** Seed the editor from an existing schedule's active revision (edit mode). */
function draftFromSchedule(schedule: MissionSchedule): EditorDraft {
  const template = schedule.template;
  return {
    name: schedule.name,
    intent: template?.intent ?? "",
    title: template?.title ?? "",
    repoRoot: template?.repoRoot ?? "",
    kind: template?.kind ?? "ship",
    agent: template?.agent ?? "claude",
    priority: template?.priority ?? "",
    labels: (template?.labels ?? []).join(", "),
    model: template?.model ?? "",
    effort: template?.effort ?? "",
    cadence: expressionToForm(schedule.expression),
    timezone: schedule.timezone,
    overlapPolicy: schedule.overlapPolicy ?? "skip-active",
    missedPolicy: schedule.missedPolicy ?? "coalesce-latest",
  };
}

function draftToDefinition(draft: EditorDraft): ScheduleDefinitionPayload {
  return {
    name: draft.name.trim(),
    expression: presetToExpression(draft.cadence),
    timezone: draft.timezone,
    overlapPolicy: draft.overlapPolicy,
    missedPolicy: draft.missedPolicy,
    template: {
      title: draft.title.trim(),
      intent: draft.intent.trim(),
      repoRoot: draft.repoRoot.trim(),
      kind: draft.kind,
      agent: draft.agent,
      priority: draft.priority || null,
      labels: parseLabelInput(draft.labels),
      model: draft.model || null,
      effort: draft.effort || null,
    },
  };
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const PRESETS: CadencePreset[] = ["daily", "weekdays", "weekly", "monthly", "advanced"];

export function ScheduleEditor({
  schedule,
  onSaved,
  onCancel,
  onDirtyChange,
  onBusyChange,
}: {
  /** The schedule being edited, or null to create a new one. */
  schedule: MissionSchedule | null;
  /** A save landed; the argument is the canonical schedule the daemon returned. */
  onSaved: (saved: MissionSchedule) => void;
  onCancel: () => void;
  /** Report unsaved edits up, so closing the overlay can confirm before discarding. */
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<EditorDraft>(() =>
    schedule ? draftFromSchedule(schedule) : emptyDraft(),
  );
  const [repos, setRepos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ScheduleValidationField, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  // The fingerprint of the definition the last SUCCESSFUL preview described. Save & enable
  // re-previews anyway (the authoritative gate), but this drives the "preview is stale" hint.
  const [previewedOk, setPreviewedOk] = useState<string | null>(null);

  const timezones = useMemo(() => {
    const available = availableTimezones();
    return available.includes(draft.timezone) ? available : [draft.timezone, ...available];
  }, [draft.timezone]);

  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const setSaving = (saving: boolean): void => {
    setBusy(saving);
    onBusyChange?.(saving);
  };

  const update = (patch: Partial<EditorDraft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setFormError(null);
    onDirtyChange?.(true);
  };
  const updateCadence = (patch: Partial<CadenceForm>): void => {
    setDraft((prev) => ({ ...prev, cadence: { ...prev.cadence, ...patch } }));
    onDirtyChange?.(true);
  };

  const definition = useMemo(() => draftToDefinition(draft), [draft]);
  const fingerprint = useMemo(() => scheduleDefinitionFingerprint(definition), [definition]);
  const expression = definition.expression;
  const previewFresh = previewedOk === fingerprint;

  const labels = parseLabelInput(draft.labels);
  const effortLevels = capabilitiesFor(draft.agent).effort?.levels ?? [];

  /** Local required-field guard. Server validation stays authoritative; this improves UX. */
  function localValidation(): Partial<Record<ScheduleValidationField, string>> {
    const errors: Partial<Record<ScheduleValidationField, string>> = {};
    if (!draft.name.trim()) errors.name = "A schedule needs a name.";
    if (!draft.title.trim()) errors.title = "A task title is required so runs never spend a titling call.";
    if (!draft.intent.trim()) errors.intent = "Describe what the task should do.";
    if (!draft.repoRoot.trim()) errors.repoRoot = "Choose a repository.";
    return errors;
  }

  async function save(enable: boolean): Promise<void> {
    const local = localValidation();
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      setFormError("Fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    setFieldErrors({});
    setFormError(null);

    // Save & enable must first obtain a successful preview for the CURRENT definition, so
    // a stale or failed cadence can never be enabled. Save paused skips this - a paused
    // schedule starts no clock - but still relies on the save route's own validation.
    if (enable) {
      const preview = await previewSchedule({ ...definition, excludeScheduleId: schedule?.id });
      if (!preview.ok) {
        setSaving(false);
        setFieldErrors({ [preview.error.field]: preview.error.message });
        setFormError("The cadence must preview successfully before it can be enabled.");
        return;
      }
      setPreviewedOk(fingerprint);
    }

    // A create is atomic: the route takes `enabled` in one write.
    if (!schedule) {
      const result = await createSchedule({ ...definition, enabled: enable });
      setSaving(false);
      if (!result.ok) {
        if (result.field) setFieldErrors({ [result.field]: result.error ?? "Invalid value." });
        setFormError(result.error ?? "Could not save the schedule.");
        return;
      }
      if (result.schedule) onSaved(result.schedule);
      return;
    }

    // An EDIT is two requests - Phase 3 has no atomic update-and-enabled route - so the
    // ORDER carries the safety, and the rule is: move the enabled flag to its safe side
    // before the revision changes, never after.
    //
    // Pausing (target disabled) pauses FIRST: once the pause is durable no tick can fire,
    // so the new revision is never runnable while the operator asked for paused (a tick in
    // the gap could otherwise create a task from a just-saved, immediately-due cadence).
    // Enabling (target enabled) defers the enable until AFTER the update, so a revision is
    // only ever runnable once it is saved. Either way the save itself rolls the enabled
    // flag back on failure, so a rejected edit never changes the mission's running state.
    const wasEnabled = schedule.enabled;
    const pauseFirst = !enable && wasEnabled;

    if (pauseFirst) {
      const paused = await setScheduleEnabled(schedule.id, false);
      if (!paused.ok) {
        setSaving(false);
        setFormError(paused.error ?? "Could not pause the schedule.");
        return;
      }
    }

    const result = await updateSchedule(schedule.id, definition);
    if (!result.ok) {
      // The save failed: undo the pre-emptive pause so the mission is left exactly as it
      // was (enabled, previous revision) rather than stopped by a rejected edit.
      if (pauseFirst) await setScheduleEnabled(schedule.id, true);
      setSaving(false);
      if (result.field) setFieldErrors({ [result.field]: result.error ?? "Invalid value." });
      setFormError(result.error ?? "Could not save the schedule.");
      return;
    }

    // Enable only now, after the revision is durably saved (never before).
    if (enable && !wasEnabled) {
      const toggled = await setScheduleEnabled(schedule.id, true);
      setSaving(false);
      if (!toggled.ok) {
        setFormError(
          "Saved, but the mission could not be enabled - it stays paused. Resume it from the catalog.",
        );
        return;
      }
      if (toggled.schedule) onSaved(toggled.schedule);
      return;
    }

    setSaving(false);
    if (result.schedule) onSaved(result.schedule);
  }

  return (
    <div className="rm-editor">
      <fieldset className="rm-editor-form" disabled={busy}>
        <FormSection
          title="Task template"
          blurb="Every occurrence creates an ordinary backlog task from this immutable revision."
        >
          <Field label="Mission name" error={fieldErrors.name}>
            <input
              className="field-input"
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="e.g. Dependency audit"
            />
          </Field>
          {/* The hint names what the number COUNTS. Bare, it rendered as
              "Repository 202 in workspace", which parses as the repository being named 202. */}
          <Field
            label="Repository"
            hint={`${repos.length} available`}
            error={fieldErrors.repoRoot}
          >
            <RepoCombobox
              repos={repos}
              value={draft.repoRoot}
              onChange={(value) => update({ repoRoot: value })}
            />
          </Field>
          <Field label="Task title" error={fieldErrors.title}>
            <input
              className="field-input"
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              placeholder="e.g. Run dependency audit and update unsafe packages"
            />
          </Field>
          <Field
            label="Agent instructions"
            hint="stored as the generated task's intent"
            error={fieldErrors.intent}
            full
          >
            <textarea
              className="field-input field-textarea"
              value={draft.intent}
              onChange={(event) => update({ intent: event.target.value })}
              placeholder="What should the agent do each run?"
            />
          </Field>
          <div className="rm-field-row">
            <Field label="Agent">
              <Tooltip label="Which harness each generated task is dispatched to">
                <select
                  className="field-input"
                  value={draft.agent}
                  onChange={(event) =>
                    update({ agent: event.target.value as AgentType, model: "", effort: "" })
                  }
                >
                  {AGENT_TYPES.map((agent) => (
                    <option key={agent} value={agent}>
                      {AGENT_IDENTITY[agent].label}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
            <Field label="Task kind">
              <Tooltip label="Whether each run asks for a delivered change or an investigation">
                <select
                  className="field-input"
                  value={draft.kind}
                  onChange={(event) => update({ kind: event.target.value as TaskKind })}
                >
                  <option value="ship">ship - deliver a change</option>
                  <option value="scout">scout - investigate / report</option>
                </select>
              </Tooltip>
            </Field>
          </div>
          <div className="rm-field-row">
            <Field label="Priority" hint="optional">
              <Tooltip label="How each generated task is ranked in the backlog">
                <select
                  className="field-input"
                  value={draft.priority}
                  onChange={(event) => update({ priority: event.target.value as TaskPriority | "" })}
                >
                  <option value="">none</option>
                  {TASK_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {PRIORITY_LABELS[priority]}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
            <Field label="Labels" hint="optional - comma separated">
              <input
                className="field-input"
                value={draft.labels}
                onChange={(event) => update({ labels: event.target.value })}
                placeholder="e.g. maintenance, dependencies"
              />
              {labels.length > 0 && (
                <span className="rm-label-preview">
                  <LabelChips labels={labels} />
                  {labels.length >= MAX_LABELS && (
                    <span className="field-hint">{MAX_LABELS} maximum</span>
                  )}
                </span>
              )}
            </Field>
          </div>
          <div className="rm-field-row">
            <Field label="Model" hint={draft.model ? "overriding harness default" : "harness default"}>
              <Tooltip label="Pin the model each run launches with, overriding the harness default">
                <select
                  className="field-input"
                  value={draft.model}
                  onChange={(event) => update({ model: event.target.value })}
                >
                  <option value="">harness default</option>
                  {modelChoicesFor(draft.agent, draft.model).map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label} - {choice.hint}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
            <Field label="Effort" hint={draft.effort ? "overriding harness default" : "harness default"}>
              <Tooltip label="How much reasoning effort each run spends, overriding the harness default">
                <select
                  className="field-input"
                  value={draft.effort}
                  onChange={(event) => update({ effort: event.target.value as ThinkingLevel | "" })}
                  disabled={effortLevels.length === 0}
                >
                  <option value="">harness default</option>
                  {effortLevels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Cadence and time zone"
          blurb="Presets stay readable; the stored, validated schedule is a five-field cron expression. One hour is the minimum interval, and seconds are not expressible."
        >
          <div className="rm-field-row">
            <Field label="Repeats">
              <Tooltip label="A readable preset, or Advanced for the raw five-field expression">
                <select
                  className="field-input"
                  value={draft.cadence.preset}
                  onChange={(event) => updateCadence({ preset: event.target.value as CadencePreset })}
                >
                  {PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {CADENCE_PRESET_LABELS[preset]}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
            {draft.cadence.preset !== "advanced" && (
              <Field label="Time">
                <Tooltip label="Wall-clock time of day in the selected time zone">
                  <input
                    className="field-input"
                    type="time"
                    value={draft.cadence.time}
                    onChange={(event) => updateCadence({ time: event.target.value })}
                  />
                </Tooltip>
              </Field>
            )}
          </div>
          {draft.cadence.preset === "weekly" && (
            <Field label="Day of week">
              <Tooltip label="Which day of the week this mission runs">
                <select
                  className="field-input"
                  value={draft.cadence.weekday}
                  onChange={(event) => updateCadence({ weekday: Number(event.target.value) })}
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {weekdayName(day)}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
          )}
          {draft.cadence.preset === "monthly" && (
            <Field label="Day of month">
              <input
                className="field-input"
                type="number"
                min={1}
                max={31}
                value={draft.cadence.monthday}
                onChange={(event) => updateCadence({ monthday: Number(event.target.value) })}
              />
            </Field>
          )}
          {draft.cadence.preset === "advanced" && (
            <Field label="Cron expression" hint="five fields: minute hour day-of-month month day-of-week" error={fieldErrors.expression}>
              <input
                className="field-input rm-mono-input"
                value={draft.cadence.expression}
                onChange={(event) => updateCadence({ expression: event.target.value })}
                placeholder="0 8 * * 1"
              />
            </Field>
          )}
          <div className="rm-field-row">
            <Field label="Time zone" error={fieldErrors.timezone}>
              <Tooltip label="The IANA time zone the wall-clock cadence is interpreted in">
                <select
                  className="field-input"
                  value={draft.timezone}
                  onChange={(event) => update({ timezone: event.target.value })}
                >
                  {timezones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </Field>
            <Field label="Stored expression">
              <input className="field-input rm-mono-input" value={expression} readOnly />
            </Field>
          </div>
        </FormSection>

        <FormSection
          title="Laptop availability"
          blurb="No local timer can run while the CPU is suspended. V1 offers durable local catch-up; other modes are shown for context but cannot be selected yet."
        >
          <div className="rm-radio-cards">
            <Tooltip label="Durable local catch-up: the only execution mode available in V1">
              <label className="rm-radio-card is-selected">
                <input type="radio" name="rm-availability" value="local-catchup" checked readOnly />
                <span className="rm-radio-body">
                  <strong>Catch up when Mission Control resumes</strong>
                  Persist every due instant. No work runs while this laptop is asleep or powered
                  off; overdue instants are accounted for exactly once when the daemon resumes,
                  and the catalog shows the actual delay.
                </span>
                <span className="rm-radio-tag">Recommended · V1</span>
              </label>
            </Tooltip>
            <Tooltip label="OS-assisted wake is not available yet; catch-up remains the fallback">
              <label className="rm-radio-card is-disabled">
                <input type="radio" name="rm-availability" value="os-wake" disabled />
                <span className="rm-radio-body">
                  <strong>Ask the operating system to wake this machine</strong>
                  A platform wake adapter is not available yet. When added it will fall back to
                  catch-up and never promise wall-clock execution.
                </span>
                <span className="rm-radio-tag">Not available</span>
              </label>
            </Tooltip>
            <Tooltip label="An always-on runner is a separate future project; not available yet">
              <label className="rm-radio-card is-disabled">
                <input type="radio" name="rm-availability" value="remote-runner" disabled />
                <span className="rm-radio-body">
                  <strong>Run on an always-on Mission runner</strong>
                  The only mode that can promise wall-clock execution when the laptop is off.
                  A separate remote-runner project; not available yet.
                </span>
                <span className="rm-radio-tag">Future</span>
              </label>
            </Tooltip>
          </div>
        </FormSection>

        <FormSection
          title="Overlap and missed-run guardrails"
          blurb="These decide how many tasks a resume or an overlap produces."
        >
          <Field label="When prior generated work is still active">
            <Tooltip label="Whether to skip a run while this mission's previous task is still in flight">
              <select
                className="field-input"
                value={draft.overlapPolicy}
                onChange={(event) => update({ overlapPolicy: event.target.value as ScheduleOverlapPolicy })}
              >
                <option value="skip-active">Skip and record the occurrence</option>
                <option value="allow">Create another backlog task regardless</option>
              </select>
            </Tooltip>
          </Field>
          <Field
            label="After one or more missed occurrences"
            hint={`create-all is capped at the newest ${SCHEDULE_CATCHUP_CREATE_CAP} tasks per catch-up`}
          >
            <Tooltip label="What to do with instants that came due while Mission Control was not running">
              <select
                className="field-input"
                value={draft.missedPolicy}
                onChange={(event) => update({ missedPolicy: event.target.value as ScheduleMissedPolicy })}
              >
                <option value="coalesce-latest">Coalesce to one task on resume</option>
                <option value="create-all">Create every missed task</option>
                <option value="skip">Skip every missed task</option>
              </select>
            </Tooltip>
          </Field>
        </FormSection>
      </fieldset>

      <aside className="rm-editor-preview">
        <div className="rm-panel-head">
          <h3>Preview and enable</h3>
          {!previewFresh && <span className="rm-dim rm-tiny">edited since last preview</span>}
        </div>
        <SchedulePreview
          definition={definition}
          excludeScheduleId={schedule?.id}
          ready={Boolean(
            draft.name.trim() && draft.repoRoot.trim() && draft.title.trim() && draft.intent.trim(),
          )}
          onResult={(printed, result) => {
            if (result.ok) setPreviewedOk(printed);
          }}
        />
      </aside>

      <footer className="rm-editor-foot">
        <span className="rm-dim rm-small">
          {schedule ? "Editing creates a new immutable revision." : "Draft · not enabled"}
        </span>
        {formError && (
          <span className="rm-error rm-inline-error" role="alert">
            {formError}
          </span>
        )}
        <span className="rm-spacer" />
        <Tooltip label="Discard and return to the catalog">
          <button className="btn" onClick={() => !busy && onCancel()} disabled={busy}>
            Cancel
          </button>
        </Tooltip>
        <Tooltip label="Store the configuration without starting the clock">
          <button className="btn" onClick={() => void save(false)} disabled={busy}>
            Save paused
          </button>
        </Tooltip>
        <Tooltip label="Preview the cadence, then create/update this mission enabled">
          <button className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
            {busy ? "Saving…" : "Save & enable"}
          </button>
        </Tooltip>
      </footer>
    </div>
  );
}

function FormSection({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rm-form-section">
      <h3>{title}</h3>
      <p className="rm-dim">{blurb}</p>
      <div className="rm-form-fields">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  full,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  full?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className={`field rm-field${full ? " rm-field-full" : ""}${error ? " has-error" : ""}`}>
      <span className="field-label">
        {label}
        {hint && <span className="field-hint"> {hint}</span>}
      </span>
      {children}
      {error && <span className="rm-field-error">{error}</span>}
    </label>
  );
}
