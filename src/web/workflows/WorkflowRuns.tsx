import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowRunDetail,
  WorkflowRunSummary,
} from "@shared/workflow.ts";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";
import { WorkflowApiError, workflowRequest } from "./workflowApi.ts";

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
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
    (latest, submission) => latest === null || submission.round > latest.round ? submission : latest,
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
}: {
  detail: WorkflowRunDetail;
  onResubmit: (unchanged: boolean) => Promise<void>;
  onRetry: (attemptId?: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onCopyFeedback?: () => Promise<void>;
  onOpenSession?: () => void;
}): React.JSX.Element {
  const latest = detail.submissions.at(-1) ?? null;
  const context = latest?.context as unknown as WorkflowContextSnapshot | null;
  const failedAttempt = [...detail.attempts].reverse().find((attempt) => attempt.state === "error");
  const version = detail.version;
  return (
    <section className="workflow-run-detail">
      <header className="workflow-run-detail-head">
        <div>
          <p className="workflow-eyebrow">Preview · version {detail.summary.workflowVersion}</p>
          <h3>{detail.summary.workflowName}</h3>
          <p>{detail.binding.sessionName} · round {detail.summary.round} of {detail.summary.maxRepairRounds + 1}</p>
          <small>Started {when(detail.run.startedAt)} · updated {when(detail.run.updatedAt)}</small>
        </div>
        <span className={`workflow-run-state wrs-${detail.run.status}`}>{detail.run.status.replaceAll("_", " ")}</span>
        <button className="btn btn-ghost" onClick={onOpenSession}>Open session</button>
        {detail.attempts.some((attempt) => attempt.verdict) && (
          <button className="btn btn-ghost" onClick={() => void onCopyFeedback()}>Copy feedback</button>
        )}
        {detail.run.status === "waiting_for_session" && (
          <>
            <button className="btn" onClick={() => void onResubmit(false)}>Preview fresh evidence</button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (window.confirm("Run another Preview against the unchanged evidence snapshot?")) {
                  void onResubmit(true);
                }
              }}
            >
              Preview unchanged
            </button>
          </>
        )}
        {detail.run.status === "blocked" && detail.run.currentPhase === "infrastructure_error" && (
          <button className="btn" onClick={() => void onRetry(failedAttempt?.id)}>Retry provider call</button>
        )}
        {!["completed", "cancelled", "failed"].includes(detail.run.status) && (
          <button className="btn btn-danger" onClick={() => void onCancel()}>Cancel</button>
        )}
      </header>

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
            <summary>Evidence snapshot</summary>
            <dl>
              <div><dt>HEAD</dt><dd>{context.evidence.headSha ?? "unavailable"}</dd></div>
              <div><dt>Working tree</dt><dd>{context.evidence.workingTreeDirty ? "dirty" : "clean"}</dd></div>
              <div><dt>Fingerprint</dt><dd><code>{latest?.evidenceFingerprint}</code></dd></div>
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
              <summary>All-pass Join · {received.length}/{new Set(incoming.map((edge) => edge.source)).size} predecessors</summary>
              <pre>{JSON.stringify(received.map((receipt) => receipt.payload), null, 2)}</pre>
            </details>
          );
        }) ?? null}
        {detail.run.gateState && (
          <details className="workflow-join-packet">
            <summary>Join and gate packet</summary>
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
}: {
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onOpenSession?: (id: string) => void;
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
    const text = detail.attempts.flatMap((attempt) => {
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
          <button
            key={run.id}
            className={selected === run.id ? "active" : ""}
            onClick={() => onSelectRun(run.id)}
          >
            <strong>{run.workflowName} · v{run.workflowVersion}</strong>
            <span>{run.noteKey} · {run.status.replaceAll("_", " ")}</span>
            <small>{when(run.updatedAt)}</small>
          </button>
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
            onOpenSession={() => {
              if (detail.summary.sessionId) onOpenSession(detail.summary.sessionId);
            }}
          />
        )}
      </div>
    </section>
  );
}
