import { useEffect, useMemo, useState } from "react";
import type { EnsembleActionBody } from "@shared/protocol.ts";
import type {
  EnsembleArtifact,
  EnsembleAttempt,
  EnsembleMember,
  EnsembleSelectOneSelection,
} from "@shared/ensemble.ts";
import { fmtUsd } from "../lib/format.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import type { EnsembleArtifactPatch, EnsembleRunDetailResponse } from "./types.ts";
import {
  ensembleStatusLabel,
  ensembleStatusTone,
  fmtElapsed,
  shortSha,
  titleCaseEnum,
} from "./format.ts";
import { EnsembleMembers } from "./EnsembleMembers.tsx";
import { EnsembleTimeline } from "./EnsembleTimeline.tsx";
import { EnsembleArtifacts } from "./EnsembleArtifacts.tsx";
import { EnsembleActions } from "./EnsembleActions.tsx";
import { ENSEMBLE_RESULT_RENDERERS } from "./results/index.ts";

/**
 * One run's generic detail: a header of strategy/status/base/budget facts, the strategy's own
 * result view (behind the renderer registry), members, artifacts, the orchestration timeline,
 * the outcome and Workflow handoff, and the state-aware action surface. Nothing here branches on
 * `best_of_n`; the only strategy-specific surface is the registry renderer.
 */
export function EnsembleDetail({
  detail,
  actionPending,
  actionError,
  actionErrorKind,
  onAction,
  onDelete,
  onLoadPatch,
  onOpenSession,
  onOpenTask,
  onManualSubmit,
  onOpenWorkflowRun,
}: {
  detail: EnsembleRunDetailResponse;
  actionPending: string | null;
  actionError: string | null;
  actionErrorKind: string | null;
  onAction: (body: EnsembleActionBody) => void;
  onDelete: (confirmId: string) => void;
  onLoadPatch: (artifactId: string) => Promise<EnsembleArtifactPatch | { error: string }>;
  onOpenSession?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onManualSubmit?: (
    memberId: string,
    result: { summary: string; checks?: string[]; testEvidence?: string | null },
  ) => Promise<string | null>;
  onOpenWorkflowRun?: (runId: string) => void;
}): React.JSX.Element {
  const { run } = detail;
  const [restorePendingId, setRestorePendingId] = useState<string | null>(null);
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);

  // A restore rides the generic action surface, so its "Restoring…" clears when the action the
  // controller was tracking finishes (pending returns to null), not on a per-artifact timer.
  useEffect(() => {
    if (actionPending === null) setRestorePendingId(null);
  }, [actionPending]);

  // artifact -> attempt -> member, so a subject artifact can be given its member identity AFTER
  // the anonymous evaluation, and a member can be found for a restore.
  const { subjectLabel, memberOrdinal } = useMemo(() => {
    const attemptById = new Map<string, EnsembleAttempt>(detail.attempts.map((a) => [a.id, a]));
    const memberById = new Map<string, EnsembleMember>(detail.members.map((m) => [m.id, m]));
    const artifactById = new Map<string, EnsembleArtifact>(detail.artifacts.map((a) => [a.id, a]));
    const label = (artifactId: string): string => {
      const artifact = artifactById.get(artifactId);
      const attempt = artifact?.attemptId ? attemptById.get(artifact.attemptId) : null;
      const member = attempt ? memberById.get(attempt.memberId) : null;
      if (member) {
        const facts = [attempt?.agent, attempt?.observedModel ?? attempt?.requestedModel]
          .filter(Boolean)
          .join(" · ");
        return `Candidate ${member.ordinal}${facts ? ` (${facts})` : ""}`;
      }
      return `Artifact ${shortSha(artifact?.digest) || artifactId.slice(0, 8)}`;
    };
    const ordinal = (memberId: string): number | null => memberById.get(memberId)?.ordinal ?? null;
    return { subjectLabel: label, memberOrdinal: ordinal };
  }, [detail.attempts, detail.members, detail.artifacts]);

  const reviewCost = detail.llmCalls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
  const allAuthoritativeCost =
    detail.llmCalls.length > 0 && detail.llmCalls.every((call) => call.costUsd !== null);
  const budget = run.plan?.budget ?? null;
  const tone = ensembleStatusTone(run.status, run.unreadable);
  const actionBusy = actionPending !== null;
  const decisionPending = actionPending === "decide";

  const Renderer = run.strategyId ? ENSEMBLE_RESULT_RENDERERS[run.strategyId] : undefined;
  const decision =
    run.status === "awaiting_decision"
      ? {
          busy: actionBusy,
          pending: decisionPending,
          error: actionErrorKind === "decide" ? actionError : null,
          onDecide: (selection: EnsembleSelectOneSelection, rationale: string) =>
            onAction({
              kind: "decide",
              // A fresh key each attempt is safe: `expectedStatus` refuses a second decide once
              // the first has moved the run to `finalizing`, so this cannot double-promote.
              requestId: crypto.randomUUID(),
              expectedStatus: "awaiting_decision",
              selection,
              rationale,
              confirmDestructive: true,
            }),
        }
      : null;

  const restore = (artifactId: string): void => {
    setRestorePendingId(artifactId);
    onAction({ kind: "restore_artifact", artifactId });
  };

  return (
    <article className="ensemble-detail" aria-label={`Ensemble ${run.title}`}>
      <header className="ensemble-detail-head">
        <div className="ensemble-detail-title">
          <h3>{run.title}</h3>
          <p className="ensemble-detail-sub">
            {run.strategyLabel} v{run.strategyVersion} · <code>{run.repoRoot}</code>
          </p>
        </div>
        <span className={`ensemble-state ensemble-tone-${tone}`}>{ensembleStatusLabel(run)}</span>
      </header>

      {run.unreadable && (
        <p className="ensemble-warn" role="note">
          This run was written by a build this one cannot fully read: {run.unreadable.reason} It can
          still be cancelled or deleted, but not resumed here.
        </p>
      )}
      {run.error && (
        <p className="ensemble-error" role="alert">
          {run.error}
        </p>
      )}

      <dl className="ensemble-facts">
        <div>
          <dt>Members</dt>
          <dd>
            {detail.members.length}
            {budget ? ` / ${budget.maxMembers} max` : ""}
          </dd>
        </div>
        {run.activeStageId && (
          <div>
            <dt>Active stage</dt>
            <dd>
              <code>{run.activeStageId}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Pinned base</dt>
          <dd>
            {run.baseSha ? <code>{shortSha(run.baseSha)}</code> : <span className="ensemble-muted">not pinned yet</span>}
            {run.baseBranch ? ` (${run.baseBranch})` : ""}
          </dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{fmtElapsed(run.createdAt, run.completedAt)}</dd>
        </div>
        {budget && (
          <div>
            <dt>Concurrency</dt>
            <dd>
              {budget.maxConcurrentMembers} at once · {budget.maxWaves} wave
              {budget.maxWaves === 1 ? "" : "s"}
            </dd>
          </div>
        )}
        <div>
          <dt>Review calls</dt>
          <dd>
            {detail.llmCalls.length}
            {allAuthoritativeCost
              ? ` · ${fmtUsd(reviewCost)}`
              : detail.llmCalls.length > 0
                ? " · partial cost telemetry"
                : ""}
          </dd>
        </div>
      </dl>

      {Renderer && (
        <section className="ensemble-section" aria-label="Result">
          <h4>Result</h4>
          <Renderer
            detail={detail}
            subjectLabel={subjectLabel}
            onOpenArtifact={(artifactId) => setOpenArtifactId(artifactId)}
            decision={decision}
          />
        </section>
      )}

      <EnsembleOutcome
        detail={detail}
        memberOrdinal={memberOrdinal}
        onOpenWorkflowRun={onOpenWorkflowRun}
      />

      <section className="ensemble-section" aria-label="Members">
        <h4>Members</h4>
        <EnsembleMembers
          detail={detail}
          pending={actionPending}
          onAction={onAction}
          onOpenSession={onOpenSession}
          onOpenTask={onOpenTask}
          onManualSubmit={onManualSubmit}
        />
      </section>

      <section className="ensemble-section" aria-label="Artifacts">
        <h4>Artifacts</h4>
        <EnsembleArtifacts
          detail={detail}
          subjectLabel={subjectLabel}
          onLoadPatch={onLoadPatch}
          onRestore={restore}
          restorePendingId={restorePendingId}
          actionsDisabled={actionBusy}
          autoOpenId={openArtifactId}
        />
      </section>

      <section className="ensemble-section" aria-label="Timeline">
        <h4>Timeline</h4>
        <EnsembleTimeline detail={detail} subjectLabel={subjectLabel} />
      </section>

      <section className="ensemble-section" aria-label="Actions">
        <h4>Actions</h4>
        <EnsembleActions
          detail={detail}
          pending={actionPending}
          error={actionErrorKind !== "decide" ? actionError : null}
          onAction={onAction}
          onDelete={onDelete}
        />
      </section>
    </article>
  );
}

function EnsembleOutcome({
  detail,
  memberOrdinal,
  onOpenWorkflowRun,
}: {
  detail: EnsembleRunDetailResponse;
  memberOrdinal: (memberId: string) => number | null;
  onOpenWorkflowRun?: (runId: string) => void;
}): React.JSX.Element | null {
  const { outcome, workflowHandoff } = detail.run;
  if (!outcome && !workflowHandoff) return null;

  const candidates = (ids: string[]): string =>
    ids
      .map((id) => memberOrdinal(id))
      .filter((n): n is number => n !== null)
      .map((n) => `#${n}`)
      .join(", ");

  return (
    <section className="ensemble-section ensemble-outcome" aria-label="Outcome">
      <h4>Outcome</h4>
      {outcome && (
        <p className="ensemble-outcome-line">
          {outcome.kind === "selected" && (
            <>
              Selected member {candidates(outcome.memberIds)}
              {outcome.materializedTaskId && " (relaunched as a fresh task)"}.
            </>
          )}
          {outcome.kind === "synthesized" && <>Synthesized from member #{memberOrdinal(outcome.memberId)}.</>}
          {outcome.kind === "retained" && <>Retained members {candidates(outcome.memberIds)}.</>}
          {outcome.kind === "no_consensus" && <>No consensus: {outcome.reason}</>}
        </p>
      )}
      {workflowHandoff && (
        <div className="ensemble-handoff">
          <h5>Workflow handoff</h5>
          <p>
            {workflowHandoff.workflowName} v{workflowHandoff.workflowVersion} ·{" "}
            {titleCaseEnum(workflowHandoff.triggerMode)} · {titleCaseEnum(workflowHandoff.deliveryMode)}
          </p>
          <p className="ensemble-muted">
            State: {titleCaseEnum(workflowHandoff.state)}
            {workflowHandoff.expectedHeadSha
              ? ` · reviewing ${shortSha(workflowHandoff.expectedHeadSha)}`
              : ""}
          </p>
          {workflowHandoff.error && (
            <p className="ensemble-error" role="alert">
              {workflowHandoff.error}
            </p>
          )}
          {workflowHandoff.runId && onOpenWorkflowRun && (
            <Tooltip label="Open the linked workflow run reviewing this winner">
              <button className="btn btn-ghost" onClick={() => onOpenWorkflowRun(workflowHandoff.runId!)}>
                Open workflow run
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </section>
  );
}
