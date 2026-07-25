import { useEffect, useRef, useState } from "react";
import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { modelChoicesFor } from "@shared/model.ts";
import { withAttachments } from "@shared/attachments.ts";
import type { PersonaView, WorkflowSummary, WorkflowVersion } from "@shared/workflow.ts";
import {
  ENSEMBLE_STRATEGY_INFO,
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
 * The Ensemble half of the dispatch form. The compose fields (repo, title, intent, attachments)
 * are the modal's, shared with Single; everything here configures the STRATEGY and reviews the
 * launch. It is descriptor-driven: the strategy cards and the config controls come from
 * `ENSEMBLE_STRATEGY_INFO` and the strategy's own `StrategyFormSpec`, so a new strategy renders
 * without new UI. It never compiles a plan or invents an estimate the server did not return -
 * launch is a two-step review-then-confirm, and any edit invalidates a stale review.
 */
export function EnsembleDispatch({
  compose,
  ensemble,
  onEnsembleChange,
  uploading,
  personas,
  workflowSummaries,
  onLaunched,
}: {
  compose: { repoRoot: string; title: string; intent: string; attachments: PendingAttachment[] };
  ensemble: EnsembleDispatchDraft;
  onEnsembleChange: (draft: EnsembleDispatchDraft) => void;
  uploading: boolean;
  personas: PersonaView[];
  workflowSummaries: WorkflowSummary[];
  onLaunched: (runId: string, submitted: EnsembleDispatchDraft) => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<EnsemblePreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const composeRef = useRef(compose);
  const ensembleRef = useRef(ensemble);
  composeRef.current = compose;
  ensembleRef.current = ensemble;

  const descriptor = ENSEMBLE_STRATEGY_INFO[ensemble.strategyId];
  const intent = withAttachments(compose.intent.trim(), readyAttachments(compose.attachments));
  const createInput = buildEnsembleCreateInput(compose, intent, ensemble);
  const fingerprint = ensemblePreviewFingerprint(createInput);
  const reviewed = ensemble.previewFingerprint === fingerprint;
  const liveEstimate = descriptor.estimate(ensemble.config);
  const hasCompose = compose.repoRoot.trim().length > 0 && compose.intent.trim().length > 0;
  const workflowUnsupported =
    ensemble.workflow !== null && reviewed && preview?.workflow?.supported === false;
  const canLaunch =
    reviewed &&
    preview?.ok === true &&
    !uploading &&
    !launching &&
    hasCompose &&
    !workflowUnsupported;

  const previewIssues = reviewed ? preview?.issues ?? [] : [];
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
  const reviewedEstimate = reviewed && preview ? preview.estimate : liveEstimate;

  const setConfig = (key: string, value: unknown): void =>
    onEnsembleChange({
      ...ensemble,
      config: setConfigPath(ensemble.config, key, value),
      previewFingerprint: null,
    });

  const pickStrategy = (id: typeof ensemble.strategyId): void => {
    if (id === ensemble.strategyId) return;
    onEnsembleChange({ ...ensemble, strategyId: id, config: defaultConfigFor(id), previewFingerprint: null });
    setPreview(null);
  };

  const setWorkflow = (workflow: EnsembleDispatchDraft["workflow"]): void =>
    onEnsembleChange({ ...ensemble, workflow, previewFingerprint: null });

  const review = async (): Promise<void> => {
    setPreviewing(true);
    setLaunchError(null);
    const submittedFingerprint = fingerprint;
    const result = await previewEnsemble(createInput);
    setPreviewing(false);
    const current = ensembleRef.current;
    const currentCompose = composeRef.current;
    const currentIntent = withAttachments(
      currentCompose.intent.trim(),
      readyAttachments(currentCompose.attachments),
    );
    const currentFingerprint = ensemblePreviewFingerprint(
      buildEnsembleCreateInput(currentCompose, currentIntent, current),
    );
    setPreview(result);
    if (currentFingerprint !== submittedFingerprint) return;
    onEnsembleChange({ ...current, previewFingerprint: currentFingerprint });
  };

  const launch = async (): Promise<void> => {
    setLaunching(true);
    setLaunchError(null);
    const submitted = ensemble;
    const result = await createEnsemble(createInput);
    setLaunching(false);
    if (result.ok) onLaunched(result.data.run.id, submitted);
    else setLaunchError(result.error);
  };

  return (
    <div className="ensemble-dispatch">
      <fieldset className="ensemble-strategy-cards">
        <legend>Strategy</legend>
        <div className="ensemble-strategy-grid">
          {Object.values(ENSEMBLE_STRATEGY_INFO).map((info) => (
            <Tooltip key={info.id} label={info.enabled ? `Use the ${info.label} strategy` : "Not available yet"}>
              <button
                type="button"
                className={`ensemble-strategy-card${info.id === ensemble.strategyId ? " selected" : ""}`}
                aria-pressed={info.id === ensemble.strategyId}
                disabled={!info.enabled}
                onClick={() => pickStrategy(info.id)}
              >
                <span className="ensemble-strategy-label">{info.label}</span>
                <span className="ensemble-strategy-blurb">{info.blurb}</span>
                {!info.enabled && <span className="ensemble-strategy-disabled">Not available yet</span>}
              </button>
            </Tooltip>
          ))}
        </div>
        <p className="ensemble-strategy-explain">{descriptor.explanation}</p>
      </fieldset>

      <div className="ensemble-config-form">
        {descriptor.form.fields.map((field) => (
          <FormField
            key={field.key}
            field={field}
            config={ensemble.config}
            issues={issuesFor(field.key)}
            onChange={setConfig}
          />
        ))}
      </div>

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

      <WorkflowPlacement
        workflows={workflowSummaries}
        selected={ensemble.workflow}
        resolution={reviewed ? preview?.workflow ?? null : null}
        issues={workflowIssues}
        onChange={setWorkflow}
      />

      <LaunchSummary estimate={reviewedEstimate} capabilities={descriptor.capabilities} />

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
      {launchError && (
        <p className="ensemble-error" role="alert">
          {launchError}
        </p>
      )}

      <div className="ensemble-launch-row" aria-live="polite">
        <Tooltip label="Preview the exact launch plan, budget, and workflow before committing">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={previewing || !hasCompose || uploading}
            onClick={() => void review()}
          >
            {previewing ? "Reviewing…" : reviewed ? "Reviewed" : "Review launch"}
          </button>
        </Tooltip>
        <Tooltip label="Launch the reviewed plan (idempotent on this request)">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canLaunch}
            onClick={() => void launch()}
          >
            {launching
              ? "Launching…"
              : uploading
                ? "Uploading…"
                : `Launch ${reviewedEstimate ? reviewedEstimate.initialMembers : ""} agents`.trim()}
          </button>
        </Tooltip>
        {!reviewed && preview && (
          <span className="ensemble-muted">The draft changed - review again before launching.</span>
        )}
      </div>
    </div>
  );
}

function FormField({
  field,
  config,
  issues,
  onChange,
}: {
  field: StrategyFormField;
  config: unknown;
  issues: StrategyIssue[];
  onChange: (key: string, value: unknown) => void;
}): React.JSX.Element {
  const error = <FieldIssues issues={issues} />;
  if (field.kind === "int") {
    const value = Number(getConfigPath(config, field.key) ?? field.min);
    return (
      <label className="ensemble-field">
        <span>{field.label}</span>
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange(field.key, Math.max(field.min, Math.min(field.max, Number.isFinite(next) ? next : field.min)));
          }}
        />
        <small>{field.help}</small>
        {error}
      </label>
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
          <small>{field.help}</small>
          {error}
        </label>
      </Tooltip>
    );
  }
  if (field.kind === "select") {
    return (
      <Tooltip label={field.help}>
        <label className="ensemble-field">
          <span>{field.label}</span>
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
          <small>{field.help}</small>
          {error}
        </label>
      </Tooltip>
    );
  }
  if (field.kind === "text") {
    const value = String(getConfigPath(config, field.key) ?? "");
    return (
      <label className="ensemble-field">
        <span>{field.label}</span>
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
  // member_roster
  const rows = (Array.isArray(getConfigPath(config, field.key))
    ? (getConfigPath(config, field.key) as Record<string, unknown>[])
    : []);
  return (
    <Roster
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

function Roster({
  label,
  help,
  minRows,
  maxRows,
  rows,
  issues,
  onChange,
}: {
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
    <fieldset className="ensemble-roster">
      <legend>
        {label} <span className="ensemble-muted">({rows.length})</span>
      </legend>
      <p className="ensemble-muted">{help}</p>
      <FieldIssues issues={issues.filter((issue) => normalizeIssuePath(issue.path) === "members")} />
      <ul className="ensemble-roster-rows">
        {rows.map((row, index) => {
          const agent = (row.agent as AgentType | null) ?? null;
          const model = (row.model as string | null) ?? null;
          const effort = (row.effort as ThinkingLevel | null) ?? null;
          const approach = (row.approach as string | null) ?? "";
          const efforts = agent ? capabilitiesFor(agent).effort?.levels ?? [] : [];
          const rowIssues = issues.filter((issue) => {
            const path = normalizeIssuePath(issue.path);
            return path === `members.${index}` || path.startsWith(`members.${index}.`);
          });
          return (
            <li key={index} className="ensemble-roster-row">
              <span className="ensemble-roster-ordinal">#{index + 1}</span>
              <Tooltip label={`Harness for candidate ${index + 1}`}>
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
                className="ensemble-roster-approach"
                placeholder="Optional approach hint"
                value={approach}
                onChange={(e) => setRow(index, { approach: e.target.value || null })}
              />
              <Tooltip label={`Remove candidate ${index + 1}`}>
                <button
                  type="button"
                  className="btn btn-ghost"
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
      </ul>
      <Tooltip label="Add another candidate (duplicates are allowed)">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={rows.length >= maxRows}
          onClick={addRow}
        >
          + Add candidate
        </button>
      </Tooltip>
    </fieldset>
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
  const usable = personas.filter((p) => p.archivedAt === null);
  const selected = usable.find((p) => p.id === selectedId) ?? null;
  return (
    <Tooltip label="Which Persona (or the built-in rubric) guides the comparison">
    <label className="ensemble-field">
      <span>Evaluator guidance</span>
      <select
        value={selectedId ?? ""}
        onChange={(e) => onChange(usable.find((p) => p.id === e.target.value) ?? null)}
      >
        <option value="">Built-in rubric</option>
        {usable.map((persona) => (
          <option key={persona.id} value={persona.id}>
            {persona.name}
          </option>
        ))}
      </select>
      <small>
        {selected
          ? `Persona "${selected.name}" revision ${selected.revision} will be pinned at creation.`
          : "The comparison uses the built-in Best-of-N rubric."}
      </small>
      <FieldIssues issues={issues} />
    </label>
    </Tooltip>
  );
}

function WorkflowPlacement({
  workflows,
  selected,
  resolution,
  issues,
  onChange,
}: {
  workflows: WorkflowSummary[];
  selected: EnsembleDispatchDraft["workflow"];
  resolution: EnsemblePreviewResult["workflow"];
  issues: StrategyIssue[];
  onChange: (workflow: EnsembleDispatchDraft["workflow"]) => void;
}): React.JSX.Element {
  const published = workflows.filter((w) => w.publishedVersion !== null && w.archivedAt === null);
  const [compatibility, setCompatibility] = useState<Record<string, WorkflowCompatibility>>({});
  const publishedSignature = published
    .map((workflow) => `${workflow.id}:${workflow.publishedVersion}`)
    .join("|");

  useEffect(() => {
    let current = true;
    setCompatibility({});
    void Promise.all(
      published.map(async (workflow): Promise<[string, WorkflowCompatibility]> => {
        try {
          const version = await workflowRequest<WorkflowVersion>(
            `/api/workflows/${encodeURIComponent(workflow.id)}/versions/${workflow.publishedVersion}`,
          );
          return [workflow.id, compatibilityForWorkflowVersion(version)];
        } catch {
          return [
            workflow.id,
            {
              supported: null,
              reason: "Compatibility could not be loaded; the backend will confirm it at Review.",
            },
          ];
        }
      }),
    ).then((entries) => {
      if (current) setCompatibility(Object.fromEntries(entries));
    });
    return () => {
      current = false;
    };
  }, [publishedSignature]);

  const selectedCompatibility = selected
    ? compatibility[selected.workflowId]
    : null;
  return (
    <div className="ensemble-workflow-placement">
      <Tooltip label="Optionally hand the confirmed winner to a published workflow">
        <label className="ensemble-field">
          <span>After a winner is chosen (optional)</span>
          <select
            value={selected?.workflowId ?? ""}
            onChange={(e) => {
              const workflow = published.find((w) => w.id === e.target.value);
              onChange(
                workflow && workflow.publishedVersion !== null
                  ? { workflowId: workflow.id, workflowVersion: workflow.publishedVersion }
                  : null,
              );
            }}
          >
            <option value="">Continue normally (no workflow)</option>
            {published.map((workflow) => {
              const status = compatibility[workflow.id];
              return (
                <option
                  key={workflow.id}
                  value={workflow.id}
                  disabled={status === undefined || status.supported === false}
                >
                  {workflow.name} (v{workflow.publishedVersion})
                  {status === undefined
                    ? " · checking compatibility"
                    : status.supported === false
                      ? ` · unavailable: ${status.reason}`
                      : ""}
                </option>
              );
            })}
          </select>
          <small>
            A workflow reviews the confirmed winner only; it is not part of the candidate comparison.
            {!resolution && (
              <> Published-version compatibility is loaded here and confirmed by the backend at Review.</>
            )}
            {!resolution && selectedCompatibility?.reason && (
              <span
                className={
                  selectedCompatibility.supported === false
                    ? "ensemble-field-error"
                    : "ensemble-muted"
                }
              >
                {" "}
                {selectedCompatibility.reason}
              </span>
            )}
            {resolution && resolution.supported && (
              <>
                {" "}
                Pinning {resolution.workflowName} v{resolution.workflowVersion} · {resolution.deliveryMode}
                {" · round cap "}
                {resolution.maxRepairRounds}.
              </>
            )}
            {resolution && !resolution.supported && resolution.unsupportedReason && (
              <span className="ensemble-field-error"> {resolution.unsupportedReason}</span>
            )}
          </small>
          <FieldIssues issues={issues} />
        </label>
      </Tooltip>
      {resolution && (
        <dl className="ensemble-workflow-resolution">
          <div>
            <dt>Resolved workflow</dt>
            <dd>
              {resolution.workflowName} v{resolution.workflowVersion}
            </dd>
          </div>
          <div>
            <dt>Workflow · version ids</dt>
            <dd><code>{resolution.workflowId}</code> · <code>{resolution.workflowVersionId}</code></dd>
          </div>
          <div>
            <dt>Trigger · delivery</dt>
            <dd>{resolution.triggerMode} · {resolution.deliveryMode}</dd>
          </div>
          <div>
            <dt>Completion</dt>
            <dd>{resolution.completionPolicy} · {resolution.maxRepairRounds} repair rounds</dd>
          </div>
          <div>
            <dt>Supported</dt>
            <dd>{resolution.supported ? "Yes" : `No${resolution.unsupportedReason ? ` — ${resolution.unsupportedReason}` : ""}`}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export type WorkflowCompatibility = {
  supported: boolean | null;
  reason: string | null;
};

export function compatibilityForWorkflowVersion(
  version: WorkflowVersion,
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

function LaunchSummary({
  estimate,
  capabilities,
}: {
  estimate: ReturnType<(typeof ENSEMBLE_STRATEGY_INFO)[keyof typeof ENSEMBLE_STRATEGY_INFO]["estimate"]>;
  capabilities: (typeof ENSEMBLE_STRATEGY_INFO)[keyof typeof ENSEMBLE_STRATEGY_INFO]["capabilities"];
}): React.JSX.Element {
  return (
    <div className="ensemble-launch-summary">
      <h5>What this launches</h5>
      {estimate ? (
        <ul>
          <li>
            {estimate.initialMembers} agents now
            {estimate.maxMembers !== estimate.initialMembers ? `, up to ${estimate.maxMembers}` : ""} · {estimate.maxConcurrentMembers}{" "}
            building at once · {estimate.maxWaves} wave{estimate.maxWaves === 1 ? "" : "s"}
          </li>
          <li>
            {estimate.evaluationCalls} comparison call{estimate.evaluationCalls === 1 ? "" : "s"} · artifacts:{" "}
            {capabilities.artifactKinds.join(", ")}
          </li>
        </ul>
      ) : (
        <p className="ensemble-field-error">The configuration is not yet valid.</p>
      )}
      <ul className="ensemble-launch-rules">
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
