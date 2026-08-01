import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorkflowRunDetail, WorkflowRunSummary } from "@shared/workflow.ts";
import {
  nodeLabel,
  projectStages,
  stageMemberKey,
  stageMembers,
  stageName,
  stageSummary,
} from "@shared/workflow-stages.ts";
import { duration } from "../lib/format.ts";
import { copyText } from "../lib/clipboard.ts";
import {
  WorkflowChip,
  workflowRunTone,
} from "../components/session-bits.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import {
  actionBlockSentence,
  actionWaitSentence,
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  deliveryStateView,
  disabledStatusFor,
  endStatus,
  gateWaitSentence,
  inspectorFooterStatus,
  inspectorOnlyRoundSentence,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  reviewerStatus,
  runStatusLabel,
  selectedSubmission,
  sessionActionProgress,
  sessionActionStatus,
  shortSha,
  stageStatus,
  submissionStatus,
  verdictMeta,
  verdictOf,
  workflowFeedbackText,
} from "./run-model.ts";
import {
  copyFeedbackAction,
  deliveryResolutionActions,
  inspectorGateActions,
  runActionTooltip,
  type RunActionDescriptor,
  type RunActionId,
  type WorkflowDeliveryResolution,
} from "./run-actions.ts";
import { useRunActions } from "./run-action-store.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";
import { workflowRequest } from "./workflowApi.ts";
import {
  createWorkflowLoadAcknowledgement,
  createWorkflowLoadCommitBarrier,
  createWorkflowRefreshQueue,
} from "./workflow-load-commit.ts";
import { useWorkflowRunDetail } from "./useWorkflowRunDetail.ts";
import {
  WorkflowLadderPeek,
  WorkflowLadderPeekPlaceholder,
} from "./WorkflowLadderPeek.tsx";

interface WorkflowLadderProps {
  summary: WorkflowRunSummary;
  detail: WorkflowRunDetail;
  onOpenRun: () => void;
  onCopyFeedback?: () => void;
  onRecheckInspector?: () => void;
  onPreparePr?: () => void;
  onOpenPr?: () => void;
  onResolveDelivery?: (
    deliveryId: string,
    action: WorkflowDeliveryResolution,
  ) => void;
  feedbackCopied?: boolean;
  actionError?: string | null;
  /** `detail.binding.sessionId !== null`; never inferred from the viewed Session. */
  sessionBound: boolean;
  isPending?: (id: RunActionId) => boolean;
}

function rungState(status: PipelineStatus, pending = false): string {
  if (status.tone === "passed") return "is-passed";
  if (status.tone === "running") return "is-running";
  if (status.tone === "failed") return "is-failed";
  return pending ? "is-pending" : "is-waiting";
}

function statusGlyph(status: PipelineStatus): string {
  if (status.degraded) return "○";
  if (status.tone === "passed") return "✓";
  if (status.tone === "failed") return "×";
  if (status.tone === "running") return "●";
  return "○";
}

function LadderAction({
  descriptor,
  pending,
  danger = false,
  onClick,
}: {
  descriptor: RunActionDescriptor;
  pending: boolean;
  danger?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const disabled = descriptor.disabled || pending;
  return (
    <Tooltip label={runActionTooltip(descriptor, pending)}>
      <button
        className={`btn wf-ladder-action${danger ? " btn-danger-ghost" : ""}`}
        type="button"
        disabled={disabled}
        onClick={onClick}
      >
        {descriptor.label}
      </button>
    </Tooltip>
  );
}

function Rung({
  name,
  sub = null,
  status,
  terminal = false,
  pending = false,
  fixed = false,
  children = null,
}: {
  name: string;
  sub?: string | null;
  status: PipelineStatus;
  terminal?: boolean;
  pending?: boolean;
  /**
   * This rung is the completion POLICY, not an authored stage: it sits after the End and
   * nothing about it can be edited from any surface. A word rather than only a class, for
   * the reason the pipeline footer's badge is one - the distinction has to survive a reader
   * who never sees the styling.
   */
  fixed?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      className={[
        "wf-ladder-rung",
        `workflow-${status.tone}`,
        rungState(status, pending),
        terminal ? "is-terminal" : "",
        fixed ? "is-fixed" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="wf-ladder-row">
        <span className="wf-ladder-title">
          <strong>{name}</strong>
          {fixed && <span className="wf-ladder-fixed">Fixed</span>}
          {sub && <span className="wf-ladder-sub">{sub}</span>}
        </span>
        <span className="wf-ladder-state">{status.label}</span>
      </div>
      {children}
    </li>
  );
}

/**
 * One workflow run, projected onto a compact vertical reading of its authored stages.
 *
 * This is deliberately a pure renderer. Fetch ownership stays in `WorkflowLadderPanel`, so
 * tests and later phases can provide literal run detail without opening a second client path.
 */
export function WorkflowLadder({
  summary,
  detail,
  onOpenRun,
  onCopyFeedback,
  onRecheckInspector,
  onPreparePr,
  onOpenPr,
  onResolveDelivery,
  feedbackCopied = false,
  actionError = null,
  sessionBound,
  isPending = () => false,
}: WorkflowLadderProps): React.JSX.Element {
  const submission = selectedSubmission(detail, null);
  const attempts = latestAttemptsFor(detail, submission?.id ?? null);
  const statuses = nodeStatusesForSubmission(detail, submission?.id ?? null);
  const pipeline = detail.version ? projectStages(detail.version.graph) : null;

  if (pipeline === null) {
    return (
      <section className="wf-ladder-fallback" aria-label="Workflow run">
        <WorkflowChip run={summary} onOpen={onOpenRun} />
        <Tooltip label="Open this workflow in Runs">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </section>
    );
  }

  const graph = detail.version!.graph;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const personaNames = graph.nodes.flatMap((node) =>
    node.kind === "persona" && "persona" in node
      ? [{ id: node.persona.sourcePersonaId, name: node.persona.name }]
      : []);
  const actionNames = graph.nodes.flatMap((node) =>
    node.kind === "session_action" && "action" in node
      ? [{ id: node.action.sourceSessionActionId, name: node.action.name }]
      : []);
  const calls = detail.llmCalls ?? [];
  const changesRequested = [...attempts.values()]
    .some((attempt) => verdictOf(attempt)?.verdict === "fail");
  const session = submissionStatus(submission, changesRequested);
  const end = endStatus(detail, submission, true);
  const inspectorOnly = submission?.mode === "inspector_only";
  const gate = detail.inspectorGate
    && detail.inspectorGate.state.waitReason !== null
    ? detail.inspectorGate
    : null;
  // The VERSION's policy, not the workflow's and not the gate's liveness: a run is pinned to
  // the version it was published from, so the footer it shows is the one that version ends
  // with, whatever the draft has since become.
  const inspectorPolicy = detail.version?.completionPolicy.kind === "inspector";
  const uncertain = detail.deliveries.find((delivery) => delivery.state === "uncertain");
  const delivery = uncertain ? deliveryStateView(uncertain.state) : null;
  const feedbackAction = copyFeedbackAction(detail, feedbackCopied);
  const gateActions = inspectorGateActions(detail);

  return (
    <section className="wf-ladder-panel" aria-label={`${summary.workflowName} workflow stages`}>
      <header className="wf-ladder-head">
        <span className="wf-ladder-name">⌁ {summary.workflowName}</span>
        <span className="wf-ladder-version">v{summary.workflowVersion}</span>
        <span className={`wf-ladder-runstate workflow-${workflowRunTone(summary)}`}>
          {runStatusLabel(summary.status)}
        </span>
        <span className="wf-ladder-round">
          round {summary.round} / {summary.maxRepairRounds}
          {/* Only when there IS one, and stated as evidence rather than folded into the
              round counter: a segment costs no repair budget, so adding it to the left of
              that slash would report a run as closer to its limit than it is. */}
          {(summary.segment ?? 0) > 0 && ` · evidence ${(summary.segment ?? 0) + 1}`}
        </span>
      </header>

      {inspectorOnly && (
        <p className="wf-ladder-bypass">{inspectorOnlyRoundSentence()}</p>
      )}

      <ul className="wf-ladder">
        <Rung name="Session" status={session} terminal />

        {pipeline.stages.map((stage, index) => {
          const members = stageMembers(stage).map((member) => {
            const nodeId = member.nodeId;
            const node = nodeId ? nodes.get(nodeId) : undefined;
            const attempt = nodeId ? attempts.get(nodeId) : undefined;
            const outcome = attempt ? checkOutcomeOf(attempt) : null;
            // The runs monitor's override, read-only here and under the same boundary: a
            // switched-off gate the round has not reached reads Disabled, while an outcome
            // this round already recorded keeps its real chip on the session tile too. An
            // action is never in that set - the feature is scoped to `isVerdictNode` - so
            // asking is skipped rather than relying on it to answer null.
            //
            // A session action then reads its OWN lifecycle table, which is the same one the
            // run monitor uses: it has no pass/fail outcome to colour, and either evaluator's
            // table would print an earned-looking word for a node that judged nothing.
            // Not gated on `waiting`. A BLOCK is recorded as `state: "error"` carrying the
            // same observation record plus its code, so gating here on the waiting state
            // made the one sentence explaining why an action stopped unreachable on the
            // surface whose whole job is to carry it.
            const actionState = member.kind === "session_action" && attempt
              ? sessionActionProgress(attempt)
              : null;
            const status = (member.kind === "session_action"
              ? null
              : disabledStatusFor(detail.run.disabledNodeIds, nodeId, attempt))
              ?? (member.kind === "session_action"
                ? sessionActionStatus(
                    nodeId ? statuses[nodeId] : undefined,
                    actionState?.wait ?? null,
                  )
                : member.kind === "check"
                  ? checkStatus(nodeId ? statuses[nodeId] : undefined, outcome?.status ?? null)
                  : reviewerStatus(nodeId ? statuses[nodeId] : undefined));
            const name = node
              ? nodeLabel(graph, node, personaNames, actionNames)
              : member.kind === "check"
                ? `Check · ${member.slot}`
                : member.kind === "session_action" ? "Missing session action" : "Missing persona";
            const verdict = attempt ? verdictOf(attempt) : null;
            const meta = attempt ? verdictMeta(attempt, calls) : null;
            return { member, name, attempt, outcome, status, verdict, meta, actionState };
          });
          const status = stageStatus(members.map((member) => member.status), stage.kind);
          const expanded = status.tone === "running"
            || status.tone === "failed"
            || members.some((member) => member.status.degraded);
          const objection = members.find((member) => member.verdict?.verdict === "fail");
          const repeatOffenders = status.tone === "failed"
            ? (detail.repeatOffenders ?? []).filter((offender) =>
                stageMembers(stage).some((member) => member.nodeId === offender.nodeId))
            : [];

          return (
            <Rung
              key={stage.kind === "evaluation" && stage.joinId !== null
                ? stage.joinId
                : `stage:${index}`}
              name={stageName(stage, index, personaNames, actionNames)}
              sub={stageSummary(stage)}
              status={status}
            >
              {expanded && (
                <ul className="wf-ladder-members">
                  {members.map((member) => {
                    // One note slot, two sources. A check explains a gate that advanced
                    // without running; an action explains what the run is waiting for, or
                    // why it stopped. The ladder is the Board's compact view, so this is
                    // often the only place an operator sees the reason at all.
                    const checkExplanation = member.status.degraded
                      && member.outcome
                      ? checkStatusView(member.outcome.status).sentence
                      : member.actionState?.blocked
                        ? actionBlockSentence(member.actionState.blocked.code)
                        : member.actionState?.wait
                          ? actionWaitSentence(member.actionState.wait)
                          : null;
                    const meta = member.meta
                      ? [
                          member.verdict
                            ? `${Math.round(member.verdict.confidence * 100)}% confident`
                            : null,
                          member.meta.durationMs === null
                            ? null
                            : duration(member.meta.durationMs),
                          member.meta.costUsd === null
                            ? null
                            : `$${member.meta.costUsd.toFixed(4)}`,
                        ].filter((part): part is string => part !== null).join(" · ")
                      : "";
                    return (
                      <li
                        className={`wf-ladder-member workflow-${member.status.tone}`}
                        key={member.member.nodeId ?? `${index}:${stageMemberKey(member.member)}`}
                      >
                        <span className="wf-ladder-member-row">
                          <span className="wf-ladder-member-mark" aria-hidden>
                            {statusGlyph(member.status)}
                          </span>
                          <span className="wf-ladder-member-name">{member.name}</span>
                          <span className="wf-ladder-member-state">{member.status.label}</span>
                        </span>
                        {meta && <span className="wf-ladder-member-meta">{meta}</span>}
                        {checkExplanation && (
                          <span className="wf-ladder-member-note">{checkExplanation}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {objection?.verdict?.verdict === "fail" && (
                <p className="wf-ladder-why">
                  <strong>{objection.name}:</strong> {objection.verdict.summary}
                </p>
              )}
              {repeatOffenders.map((offender) => (
                <p className="wf-ladder-repeat" key={offender.nodeId}>
                  {offender.personaName} has failed {offender.rounds} rounds running.
                </p>
              ))}
              {status.tone === "failed" && changesRequested && onCopyFeedback && (
                <div className="wf-ladder-actrow">
                  <LadderAction
                    descriptor={feedbackAction}
                    pending={false}
                    onClick={onCopyFeedback}
                  />
                </div>
              )}
            </Rung>
          );
        })}

        {delivery && uncertain && (
          <Rung
            name={uncertain.kind === "session_action" ? "Session action delivery" : "Repair delivery"}
            status={{ tone: "waiting", label: delivery.label }}
          >
            <p className="wf-ladder-sentence">{delivery.sentence}</p>
            {onResolveDelivery && (
              <div className="wf-ladder-actrow">
                {deliveryResolutionActions(uncertain, sessionBound).map((action) => (
                  <LadderAction
                    key={action.id}
                    descriptor={action}
                    pending={isPending(action.id)}
                    danger={action.confirm.danger}
                    onClick={() => onResolveDelivery(action.deliveryId, action.resolution)}
                  />
                ))}
              </div>
            )}
          </Rung>
        )}

        <Rung
          name={pipeline.endOutcome}
          status={end}
          terminal
          pending={end.tone === "waiting"}
        />

        {/* AFTER the End, and drawn from the version's completion policy rather than from
            whether the gate currently has something to say. Inspector claims a run that has
            already reached graph success, so a ladder that showed it above End told the
            reader the two happen the other way round - and one that appeared only while the
            gate was waiting made the final step of an approved run vanish the moment it
            passed.

            It carries no `sub`. Every other rung's sub says what the stage HOLDS; this one
            would say "completion policy", which the Fixed badge beside it and the sentence
            below it already say twice - and a third label is what pushed this row past the
            Board's ~200px column at the Electron window's minimum width. */}
        {inspectorPolicy && (
          <Rung
            name="Inspector"
            status={inspectorFooterStatus(summary.gate)}
            fixed
          >
            <p className="wf-ladder-sentence">
              {gate
                ? gateWaitSentence(gate.state.waitReason)
                : "Reviews the finished pull request once the workflow succeeds."}
            </p>
            {/* The FACTS and the buttons stay gated on a live gate, even though the rung no
                longer is. Making the rung unconditional was the point of the footer; moving
                its body with it printed `pull request: not resolved · target head: not
                pinned · posture: unknown` beside a permanently disabled Open PR from the
                first submission of every Inspector workflow - three unknowns and a dead
                control, for a gate the run has not reached. */}
            {gate && (
              <dl className="wf-ladder-meta">
                <div>
                  <dt>pull request</dt>
                  <dd>{summary.gatePrNumber ? `#${summary.gatePrNumber}` : "not resolved"}</dd>
                </div>
                <div>
                  <dt>target head</dt>
                  <dd>{shortSha(summary.gateHeadShort) ?? "not pinned"}</dd>
                </div>
                <div>
                  <dt>posture</dt>
                  <dd>{summary.reviewPosture ?? "unknown"}</dd>
                </div>
              </dl>
            )}
            {gate && (onPreparePr || onRecheckInspector || onOpenPr) && (
              <div className="wf-ladder-actrow">
                {gateActions.map((action) => {
                  const callback = action.kind === "prepare-pr"
                    ? onPreparePr
                    : action.kind === "recheck-inspector"
                      ? onRecheckInspector
                      : onOpenPr;
                  if (!callback) return null;
                  return (
                    <LadderAction
                      key={action.id}
                      descriptor={action}
                      pending={isPending(action.id)}
                      onClick={callback}
                    />
                  );
                })}
              </div>
            )}
          </Rung>
        )}
      </ul>

      {actionError && (
        <p className="wf-ladder-action-error" role="alert">{actionError}</p>
      )}

      <div className="wf-ladder-actrow">
        <Tooltip label="Open this workflow in Runs">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </div>
    </section>
  );
}

export interface WorkflowTileDisclosureState {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

function WorkflowTileDisclosure({
  run,
  detail,
  expanded,
  onExpandedChange,
  regionId,
  loadError = false,
  children,
}: {
  run: WorkflowRunSummary;
  detail: WorkflowRunDetail | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  regionId: string;
  loadError?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={`tile-workflow-disclosure${expanded ? " is-expanded" : ""}`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="tile-workflow-content" id={regionId}>
        {expanded
          ? children
          : detail
            ? <WorkflowLadderPeek summary={run} detail={detail} />
            : <WorkflowLadderPeekPlaceholder summary={run} error={loadError} />}
      </div>
      <div className="tile-workflow-disclosure-row">
        <Tooltip label={expanded
          ? "Return to the consequential workflow rung"
          : "Show every workflow stage and action inside this Board tile"}>
          <button
            className="tile-workflow-disclosure-btn"
            type="button"
            aria-controls={regionId}
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            <span className="tile-workflow-chevron" aria-hidden>⌄</span>
            {expanded ? "Collapse workflow" : "Show full workflow"}
          </button>
        </Tooltip>
        <span className="tile-workflow-disclosure-hint">
          {expanded ? "The active rung stays in context" : "Expand this tile in place"}
        </span>
      </div>
    </section>
  );
}

export function WorkflowLadderPanel({
  run,
  onOpenRun,
  tileDisclosure = null,
}: {
  run: WorkflowRunSummary;
  onOpenRun: () => void;
  tileDisclosure?: WorkflowTileDisclosureState | null;
}): React.JSX.Element {
  const disclosureRegionId = useId();
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [feedbackCopied, setFeedbackCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const copyReset = useRef<number | null>(null);
  const mounted = useRef(false);
  const refreshGeneration = useRef(0);
  const refreshCommit = useRef(createWorkflowLoadCommitBarrier());
  const refreshAcknowledgement = useRef(createWorkflowLoadAcknowledgement());
  const refreshQueue = useRef(createWorkflowRefreshQueue());
  const performRefresh = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    const generation = ++refreshGeneration.current;
    const committed = refreshCommit.current.waitFor(generation);
    setRefreshRevision(generation);
    return committed;
  }, []);
  const requestRefresh = useCallback(
    (): Promise<void> => refreshQueue.current.enqueue(performRefresh),
    [performRefresh],
  );
  const state = useWorkflowRunDetail(run.id, run.updatedAt + refreshRevision);
  const controller = useRunActions(run.id, requestRefresh);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshCommit.current.release();
      if (copyReset.current !== null) window.clearTimeout(copyReset.current);
    };
  }, []);
  useEffect(() => {
    // React can run the prior ready-state effect after requestRefresh registers a waiter but
    // before useWorkflowRunDetail publishes loading. Require this generation's loading render
    // before its later ready/error render may release the shared action guard.
    if (refreshAcknowledgement.current.observe(
      refreshRevision,
      state.state === "loading",
    )) refreshCommit.current.commit(refreshRevision);
  }, [refreshRevision, state]);
  useEffect(() => {
    refreshCommit.current.release();
    setFeedbackCopied(false);
    setLocalError(null);
    setConfirm(null);
  }, [run.id]);

  if (state.state === "loading") {
    const feedback = (
      <section className="wf-ladder-feedback" aria-busy="true">
        Loading workflow stages…
      </section>
    );
    return tileDisclosure
      ? (
          <WorkflowTileDisclosure
            run={run}
            detail={null}
            expanded={tileDisclosure.expanded}
            onExpandedChange={tileDisclosure.onExpandedChange}
            regionId={disclosureRegionId}
          >
            {feedback}
          </WorkflowTileDisclosure>
        )
      : feedback;
  }
  if (state.state === "error") {
    const feedback = (
      <section className="wf-ladder-feedback" role="alert">
        <p className="wf-ladder-error">{state.message}</p>
        <Tooltip label="Open this workflow in Runs">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </section>
    );
    return tileDisclosure
      ? (
          <WorkflowTileDisclosure
            run={run}
            detail={null}
            expanded={tileDisclosure.expanded}
            onExpandedChange={tileDisclosure.onExpandedChange}
            regionId={disclosureRegionId}
            loadError
          >
            {feedback}
          </WorkflowTileDisclosure>
        )
      : feedback;
  }
  const detail = state.detail;
  const sessionBound = detail.binding.sessionId !== null;
  const copyFeedback = (): void => {
    setLocalError(null);
    void copyText(workflowFeedbackText(detail))
      .then(() => {
        setFeedbackCopied(true);
        if (copyReset.current !== null) window.clearTimeout(copyReset.current);
        copyReset.current = window.setTimeout(() => {
          setFeedbackCopied(false);
          copyReset.current = null;
        }, 1600);
      })
      .catch((caught) => {
        setFeedbackCopied(false);
        setLocalError(caught instanceof Error
          ? caught.message
          : "Could not copy workflow feedback");
      });
  };
  const runPost = (
    id: RunActionId,
    path: string,
    body: (requestId: string) => object,
  ): void => {
    setLocalError(null);
    controller.run(id, (requestId) => workflowRequest(path, {
      method: "POST",
      body: JSON.stringify(body(requestId)),
    }));
  };
  const resolveDelivery = (
    deliveryId: string,
    resolution: WorkflowDeliveryResolution,
  ): void => {
    const target = detail.deliveries.find((item) => item.id === deliveryId);
    if (!target) return;
    const action = deliveryResolutionActions(target, sessionBound)
      .find((candidate) => candidate.resolution === resolution);
    if (!action || action.disabled) return;
    setConfirm({
      ...action.confirm,
      onConfirm: () => runPost(
        action.id,
        `/api/workflow-deliveries/${encodeURIComponent(deliveryId)}/resolve`,
        (requestId) => ({
          requestId,
          resolution,
          ...(action.confirm.requirePhrase
            ? { confirmation: action.confirm.requirePhrase }
            : {}),
          ...(resolution === "discard_and_new_round" && detail.binding.sessionId
            ? {
                expectedSessionId: detail.binding.sessionId,
                expectedNoteKey: detail.binding.noteKey,
              }
            : {}),
        }),
      ),
    });
  };
  const prUrl = detail.inspectorGate?.state.prUrl ?? null;
  const ladder = (
    <WorkflowLadder
      summary={run}
      detail={detail}
      onOpenRun={onOpenRun}
      onCopyFeedback={copyFeedback}
      onPreparePr={() => runPost(
        "prepare-pr",
        `/api/workflow-runs/${encodeURIComponent(run.id)}/prepare-pr`,
        (requestId) => ({ requestId }),
      )}
      onRecheckInspector={() => runPost(
        "recheck-inspector",
        `/api/workflow-runs/${encodeURIComponent(run.id)}/recheck-inspector`,
        (requestId) => ({ requestId }),
      )}
      onOpenPr={() => {
        if (prUrl) window.open(prUrl, "_blank", "noopener,noreferrer");
      }}
      onResolveDelivery={resolveDelivery}
      feedbackCopied={feedbackCopied}
      actionError={localError ?? controller.error}
      sessionBound={sessionBound}
      isPending={controller.isPending}
    />
  );
  return (
    <>
      {tileDisclosure
        ? (
            <WorkflowTileDisclosure
              run={run}
              detail={detail}
              expanded={tileDisclosure.expanded}
              onExpandedChange={tileDisclosure.onExpandedChange}
              regionId={disclosureRegionId}
            >
              {ladder}
            </WorkflowTileDisclosure>
          )
        : ladder}
      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </>
  );
}
