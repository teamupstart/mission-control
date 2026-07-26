import { useEffect, useRef, useState } from "react";
import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { modelChoicesFor } from "@shared/model.ts";
import { withAttachments } from "@shared/attachments.ts";
import type { EnsembleLaunchEstimate } from "@shared/ensemble.ts";
import type {
  PersonaView,
  WorkflowSummary,
  WorkflowVersionMetadata,
} from "@shared/workflow.ts";
import {
  personaChoiceLabel,
  personaChoicesForDisplay,
} from "@shared/workflow.ts";
import {
  ENSEMBLE_STRATEGY_INFO,
  type EnsembleStrategyInfo,
  type StrategyFormField,
} from "@shared/ensemble-strategies.ts";
import { readyAttachments, type PendingAttachment } from "../../components/ImageDrop.tsx";
import { Tooltip } from "../../components/Tooltip.tsx";
import { createEnsemble, previewEnsemble } from "../../lib/api.ts";
import { workflowRequest } from "../../workflows/workflowApi.ts";
import type { EnsemblePreviewResult, StrategyIssue } from "../types.ts";
import {
  buildEnsembleCreateInput,
  defaultConfigFor,
  ensemblePreviewFingerprint,
  getConfigPath,
  setConfigPath,
  type EnsembleDispatchDraft,
} from "./config.ts";

/**
 * Everything the launch decision needs, lifted out of the body so the MODAL FOOTER can own
 * Review/Launch: the two-step lives in the one action row every other dispatch uses, instead of a
 * second row of buttons floating mid-form. The body reads the same object for issues and the plan
 * strip, so the footer and the form cannot disagree about whether the plan is reviewed.
 */
export interface EnsembleLaunchState {
  /** False while the modal is not in Ensemble mode - every action is then a no-op. */
  active: boolean;
  /** The current input matches the fingerprint the last preview recorded. */
  reviewed: boolean;
  previewing: boolean;
  launching: boolean;
  uploading: boolean;
  /** Repo and intent are both present - the same gate Single's Dispatch applies. */
  hasCompose: boolean;
  canLaunch: boolean;
  preview: EnsemblePreviewResult | null;
  previewIssues: StrategyIssue[];
  workflowUnsupported: boolean;
  launchError: string | null;
  /** The server's estimate once reviewed, the descriptor's live one until then. */
  estimate: EnsembleLaunchEstimate | null;
  review: () => Promise<void>;
  launchNow: () => Promise<void>;
}

/**
 * The preview/launch state machine for an Ensemble draft. Called unconditionally (it is a hook)
 * with `ensemble` undefined while the modal is in Single mode, where it stays inert. It never
 * compiles a plan or invents an estimate the server did not return - launch is a two-step
 * review-then-confirm, and any edit invalidates a stale review.
 */
export function useEnsembleLaunch({
  compose,
  ensemble,
  onEnsembleChange,
  uploading,
  onLaunched,
}: {
  compose: { repoRoot: string; title: string; intent: string; attachments: PendingAttachment[] };
  ensemble: EnsembleDispatchDraft | undefined;
  onEnsembleChange?: (draft: EnsembleDispatchDraft) => void;
  uploading: boolean;
  onLaunched?: (runId: string, submitted: EnsembleDispatchDraft) => void;
}): EnsembleLaunchState {
  const [preview, setPreview] = useState<EnsemblePreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const composeRef = useRef(compose);
  const ensembleRef = useRef(ensemble);
  composeRef.current = compose;
  ensembleRef.current = ensemble;

  const intent = withAttachments(compose.intent.trim(), readyAttachments(compose.attachments));
  const createInput = ensemble ? buildEnsembleCreateInput(compose, intent, ensemble) : null;
  const fingerprint = createInput ? ensemblePreviewFingerprint(createInput) : null;
  const reviewed = ensemble !== undefined && ensemble.previewFingerprint === fingerprint;
  const descriptor = ensemble ? ENSEMBLE_STRATEGY_INFO[ensemble.strategyId] : null;
  const liveEstimate = ensemble && descriptor ? descriptor.estimate(ensemble.config) : null;
  const hasCompose = compose.repoRoot.trim().length > 0 && compose.intent.trim().length > 0;
  const workflowUnsupported =
    ensemble !== undefined &&
    ensemble.workflow !== null &&
    reviewed &&
    preview?.workflow?.supported === false;
  const canLaunch =
    reviewed &&
    preview?.ok === true &&
    !uploading &&
    !launching &&
    hasCompose &&
    !workflowUnsupported;
  const previewIssues = reviewed ? preview?.issues ?? [] : [];
  const estimate = reviewed && preview ? preview.estimate : liveEstimate;

  const review = async (): Promise<void> => {
    if (!createInput || fingerprint === null) return;
    setPreviewing(true);
    setLaunchError(null);
    const submittedFingerprint = fingerprint;
    const result = await previewEnsemble(createInput);
    setPreviewing(false);
    const current = ensembleRef.current;
    const currentCompose = composeRef.current;
    setPreview(result);
    if (!current) return;
    const currentIntent = withAttachments(
      currentCompose.intent.trim(),
      readyAttachments(currentCompose.attachments),
    );
    const currentFingerprint = ensemblePreviewFingerprint(
      buildEnsembleCreateInput(currentCompose, currentIntent, current),
    );
    if (currentFingerprint !== submittedFingerprint) return;
    onEnsembleChange?.({ ...current, previewFingerprint: currentFingerprint });
  };

  const launchNow = async (): Promise<void> => {
    if (!ensemble || !createInput) return;
    setLaunching(true);
    setLaunchError(null);
    const submitted = ensemble;
    const result = await createEnsemble(createInput);
    setLaunching(false);
    if (result.ok) onLaunched?.(result.data.run.id, submitted);
    else setLaunchError(result.error);
  };

  return {
    active: ensemble !== undefined,
    reviewed,
    previewing,
    launching,
    uploading,
    hasCompose,
    canLaunch,
    preview,
    previewIssues,
    workflowUnsupported,
    launchError,
    estimate,
    review,
    launchNow,
  };
}

/**
 * The footer's half of the two-step: Review sits in the primary slot until the plan verifies,
 * then a green Reviewed chip appears beside the real Launch. Any edit clears the fingerprint,
 * which puts Review back. Rendered by the dispatch modal's footer, beside Cancel.
 */
export function EnsembleLaunchControls({
  launch,
}: {
  launch: EnsembleLaunchState;
}): React.JSX.Element {
  if (!launch.reviewed || launch.preview?.ok !== true) {
    return (
      <Tooltip label="Preview the exact launch plan, budget, and workflow before committing">
        <button
          type="button"
          className="btn btn-primary"
          disabled={launch.previewing || !launch.hasCompose || launch.uploading}
          onClick={() => void launch.review()}
        >
          {launch.previewing ? "Reviewing…" : "Review launch"}
        </button>
      </Tooltip>
    );
  }
  return (
    <>
      <span className="ensemble-reviewed-chip">Reviewed ✓</span>
      <Tooltip label="Launch the reviewed plan (idempotent on this request)">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!launch.canLaunch}
          onClick={() => void launch.launchNow()}
        >
          {launch.launching
            ? "Launching…"
            : launch.uploading
              ? "Uploading…"
              : `Launch ${launch.estimate ? launch.estimate.initialMembers : ""} agents`.trim()}
        </button>
      </Tooltip>
    </>
  );
}

/**
 * The Ensemble half of the dispatch form. The compose fields (repo, title, intent, attachments)
 * are the modal's, shared with Single; everything here configures the STRATEGY. It is
 * descriptor-driven: the strategy segments and the config controls come from
 * `ENSEMBLE_STRATEGY_INFO` and the strategy's own `StrategyFormSpec`, so a new strategy renders
 * without new UI. Launch state arrives as `launch` (see `useEnsembleLaunch`) so the plan strip
 * and the footer read one object.
 */
export function EnsembleDispatch({
  ensemble,
  onEnsembleChange,
  personas,
  workflowSummaries,
  launch,
}: {
  ensemble: EnsembleDispatchDraft;
  onEnsembleChange: (draft: EnsembleDispatchDraft) => void;
  personas: PersonaView[];
  workflowSummaries: WorkflowSummary[];
  launch: EnsembleLaunchState;
}): React.JSX.Element {
  const descriptor = ENSEMBLE_STRATEGY_INFO[ensemble.strategyId];
  const { preview, reviewed, previewIssues, estimate } = launch;

  const issuesFor = (key: string): StrategyIssue[] =>
    previewIssues.filter((issue) => issueMatchesField(issue, key));
  const evaluatorIssues = previewIssues.filter((issue) =>
    ["evaluator.personaId", "evaluator.personaRevision"].includes(normalizeIssuePath(issue.path)),
  );
  const workflowIssues = previewIssues.filter((issue) => issueMatchesField(issue, "workflow"));
  const routedIssues = new Set([
    ...descriptor.form.fields.flatMap((field) => issuesFor(field.key)),
    ...evaluatorIssues,
    ...workflowIssues,
  ]);
  const generalIssues = previewIssues.filter((issue) => !routedIssues.has(issue));
  const workflowUnsupported = launch.workflowUnsupported;
  const workflowResolution = reviewed ? preview?.workflow ?? null : null;

  const setConfig = (key: string, value: unknown): void =>
    onEnsembleChange({
      ...ensemble,
      config: setConfigPath(ensemble.config, key, value),
      previewFingerprint: null,
    });

  const pickStrategy = (id: typeof ensemble.strategyId): void => {
    if (id === ensemble.strategyId) return;
    onEnsembleChange({ ...ensemble, strategyId: id, config: defaultConfigFor(id), previewFingerprint: null });
  };

  const setWorkflow = (workflow: EnsembleDispatchDraft["workflow"]): void =>
    onEnsembleChange({ ...ensemble, workflow, previewFingerprint: null });

  // The tune row holds the single-control fields - steppers, selects, toggles - beside the
  // evaluator and workflow pickers; composite fields (rosters, judge panels, long text) keep
  // their own full-width sections above it. This is presentation grouping only: every field
  // still comes from the strategy's own descriptor and edits through the same `setConfig`.
  const wideFields = descriptor.form.fields.filter(
    (field) => field.kind === "member_roster" || field.kind === "lens_panel" || field.kind === "text",
  );
  const tuneFields = descriptor.form.fields.filter(
    (field) => field.kind === "int" || field.kind === "select" || field.kind === "toggle",
  );

  // Which published workflow versions we have checked for handoff compatibility, keyed by
  // (workflowId, version). Loaded lazily for the SELECTED choice only - the backend re-confirms
  // at Review either way, so this is advisory speed, not authority.
  const published = workflowSummaries.filter((w) => w.publishedVersion !== null && w.archivedAt === null);
  const selectedKey = ensemble.workflow
    ? workflowVersionCompatibilityKey(ensemble.workflow.workflowId, ensemble.workflow.workflowVersion)
    : null;
  const choices: WorkflowChoice[] = published.map((workflow) => ({
    key: workflowVersionCompatibilityKey(workflow.id, workflow.publishedVersion!),
    workflowId: workflow.id,
    workflowVersion: workflow.publishedVersion!,
    name: workflow.name,
  }));
  if (ensemble.workflow && selectedKey && !choices.some((choice) => choice.key === selectedKey)) {
    choices.unshift({
      key: selectedKey,
      workflowId: ensemble.workflow.workflowId,
      workflowVersion: ensemble.workflow.workflowVersion,
      name: workflowSummaries.find((workflow) => workflow.id === ensemble.workflow?.workflowId)?.name
        ?? ensemble.workflow.workflowId,
    });
  }
  const [compatibility, setCompatibility] = useState<Record<string, WorkflowCompatibility>>({});
  const [loadingCompatibilityKey, setLoadingCompatibilityKey] = useState<string | null>(null);
  const selectedCompatibility = selectedKey ? compatibility[selectedKey] : undefined;
  const selectedWorkflow = ensemble.workflow;

  useEffect(() => {
    if (!selectedWorkflow || !selectedKey || selectedCompatibility) {
      setLoadingCompatibilityKey((key) => (key === selectedKey ? null : key));
      return;
    }
    let current = true;
    const workflowId = selectedWorkflow.workflowId;
    const selectedVersion = selectedWorkflow.workflowVersion;
    setLoadingCompatibilityKey(selectedKey);
    void workflowRequest<WorkflowVersionMetadata[]>(
      `/api/workflows/${encodeURIComponent(workflowId)}/versions`,
    )
      .then((versions) => {
        if (!current) return;
        const version = versions.find((item) => item.version === selectedVersion);
        setCompatibility((known) => ({
          ...known,
          [selectedKey]: version
            ? compatibilityForWorkflowVersion(version)
            : {
                supported: null,
                reason: `Published workflow version ${selectedVersion} could not be found; the backend will confirm it at Review.`,
              },
        }));
      })
      .catch(() => {
        if (!current) return;
        setCompatibility((known) => ({
          ...known,
          [selectedKey]: {
            supported: null,
            reason: "Compatibility could not be loaded; the backend will confirm it at Review.",
          },
        }));
      })
      .finally(() => {
        if (current) {
          setLoadingCompatibilityKey((key) => (key === selectedKey ? null : key));
        }
      });
    return () => {
      current = false;
    };
  }, [selectedWorkflow, selectedKey, selectedCompatibility]);

  return (
    <div className="ensemble-dispatch">
      <div className="field">
        <span className="field-label">Strategy</span>
        <div className="dispatch-mode-toggle ensemble-strategy-seg" role="radiogroup" aria-label="Ensemble strategy">
          {Object.values(ENSEMBLE_STRATEGY_INFO).map((info) => (
            <Tooltip key={info.id} label={info.enabled ? info.blurb : "Not available yet"}>
              <button
                type="button"
                role="radio"
                aria-checked={info.id === ensemble.strategyId}
                className={info.id === ensemble.strategyId ? "active" : ""}
                disabled={!info.enabled}
                onClick={() => pickStrategy(info.id)}
              >
                {info.label}
              </button>
            </Tooltip>
          ))}
        </div>
        <Tooltip label={descriptor.explanation}>
          <p className="ensemble-strategy-blurb">{descriptor.blurb}</p>
        </Tooltip>
      </div>

      {wideFields.map((field) => (
        <FormField
          key={field.key}
          field={field}
          config={ensemble.config}
          personas={personas}
          issues={issuesFor(field.key)}
          onChange={setConfig}
        />
      ))}

      <div className="ensemble-tune">
        {tuneFields.map((field) => (
          <FormField
            key={field.key}
            field={field}
            config={ensemble.config}
            personas={personas}
            issues={issuesFor(field.key)}
            onChange={setConfig}
          />
        ))}
        {isObject(getConfigPath(ensemble.config, "evaluator")) && (
          <EvaluatorPicker
            personas={personas}
            selectedId={stringOrNull(getConfigPath(ensemble.config, "evaluator.personaId"))}
            issues={evaluatorIssues}
            onChange={(persona) => {
              const withId = setConfigPath(ensemble.config, "evaluator.personaId", persona?.id ?? null);
              const withRevision = setConfigPath(withId, "evaluator.personaRevision", persona?.revision ?? null);
              onEnsembleChange({ ...ensemble, config: withRevision, previewFingerprint: null });
            }}
          />
        )}
        <WorkflowField
          choices={choices}
          selectedKey={selectedKey}
          compatibility={compatibility}
          loadingCompatibilityKey={loadingCompatibilityKey}
          issues={workflowIssues}
          onChange={setWorkflow}
        />
      </div>
      <p className="ensemble-tune-hint">
        The comparison recommends; it cannot promote. A workflow reviews the confirmed winner
        only - it is not part of the candidate comparison.
        {!workflowResolution && selectedCompatibility?.reason && (
          <span
            className={
              selectedCompatibility.supported === false ? "ensemble-field-error" : "ensemble-muted"
            }
          >
            {" "}
            {selectedCompatibility.reason}
          </span>
        )}
      </p>

      {workflowResolution && (
        <dl className="ensemble-workflow-resolution">
          <div>
            <dt>Resolved workflow</dt>
            <dd>
              {workflowResolution.workflowName} v{workflowResolution.workflowVersion}
            </dd>
          </div>
          <div>
            <dt>Workflow · version ids</dt>
            <dd><code>{workflowResolution.workflowId}</code> · <code>{workflowResolution.workflowVersionId}</code></dd>
          </div>
          <div>
            <dt>Trigger · delivery</dt>
            <dd>{workflowResolution.triggerMode} · {workflowResolution.deliveryMode}</dd>
          </div>
          <div>
            <dt>Completion</dt>
            <dd>{workflowResolution.completionPolicy} · {workflowResolution.maxRepairRounds} repair rounds</dd>
          </div>
          <div>
            <dt>Supported</dt>
            <dd>{workflowResolution.supported ? "Yes" : `No${workflowResolution.unsupportedReason ? ` - ${workflowResolution.unsupportedReason}` : ""}`}</dd>
          </div>
        </dl>
      )}

      <PlanStrip descriptor={descriptor} config={ensemble.config} estimate={estimate} />

      {generalIssues.length > 0 && (
        <ul className="ensemble-issues" role="alert">
          {generalIssues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}
      {preview && preview.reason && !preview.ok && (
        <p className="ensemble-error" role="alert">
          This launch is refused: {preview.reason}.
        </p>
      )}
      {workflowUnsupported && (
        <p className="ensemble-error" role="alert">
          {preview?.workflow?.unsupportedReason ?? "The chosen workflow mode is not available yet."}
        </p>
      )}
      {launch.launchError && (
        <p className="ensemble-error" role="alert">
          {launch.launchError}
        </p>
      )}
      {!reviewed && preview && (
        <p className="ensemble-muted ensemble-stale-note" aria-live="polite">
          The draft changed - review again before launching.
        </p>
      )}
    </div>
  );
}

function FormField({
  field,
  config,
  personas,
  issues,
  onChange,
}: {
  field: StrategyFormField;
  config: unknown;
  /** The operator's Personas, for the field kinds that can offer one. */
  personas: PersonaView[];
  issues: StrategyIssue[];
  onChange: (key: string, value: unknown) => void;
}): React.JSX.Element {
  const error = <FieldIssues issues={issues} />;
  if (field.kind === "int") {
    const value = Number(getConfigPath(config, field.key) ?? field.min);
    const clamp = (next: number): number =>
      Math.max(field.min, Math.min(field.max, Number.isFinite(next) ? next : field.min));
    return (
      <div className="ensemble-field">
        <Tooltip label={field.help}>
          <span className="ensemble-field-name">{field.label}</span>
        </Tooltip>
        <span className="ensemble-stepper">
          <Tooltip label={`Decrease ${field.label}`}>
            <button
              type="button"
              aria-label={`Decrease ${field.label}`}
              disabled={value <= field.min}
              onClick={() => onChange(field.key, clamp(value - field.step))}
            >
              −
            </button>
          </Tooltip>
          <input
            type="number"
            aria-label={field.label}
            min={field.min}
            max={field.max}
            step={field.step}
            value={value}
            onChange={(e) => onChange(field.key, clamp(Number(e.target.value)))}
          />
          <Tooltip label={`Increase ${field.label}`}>
            <button
              type="button"
              aria-label={`Increase ${field.label}`}
              disabled={value >= field.max}
              onClick={() => onChange(field.key, clamp(value + field.step))}
            >
              +
            </button>
          </Tooltip>
        </span>
        {error}
      </div>
    );
  }
  if (field.kind === "toggle") {
    return (
      <Tooltip label={field.help}>
        <label className="ensemble-field ensemble-toggle-field">
          <span className="ensemble-toggle-row">
            <input
              type="checkbox"
              checked={Boolean(getConfigPath(config, field.key))}
              onChange={(e) => onChange(field.key, e.target.checked)}
            />
            {field.label}
          </span>
          {error}
        </label>
      </Tooltip>
    );
  }
  if (field.kind === "select") {
    return (
      <Tooltip label={field.help}>
        <label className="ensemble-field">
          <span className="ensemble-field-name">{field.label}</span>
          <select
            value={String(getConfigPath(config, field.key) ?? "")}
            onChange={(e) => onChange(field.key, e.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {error}
        </label>
      </Tooltip>
    );
  }
  if (field.kind === "text") {
    const value = String(getConfigPath(config, field.key) ?? "");
    return (
      <label className="ensemble-field">
        <span className="ensemble-field-name">{field.label}</span>
        {field.multiline ? (
          <textarea maxLength={field.maxLength} value={value} onChange={(e) => onChange(field.key, e.target.value)} />
        ) : (
          <input maxLength={field.maxLength} value={value} onChange={(e) => onChange(field.key, e.target.value)} />
        )}
        <small>{field.help}</small>
        {error}
      </label>
    );
  }
  const rows = Array.isArray(getConfigPath(config, field.key))
    ? (getConfigPath(config, field.key) as Record<string, unknown>[])
    : [];
  if (field.kind === "lens_panel") {
    return (
      <JudgePanel
        fieldKey={field.key}
        label={field.label}
        help={field.help}
        minRows={field.minRows}
        maxRows={field.maxRows}
        lenses={field.options}
        personas={personas}
        rows={rows}
        issues={issues}
        onChange={(next) => onChange(field.key, next)}
      />
    );
  }
  // member_roster
  return (
    <Roster
      fieldKey={field.key}
      label={field.label}
      help={field.help}
      minRows={field.minRows}
      maxRows={field.maxRows}
      rows={rows}
      issues={issues}
      onChange={(next) => onChange(field.key, next)}
    />
  );
}

/** The section chrome every composite field shares: label, help, count, its rows, one adder. */
function LaneSection({
  label,
  help,
  count,
  max,
  addLabel,
  addTooltip,
  addDisabled,
  onAdd,
  issues,
  fieldKey,
  children,
}: {
  label: string;
  help: string;
  count: number;
  max: number;
  addLabel: string;
  addTooltip: string;
  addDisabled: boolean;
  onAdd: () => void;
  issues: StrategyIssue[];
  fieldKey: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="field ensemble-roster">
      <span className="field-label">
        {label}
        <span className="actions-spacer" />
        <span className="field-hint">{count} of {max}</span>
      </span>
      <p className="ensemble-roster-help">{help}</p>
      <FieldIssues issues={issues.filter((issue) => normalizeIssuePath(issue.path) === fieldKey)} />
      <ul className="ensemble-lanes">{children}</ul>
      <Tooltip label={addTooltip}>
        <button type="button" className="ensemble-lane-add" disabled={addDisabled} onClick={onAdd}>
          {addLabel}
        </button>
      </Tooltip>
    </div>
  );
}

function Roster({
  fieldKey,
  label,
  help,
  minRows,
  maxRows,
  rows,
  issues,
  onChange,
}: {
  /** The config path this roster edits - and therefore the path its issues are addressed at. */
  fieldKey: string;
  label: string;
  help: string;
  minRows: number;
  maxRows: number;
  rows: Record<string, unknown>[];
  issues: StrategyIssue[];
  onChange: (rows: Record<string, unknown>[]) => void;
}): React.JSX.Element {
  const setRow = (index: number, patch: Record<string, unknown>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const addRow = (): void => {
    const template = rows[rows.length - 1] ?? { agent: null, model: null, effort: null, approach: null };
    onChange([...rows, { ...template }]);
  };
  const removeRow = (index: number): void => {
    onChange(rows.filter((_, i) => i !== index));
  };

  return (
    <LaneSection
      label={label}
      help={help}
      count={rows.length}
      max={maxRows}
      addLabel="+ Add candidate"
      addTooltip="Add another candidate (duplicates are allowed)"
      addDisabled={rows.length >= maxRows}
      onAdd={addRow}
      issues={issues}
      fieldKey={fieldKey}
    >
      {rows.map((row, index) => {
        const agent = (row.agent as AgentType | null) ?? null;
        const model = (row.model as string | null) ?? null;
        const effort = (row.effort as ThinkingLevel | null) ?? null;
        const approach = (row.approach as string | null) ?? "";
        const efforts = agent ? capabilitiesFor(agent).effort?.levels ?? [] : [];
        const rowIssues = issues.filter((issue) => {
          const path = normalizeIssuePath(issue.path);
          return path === `${fieldKey}.${index}` || path.startsWith(`${fieldKey}.${index}.`);
        });
        return (
          <li key={index} className="ensemble-lane">
            <span className="ensemble-lane-ordinal">#{index + 1}</span>
            <Tooltip label={`Harness for candidate ${index + 1}`}>
              <span
                className="ensemble-lane-agent"
                style={agent ? { ["--agent-accent" as string]: AGENT_IDENTITY[agent].accent } : undefined}
              >
                <select
                  aria-label={`Candidate ${index + 1} agent`}
                  value={agent ?? ""}
                  onChange={(e) =>
                    setRow(index, {
                      agent: e.target.value ? (e.target.value as AgentType) : null,
                      model: null,
                      effort: null,
                    })
                  }
                >
                  <option value="">Default agent</option>
                  {AGENT_TYPES.map((a) => (
                    <option key={a} value={a}>
                      {AGENT_IDENTITY[a].label}
                    </option>
                  ))}
                </select>
              </span>
            </Tooltip>
            <Tooltip label={agent ? `Model for candidate ${index + 1}` : "Choose an agent first"}>
              <select
                aria-label={`Candidate ${index + 1} model`}
                value={model ?? ""}
                onChange={(e) => setRow(index, { model: e.target.value || null })}
              >
                <option value="">Default model</option>
                {agent &&
                  modelChoicesFor(agent, model).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </Tooltip>
            <Tooltip label={agent ? `Reasoning effort for candidate ${index + 1}` : "Choose an agent first"}>
              <select
                aria-label={`Candidate ${index + 1} effort`}
                value={effort ?? ""}
                onChange={(e) => setRow(index, { effort: e.target.value || null })}
              >
                <option value="">Default effort</option>
                {efforts.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Tooltip>
            <input
              aria-label={`Candidate ${index + 1} approach`}
              className="ensemble-lane-approach"
              placeholder="Optional approach nudge"
              value={approach}
              onChange={(e) => setRow(index, { approach: e.target.value || null })}
            />
            <Tooltip label={`Remove candidate ${index + 1}`}>
              <button
                type="button"
                className="ensemble-lane-x"
                aria-label={`Remove candidate ${index + 1}`}
                disabled={rows.length <= minRows}
                onClick={() => removeRow(index)}
              >
                ✕
              </button>
            </Tooltip>
            <FieldIssues issues={rowIssues} />
          </li>
        );
      })}
    </LaneSection>
  );
}

/**
 * A panel of judges: one row each, one control each, and that control is the judge's LENS.
 *
 * A judge is one built-in lens or one Persona, so a single select offers both in two groups rather
 * than a lens picker plus a Persona picker whose interaction the operator has to work out. Choosing
 * a Persona pins the revision it was chosen at, which is what makes the daemon refuse the launch if
 * that Persona moves on before the operator confirms - the same drift a base-commit pin removes.
 *
 * The next free lens is what a new row defaults to, because the panel refuses duplicate built-in
 * lenses: defaulting to a repeat would add a row that is invalid the moment it appears.
 */
function JudgePanel({
  fieldKey,
  label,
  help,
  minRows,
  maxRows,
  lenses,
  personas,
  rows,
  issues,
  onChange,
}: {
  fieldKey: string;
  label: string;
  help: string;
  minRows: number;
  maxRows: number;
  lenses: Array<{ value: string; label: string; help: string }>;
  personas: PersonaView[];
  rows: Record<string, unknown>[];
  issues: StrategyIssue[];
  onChange: (rows: Record<string, unknown>[]) => void;
}): React.JSX.Element {
  const valueOf = (row: Record<string, unknown>): string => {
    const personaId = stringOrNull(row.personaId);
    return personaId === null ? String(row.lens ?? lenses[0]?.value ?? "") : `persona:${personaId}`;
  };
  const rowFor = (value: string): Record<string, unknown> => {
    if (value.startsWith("persona:")) {
      const persona = personas.find((p) => p.id === value.slice("persona:".length));
      return {
        lens: lenses[0]?.value ?? "",
        personaId: persona?.id ?? null,
        personaRevision: persona?.revision ?? null,
        runner: null,
        model: null,
      };
    }
    return { lens: value, personaId: null, personaRevision: null, runner: null, model: null };
  };
  const nextFreeLens = (): string => {
    const taken = new Set(rows.filter((row) => stringOrNull(row.personaId) === null).map((row) => String(row.lens)));
    return lenses.find((lens) => !taken.has(lens.value))?.value ?? lenses[0]?.value ?? "";
  };

  return (
    <LaneSection
      label={label}
      help={help}
      count={rows.length}
      max={maxRows}
      addLabel="+ Add judge"
      addTooltip="Add another judge - a panel disagrees only if its lenses differ"
      addDisabled={rows.length >= maxRows}
      onAdd={() => onChange([...rows, rowFor(nextFreeLens())])}
      issues={issues}
      fieldKey={fieldKey}
    >
      {rows.map((row, index) => {
        const value = valueOf(row);
        const lens = lenses.find((option) => option.value === value);
        const personaId = stringOrNull(row.personaId);
        const isPersona = personaId !== null;
        const personaChoices = personaChoicesForDisplay(
          personas,
          personaId === null ? [] : [personaId],
        );
        const selectedPersonaAvailable = personaId === null
          || personaChoices.some(({ persona }) => persona.id === personaId);
        const rowIssues = issues.filter((issue) => {
          const path = normalizeIssuePath(issue.path);
          return path === `${fieldKey}.${index}` || path.startsWith(`${fieldKey}.${index}.`);
        });
        return (
          <li key={index} className="ensemble-lane ensemble-judge-lane">
            <span className="ensemble-lane-ordinal">#{index + 1}</span>
            <Tooltip label={`What judge ${index + 1} weighs, and nothing else`}>
              <select
                aria-label={`Judge ${index + 1} lens`}
                className={isPersona ? "ensemble-judge-persona" : undefined}
                value={value}
                onChange={(e) => onChange(rows.map((r, i) => (i === index ? rowFor(e.target.value) : r)))}
              >
                <optgroup label="Built-in lenses">
                  {lenses.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                {!selectedPersonaAvailable && (
                  <option value={`persona:${personaId}`}>Unavailable: {personaId}</option>
                )}
                {personaChoices.length > 0 && (
                  <optgroup label="Personas">
                    {personaChoices.map(({ persona, retained }) => (
                      <option key={persona.id} value={`persona:${persona.id}`}>
                        {personaChoiceLabel(persona, retained)} (rev {persona.revision})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Tooltip>
            <span className="ensemble-judge-blurb">
              {lens ? lens.help : "This judge uses your Persona's guidance, pinned at the revision above."}
            </span>
            <Tooltip label={`Remove judge ${index + 1}`}>
              <button
                type="button"
                className="ensemble-lane-x"
                aria-label={`Remove judge ${index + 1}`}
                disabled={rows.length <= minRows}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </Tooltip>
            <FieldIssues issues={rowIssues} />
          </li>
        );
      })}
    </LaneSection>
  );
}

function EvaluatorPicker({
  personas,
  selectedId,
  issues,
  onChange,
}: {
  personas: PersonaView[];
  selectedId: string | null;
  issues: StrategyIssue[];
  onChange: (persona: PersonaView | null) => void;
}): React.JSX.Element {
  const choices = personaChoicesForDisplay(
    personas,
    selectedId === null ? [] : [selectedId],
  );
  const selected = personas.find((persona) => persona.id === selectedId) ?? null;
  const selectedAvailable = selectedId === null
    || choices.some(({ persona }) => persona.id === selectedId);
  return (
    <Tooltip label="Which Persona (or the built-in rubric) guides the comparison">
    <label className="ensemble-field">
      <span className="ensemble-field-name">Judged by</span>
      <select
        value={selectedId ?? ""}
        onChange={(e) => onChange(personas.find((p) => p.id === e.target.value) ?? null)}
      >
        <option value="">Built-in rubric</option>
        {!selectedAvailable && <option value={selectedId ?? ""}>Unavailable: {selectedId}</option>}
        {choices.map(({ persona, retained }) => (
          <option key={persona.id} value={persona.id}>
            {personaChoiceLabel(persona, retained)}
          </option>
        ))}
      </select>
      {selected && (
        <small>
          Persona "{selected.name}" revision {selected.revision} will be pinned at creation.
        </small>
      )}
      <FieldIssues issues={issues} />
    </label>
    </Tooltip>
  );
}

/** The optional post-selection handoff: which published workflow reviews the confirmed winner. */
function WorkflowField({
  choices,
  selectedKey,
  compatibility,
  loadingCompatibilityKey,
  issues,
  onChange,
}: {
  choices: WorkflowChoice[];
  selectedKey: string | null;
  compatibility: Record<string, WorkflowCompatibility>;
  loadingCompatibilityKey: string | null;
  issues: StrategyIssue[];
  onChange: (workflow: EnsembleDispatchDraft["workflow"]) => void;
}): React.JSX.Element {
  return (
    <Tooltip label="Optionally hand the confirmed winner to a published workflow">
      <label className="ensemble-field">
        <span className="ensemble-field-name">
          After the winner <span className="field-hint">optional</span>
        </span>
        <select
          value={selectedKey ?? ""}
          onChange={(e) => {
            const workflow = choices.find((choice) => choice.key === e.target.value);
            onChange(
              workflow
                ? {
                    workflowId: workflow.workflowId,
                    workflowVersion: workflow.workflowVersion,
                  }
                : null,
            );
          }}
        >
          <option value="">Continue normally (no workflow)</option>
          {choices.map((workflow) => {
            const status = compatibility[workflow.key];
            const isSelected = workflow.key === selectedKey;
            const checking =
              workflow.key === loadingCompatibilityKey || (isSelected && status === undefined);
            return (
              <option
                key={workflow.key}
                value={workflow.key}
                disabled={status?.supported === false}
              >
                {workflow.name} (v{workflow.workflowVersion})
                {isSelected ? " · pinned" : ""}
                {checking
                  ? " · checking compatibility"
                  : status?.supported === false
                    ? ` · unavailable: ${status.reason}`
                    : status?.supported === null && status.reason
                      ? ` · ${status.reason}`
                    : ""}
              </option>
            );
          })}
        </select>
        <FieldIssues issues={issues} />
      </label>
    </Tooltip>
  );
}

export type WorkflowCompatibility = {
  supported: boolean | null;
  reason: string | null;
};

type WorkflowChoice = {
  key: string;
  workflowId: string;
  workflowVersion: number;
  name: string;
};

export function workflowVersionCompatibilityKey(
  workflowId: string,
  workflowVersion: number,
): string {
  return JSON.stringify([workflowId, workflowVersion]);
}

export function compatibilityForWorkflowVersion(
  version: WorkflowVersionMetadata,
): WorkflowCompatibility {
  if (version.bindingDefaults.deliveryMode !== "preview") {
    return {
      supported: false,
      reason:
        "Live delivery is not available for an ensemble handoff on this build; only Preview is",
    };
  }
  if (version.bindingDefaults.triggerMode !== "manual") {
    return {
      supported: false,
      reason:
        "This workflow's trigger mode is not available for an ensemble handoff on this build",
    };
  }
  return { supported: true, reason: null };
}

/**
 * The plan strip: what pressing Launch starts, drawn rather than listed. One pinned base, N
 * isolated lanes, one evaluation, and the human gate - with the estimate figures beside it and
 * the run's standing rules under it. Everything here comes from the strategy descriptor and the
 * draft config; it invents nothing the server does not verify at Review.
 */
function PlanStrip({
  descriptor,
  config,
  estimate,
}: {
  descriptor: EnsembleStrategyInfo;
  config: unknown;
  estimate: EnsembleLaunchEstimate | null;
}): React.JSX.Element {
  const capabilities = descriptor.capabilities;
  const memberField = descriptor.form.fields.find((field) => field.kind === "member_roster");
  const memberRows =
    memberField && Array.isArray(getConfigPath(config, memberField.key))
      ? (getConfigPath(config, memberField.key) as Record<string, unknown>[])
      : [];
  const laneFor = (row: Record<string, unknown>): { accent: string | null; text: string } => {
    const agent = (row.agent as AgentType | null) ?? null;
    const model = (row.model as string | null) ?? null;
    const effort = (row.effort as ThinkingLevel | null) ?? null;
    const modelLabel = agent && model
      ? modelChoicesFor(agent, model).find((m) => m.id === model)?.label ?? model
      : model;
    return {
      accent: agent ? AGENT_IDENTITY[agent].accent : null,
      text: [
        agent ? AGENT_IDENTITY[agent].label : "Default agent",
        modelLabel ?? "default",
        effort ?? "default",
      ].join(" · "),
    };
  };
  return (
    <div className="ensemble-plan">
      <span className="ensemble-plan-eyebrow">Launch plan</span>
      {estimate ? (
        <>
          <div className="ensemble-plan-flow" aria-hidden>
            <span className="ensemble-plan-node ensemble-plan-base">base pinned at launch</span>
            <span className="ensemble-plan-line" />
            <span className="ensemble-plan-lanes">
              {memberRows.map((row, index) => {
                const lane = laneFor(row);
                return (
                  <span key={index} className="ensemble-plan-lane">
                    <span className="ensemble-plan-tick" />
                    <span className="ensemble-plan-who">
                      <span
                        className="ensemble-plan-dot"
                        style={{ background: lane.accent ?? "var(--neutral)" }}
                      />
                      {lane.text}
                    </span>
                  </span>
                );
              })}
            </span>
            <span className="ensemble-plan-line" />
            <span className="ensemble-plan-node ensemble-plan-judge">
              {estimate.evaluationCalls} comparison call{estimate.evaluationCalls === 1 ? "" : "s"}
            </span>
            <span className="ensemble-plan-line" />
            <span className="ensemble-plan-node ensemble-plan-human">
              {capabilities.requiresHumanDecision ? "you confirm" : "you review"}
            </span>
          </div>
          <p className="ensemble-plan-figs">
            {estimate.initialMembers} agents now
            {estimate.maxMembers !== estimate.initialMembers ? `, up to ${estimate.maxMembers}` : ""} ·{" "}
            {estimate.maxConcurrentMembers} building at once · {estimate.maxWaves} wave
            {estimate.maxWaves === 1 ? "" : "s"} · artifacts: {capabilities.artifactKinds.join(", ")}
          </p>
        </>
      ) : (
        <p className="ensemble-field-error">The configuration is not yet valid.</p>
      )}
      <ul className="ensemble-plan-rules">
        <li>Members work in isolation and do not see each other's work.</li>
        <li>No member will push or open a pull request.</li>
        {capabilities.requiresHumanDecision && <li>A person confirms the winner before anything destructive.</li>}
        <li>The exact base commit is pinned when you launch.</li>
      </ul>
    </div>
  );
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeIssuePath(path: string): string {
  if (path === "strategyConfig") return "";
  if (path.startsWith("strategyConfig.")) return path.slice("strategyConfig.".length);
  if (path.startsWith("roles.")) return `members.${path.slice("roles.".length)}`;
  return path;
}

function issueMatchesField(issue: StrategyIssue, key: string): boolean {
  const path = normalizeIssuePath(issue.path);
  return path === key || path.startsWith(`${key}.`);
}

function FieldIssues({ issues }: { issues: StrategyIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <ul className="ensemble-field-error" role="alert">
      {issues.map((issue, index) => <li key={`${issue.path}:${index}`}>{issue.message}</li>)}
    </ul>
  );
}
