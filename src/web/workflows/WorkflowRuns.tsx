import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowExternalSource,
  WorkflowRunDetail,
  WorkflowRunPage,
  WorkflowRunSummary,
  WorkflowEventPage,
  WorkflowLlmCallPage,
} from "@shared/workflow.ts";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";
import { WorkflowApiError, workflowRequest } from "./workflowApi.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import type { WorkflowRunFilters } from "./useWorkflowRoute.ts";
import { requestWorkflowVersionOpen } from "./workflowSelection.ts";

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function workflowCallCost(
  calls: NonNullable<WorkflowRunDetail["llmCalls"]>,
  totalCount: number,
  nextAfter: string | null | undefined,
): number | null {
  if (
    calls.length === 0
    || calls.length !== totalCount
    || nextAfter != null
    || calls.some((call) => call.costUsd === null)
  ) {
    return null;
  }
  return calls.reduce((total, call) => total + (call.costUsd ?? 0), 0);
}

const EXTERNAL_SOURCE_LABELS: Record<WorkflowExternalSource["kind"], string> = {
  ensemble: "Ensemble",
};

/**
 * Where a run came from, when something other than an operator started it.
 *
 * Deliberately not a link: the route that would open the source does not exist yet, and a
 * dead navigation target reads as a broken product rather than an unfinished one. The id is
 * shown as text so an operator can still find the record it names.
 */
function ExternalProvenance({
  source,
}: {
  source: WorkflowExternalSource;
}): React.JSX.Element {
  return (
    <p className="workflow-run-provenance">
      Started by {EXTERNAL_SOURCE_LABELS[source.kind]} <code>{source.sourceId}</code>
      {" · "}{when(source.createdAt)}
    </p>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }): React.JSX.Element | null {
  if (evidence.length === 0) return null;
  return (
    <ul className="workflow-verdict-evidence">
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${item.path ?? ""}:${item.line ?? ""}:${index}`}>
          <code>{item.kind}{item.path ? ` · ${item.path}` : ""}{item.line ? `:${item.line}` : ""}</code>
          <span>{item.quote}</span>
        </li>
      ))}
    </ul>
  );
}

function VerdictCard({
  persona,
  verdict,
}: {
  persona: string;
  verdict: PersonaVerdict;
}): React.JSX.Element {
  return (
    <article className={`workflow-verdict workflow-verdict-${verdict.verdict}`}>
      <header>
        <strong>{persona}</strong>
        <span>{verdict.verdict} · {Math.round(verdict.confidence * 100)}%</span>
      </header>
      <p>{verdict.summary}</p>
      {verdict.verdict === "pass" ? (
        <div>
          <h5>Approval rationale</h5>
          <p>{verdict.approvalDetails.reason}</p>
          <EvidenceList evidence={verdict.approvalDetails.evidence} />
        </div>
      ) : (
        <div>
          <h5>Requested changes</h5>
          <ol>
            {verdict.requestedChanges.map((change, index) => (
              <li key={`${change.title}:${index}`}>
                <strong>{change.title}</strong>
                <p>{change.rationale}</p>
                {change.path && <code>{change.path}{change.line ? `:${change.line}` : ""}</code>}
                <EvidenceList evidence={change.evidence} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

export function workflowNodeStatuses(detail: WorkflowRunDetail): Record<string, string> {
  const statuses: Record<string, string> = {};
  const latestSubmission = detail.submissions.reduce<WorkflowRunDetail["submissions"][number] | null>(
    (latest, submission) => {
      if (submission.mode !== "full_workflow") return latest;
      return latest === null || submission.round > latest.round ? submission : latest;
    },
    null,
  );
  if (!latestSubmission) return statuses;
  const latestAttempts = new Map<string, WorkflowRunDetail["attempts"][number]>();
  for (const attempt of detail.attempts) {
    if (attempt.submissionId !== latestSubmission.id) continue;
    const previous = latestAttempts.get(attempt.nodeId);
    if (previous && previous.attempt > attempt.attempt) continue;
    latestAttempts.set(attempt.nodeId, attempt);
  }
  for (const attempt of latestAttempts.values()) {
    const verdict = attempt.verdict as unknown as PersonaVerdict | null;
    statuses[attempt.nodeId] = verdict?.verdict ?? attempt.state;
  }
  return statuses;
}

export function WorkflowRunView({
  detail,
  onResubmit,
  onRetry,
  onCancel,
  onCopyFeedback = async () => {},
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
  onPreparePr = async () => {},
  onRecheckInspector = async () => {},
  onRestartFull = async () => {},
  onRetryDelivery = async () => {},
  onResolveDelivery = async () => {},
  onLoadEvents = async () => {},
  onLoadCalls = async () => {},
}: {
  detail: WorkflowRunDetail;
  onResubmit: (unchanged: boolean) => Promise<void>;
  onRetry: (attemptId?: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onCopyFeedback?: () => Promise<void>;
  onOpenSession?: () => void;
  onOpenInspectorSettings?: () => void;
  onPreparePr?: () => Promise<void>;
  onRecheckInspector?: () => Promise<void>;
  onRestartFull?: (confirmation?: string) => Promise<void>;
  onRetryDelivery?: (deliveryId: string) => Promise<void>;
  onResolveDelivery?: (
    deliveryId: string,
    resolution: "mark_delivered" | "discard_and_new_round",
    confirmation?: string,
  ) => Promise<void>;
  onLoadEvents?: () => Promise<void>;
  onLoadCalls?: () => Promise<void>;
}): React.JSX.Element {
  const latest = detail.submissions.at(-1) ?? null;
  const latestFull = [...detail.submissions].reverse().find((submission) =>
    submission.mode === "full_workflow") ?? null;
  const context = latestFull?.context as unknown as WorkflowContextSnapshot | null;
  const failedAttempt = [...detail.attempts].reverse().find((attempt) => attempt.state === "error");
  const version = detail.version;
  const inspectorGate = detail.inspectorGate;
  const inspectorOnly = latest?.mode === "inspector_only";
  const bypassSourceHead = inspectorOnly
    && latest.context !== null
    && typeof latest.context === "object"
    && !Array.isArray(latest.context)
    && typeof latest.context.failedHeadSha === "string"
    ? latest.context.failedHeadSha
    : null;
  const completionClaims = detail.events.flatMap((event) => {
    if (
      event.kind !== "workflow_completion_claimed"
      || !event.payload
      || Array.isArray(event.payload)
      || typeof event.payload !== "object"
    ) return [];
    const { completionKind, marker, summary, state } = event.payload;
    if (
      typeof completionKind !== "string"
      || typeof marker !== "string"
      || typeof summary !== "string"
      || typeof state !== "string"
    ) return [];
    return [{ id: event.id, completionKind, marker, summary, state }];
  });
  const calls = detail.llmCalls ?? [];
  const feedbackAvailable = detail.deliveries.some((delivery) => delivery.payload.length > 0)
    || detail.attempts.some((attempt) => attempt.verdict);
  const totalCost = workflowCallCost(
    calls,
    detail.llmCallCount ?? calls.length,
    detail.nextLlmCallAfter,
  );
  const roundBySubmission = new Map(detail.submissions.map((submission) => [
    submission.id,
    submission.round,
  ]));
  const timelineByRound = new Map<number, typeof detail.events>();
  const uncertainDeliveries = detail.deliveries.filter((delivery) => delivery.state === "uncertain");
  const uncertainIds = uncertainDeliveries.map((delivery) => delivery.id).sort().join(",");
  const previousUncertainIds = useRef("");
  const [uncertainAnnouncement, setUncertainAnnouncement] = useState("");
  useEffect(() => {
    if (uncertainIds && uncertainIds !== previousUncertainIds.current) {
      setUncertainAnnouncement(
        `${uncertainDeliveries.length} workflow delivery outcome${uncertainDeliveries.length === 1 ? " is" : "s are"} uncertain`,
      );
    }
    previousUncertainIds.current = uncertainIds;
  }, [uncertainDeliveries.length, uncertainIds]);
  let timelineRound = 0;
  for (const event of [...detail.events].sort((a, b) => a.id - b.id)) {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload
      : null;
    const submissionId = payload && typeof payload.submissionId === "string"
      ? payload.submissionId
      : null;
    const payloadRound = payload && typeof payload.round === "number" ? payload.round : null;
    timelineRound = payloadRound
      ?? (submissionId ? roundBySubmission.get(submissionId) ?? timelineRound : timelineRound);
    const group = timelineByRound.get(timelineRound) ?? [];
    group.push(event);
    timelineByRound.set(timelineRound, group);
  }
  return (
    <section className="workflow-run-detail">
      <p className="sr-only" aria-live="assertive">{uncertainAnnouncement}</p>
      <header className="workflow-run-detail-head">
        <div>
          <p className="workflow-eyebrow">
            {detail.binding.deliveryMode === "live" ? "Live" : "Preview"} · version {detail.summary.workflowVersion}
          </p>
          <h3>{detail.summary.workflowName}</h3>
          <p>{detail.binding.sessionName} · round {detail.summary.round} of {detail.summary.maxRepairRounds + 1}</p>
          {detail.externalSource && <ExternalProvenance source={detail.externalSource} />}
          <small>Started {when(detail.run.startedAt)} · updated {when(detail.run.updatedAt)}</small>
        </div>
        <span className={`workflow-run-state wrs-${detail.run.status}`}>{detail.run.status.replaceAll("_", " ")}</span>
        <Tooltip label={detail.summary.sessionId
          ? "Jump to the session this run is reviewing"
          : "The bound session is no longer available"}>
          <button
            className="btn btn-ghost"
            disabled={!detail.summary.sessionId}
            onClick={onOpenSession}
          >
            Open session
          </button>
        </Tooltip>
        <Tooltip label="Copy this durable workflow run id">
          <button
            className="btn btn-ghost"
            onClick={() => void navigator.clipboard.writeText(detail.run.id)}
          >
            Copy run id
          </button>
        </Tooltip>
        <Tooltip label="Download this run's complete retained audit history as JSON">
          <a
            className="btn btn-ghost"
            href={`/api/workflow-runs/${encodeURIComponent(detail.run.id)}/export`}
            download={`workflow-run-${detail.run.id}.json`}
          >
            Export run
          </a>
        </Tooltip>
        <Tooltip label={version
          ? `Open immutable workflow version ${version.version}`
          : "The immutable published version is missing or corrupt"}>
          <button
            className="btn btn-ghost"
            disabled={!version}
            onClick={() => {
              if (!version) return;
              requestWorkflowVersionOpen(version.workflowId, version.version);
              window.location.hash = "#/workflows";
            }}
          >
            Open version
          </button>
        </Tooltip>
        {version ? (
          <Tooltip label={`Download immutable workflow version ${version.version} as JSON`}>
            <a
              className="btn btn-ghost"
              href={`/api/workflows/${encodeURIComponent(version.workflowId)}/versions/${version.version}/export`}
              download={`workflow-version-${version.version}.json`}
            >
              Export version
            </a>
          </Tooltip>
        ) : (
          <Tooltip label="The immutable published version is missing or corrupt">
            <button
              className="btn btn-ghost"
              disabled
            >
              Export version
            </button>
          </Tooltip>
        )}
        {inspectorGate?.state.prUrl ? (
          <Tooltip label="Open this run's adopted pull request in a new tab">
            <a
              className="btn btn-ghost"
              href={inspectorGate.state.prUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open PR
            </a>
          </Tooltip>
        ) : (
          <Tooltip label="This run has no adopted pull request">
            <button className="btn btn-ghost" disabled>Open PR</button>
          </Tooltip>
        )}
        <Tooltip label={feedbackAvailable
          ? "Copy every reviewer verdict to the clipboard"
          : detail.deliveries.some((delivery) => delivery.payloadPrunedAt != null)
            ? "Raw delivery feedback was pruned and no Persona verdict remains"
            : "No workflow feedback has been recorded yet"}>
          <button
            className="btn btn-ghost"
            disabled={!feedbackAvailable}
            onClick={() => void onCopyFeedback()}
          >
            Copy feedback
          </button>
        </Tooltip>
        {detail.run.status === "waiting_for_session" && (
          <>
            <Tooltip label="Re-read the session's current diff and run the review again">
              <button className="btn" onClick={() => void onResubmit(false)}>
                {detail.binding.deliveryMode === "live" ? "Submit fresh evidence" : "Preview fresh evidence"}
              </button>
            </Tooltip>
            <Tooltip label="Run the review again against the evidence snapshot already taken">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (window.confirm(
                    detail.binding.deliveryMode === "live"
                      ? "Run another review against the unchanged evidence snapshot?"
                      : "Run another Preview against the unchanged evidence snapshot?",
                  )) {
                    void onResubmit(true);
                  }
                }}
              >
                {detail.binding.deliveryMode === "live" ? "Submit unchanged" : "Preview unchanged"}
              </button>
            </Tooltip>
          </>
        )}
        {inspectorGate && inspectorGate.state.waitReason !== null && (
          <Tooltip label="Evaluate the gate again from Inspector's current durable ledger">
            <button className="btn btn-ghost" onClick={() => void onRecheckInspector()}>
              Recheck Inspector
            </button>
          </Tooltip>
        )}
        {inspectorGate && detail.run.status === "waiting_for_pr"
          && ["missing_pr", "unadopted_pr"].includes(inspectorGate.state.waitReason ?? "")
          && version?.completionPolicy.kind === "inspector"
          && version.completionPolicy.missingPrAction === "offer_prepare_pr" && (
          <Tooltip label="Send the session an explicit commit, push, and PR handoff packet">
            <button className="btn" onClick={() => void onPreparePr()}>Prepare PR in session</button>
          </Tooltip>
        )}
        {inspectorGate && (inspectorOnly || detail.run.status === "waiting_for_new_head") && (
          <Tooltip label="Abandon this repair path and rerun every Persona from fresh evidence">
            <button
              className="btn btn-ghost"
              onClick={() => {
                const confirmation = window.prompt(
                  "Type RESTART FULL WORKFLOW to abandon the Inspector-only repair.",
                );
                if (confirmation !== null) void onRestartFull(confirmation);
              }}
            >
              Restart full workflow
            </button>
          </Tooltip>
        )}
        {detail.run.status === "blocked" && detail.run.currentPhase === "infrastructure_error" && (
          <Tooltip label="The provider call failed rather than the review - try it again">
            <button className="btn" onClick={() => void onRetry(failedAttempt?.id)}>Retry provider call</button>
          </Tooltip>
        )}
        {!["completed", "cancelled", "failed"].includes(detail.run.status) && (
          <Tooltip label="Stop this run - it will not resume">
            <button className="btn btn-danger" onClick={() => void onCancel()}>Cancel</button>
          </Tooltip>
        )}
      </header>

      {inspectorOnly && (
        <p className="workflow-inspector-bypass" role="status">
          <strong>Persona review bypassed for Inspector repair</strong>
          {" "}The audited repair submission moved from {bypassSourceHead?.slice(0, 12) ?? "an earlier head"} to{" "}
          {latest.prHeadSha?.slice(0, 12) ?? "a newly observed head"} without Persona attempts.
        </p>
      )}

      {inspectorGate && (
        <section className={`workflow-inspector-gate workflow-gate-${detail.summary.gate}`}>
          <header>
            <div>
              <p className="workflow-eyebrow">Final gate</p>
              <h4>Inspector · {inspectorGate.state.waitReason?.replaceAll("_", " ") ?? "complete"}</h4>
            </div>
            <span className={`workflow-run-state wrs-${detail.run.status}`}>
              {detail.summary.gate.replaceAll("_", " ")}
            </span>
          </header>
          <dl>
            <div>
              <dt>Pull request</dt>
              <dd>
                {inspectorGate.state.prUrl ? (
                  <Tooltip label="Open the adopted pull request on GitHub">
                    <a href={inspectorGate.state.prUrl} target="_blank" rel="noreferrer">
                      #{inspectorGate.inspection?.number ?? detail.summary.gatePrNumber ?? "unknown"}
                    </a>
                  </Tooltip>
                ) : "not resolved"}
              </dd>
            </div>
            <div><dt>Adopted provenance</dt><dd>{inspectorGate.inspection?.source ?? "not adopted"}</dd></div>
            <div><dt>Inspector</dt><dd>{inspectorGate.inspector.enabled ? inspectorGate.inspector.mode : "disabled"} · {inspectorGate.inspector.posture ?? "unknown posture"}</dd></div>
            <div><dt>Review round</dt><dd>{inspectorGate.inspection?.round ?? 0}</dd></div>
            <div><dt>Target head</dt><dd><code>{inspectorGate.state.targetHeadSha ?? "not pinned"}</code></dd></div>
            <div><dt>Observed head</dt><dd><code>{inspectorGate.state.observedHeadSha ?? "not observed"}</code></dd></div>
            <div><dt>Reviewed head</dt><dd><code>{inspectorGate.inspection?.headSha ?? "not reviewed"}</code></dd></div>
            <div><dt>Observed</dt><dd>{inspectorGate.state.lastObservedAt ? when(inspectorGate.state.lastObservedAt) : "waiting for post-entry observation"}</dd></div>
            <div><dt>Backoff</dt><dd>{inspectorGate.inspection?.nextAttemptAt ? when(inspectorGate.inspection.nextAttemptAt) : "none"}</dd></div>
          </dl>
          {inspectorGate.inspection?.lastError && (
            <p className="persona-error" role="alert">{inspectorGate.inspection.lastError}</p>
          )}
          <p>
            Findings policy: <strong>{version?.completionPolicy.kind === "inspector"
              ? version.completionPolicy.onFindings.replaceAll("_", " ")
              : "none"}</strong>
            {" · "}Missing PR: <strong>{version?.completionPolicy.kind === "inspector"
              ? version.completionPolicy.missingPrAction.replaceAll("_", " ")
              : "wait"}</strong>
          </p>
          <Tooltip label="Open Inspector settings to review its enablement, mode, and allowlist">
            <button className="btn btn-ghost" onClick={onOpenInspectorSettings}>Open Inspector settings</button>
          </Tooltip>
          <div className="workflow-inspector-findings">
            {inspectorGate.findings.length === 0 ? (
              <p>No findings are recorded for this adopted pull request.</p>
            ) : inspectorGate.findings.map((finding) => (
              <article key={finding.id} className={`workflow-inspector-finding finding-${finding.severity}`}>
                <header>
                  <strong>{finding.severity} · {finding.title}</strong>
                  <span>{finding.status}</span>
                </header>
                <code>{finding.path ?? "general"}{finding.line ? `:${finding.line}` : ""}</code>
                <p>{finding.body ?? "Legacy finding: detail was not persisted by the Inspector version that created this row."}</p>
                <small>{finding.fingerprint}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      {completionClaims.length > 0 && (
        <section className="workflow-completion-claims">
          <h4>Foreman completion claim</h4>
          {completionClaims.map((claim) => (
            <article key={claim.id}>
              <strong>{claim.completionKind} · {claim.state.replaceAll("_", " ")}</strong>
              <code>{claim.marker.slice(0, 12)}</code>
              <p>{claim.summary}</p>
            </article>
          ))}
        </section>
      )}

      {detail.deliveries.length > 0 && (
        <section className="workflow-deliveries">
          <h4>Repair delivery</h4>
          {detail.deliveries.map((delivery) => (
            <article key={delivery.id} className={`workflow-delivery workflow-delivery-${delivery.state}`}>
              <header>
                <strong>{delivery.state.replaceAll("_", " ")}</strong>
                <code>{delivery.payloadSha256}</code>
              </header>
              <dl>
                <div><dt>Target session</dt><dd>{delivery.sessionId}</dd></div>
                <div><dt>Conversation</dt><dd>{delivery.noteKey}</dd></div>
                <div><dt>Prepared</dt><dd>{when(delivery.createdAt)}</dd></div>
                <div><dt>Last transition</dt><dd>{when(delivery.updatedAt)}</dd></div>
                <div><dt>Delivered</dt><dd>{delivery.deliveredAt ? when(delivery.deliveredAt) : "not confirmed"}</dd></div>
              </dl>
              {delivery.error && <p className="persona-error">{delivery.error.replaceAll("_", " ")}</p>}
              {delivery.payloadPrunedAt ? (
                <p className="workflow-pruned-badge">
                  Payload pruned {when(delivery.payloadPrunedAt)}. SHA-256 and transition
                  metadata remain available.
                </p>
              ) : <pre>{delivery.payload}</pre>}
              {delivery.state === "refused" && (
                <Tooltip label="Retry this packet after a positive delivery refusal">
                  <button className="btn" onClick={() => void onRetryDelivery(delivery.id)}>
                    Retry refused delivery
                  </button>
                </Tooltip>
              )}
              {delivery.state === "uncertain" && (
                <div className="workflow-delivery-recovery">
                  <Tooltip label="Confirm the exact packet already reached the inspected pane">
                    <button
                      className="btn"
                      onClick={() => {
                        if (window.confirm("Confirm that you inspected the pane and the repair prompt landed?")) {
                          void onResolveDelivery(delivery.id, "mark_delivered");
                        }
                      }}
                    >
                      Mark delivered
                    </button>
                  </Tooltip>
                  <Tooltip label="Discard this ambiguous packet and create a replacement repair round">
                    <button
                      className="btn btn-danger"
                      onClick={() => {
                        const confirmation = window.prompt(
                          "Type DISCARD AND SEND A NEW REPAIR ROUND to discard this ambiguous packet.",
                        );
                        if (confirmation !== null) {
                          void onResolveDelivery(delivery.id, "discard_and_new_round", confirmation);
                        }
                      }}
                    >
                      Discard and send new round
                    </button>
                  </Tooltip>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {version ? (
        <WorkflowCanvas
          graph={version.graph}
          personas={[]}
          readOnly
          nodeStatuses={workflowNodeStatuses(detail)}
        />
      ) : (
        <p className="persona-error" role="alert">
          The immutable workflow version is missing or corrupt. This run cannot be resumed.
        </p>
      )}

      {context && (
        <section className="workflow-run-context">
          <header>
            <h4>Captured intent and evidence</h4>
            <span className={`workflow-compaction-${context.compaction.status}`}>
              {context.compaction.status === "model" ? "Context compacted" : "Deterministic fallback"}
            </span>
            {context.evidence.retention?.state === "pruned" && (
              <span className="workflow-pruned-badge">
                Raw evidence pruned {when(context.evidence.retention.prunedAt)}
              </span>
            )}
          </header>
          <h5>Original goal</h5>
          <pre>{context.primaryGoal.rawPrompt || "(No captured goal)"}</pre>
          {context.primaryGoal.refined && <p><strong>Refined:</strong> {context.primaryGoal.refined}</p>}
          <h5>Human decisions and rationale</h5>
          {context.humanDecisions.length === 0 ? <p>None captured.</p> : (
            <ul>
              {context.humanDecisions.map((decision) => (
                <li key={`${decision.source.kind}:${decision.source.id}`}>
                  <p>{decision.decision}</p>
                  {decision.rationale && <small>Rationale: {decision.rationale}</small>}
                  <code>{decision.source.kind}:{decision.source.id}</code>
                </li>
              ))}
            </ul>
          )}
          {context.constraints.length > 0 && (
            <><h5>Compacted constraints</h5><ul>{context.constraints.map((item) => <li key={item}>{item}</li>)}</ul></>
          )}
          {context.acceptanceCriteria.length > 0 && (
            <><h5>Acceptance criteria</h5><ul>{context.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul></>
          )}
          {context.compaction.status === "fallback" && context.compaction.error && (
            <p className="workflow-context-warning">Compaction fallback: {context.compaction.error}</p>
          )}
          <details>
            <Tooltip label="Show the exact repository state this review was given">
              <summary>Evidence snapshot</summary>
            </Tooltip>
            <dl>
              <div><dt>HEAD</dt><dd>{context.evidence.headSha ?? "unavailable"}</dd></div>
              <div>
                <dt>Working tree</dt>
                <dd>
                  {context.evidence.workingTreeDirty ? "dirty" : "clean"}
                  {context.evidence.workingTreeStatusTruncated ? " · status truncated" : ""}
                </dd>
              </div>
              <div><dt>Fingerprint</dt><dd><code>{latestFull?.evidenceFingerprint}</code></dd></div>
              <div><dt>Diff</dt><dd>{context.evidence.diffTruncated ? "truncated" : "complete"}</dd></div>
              <div><dt>Transcript</dt><dd>{context.evidence.transcriptTruncated ? "truncated" : "complete"}</dd></div>
              <div><dt>Standards</dt><dd>{context.evidence.standardsTruncated ? "truncated" : "complete"}</dd></div>
            </dl>
            {context.evidence.retention?.state === "pruned" ? (
              <p>
                Raw diff, transcript, status paths, and standards bodies were pruned.
                Fingerprints, counts, caps, HEAD, branch, decisions, constraints, verdicts,
                and audit history remain.
              </p>
            ) : context.evidence.workingTreeStatus.length > 0 && (
              <pre>{context.evidence.workingTreeStatus.join("\n")}</pre>
            )}
            {context.evidence.retention?.state !== "pruned" && (
              <pre>{context.evidence.diff || "(No diff)"}</pre>
            )}
          </details>
        </section>
      )}

      <section className="workflow-model-calls">
        <header>
          <h4>Workflow-owned model calls</h4>
          <strong>
            {totalCost === null
              ? "Cost unavailable from this runner"
              : `$${totalCost.toFixed(4)}`}
          </strong>
        </header>
        {calls.length === 0 ? (
          <p>No workflow-owned model calls are recorded for this run.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Runner / model</th>
                <th>Attempt</th>
                <th>State</th>
                <th>Failure class</th>
                <th>Duration</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id}>
                  <td>{call.purpose.replaceAll("_", " ")}</td>
                  <td>{call.runner} / {call.model}</td>
                  <td>{call.attempt}</td>
                  <td>{call.state}</td>
                  <td>{call.errorCode ?? "none"}</td>
                  <td>{call.durationMs === null ? "unavailable" : `${call.durationMs} ms`}</td>
                  <td>{call.inputBytes} B</td>
                  <td>{call.outputBytes} B</td>
                  <td>{call.costUsd === null ? "unavailable" : `$${call.costUsd.toFixed(4)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {detail.nextLlmCallAfter && (
          <Tooltip label="Load the next page of durable model-call accounting">
            <button className="btn btn-ghost" onClick={() => void onLoadCalls()}>
              Load more model calls
            </button>
          </Tooltip>
        )}
      </section>

      <section className="workflow-verdicts">
        <h4>Persona verdicts</h4>
        {detail.attempts.flatMap((attempt) => {
          const verdict = attempt.verdict as unknown as PersonaVerdict | null;
          return verdict && attempt.persona
            ? [<VerdictCard key={attempt.id} persona={attempt.persona.name} verdict={verdict} />]
            : [];
        })}
        <div className="workflow-attempt-list">
          {detail.attempts.filter((attempt) => attempt.persona).map((attempt) => (
            <p key={`attempt:${attempt.id}`}>
              <strong>{attempt.persona?.name}</strong>
              {" "}revision {attempt.persona?.sourceRevision} · attempt {attempt.attempt} · {attempt.state}
              {attempt.runner && attempt.model ? ` · ${attempt.runner}/${attempt.model}` : ""}
              {attempt.error ? ` · ${attempt.error}` : ""}
            </p>
          ))}
        </div>
        {version?.graph.nodes.filter((node) => node.kind === "all_pass").map((join) => {
          const incoming = version.graph.edges.filter((edge) => edge.target === join.id);
          const received = detail.receipts.filter((receipt) =>
            incoming.some((edge) => edge.id === receipt.edgeId));
          return (
            <details className="workflow-join-packet" key={join.id}>
              <Tooltip label="Show the payloads each predecessor branch handed this join">
                <summary>All-pass Join · {received.length}/{new Set(incoming.map((edge) => edge.source)).size} predecessors</summary>
              </Tooltip>
              <pre>{JSON.stringify(received.map((receipt) => receipt.payload), null, 2)}</pre>
            </details>
          );
        }) ?? null}
        {detail.run.gateState && (
          <details className="workflow-join-packet">
            <Tooltip label="Show the raw join and final-gate state for this run">
              <summary>Join and gate packet</summary>
            </Tooltip>
            <pre>{JSON.stringify(detail.run.gateState, null, 2)}</pre>
          </details>
        )}
      </section>

      <section className="workflow-run-timeline">
        <h4>Timeline</h4>
        {[...timelineByRound.entries()]
          .sort(([roundA], [roundB]) => roundA - roundB)
          .map(([round, events]) => (
            <section key={round} className="workflow-timeline-round">
              <h5>{round === 0 ? "Run-level events" : `Repair round ${round}`}</h5>
              <ol>
                {[...events].sort((a, b) => a.id - b.id).map((event) => (
                  <li key={event.id}>
                    <time>{when(event.timestamp)}</time>
                    <strong>{event.kind.replaceAll("_", " ")}</strong>
                    <code>{JSON.stringify(event.payload)}</code>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        {detail.nextEventAfter && (
          <Tooltip label="Load the next page of durable workflow events">
            <button className="btn btn-ghost" onClick={() => void onLoadEvents()}>
              Load more events ({detail.events.length} of {detail.eventCount ?? detail.events.length})
            </button>
          </Tooltip>
        )}
      </section>
    </section>
  );
}

export function WorkflowRuns({
  runs,
  selectedRunId,
  filters,
  onSelectRun,
  onFilters = () => {},
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
}: {
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  filters?: WorkflowRunFilters;
  onSelectRun: (id: string) => void;
  onFilters?: (filters: WorkflowRunFilters | undefined) => void;
  onOpenSession?: (id: string) => void;
  onOpenInspectorSettings?: () => void;
}): React.JSX.Element {
  const [history, setHistory] = useState<WorkflowRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const filterKey = JSON.stringify(filters ?? {});
  const ordered = useMemo(
    () => [...history].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
    [history],
  );
  const loadGeneration = useRef(0);
  const listGeneration = useRef(0);
  const selectedIndex = useRef(0);
  const unchangedRequest = useRef<{ runId: string; requestId: string } | null>(null);
  const selected = selectedRunId ?? ordered[0]?.id ?? null;
  const selectedSummary = ordered.find((run) => run.id === selected) ?? null;
  const listPage = async (cursor: string | null, append: boolean): Promise<void> => {
    const generation = ++listGeneration.current;
    setListLoading(true);
    if (!append) setListError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.workflowId) params.set("workflowId", filters.workflowId);
    if (filters?.session) params.set("session", filters.session);
    try {
      const page = await workflowRequest<WorkflowRunPage>(`/api/workflow-runs?${params}`);
      if (generation !== listGeneration.current) return;
      setHistory((current) => append
        ? [...new Map([...current, ...page.items].map((run) => [run.id, run])).values()]
        : page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (generation === listGeneration.current) {
        setListError(caught instanceof Error ? caught.message : "Could not load workflow runs");
      }
    } finally {
      if (generation === listGeneration.current) setListLoading(false);
    }
  };
  useEffect(() => {
    setHistory([]);
    setNextCursor(null);
    void listPage(null, false);
    return () => { listGeneration.current++; };
  }, [filterKey]);

  useEffect(() => {
    const live = new Map(runs.map((run) => [run.id, run]));
    setHistory((current) => {
      const reconciled = current
        .filter((run) => live.has(run.id))
        .map((run) => live.get(run.id) ?? run);
      for (const run of runs) {
        if (reconciled.some((item) => item.id === run.id)) continue;
        const matches = (!filters?.status || run.status === filters.status)
          && (!filters?.workflowId || run.workflowId === filters.workflowId)
          && (!filters?.session || run.sessionId === filters.session || run.noteKey === filters.session);
        if (
          matches
          && !["completed", "cancelled", "failed"].includes(run.status)
        ) reconciled.unshift(run);
      }
      return reconciled;
    });
  }, [runs, filterKey]);
  useEffect(() => {
    const index = selectedRunId
      ? ordered.findIndex((run) => run.id === selectedRunId)
      : -1;
    if (index >= 0) selectedIndex.current = index;
  }, [ordered, selectedRunId]);
  useEffect(() => {
    if (
      !selectedRunId
      || detail?.run.id !== selectedRunId
      || runs.some((run) => run.id === selectedRunId)
      || ordered.some((run) => run.id === selectedRunId)
      || ordered.length === 0
    ) return;
    onSelectRun(ordered[Math.min(selectedIndex.current, ordered.length - 1)]!.id);
  }, [detail?.run.id, onSelectRun, ordered, runs, selectedRunId]);
  const load = (clear = false): void => {
    const generation = ++loadGeneration.current;
    if (clear) setDetail(null);
    if (!selected) {
      setDetail(null);
      return;
    }
    setError(null);
    void workflowRequest<WorkflowRunDetail>(
      `/api/workflow-runs/${encodeURIComponent(selected)}`,
    )
      .then((next) => {
        if (loadGeneration.current === generation) setDetail(next);
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setDetail(null);
        setError(
          caught instanceof WorkflowApiError && caught.status === 404
            ? "This workflow run is no longer retained. Select another run from history."
            : caught instanceof Error
              ? caught.message
              : "Could not load workflow run",
        );
      });
  };
  useEffect(() => {
    load(true);
    return () => { loadGeneration.current++; };
  }, [selected, selectedSummary]);

  const mutate = async (path: string, body: object): Promise<boolean> => {
    setError(null);
    try {
      await workflowRequest(path, { method: "POST", body: JSON.stringify(body) });
      load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow action failed");
      load();
      return false;
    }
  };

  const resubmit = async (unchanged: boolean): Promise<void> => {
    if (!detail) return;
    const remembered = unchangedRequest.current?.runId === detail.run.id
      ? unchangedRequest.current.requestId
      : null;
    const requestId = unchanged && remembered ? remembered : crypto.randomUUID();
    setError(null);
    try {
      await workflowRequest(`/api/workflow-runs/${detail.run.id}/resubmit`, {
        method: "POST",
        body: JSON.stringify({ requestId, resubmitUnchanged: unchanged }),
      });
      unchangedRequest.current = null;
      load();
    } catch (caught) {
      if (
        caught instanceof WorkflowApiError
        && caught.body?.code === "workflow_unchanged_evidence"
      ) {
        unchangedRequest.current = { runId: detail.run.id, requestId };
      }
      setError(caught instanceof Error ? caught.message : "Workflow resubmission failed");
      load();
    }
  };

  const copyFeedback = async (): Promise<void> => {
    if (!detail) return;
    const deliveryPayload = [...detail.deliveries].reverse()
      .find((delivery) => delivery.payload.length > 0)?.payload;
    const text = deliveryPayload ?? detail.attempts.flatMap((attempt) => {
      const verdict = attempt.verdict as unknown as PersonaVerdict | null;
      if (!verdict || !attempt.persona) return [];
      if (verdict.verdict === "pass") {
        return [`${attempt.persona.name}: PASS\n${verdict.summary}\n${verdict.approvalDetails.reason}`];
      }
      return [([
        `${attempt.persona.name}: FAIL`,
        verdict.summary,
        ...verdict.requestedChanges.map((change) => `- ${change.title}: ${change.rationale}`),
      ].join("\n"))];
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not copy workflow feedback");
    }
  };

  const loadMoreEvents = async (): Promise<void> => {
    const current = detail;
    if (!current?.nextEventAfter) return;
    try {
      const page = await workflowRequest<WorkflowEventPage>(
        `/api/workflow-runs/${encodeURIComponent(current.run.id)}/events?after=${current.nextEventAfter}&limit=200`,
      );
      setDetail((value) => value?.run.id === current.run.id
        ? {
            ...value,
            events: [...value.events, ...page.items],
            nextEventAfter: page.nextAfter,
          }
        : value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more workflow events");
    }
  };

  const loadMoreCalls = async (): Promise<void> => {
    const current = detail;
    if (!current?.nextLlmCallAfter) return;
    try {
      const page = await workflowRequest<WorkflowLlmCallPage>(
        `/api/workflow-runs/${encodeURIComponent(current.run.id)}/calls?after=${encodeURIComponent(current.nextLlmCallAfter)}&limit=200`,
      );
      setDetail((value) => value?.run.id === current.run.id
        ? {
            ...value,
            llmCalls: [...(value.llmCalls ?? []), ...page.items],
            nextLlmCallAfter: page.nextAfter,
          }
        : value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more workflow model calls");
    }
  };

  if (ordered.length === 0 && listLoading) {
    return <section className="workflow-empty" aria-live="polite"><p>Loading workflow runs…</p></section>;
  }

  if (ordered.length === 0 && !filters && !selectedRunId && !listError) {
    return (
      <section className="workflow-empty">
        <span className="workflow-empty-mark" aria-hidden>↻</span>
        <h3>No workflow runs yet</h3>
        <p>Bind an immutable published version to a session, then submit a manual Preview.</p>
      </section>
    );
  }

  return (
    <section className="workflow-runs">
      <aside className="workflow-run-list">
        {listError && <p className="persona-error" role="alert">{listError}</p>}
        <form
          className="workflow-run-filters"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Filter workflow runs"
        >
          <label>
            State
            <Tooltip label="Limit history to runs in one current state">
              <select
                value={filters?.status ?? ""}
                onChange={(event) => onFilters({
                  ...filters,
                  status: event.target.value
                    ? event.target.value as WorkflowRunSummary["status"]
                    : undefined,
                })}
              >
                <option value="">All states</option>
                {[
                  "capturing", "running", "waiting_for_session", "waiting_for_pr",
                  "waiting_for_inspector", "waiting_for_new_head", "blocked",
                  "completed", "cancelled", "failed",
                ].map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
              </select>
            </Tooltip>
          </label>
          <label>
            Workflow id
            <input
              maxLength={200}
              value={filters?.workflowId ?? ""}
              onChange={(event) => onFilters({
                ...filters,
                workflowId: event.target.value || undefined,
              })}
            />
          </label>
          <label>
            Session
            <input
              maxLength={200}
              value={filters?.session ?? ""}
              onChange={(event) => onFilters({
                ...filters,
                session: event.target.value || undefined,
              })}
            />
          </label>
          {filters && (
            <Tooltip label="Show Workflow history without state, workflow, or session filters">
              <button className="btn btn-ghost" onClick={() => onFilters(undefined)}>
                Clear filters
              </button>
            </Tooltip>
          )}
        </form>
        {ordered.length === 0 && (
          <div className="workflow-run-empty-filter">
            <strong>No runs match these filters.</strong>
            <p>Clear a filter or wait for a matching run.</p>
          </div>
        )}
        {ordered.map((run) => (
          <Tooltip key={run.id} label={`Open this ${run.workflowName} run - ${run.status.replaceAll("_", " ")}`}>
            <button
              className={selected === run.id ? "active" : ""}
              onClick={() => onSelectRun(run.id)}
            >
              <strong>{run.workflowName} · v{run.workflowVersion}</strong>
              <span>{run.noteKey} · {run.status.replaceAll("_", " ")}</span>
              {run.gate !== "none" && (
                <span>
                  Inspector: {run.gate.replaceAll("_", " ")}
                  {run.gatePrNumber ? ` · #${run.gatePrNumber}` : ""}
                  {run.gateHeadShort ? ` · ${run.gateHeadShort}` : ""}
                </span>
              )}
              <small>{when(run.updatedAt)}</small>
            </button>
          </Tooltip>
        ))}
        {nextCursor && (
          <Tooltip label="Load the next page of Workflow run history">
            <button
              className="btn btn-ghost workflow-run-load-more"
              disabled={listLoading}
              onClick={() => void listPage(nextCursor, true)}
            >
              {listLoading ? "Loading…" : "Load more runs"}
            </button>
          </Tooltip>
        )}
      </aside>
      <div className="workflow-run-reader">
        {error && <p className="persona-error" role="alert">{error}</p>}
        {!detail && !error && selected
          ? <p>Loading run…</p>
          : !detail && !error
            ? <p>Select a workflow run to inspect its audit history.</p>
            : null}
        {detail && (
          <WorkflowRunView
            detail={detail}
            onResubmit={resubmit}
            onRetry={async (nodeAttemptId) => {
              await mutate(`/api/workflow-runs/${detail.run.id}/retry`, {
                requestId: crypto.randomUUID(),
                ...(nodeAttemptId ? { nodeAttemptId } : {}),
              });
            }}
            onCancel={async () => {
              await mutate(`/api/workflow-runs/${detail.run.id}/cancel`, {
                requestId: crypto.randomUUID(),
              });
            }}
            onCopyFeedback={copyFeedback}
            onLoadEvents={loadMoreEvents}
            onLoadCalls={loadMoreCalls}
            onPreparePr={async () => {
              await mutate(`/api/workflow-runs/${detail.run.id}/prepare-pr`, {
                requestId: crypto.randomUUID(),
              });
            }}
            onRecheckInspector={async () => {
              await mutate(`/api/workflow-runs/${detail.run.id}/recheck-inspector`, {
                requestId: crypto.randomUUID(),
              });
            }}
            onRestartFull={async (confirmation) => {
              await mutate(`/api/workflow-runs/${detail.run.id}/restart-full`, {
                requestId: crypto.randomUUID(),
                ...(confirmation ? { confirmation } : {}),
              });
            }}
            onOpenInspectorSettings={onOpenInspectorSettings}
            onRetryDelivery={async (deliveryId) => {
              if (!detail.binding.sessionId) return;
              await mutate(`/api/workflow-deliveries/${deliveryId}/retry`, {
                requestId: crypto.randomUUID(),
                expectedSessionId: detail.binding.sessionId,
                expectedNoteKey: detail.binding.noteKey,
              });
            }}
            onResolveDelivery={async (deliveryId, resolution, confirmation) => {
              await mutate(`/api/workflow-deliveries/${deliveryId}/resolve`, {
                requestId: crypto.randomUUID(),
                resolution,
                ...(confirmation ? { confirmation } : {}),
                ...(resolution === "discard_and_new_round" && detail.binding.sessionId
                  ? {
                      expectedSessionId: detail.binding.sessionId,
                      expectedNoteKey: detail.binding.noteKey,
                    }
                  : {}),
              });
            }}
            onOpenSession={() => {
              if (detail.summary.sessionId) onOpenSession(detail.summary.sessionId);
            }}
          />
        )}
      </div>
    </section>
  );
}
