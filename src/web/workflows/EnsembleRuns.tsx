import { useEffect, useMemo, useRef, useState } from "react";
import type { EnsembleActionBody } from "@shared/protocol.ts";
import { ENSEMBLE_STATUSES, type EnsembleSummary } from "@shared/ensemble.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { relativeTime } from "../lib/format.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { EnsembleProgressDots } from "../components/session-bits.tsx";
import {
  deleteEnsemble,
  ensembleAction,
  fetchEnsembleArtifactPatch,
  fetchEnsembleDetail,
  submitEnsembleMember,
} from "../lib/api.ts";
import type { EnsembleArtifactPatch, EnsembleRunDetailResponse } from "../ensembles/types.ts";
import { EnsembleDetail } from "../ensembles/EnsembleDetail.tsx";
import { ensembleStatusLabel, ensembleStatusTone, titleCaseEnum } from "../ensembles/format.ts";

/**
 * The Ensembles tab's list + detail controller, mirroring `WorkflowRuns` but simpler: the list
 * is driven straight off the live `ensembleSummaries` SSE collection (which is already the full
 * bounded set), so there is no second fetch loop for history. Only the SELECTED run's bounded
 * detail is fetched over HTTP, aborted-by-generation on change and refetched when that run's SSE
 * summary revises - never polled. Actions carry the state they expect and, on a 409, refetch and
 * show the new state rather than replaying.
 */
export function EnsembleRuns({
  summaries,
  sessions = [],
  reviews = [],
  selectedId,
  hasSnapshot = false,
  onSelect,
  onOpenSession,
  onOpenTask,
  onOpenWorkflowRun,
}: {
  summaries: EnsembleSummary[];
  sessions?: Session[];
  reviews?: ReviewItem[];
  selectedId: string | null;
  hasSnapshot?: boolean;
  onSelect: (id: string | null) => void;
  onOpenSession?: (id: string) => void;
  onOpenTask?: (id: string) => void;
  onOpenWorkflowRun?: (runId: string) => void;
}): React.JSX.Element {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [strategyFilter, setStrategyFilter] = useState<string>("");
  const [repoFilter, setRepoFilter] = useState<string>("");

  const [detail, setDetail] = useState<EnsembleRunDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorKind, setActionErrorKind] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const observedRunIds = useRef(new Set<string>());

  const strategies = useMemo(
    () => [...new Set(summaries.map((s) => s.strategyLabel))].sort(),
    [summaries],
  );

  const ordered = useMemo(() => {
    const repo = repoFilter.trim().toLowerCase();
    return summaries
      .filter((s) => (!statusFilter || s.status === statusFilter))
      .filter((s) => (!strategyFilter || s.strategyLabel === strategyFilter))
      .filter((s) => (!repo || s.repoRoot.toLowerCase().includes(repo)))
      .sort(
        (a, b) =>
          Number(b.attention) - Number(a.attention) || b.updatedAt - a.updatedAt,
      );
  }, [summaries, statusFilter, strategyFilter, repoFilter]);

  const selected = selectedId ?? ordered[0]?.id ?? null;
  const selectedSummary = summaries.find((s) => s.id === selected) ?? null;
  const selectedRevision = selectedSummary?.updatedAt ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    for (const summary of summaries) observedRunIds.current.add(summary.id);
  }, [summaries]);

  useEffect(() => {
    if (
      hasSnapshot &&
      selectedId &&
      observedRunIds.current.has(selectedId) &&
      !summaries.some((s) => s.id === selectedId)
    ) {
      onSelect(ordered[0]?.id ?? null);
    }
  }, [hasSnapshot, selectedId, summaries, ordered, onSelect]);

  const load = (runId: string | null, clear: boolean): void => {
    const generation = ++loadGeneration.current;
    if (clear) {
      setDetail(null);
      setDetailError(null);
    }
    if (!runId) {
      setDetail(null);
      return;
    }
    void fetchEnsembleDetail(runId).then((result) => {
      if (loadGeneration.current !== generation || selectedRef.current !== runId) return;
      if (result.ok) {
        setDetail(result.data);
        setDetailError(null);
      } else {
        setDetail(null);
        setDetailError(
          result.status === 404
            ? "This ensemble is no longer retained. Choose another from the list."
            : result.error,
        );
      }
    });
  };

  // Refetch when the selection changes, or when THIS run's SSE summary revises (a new
  // `updatedAt`). Aborted-by-generation, never polled.
  useEffect(() => {
    load(selected, true);
    return () => {
      loadGeneration.current++;
    };
    // `selected` and `selectedRevision` are the only inputs that should re-fetch.
  }, [selected, selectedRevision]);

  useEffect(() => {
    actionGeneration.current++;
    setActionPending(null);
    setActionError(null);
    setActionErrorKind(null);
  }, [selected]);

  const runAction = (body: EnsembleActionBody): void => {
    const actedRunId = selected;
    if (!actedRunId) return;
    const actionToken = ++actionGeneration.current;
    setActionPending(body.kind);
    setActionError(null);
    setActionErrorKind(null);
    void ensembleAction(actedRunId, body).then((result) => {
      if (
        selectedRef.current !== actedRunId ||
        actionGeneration.current !== actionToken
      ) {
        return;
      }
      setActionPending(null);
      if (result.ok) {
        load(actedRunId, false);
      } else {
        // A 409 means the run moved on; show the fresh state, never replay automatically.
        setActionError(result.error);
        setActionErrorKind(body.kind);
        if (result.status === 409) load(actedRunId, false);
      }
    });
  };

  const runDelete = (confirmId: string): void => {
    const actedRunId = selected;
    if (!actedRunId) return;
    const actionToken = ++actionGeneration.current;
    setActionPending("delete");
    setActionError(null);
    setActionErrorKind(null);
    void deleteEnsemble(actedRunId, confirmId).then((result) => {
      if (
        selectedRef.current !== actedRunId ||
        actionGeneration.current !== actionToken
      ) {
        return;
      }
      setActionPending(null);
      if (result.ok) {
        onSelect(null);
      } else {
        setActionError(result.error);
        setActionErrorKind("delete");
        if (result.status === 409) load(actedRunId, false);
      }
    });
  };

  const loadPatch = async (
    artifactId: string,
  ): Promise<EnsembleArtifactPatch | { error: string }> => {
    if (!selected) return { error: "No run selected." };
    const result = await fetchEnsembleArtifactPatch(selected, artifactId);
    return result.ok ? result.data : { error: result.error };
  };

  const manualSubmit = async (
    memberId: string,
    result: { summary: string; checks?: string[]; testEvidence?: string | null },
  ): Promise<string | null> => {
    const actedRunId = selected;
    if (!actedRunId) return "No run selected.";
    const actionToken = ++actionGeneration.current;
    setActionPending("submit_member");
    setActionError(null);
    setActionErrorKind(null);
    const response = await submitEnsembleMember(actedRunId, memberId, result);
    if (
      selectedRef.current !== actedRunId ||
      actionGeneration.current !== actionToken
    ) {
      return null;
    }
    setActionPending(null);
    load(actedRunId, false);
    if (!response.ok) {
      setActionError(response.error);
      setActionErrorKind("submit_member");
      return response.error;
    }
    return null;
  };

  return (
    <div className="ensemble-runs">
      <div className="ensemble-run-list">
        <div className="ensemble-run-filters">
          <Tooltip label="Filter runs by status">
            <label>
              <span>Status</span>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All</option>
                {ENSEMBLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {titleCaseEnum(s)}
                  </option>
                ))}
              </select>
            </label>
          </Tooltip>
          {strategies.length > 1 && (
            <Tooltip label="Filter runs by strategy">
              <label>
                <span>Strategy</span>
                <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)}>
                  <option value="">All</option>
                  {strategies.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </Tooltip>
          )}
          <label>
            <span>Repository</span>
            <input
              value={repoFilter}
              placeholder="Filter by path"
              onChange={(e) => setRepoFilter(e.target.value)}
            />
          </label>
        </div>

        {ordered.length === 0 ? (
          <p className="ensemble-run-empty">
            {summaries.length === 0
              ? "No ensembles yet. Start one from Dispatch (switch to Ensemble mode)."
              : "No ensembles match these filters."}
          </p>
        ) : (
          <ul className="ensemble-run-buttons">
            {ordered.map((summary) => (
              <li key={summary.id}>
                <Tooltip label={`Open ${summary.title}`}>
                <button
                  className={summary.id === selected ? "active" : ""}
                  aria-current={summary.id === selected ? "true" : undefined}
                  onClick={() => onSelect(summary.id)}
                >
                  <span className="ensemble-run-title">
                    {summary.attention && (
                      <span className="ensemble-attention-dot" aria-label="Needs attention">
                        !
                      </span>
                    )}
                    {summary.title}
                  </span>
                  <small>
                    {summary.strategyLabel} ·{" "}
                    <span className={`ensemble-tone-${ensembleStatusTone(summary.status, summary.unreadable)}`}>
                      {ensembleStatusLabel(summary)}
                    </span>{" "}
                    · {relativeTime(summary.updatedAt)}
                  </small>
                  {/* The counts the SSE summary has always carried and no surface rendered.
                      `membersReady` (members that submitted and are neither out nor blocked)
                      over `maxMembers` - the same numerator and the same denominator the dots
                      beside it and the session chip use, because a third progress vocabulary
                      is a third answer to "how far along is this". `launchedMembers` is named
                      only while it is short of the roster, which is the one time the two
                      denominators differ and the operator would otherwise wonder where the
                      missing lanes went. */}
                  <span className="ensemble-run-progress">
                    <EnsembleProgressDots summary={summary} />
                    <span className="ensemble-run-counts">
                      {summary.membersReady}/{summary.maxMembers} in
                      {summary.launchedMembers < summary.maxMembers
                        ? ` · ${summary.launchedMembers} launched`
                        : ""}
                    </span>
                    {summary.membersNeedingInput > 0 && (
                      <span className="ensemble-run-needs">
                        {summary.membersNeedingInput} need
                        {summary.membersNeedingInput === 1 ? "s" : ""} you
                      </span>
                    )}
                  </span>
                </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ensemble-run-reader">
        {detailError && (
          <p className="ensemble-error" role="alert">
            {detailError}
          </p>
        )}
        {!detailError && !detail && selected && <p className="ensemble-muted">Loading ensemble…</p>}
        {!detailError && !selected && (
          <p className="ensemble-muted">Select an ensemble to see its members, evidence, and decision.</p>
        )}
        {detail && (
          <EnsembleDetail
            detail={detail}
            summary={selectedSummary}
            sessions={sessions}
            reviews={reviews}
            actionPending={actionPending}
            actionError={actionError}
            actionErrorKind={actionErrorKind}
            onAction={runAction}
            onDelete={runDelete}
            onLoadPatch={loadPatch}
            onOpenSession={onOpenSession}
            onOpenTask={onOpenTask}
            onManualSubmit={manualSubmit}
            onOpenWorkflowRun={onOpenWorkflowRun}
          />
        )}
      </div>
    </div>
  );
}
