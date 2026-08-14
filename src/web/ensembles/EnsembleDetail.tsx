import { useEffect, useMemo, useRef, useState } from "react";
import type { EnsembleActionBody } from "@shared/protocol.ts";
import type {
  EnsembleArtifact,
  EnsembleAttempt,
  EnsembleJson,
  EnsembleMember,
  EnsembleSummary,
} from "@shared/ensemble.ts";
import { aggregateEnsembleAgentCost } from "@shared/ensemble.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { fmtUsd } from "../lib/format.ts";
import { RepositoryName } from "../components/RepositoryName.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import type { EnsembleArtifactPatch, EnsembleRunDetailResponse } from "./types.ts";
import {
  agentCostSummary,
  ensembleStatusLabel,
  ensembleStatusTone,
  fmtElapsed,
  shortSha,
  titleCaseEnum,
} from "./format.ts";
import {
  EnsembleMembers,
  type EnsembleMemberLiveLane,
} from "./EnsembleMembers.tsx";
import { EnsemblePipeline } from "./EnsemblePipeline.tsx";
import { EnsembleTimeline } from "./EnsembleTimeline.tsx";
import { EnsembleArtifacts } from "./EnsembleArtifacts.tsx";
import { EnsembleCompare } from "./EnsembleCompare.tsx";
import { EnsembleActions } from "./EnsembleActions.tsx";
import {
  chooseCompareArtifactIds,
  eligibleCompareArtifacts,
  type CompareControl,
} from "./compare.ts";
import { ENSEMBLE_RESULT_RENDERERS } from "./results/index.ts";

/**
 * One run's generic detail: a header of strategy/status/base/budget facts, the strategy's own
 * result view (behind the renderer registry), members, the comparison workspace, artifacts, the
 * orchestration timeline, the outcome and Workflow handoff, and the state-aware action surface.
 * Nothing here branches on `best_of_n`; the only strategy-specific surface is the registry
 * renderer.
 */
export function EnsembleDetail({
  detail,
  summary = null,
  sessions = [],
  reviews = [],
  actionPending,
  actionError,
  actionErrorKind,
  actionErrorMemberId = null,
  onAction,
  onDelete,
  onLoadPatch,
  onOpenSession,
  onOpenTask,
  onManualSubmit,
  onOpenWorkflowRun,
}: {
  detail: EnsembleRunDetailResponse;
  summary?: EnsembleSummary | null;
  sessions?: Session[];
  reviews?: ReviewItem[];
  actionPending: string | null;
  actionError: string | null;
  actionErrorKind: string | null;
  /** The member `actionError` was addressed to, when the refused action named one. */
  actionErrorMemberId?: string | null;
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
  const [compare, setCompare] = useState<CompareControl | null>(null);
  const compareRef = useRef<HTMLElement>(null);

  // Both control channels name artifacts inside ONE run. A route change must not briefly open
  // the previous run's evidence in the next run while its component-scoped fetch caches reset.
  useEffect(() => {
    setOpenArtifactId(null);
    setCompare(null);
  }, [run.id]);

  // The detail wire is intentionally durable-only. Live lanes join through the Task pointer
  // already present on each session, and reviews join through that session id. Kept here (rather
  // than inside each card) so the member half of this page owns one correlation rule and Phase 6
  // can remain a sibling consumer of the same threaded inputs.
  const liveByMemberId = useMemo(() => {
    const sessionByTaskId = new Map<string, Session>();
    for (const session of sessions) {
      if (session.task?.id) sessionByTaskId.set(session.task.id, session);
    }
    const pendingBySessionId = new Map<string, ReviewItem[]>();
    for (const review of reviews) {
      if (review.status !== "pending") continue;
      const list = pendingBySessionId.get(review.sessionId);
      if (list) list.push(review);
      else pendingBySessionId.set(review.sessionId, [review]);
    }
    const joined = new Map<string, EnsembleMemberLiveLane>();
    for (const member of detail.members) {
      if (!member.taskId) continue;
      const session = sessionByTaskId.get(member.taskId);
      if (!session) continue;
      joined.set(member.id, {
        session,
        reviews: pendingBySessionId.get(session.id) ?? [],
      });
    }
    return joined;
  }, [detail.members, sessions, reviews]);

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
    const memberBySelectedAttemptId = new Map<string, EnsembleMember>(
      detail.members
        .filter((member) => member.selectedAttemptId !== null)
        .map((member) => [member.selectedAttemptId!, member] as const),
    );
    const artifactById = new Map<string, EnsembleArtifact>(detail.artifacts.map((a) => [a.id, a]));
    const label = (artifactId: string): string => {
      const artifact = artifactById.get(artifactId);
      const attempt = artifact?.attemptId ? attemptById.get(artifact.attemptId) : null;
      const member = attempt
        ? memberById.get(attempt.memberId)
        : artifact?.attemptId
          ? memberBySelectedAttemptId.get(artifact.attemptId)
          : null;
      if (member) {
        const facts = [attempt?.agent, attempt?.observedModel ?? attempt?.requestedModel]
          .filter(Boolean)
          .join(" · ");
        // The compiled role's own label, not a literal "Candidate": a strategy names its members
        // (Best-of-N's candidates, Consensus's attempts) and the Members list below already prints
        // that name, so a hard-coded word here makes one page call the same member two things.
        const name = member.roleLabel.trim() || `Member ${member.ordinal}`;
        return `${name}${facts ? ` (${facts})` : ""}`;
      }
      return `Artifact ${shortSha(artifact?.digest) || artifactId.slice(0, 8)}`;
    };
    const ordinal = (memberId: string): number | null => memberById.get(memberId)?.ordinal ?? null;
    return { subjectLabel: label, memberOrdinal: ordinal };
  }, [detail.attempts, detail.members, detail.artifacts]);

  const reviewCost = detail.llmCalls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
  const allAuthoritativeCost =
    detail.llmCalls.length > 0 && detail.llmCalls.every((call) => call.costUsd !== null);
  // Aggregate agent cost, attributed per submitted member from the immutable artifacts and kept
  // honestly separate from the evaluator's own model cost above. Unknown stays unknown: a member
  // whose runner reported no cost is counted as unreported, never as $0.
  const agentCost = aggregateEnsembleAgentCost(detail.attempts, detail.artifacts);
  const agentCostLine = agentCostSummary(agentCost, fmtUsd);
  const budget = run.plan?.budget ?? null;
  const tone = ensembleStatusTone(run.status, run.unreadable);
  const actionBusy = actionPending !== null;
  const decisionPending = actionPending === "decide";

  // An action refusal is addressed to the surface that raised it, and the Actions section is only
  // one of those: a `decide` goes back to the result renderer holding the decision form, and an
  // action that named a member goes back to that member's card. Everything else is what Actions
  // shows. A refusal rendered at the page bottom under a heading the operator did not click reads
  // as a fact about the run rather than as an answer to what they just did.
  const memberActionError =
    actionError !== null && actionErrorMemberId !== null
      ? { memberId: actionErrorMemberId, message: actionError }
      : null;

  const Renderer = run.strategyId ? ENSEMBLE_RESULT_RENDERERS[run.strategyId] : undefined;
  const decision =
    run.status === "awaiting_decision"
      ? {
          busy: actionBusy,
          pending: decisionPending,
          error: actionErrorKind === "decide" ? actionError : null,
          onDecide: (selection: EnsembleJson, rationale: string) =>
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

  const openCompare = (artifactIds: string[], path: string): void => {
    const eligibleIds = eligibleCompareArtifacts(detail).map((artifact) => artifact.id);
    const scoredArtifactId = artifactIds[0];
    if (!scoredArtifactId) return;
    // Renderers supply the activation-safe pair for a first click. The same pure chooser keeps an
    // operator's existing 2-3 column selection when it already includes this scorecard's artifact.
    const target = chooseCompareArtifactIds({
      scoredArtifactId,
      currentSelection: compare?.artifactIds ?? [],
      recommendedArtifactId: artifactIds[1] ?? null,
      rankedArtifactIds: artifactIds,
      eligibleArtifactIds: eligibleIds,
    });
    if (!target) return;
    setCompare({ artifactIds: target, path });
    window.requestAnimationFrame(() => {
      compareRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <article className="ensemble-detail" aria-label={`Ensemble ${run.title}`}>
      <header className="ensemble-detail-head">
        <div className="ensemble-detail-title">
          <h3>{run.title}</h3>
          <p className="ensemble-detail-sub">
            {run.strategyLabel} v{run.strategyVersion} · <code><RepositoryName path={run.repoRoot} /></code>
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

      <EnsemblePipeline
        run={run}
        summary={summary}
        members={detail.members}
        stageAttempts={detail.stageAttempts}
      />

      <dl className="ensemble-facts">
        <div>
          <dt>Members</dt>
          <dd>
            {detail.members.length}
            {budget ? ` / ${budget.maxMembers} max` : ""}
          </dd>
        </div>
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
        {agentCost.known + agentCost.unknown > 0 && (
          <div>
            <dt>Candidate cost</dt>
            {/* One spelling of the partial-cost sentence, shared with the dossier's header:
                two surfaces printing the same figure had two chances to coalesce an unknown
                into a $0.00 that reads as "this candidate was free". */}
            <dd>
              {agentCostLine.reported ? (
                agentCostLine.label
              ) : (
                <span className="ensemble-muted">{agentCostLine.label}</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      {Renderer && (
        <section className="ensemble-section" aria-label="Result">
          <h4>Result</h4>
          <Renderer
            detail={detail}
            subjectLabel={subjectLabel}
            onOpenArtifact={(artifactId) => setOpenArtifactId(artifactId)}
            onOpenCompare={openCompare}
            // The SAME restore the Artifacts section runs, not a second path: it goes through
            // `onAction`, so its "Restoring…" clears on the controller's own pending flag and a
            // 409 lands where every other action's does.
            onRestoreArtifact={restore}
            restorePendingArtifactId={restorePendingId}
            decision={decision}
          />
        </section>
      )}

      <EnsembleOutcome
        detail={detail}
        memberOrdinal={memberOrdinal}
        onOpenTask={onOpenTask}
        onOpenWorkflowRun={onOpenWorkflowRun}
      />

      <section className="ensemble-section" aria-label="Members">
        <h4>Members</h4>
        <EnsembleMembers
          detail={detail}
          liveByMemberId={liveByMemberId}
          pending={actionPending}
          actionError={memberActionError}
          onAction={onAction}
          onOpenSession={onOpenSession}
          onOpenTask={onOpenTask}
          onManualSubmit={onManualSubmit}
        />
      </section>

      <EnsembleCompare
        key={run.id}
        detail={detail}
        subjectLabel={subjectLabel}
        compare={compare}
        onCompareChange={setCompare}
        sectionRef={compareRef}
      />

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
          error={actionErrorKind !== "decide" && memberActionError === null ? actionError : null}
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
  onOpenTask,
  onOpenWorkflowRun,
}: {
  detail: EnsembleRunDetailResponse;
  memberOrdinal: (memberId: string) => number | null;
  onOpenTask?: (taskId: string) => void;
  onOpenWorkflowRun?: (runId: string) => void;
}): React.JSX.Element | null {
  const { outcome, workflowHandoff } = detail.run;
  if (!outcome && !workflowHandoff) return null;
  const materializedTaskId =
    outcome && "materializedTaskId" in outcome ? outcome.materializedTaskId : null;

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
              Selected member {candidates(outcome.memberIds)}.
            </>
          )}
          {outcome.kind === "synthesized" && <>Synthesized from member #{memberOrdinal(outcome.memberId)}.</>}
          {outcome.kind === "retained" && <>Retained members {candidates(outcome.memberIds)}.</>}
          {outcome.kind === "no_consensus" && <>No consensus: {outcome.reason}</>}
        </p>
      )}
      {materializedTaskId && (
        <dl className="ensemble-workflow-resolution">
          <div>
            <dt>Materialized task</dt>
            <dd>
              <code>{materializedTaskId}</code>
              {onOpenTask && (
                <Tooltip label="Open the materialized winner Task">
                  <button className="btn btn-ghost" onClick={() => onOpenTask(materializedTaskId)}>
                    Open task
                  </button>
                </Tooltip>
              )}
            </dd>
          </div>
        </dl>
      )}
      {workflowHandoff && (
        <div className="ensemble-handoff">
          <h5>Workflow handoff</h5>
          <dl className="ensemble-workflow-resolution">
            <div>
              <dt>Pinned workflow</dt>
              <dd>
                {workflowHandoff.workflowName} v{workflowHandoff.workflowVersion}
              </dd>
            </div>
            <div>
              <dt>Workflow · version ids</dt>
              <dd>
                <code>{workflowHandoff.workflowId}</code> ·{" "}
                <code>{workflowHandoff.workflowVersionId}</code>
              </dd>
            </div>
            <div>
              <dt>Trigger · delivery</dt>
              <dd>
                {titleCaseEnum(workflowHandoff.triggerMode)} ·{" "}
                {titleCaseEnum(workflowHandoff.deliveryMode)}
              </dd>
            </div>
            <div>
              <dt>Completion</dt>
              <dd>
                {titleCaseEnum(workflowHandoff.completionPolicy)} ·{" "}
                {workflowHandoff.maxRepairRounds} repair rounds
              </dd>
            </div>
            <div>
              <dt>Handoff state</dt>
              <dd>{titleCaseEnum(workflowHandoff.state)}</dd>
            </div>
            <div>
              <dt>Expected head</dt>
              <dd>
                {workflowHandoff.expectedHeadSha ? (
                  <code>{workflowHandoff.expectedHeadSha}</code>
                ) : (
                  <span className="ensemble-muted">Not pinned yet</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Binding id</dt>
              <dd>
                {workflowHandoff.bindingId ? (
                  <code>{workflowHandoff.bindingId}</code>
                ) : (
                  <span className="ensemble-muted">Not bound yet</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Workflow run</dt>
              <dd>
                {workflowHandoff.runId ? (
                  <>
                    <code>{workflowHandoff.runId}</code>
                    {onOpenWorkflowRun && (
                      <Tooltip label="Open the linked workflow run reviewing this winner">
                        <button
                          className="btn btn-ghost"
                          onClick={() => onOpenWorkflowRun(workflowHandoff.runId!)}
                        >
                          Open workflow run
                        </button>
                      </Tooltip>
                    )}
                  </>
                ) : (
                  <span className="ensemble-muted">Not started yet</span>
                )}
              </dd>
            </div>
          </dl>
          {workflowHandoff.error && (
            <p className="ensemble-error" role="alert">
              {workflowHandoff.error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
