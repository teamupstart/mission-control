import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowExternalSource,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "@shared/workflow.ts";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";
import { WorkflowApiError, workflowRequest } from "./workflowApi.ts";
import { Tooltip } from "../components/Tooltip.tsx";

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
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
  return (
    <section className="workflow-run-detail">
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
        <Tooltip label="Jump to the session this run is reviewing">
          <button className="btn btn-ghost" onClick={onOpenSession}>Open session</button>
        </Tooltip>
        {(detail.deliveries.length > 0 || detail.attempts.some((attempt) => attempt.verdict)) && (
          <Tooltip label="Copy every reviewer verdict to the clipboard">
            <button className="btn btn-ghost" onClick={() => void onCopyFeedback()}>Copy feedback</button>
          </Tooltip>
        )}
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
              <pre>{delivery.payload}</pre>
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
            {context.evidence.workingTreeStatus.length > 0 && (
              <pre>{context.evidence.workingTreeStatus.join("\n")}</pre>
            )}
            <pre>{context.evidence.diff || "(No diff)"}</pre>
          </details>
        </section>
      )}

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
              {" "}attempt {attempt.attempt} · {attempt.state}
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
        <ol>
          {detail.events.map((event) => (
            <li key={event.id}>
              <time>{when(event.timestamp)}</time>
              <strong>{event.kind.replaceAll("_", " ")}</strong>
              <code>{JSON.stringify(event.payload)}</code>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}

export function WorkflowRuns({
  runs,
  selectedRunId,
  onSelectRun,
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
}: {
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onOpenSession?: (id: string) => void;
  onOpenInspectorSettings?: () => void;
}): React.JSX.Element {
  const ordered = useMemo(() => [...runs].sort((a, b) => b.updatedAt - a.updatedAt), [runs]);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const unchangedRequest = useRef<{ runId: string; requestId: string } | null>(null);
  const selected = selectedRunId ?? ordered[0]?.id ?? null;
  const selectedSummary = ordered.find((run) => run.id === selected) ?? null;
  const load = (clear = false): void => {
    const generation = ++loadGeneration.current;
    if (clear) setDetail(null);
    if (!selected) {
      setDetail(null);
      return;
    }
    setError(null);
    void workflowRequest<WorkflowRunDetail>(`/api/workflow-runs/${selected}`)
      .then((next) => {
        if (loadGeneration.current === generation) setDetail(next);
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setDetail(null);
        setError(caught instanceof Error ? caught.message : "Could not load workflow run");
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
    const delivery = detail.deliveries.at(-1);
    const text = delivery?.payload ?? detail.attempts.flatMap((attempt) => {
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

  if (ordered.length === 0) {
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
      </aside>
      <div className="workflow-run-reader">
        {error && <p className="persona-error" role="alert">{error}</p>}
        {!detail && !error && <p>Loading run…</p>}
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
