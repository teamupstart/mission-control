import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowCheckOutcome,
  WorkflowExternalSource,
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowRunPage,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowEventPage,
  WorkflowLlmCallPage,
} from "@shared/workflow.ts";
import {
  formatCheckCommand,
  isVerdictNode,
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
} from "@shared/workflow.ts";
import { nodeLabel } from "@shared/workflow-stages.ts";
import { WorkflowApiError, workflowRequest } from "./workflowApi.ts";
import { RunPipeline } from "./RunPipeline.tsx";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import type { SessionActionProgress } from "./run-model.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRunTone } from "../components/session-bits.tsx";
import { copyText } from "../lib/clipboard.ts";
import { relativeTime } from "../lib/format.ts";
import type { WorkflowRunFilters } from "./useWorkflowRoute.ts";
import { requestWorkflowVersionOpen } from "./workflowSelection.ts";
import {
  actionBlockSentence,
  actionWaitSentence,
  attemptStateLabel,
  checkOutcomeOf,
  checkStatusView,
  continuationSourceAttempt,
  disabledStatusFor,
  endStatus,
  errorView,
  eventLine,
  eventsByRound,
  deliveryKindLabel,
  deliveryStateView,
  gateSummaryStatus,
  gateWaitSentence,
  inspectorFooterStatus,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  previousFullWorkflowAttempts,
  priorAttemptPassed,
  readCapturedContext,
  reviewerAttempts,
  runRounds,
  runStatusLabel,
  segmentProvenanceSentence,
  selectedSubmission,
  provenPullRequest,
  sessionActionProgress,
  sessionActionStatus,
  shortSha,
  submissionStatus,
  verdictMeta,
  verdictOf,
  workflowCallCost,
  workflowFeedbackText,
  workflowRunLoadError,
} from "./run-model.ts";
import {
  copyFeedbackAction,
  deliveryResolutionActions,
  inspectorGateActions,
  resubmitAvailability,
  runActionTooltip,
  type RunActionId,
} from "./run-actions.ts";
import { useRunActions } from "./run-action-store.ts";
import { createWorkflowLoadCommitBarrier } from "./workflow-load-commit.ts";

/**
 * Watching a run.
 *
 * The rebuild's one idea: a run is read on the pipeline it was authored on. The strip is
 * drawn from the same `pipeline-bits.tsx` leaves the editor uses, fed the immutable
 * published graph and the runtime statuses this file already computed; the round scrubber
 * says which submission every scoped section is about; and every durable enum reaches the
 * screen as a sentence, with its machine code demoted to a detail affordance.
 *
 * Two rules the sections below keep, and they pull in opposite directions on purpose:
 *
 *  - The strip, the verdicts, the join packets and the timeline are SCOPED to the viewed
 *    round. An attempt from round 1 says nothing about round 3, and a reader that merged
 *    them showed a reviewer as passed while it was being re-run.
 *  - The Inspector gate, the completion claims, the deliveries and every recovery control
 *    reflect the LIVE run whatever round is being viewed, because they are the run's
 *    current state and acting on a stale copy of them is how a packet gets sent twice. A
 *    note says so whenever an older round is selected.
 *
 * Decision rules live in `run-model.ts` so they can be checked without rendering; this file
 * is the arrangement, the actions, and their enabling conditions.
 */

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

const EXTERNAL_SOURCE_LABELS: Record<WorkflowExternalSource["kind"], string> = {
  ensemble: "Ensemble",
};

/**
 * The rail's quick filters, mapped onto the ONE status the run list query accepts.
 *
 * Each chip is exactly one durable status rather than a client-side union: history is
 * cursor-paginated by the daemon, so a filter the browser applied after the fact would
 * silently drop rows out of a page and report the wrong count. The full `State` select
 * below the chips still reaches every status, so nothing is unreachable - the chips are the
 * four an operator asks for all day.
 */
const RUN_FILTER_CHIPS: {
  label: string;
  status: WorkflowRunStatus | undefined;
  hint: string;
}[] = [
  { label: "All", status: undefined, hint: "Every run in history" },
  { label: "Running", status: "running", hint: "Runs whose reviewers are working right now" },
  {
    label: "Needs you",
    status: "waiting_for_session",
    hint: "Runs waiting for you to repair the work and resubmit",
  },
  { label: "Done", status: "completed", hint: "Runs that completed" },
];

/**
 * Where a run came from, when something other than an operator started it.
 *
 * An Ensemble source deep-links to that run's detail under the Ensembles tab (the route landed
 * with the Phase 7 dashboard). If the ensemble was since deleted, the id lands on the Ensembles
 * list rather than a fabricated run - the same rule a deleted-run id follows. Ensemble and
 * Workflow states stay separate: this link never implies the ensemble is approved or shipped.
 */
function ExternalProvenance({
  source,
}: {
  source: WorkflowExternalSource;
}): React.JSX.Element {
  const href =
    source.kind === "ensemble"
      ? `#/ensembles/${encodeURIComponent(source.sourceId)}`
      : null;
  return (
    <p className="wf-run-provenance">
      Started by {EXTERNAL_SOURCE_LABELS[source.kind]}{" "}
      {href ? (
        <Tooltip label="Open the ensemble run that started this workflow">
          <a href={href}>
            <code>{source.sourceId}</code>
          </a>
        </Tooltip>
      ) : (
        <code>{source.sourceId}</code>
      )}
      {" · "}{when(source.createdAt)}
    </p>
  );
}

/** A durable error as a sentence, with its machine code kept beside it, never instead of it. */
function ErrorLine({
  raw,
  alert = false,
}: {
  raw: string | null | undefined;
  alert?: boolean;
}): React.JSX.Element | null {
  const view = errorView(raw);
  if (!view) return null;
  return (
    <p className="wf-run-error" {...(alert ? { role: "alert" } : {})}>
      {view.sentence}
      {view.code && <code className="wf-run-code">{view.code}</code>}
    </p>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }): React.JSX.Element | null {
  if (evidence.length === 0) return null;
  return (
    <ul className="wf-run-evidence">
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${item.path ?? ""}:${item.line ?? ""}:${index}`}>
          <code>{item.kind}{item.path ? ` · ${item.path}` : ""}{item.line ? `:${item.line}` : ""}</code>
          <span>{item.quote}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A Check node's own card.
 *
 * Separate from `VerdictCard` because a check answers different questions. It has no
 * Persona, so that card's `attempt.persona?.name ?? "Missing persona"` would accuse an
 * exit-code gate of pointing at a deleted reviewer; it has no runner, model or cost, so
 * three quarters of that meta line would read "cost unavailable" about a subprocess; and
 * the fact a reader wants first is the exit code, which a verdict only ever paraphrases.
 *
 * The four statuses reach the screen as sentences from `run-model.ts`, never as their
 * durable spellings.
 */
function CheckCard({
  attempt,
  outcome,
}: {
  attempt: WorkflowNodeAttempt;
  outcome: WorkflowCheckOutcome;
}): React.JSX.Element {
  const view = checkStatusView(outcome.status);
  const parts = [
    outcome.command ? formatCheckCommand(outcome.command) : "no command configured",
    outcome.exitCode === null ? null : `exit ${outcome.exitCode}`,
    `attempt ${attempt.attempt}`,
  ].filter((part): part is string => part !== null);
  return (
    <article className={`wf-run-card wf-run-check is-${outcome.status}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${outcome.status === "failed" ? "failed" : "passed"}`}>
          {view.label}
        </span>
        <strong>Check · {outcome.slot}</strong>
      </header>
      <p className="wf-run-summary">{outcome.note}</p>
      <p className="wf-run-check-sentence">{view.sentence}</p>
      {outcome.output && (
        <div className="wf-run-card-body">
          <h5>Command output</h5>
          {/* The TAIL, which is what the runner kept: a build prints its failure last. The
              omitted count is stated rather than implied by an ellipsis, so nobody reads a
              bounded log as the whole one. */}
          <pre className="wf-run-check-output">{outcome.output}</pre>
          {outcome.truncatedBytes > 0 && (
            <p className="wf-run-meta">
              Earlier {outcome.truncatedBytes} bytes of output were omitted.
            </p>
          )}
        </div>
      )}
      <p className="wf-run-meta">{parts.join(" · ")}</p>
    </article>
  );
}

/**
 * How much of an authored instruction the run view will print inline.
 *
 * The prompt is bounded at authoring time, but 58,000 bytes inside a run card is a wall an
 * operator has to scroll past to reach the delivery beneath it. The whole text is one click
 * away in the version's snapshot detail, which is the surface that exists to be exact.
 */
const ACTION_PREVIEW_CHARS = 1200;

/**
 * One session action attempt.
 *
 * Its own card, not a Persona card with the words changed, because every field a verdict card
 * carries is a claim this one must not make: there is no verdict, no confidence, no requested
 * change and no repair packet. What it reports instead is a LIFECYCLE - what was sent, what
 * proved the session read it, and what the run is waiting for - plus the immutable snapshot
 * that says which instruction was sent, so an audit trail does not stop at "an action ran".
 */
function SessionActionCard({
  attempt,
  status,
  state,
}: {
  attempt: WorkflowNodeAttempt;
  status: PipelineStatus;
  state: SessionActionProgress | null;
}): React.JSX.Element {
  const snapshot = attempt.sessionAction;
  const blocked = state?.blocked ?? null;
  const proven = provenPullRequest(state);
  const prompt = snapshot?.promptMarkdown ?? "";
  const clipped = prompt.length > ACTION_PREVIEW_CHARS;
  return (
    <article className="wf-run-card wf-run-action">
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${status.tone}`}>{status.label}</span>
        <strong>{snapshot?.name ?? "Session action"}</strong>
      </header>
      {/* The wait reason first: it is the answer to "why is nothing happening", which is the
          question that brought the reader here. A block replaces it, because a blocked action
          is not waiting for anything. */}
      {/* The wait, the block, or - once it is over - what it accomplished. The last arm is
          the one every finished action shows, and the first draft of this card fell through
          it to `attemptStateLabel`, which printed the bare word "completed" under a heading
          that had just said the same thing. */}
      <p className="wf-run-summary">
        {blocked
          ? actionBlockSentence(blocked.code)
          : state?.wait
            ? actionWaitSentence(state.wait)
            : state?.complete
              ? "The turn finished, and the fresh evidence the stages below it review was"
                + " captured."
              : attemptStateLabel(attempt.state)}
      </p>
      {blocked && <ErrorLine raw={blocked.detail} />}
      <p className="wf-run-meta">
        {[
          snapshot ? sessionActionSkillLabel(snapshot.requiredSkillId) : null,
          snapshot ? `Completes when ${sessionActionCompletionLabel(snapshot.completion)
            .toLocaleLowerCase("en-US")}` : null,
          snapshot ? `Snapshot revision ${snapshot.sourceRevision}` : null,
          `attempt ${attempt.attempt}`,
        ].filter(Boolean).join(" · ")}
      </p>
      {state?.anchor && (
        <p className="wf-run-meta">
          Sent {when(state.anchor.deliveredAt)}
          {state.pickedUpAt === null ? "" : ` · picked up ${when(state.pickedUpAt)}`}
          {state.settledAt === null ? "" : ` · turn finished ${when(state.settledAt)}`}
        </p>
      )}
      {/* What the proof actually WAS, for the one adapter that has one.
          Shown only once it exists, because until then there is no pull request to link and
          no commit to name - and a link rendered early is the "Open PR" affordance the plan
          refuses, offering to open something nothing has verified. The commit is printed
          because it is the whole claim: this pull request, at this commit, is what the stages
          below were allowed to read fresh evidence for. */}
      {proven && (
        <p className="wf-run-meta wf-run-action-pr">
          <Tooltip label="The pull request this action proved, at the commit it was proved at">
            <a href={proven.pullRequestUrl} target="_blank" rel="noreferrer">
              #{proven.pullRequestNumber}
            </a>
          </Tooltip>
          {` on ${proven.branch}, verified at ${proven.expectedHeadOid.slice(0, 8)}`}
        </p>
      )}
      {snapshot && (
        <details className="wf-run-packet">
          <Tooltip label="Show the exact instruction this version froze for this action">
            <summary>Instruction sent</summary>
          </Tooltip>
          <pre>{clipped ? `${prompt.slice(0, ACTION_PREVIEW_CHARS)}…` : prompt}</pre>
          {clipped && (
            <p className="wf-run-meta">
              First {ACTION_PREVIEW_CHARS} characters. The published version carries the exact
              text.
            </p>
          )}
        </details>
      )}
      <ErrorLine raw={attempt.error} />
    </article>
  );
}

function VerdictCard({
  attempt,
  verdict,
  meta,
}: {
  attempt: WorkflowNodeAttempt;
  verdict: PersonaVerdict;
  meta: ReturnType<typeof verdictMeta>;
}): React.JSX.Element {
  const parts = [
    meta.runner && meta.model ? `${meta.runner} · ${meta.model}` : null,
    meta.durationMs === null ? null : `${Math.round(meta.durationMs / 1000)}s`,
    meta.costUsd === null ? "cost unavailable" : `$${meta.costUsd.toFixed(4)}`,
    `attempt ${attempt.attempt}`,
    attempt.persona ? `Persona revision ${attempt.persona.sourceRevision}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <article className={`wf-run-card wf-run-verdict is-${verdict.verdict}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${verdict.verdict === "pass" ? "passed" : "failed"}`}>
          {verdict.verdict === "pass" ? "Passed" : "Changes requested"}
        </span>
        <strong>{attempt.persona?.name ?? "Missing persona"}</strong>
        <span className="wf-run-confidence">{Math.round(verdict.confidence * 100)}% confident</span>
      </header>
      <p className="wf-run-summary">{verdict.summary}</p>
      {verdict.verdict === "pass" ? (
        <div className="wf-run-card-body">
          <h5>Approval rationale</h5>
          <p>{verdict.approvalDetails.reason}</p>
          <EvidenceList evidence={verdict.approvalDetails.evidence} />
        </div>
      ) : (
        <div className="wf-run-card-body">
          <h5>Requested changes</h5>
          <ol className="wf-run-changes">
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
      <p className="wf-run-meta">{parts.join(" · ")}</p>
    </article>
  );
}

export function WorkflowRunView({
  detail,
  roundId = null,
  onRound = () => {},
  onResubmit,
  onRetry,
  onCancel,
  onConfirm = () => {},
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
  onToggleNodesDisabled,
  isActionPending = () => false,
}: {
  detail: WorkflowRunDetail;
  /** The submission being read. `null` means the newest one. */
  roundId?: string | null;
  onRound?: (submissionId: string) => void;
  onResubmit: (unchanged: boolean) => Promise<void>;
  onRetry: (attemptId?: string) => Promise<void>;
  onCancel: () => Promise<void>;
  /** Destructive confirmations, hosted by the overlay registry rather than `window.confirm`. */
  onConfirm?: (request: WorkflowConfirmRequest) => void;
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
  /**
   * Toggle the per-run auto-pass on verdict nodes. Optional so read-only hosts render the
   * disabled set without offering the switch; the view itself withholds it once the run is
   * terminal, because a finished run can no longer be affected.
   */
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
  isActionPending?: (id: RunActionId) => boolean;
}): React.JSX.Element {
  const version = detail.version;
  // Declared before the scrubber rather than beside the timeline, because a continuation
  // entry names the action it came from and a published action node carries its own snapshot
  // name - so the resolver is the one thing standing between "evidence 2" and "evidence 2,
  // after Open the pull request".
  const nodeById = new Map((version?.graph.nodes ?? []).map((node) => [node.id, node]));
  const nameOfNode = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    return node && version ? nodeLabel(version.graph, node, []) : null;
  };
  const rounds = runRounds(detail, nameOfNode);
  const viewed = selectedSubmission(detail, roundId);
  const viewedRound = rounds.find((round) => round.submissionId === viewed?.id) ?? null;
  const latest = rounds.at(-1) ?? null;
  const isLatest = viewed === null || viewed.id === latest?.submissionId;
  /**
   * Two different questions, and they were one variable until the Inspector caught it.
   *
   * `inspectorOnly` describes the round BEING READ - it is what the bypass notice and the
   * "ran no Personas" line are about, and scrubbing is exactly how an operator reaches them.
   * `liveInspectorRepair` describes the run RIGHT NOW, and it is what may enable a recovery
   * action: with the live submission Inspector-only and the run waiting on Inspector rather
   * than on a new head, reading round 1 made Restart full workflow disappear - a live control
   * withdrawn by a view choice, which is the one thing the scrubber must never do.
   */
  const inspectorOnly = viewed?.mode === "inspector_only";
  const liveInspectorRepair = detail.submissions.some((submission) =>
    submission.id === latest?.submissionId && submission.mode === "inspector_only");
  const bypassSourceHead = inspectorOnly
    && viewed.context !== null
    && typeof viewed.context === "object"
    && !Array.isArray(viewed.context)
    && typeof viewed.context.failedHeadSha === "string"
    ? viewed.context.failedHeadSha
    : null;
  // Scoped to the VIEWED round, and validated rather than cast: `contextState` answers for
  // the run (the newest full submission's kind, or corrupt if any is), so it cannot say
  // whether the round a scrubber selected is readable. When it is not, the round says so
  // instead of rendering nothing.
  const contextRound = viewed?.mode === "full_workflow" ? viewed : null;
  const context = contextRound && detail.contextState === "captured"
    ? readCapturedContext(contextRound.context)
    : null;
  const contextUnreadable = contextRound !== null
    && detail.contextState === "captured"
    && context === null;
  const inspectorGate = detail.inspectorGate;
  const failedAttempt = [...detail.attempts].reverse().find((attempt) => attempt.state === "error");
  const roundAttempts = detail.attempts.filter((attempt) => attempt.submissionId === viewed?.id);
  // Split by what the attempt IS, read off the durable snapshot column the runtime writes for
  // exactly this kind - never guessed from the absence of a verdict, which is also what an
  // errored reviewer looks like.
  //
  // The action that AUTHORIZED this segment is shown with it even though it belongs to the
  // parent, because a segment whose own provenance is invisible reads as a round that started
  // from nowhere. It is the one deliberate cross-submission read, and the runtime wrote the
  // link.
  const continuationSource = continuationSourceAttempt(detail, viewed?.id ?? null);
  const actionAttempts = [
    ...(continuationSource ? [continuationSource] : []),
    ...roundAttempts.filter((attempt) => attempt.sessionAction !== null),
  ];
  // Session actions leave; the Session, join and End attempts never belonged here at all - see
  // `reviewerAttempts`, which is also what keeps a queued or errored reviewer in the list.
  const reviewAttempts = reviewerAttempts(
    roundAttempts.filter((attempt) => attempt.sessionAction === null),
    version?.graph,
  );
  /** A published graph that CANNOT produce a verdict, which is a different empty than "not yet". */
  const reviewerlessVersion = version ? !version.graph.nodes.some(isVerdictNode) : false;
  const latestAttemptByNode = latestAttemptsFor(detail, viewed?.id ?? null);
  const previousFullAttempts = inspectorOnly
    ? previousFullWorkflowAttempts(detail, viewed)
    : new Map<string, WorkflowNodeAttempt>();
  const priorPassedNodeIds = inspectorOnly && version
    ? version.graph.nodes.flatMap((node) => {
        if (node.kind !== "persona" && node.kind !== "check" && node.kind !== "session_action") {
          return [];
        }
        return priorAttemptPassed(node.kind, previousFullAttempts.get(node.id)) ? [node.id] : [];
      })
    : [];
  const statuses = nodeStatusesForSubmission(detail, viewed?.id ?? null);
  const calls = detail.llmCalls ?? [];
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
  const [feedbackCopied, setFeedbackCopied] = useState(false);
  const feedbackAction = copyFeedbackAction(detail, feedbackCopied);
  const resubmit = resubmitAvailability(detail, liveInspectorRepair);
  const gateActions = inspectorGateActions(detail);
  const preparePrAction = gateActions.find((action) => action.kind === "prepare-pr");
  const recheckAction = gateActions.find((action) => action.kind === "recheck-inspector");
  const openPrAction = gateActions.find((action) => action.kind === "open-pr")!;
  const totalCost = workflowCallCost(
    calls,
    detail.llmCallCount ?? calls.length,
    detail.nextLlmCallAfter,
  );
  const timeline = eventsByRound(detail);
  const roundOfSubmission = (submissionId: string): number | null =>
    detail.submissions.find((submission) => submission.id === submissionId)?.round ?? null;
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

  const preview = detail.binding.deliveryMode !== "live";
  /**
   * Whether the binding still names a live conversation.
   *
   * ONE field answers it for every control that needs a session - the header's link and the
   * two send-side delivery recoveries. `summary.sessionId` reads the same column today, but
   * a second source for one fact is how a link stays enabled onto a session that is gone.
   */
  const sessionBound = detail.binding.sessionId !== null;
  return (
    <section className="wf-run-detail">
      <p className="sr-only" aria-live="assertive">{uncertainAnnouncement}</p>
      <header className="wf-run-head">
        <div className="wf-run-identity">
          <p className="workflow-eyebrow">
            {preview ? "Preview" : "Live"} · round {detail.summary.round} of {detail.summary.maxRepairRounds + 1}
          </p>
          <h3>{detail.summary.workflowName}</h3>
          <p className="wf-run-facts">
            <span className="wf-run-version">v{detail.summary.workflowVersion}</span>
            <span className={`workflow-chip workflow-${workflowRunTone(detail.summary)}`}>
              {runStatusLabel(detail.run.status)}
            </span>
            <Tooltip label={sessionBound
              ? "Jump to the session this run is reviewing"
              : "The bound session is no longer available"}>
              <button
                className="wf-run-session"
                disabled={!sessionBound}
                onClick={onOpenSession}
              >
                {detail.binding.sessionName}
              </button>
            </Tooltip>
          </p>
          {detail.externalSource && <ExternalProvenance source={detail.externalSource} />}
          <small>Started {when(detail.run.startedAt)} · updated {relativeTime(detail.run.updatedAt)}</small>
        </div>

        <div className="wf-run-actions">
          {resubmit && (
            <>
              <Tooltip label={resubmit.refusal
                ?? (resubmit.resuming
                  ? "Re-read the session's current diff and resume this run where it stalled"
                  : "Re-read the session's current diff and run the review again")}>
                <button
                  className="btn"
                  disabled={resubmit.refusal !== null}
                  onClick={() => void onResubmit(false)}
                >
                  {preview ? "Preview fresh evidence" : "Submit fresh evidence"}
                </button>
              </Tooltip>
              <Tooltip label={resubmit.refusal
                ?? "Run the review again against the evidence snapshot already taken"}>
                <button
                  className="btn btn-ghost"
                  disabled={resubmit.refusal !== null}
                  onClick={() => onConfirm({
                    title: preview ? "Preview unchanged evidence" : "Submit unchanged evidence",
                    body: "This runs every reviewer again against the snapshot already taken, so"
                      + " nothing about the work under review has changed since the last round.",
                    confirmLabel: preview ? "Preview unchanged" : "Submit unchanged",
                    confirmHint: "Starts a new round against the existing evidence snapshot",
                    onConfirm: () => void onResubmit(true),
                  })}
                >
                  {preview ? "Preview unchanged" : "Submit unchanged"}
                </button>
              </Tooltip>
            </>
          )}
          {preparePrAction && (
            <Tooltip label={runActionTooltip(
              preparePrAction,
              isActionPending(preparePrAction.id),
            )}>
              <button
                className="btn"
                disabled={preparePrAction.disabled || isActionPending(preparePrAction.id)}
                onClick={() => void onPreparePr()}
              >
                {preparePrAction.label}
              </button>
            </Tooltip>
          )}
          {detail.run.status === "blocked" && detail.run.currentPhase === "infrastructure_error" && (
            <Tooltip label="The provider call failed rather than the review - try it again">
              <button className="btn" onClick={() => void onRetry(failedAttempt?.id)}>Retry provider call</button>
            </Tooltip>
          )}
          {recheckAction && (
            <Tooltip label={runActionTooltip(
              recheckAction,
              isActionPending(recheckAction.id),
            )}>
              <button
                className="btn btn-ghost"
                disabled={recheckAction.disabled || isActionPending(recheckAction.id)}
                onClick={() => void onRecheckInspector()}
              >
                {recheckAction.label}
              </button>
            </Tooltip>
          )}
          <Tooltip label={feedbackAction.tooltip}>
            <button
              className="btn btn-ghost"
              disabled={feedbackAction.disabled}
              onClick={() => void (async () => {
                try {
                  await onCopyFeedback();
                  setFeedbackCopied(true);
                  window.setTimeout(() => setFeedbackCopied(false), 1600);
                } catch {
                  setFeedbackCopied(false);
                }
              })()}
            >
              {feedbackAction.label}
            </button>
          </Tooltip>
          {openPrAction.href ? (
            <Tooltip label={openPrAction.tooltip}>
              <a
                className="btn btn-ghost"
                href={openPrAction.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {openPrAction.label}
              </a>
            </Tooltip>
          ) : (
            <Tooltip label={openPrAction.tooltip}>
              <button className="btn btn-ghost" disabled>{openPrAction.label}</button>
            </Tooltip>
          )}
          <Tooltip label={version
            ? `Open immutable workflow version ${version.version}`
            : "The immutable published version is missing or corrupt"}>
            <button
              className="btn btn-ghost"
              disabled={!version}
              onClick={() => {
                if (!version) return;
                // The version to reveal is handed over in session storage (the builder reads
                // it as it mounts); the hash names the WORKFLOW, so the link is a real deep
                // link rather than "the builder, on whatever it had open last".
                requestWorkflowVersionOpen(version.workflowId, version.version);
                window.location.hash =
                  `#/library/workflows/${encodeURIComponent(version.workflowId)}`;
              }}
            >
              Open version
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
              <button className="btn btn-ghost" disabled>Export version</button>
            </Tooltip>
          )}
          <Tooltip label="Copy this durable workflow run id">
            <button
              className="btn btn-ghost"
              onClick={() => void navigator.clipboard.writeText(detail.run.id)}
            >
              Copy run id
            </button>
          </Tooltip>
        </div>

        {/* The two that cannot be undone, kept apart from the rest and never filled red:
            they sit beside actions an operator clicks all day. */}
        <div className="wf-run-actions wf-run-actions-danger">
          {inspectorGate && (liveInspectorRepair || detail.run.status === "waiting_for_new_head") && (
            <Tooltip label="Abandon this repair path and rerun every Persona from fresh evidence">
              <button
                className="btn btn-danger-ghost"
                onClick={() => onConfirm({
                  title: "Restart the full workflow",
                  body: "This abandons the Inspector-only repair and reruns every Persona against"
                    + " freshly captured evidence. The audited repair submissions stay in history.",
                  confirmLabel: "Restart full workflow",
                  confirmHint: "Abandons the Inspector-only repair and reruns every Persona",
                  danger: true,
                  requirePhrase: "RESTART FULL WORKFLOW",
                  onConfirm: () => void onRestartFull("RESTART FULL WORKFLOW"),
                })}
              >
                Restart full workflow
              </button>
            </Tooltip>
          )}
          {!["completed", "cancelled", "failed"].includes(detail.run.status) && (
            <Tooltip label="Stop this run - it will not resume">
              <button
                className="btn btn-danger-ghost"
                onClick={() => onConfirm({
                  title: "Cancel this run",
                  body: `Stop ${detail.summary.workflowName} v${detail.summary.workflowVersion} on`
                    + ` ${detail.binding.sessionName}? It will not resume, and its evidence and`
                    + " verdicts stay in history.",
                  confirmLabel: "Cancel run",
                  confirmHint: "Stops the run for good",
                  danger: true,
                  onConfirm: () => void onCancel(),
                })}
              >
                Cancel run
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      {rounds.length > 0 && (
        <section className="wf-run-rounds" aria-label="Rounds">
          <div className="wf-run-scrubber" role="group" aria-label="Select a round">
            {rounds.map((round) => (
              <Tooltip
                key={round.submissionId}
                // The provenance ADDS to the round and its status rather than replacing
                // them: a continuation entry is still an entry whose state a reader wants.
                label={[
                  `${round.label}: ${round.status.label}`,
                  segmentProvenanceSentence(round),
                ].filter(Boolean).join(". ")}
              >
                <button
                  className={`wf-run-round workflow-${round.status.tone}${
                    round.submissionId === viewed?.id ? " active" : ""}`}
                  aria-pressed={round.submissionId === viewed?.id}
                  onClick={() => onRound(round.submissionId)}
                >
                  <span className="wf-run-round-name">{round.label}</span>
                  <span className="wf-run-round-state">{round.status.label}</span>
                </button>
              </Tooltip>
            ))}
          </div>
          {/* Said under the scrubber rather than only in a tooltip: a second entry under one
              round looks exactly like a repair, and the whole point of the segment model is
              that it is not one. */}
          {viewedRound && segmentProvenanceSentence(viewedRound) && (
            <p className="wf-run-notice" role="status">
              {segmentProvenanceSentence(viewedRound)}
            </p>
          )}
          {!isLatest && (
            <p className="wf-run-stale" role="status">
              Viewing an earlier round. The pipeline, verdicts and timeline below are that
              round's; the Inspector gate, deliveries and every recovery action are always the
              live run's.
            </p>
          )}
        </section>
      )}

      {version ? (
        <RunPipeline
          version={version}
          statuses={statuses}
          session={viewed
            ? submissionStatus(viewed, roundAttempts.some((attempt) => verdictOf(attempt)?.verdict === "fail"))
            : { tone: "waiting", label: "No submission yet" }}
          end={endStatus(detail, viewed, isLatest)}
          metaFor={(nodeId) => {
            // The NEWEST attempt, the same one the chip above it reads: a retry resolves the
            // provider again, so the first attempt's runner and model describe a call that is
            // over.
            const attempt = latestAttemptByNode.get(nodeId);
            return attempt?.runner && attempt.model ? `${attempt.runner} · ${attempt.model}` : null;
          }}
          checkOutcomeFor={(nodeId) => {
            // Read from the attempt's recorded outcome, never inferred from its verdict: a
            // check that was skipped or could not run passes the gate, so the verdict says
            // "pass" for a command that never executed.
            const attempt = latestAttemptByNode.get(nodeId);
            const prior = inspectorOnly ? previousFullAttempts.get(nodeId) : undefined;
            return attempt
              ? checkOutcomeOf(attempt)?.status ?? null
              : prior ? checkOutcomeOf(prior)?.status ?? null : null;
          }}
          inspectorOnly={inspectorOnly}
          priorPassedNodeIds={priorPassedNodeIds}
          actionWaitFor={(nodeId) => {
            // The attempt's OWN durable state, not `summary.actionWait`. A repair round can
            // run several actions in turn and the summary carries one; scrubbing to an
            // earlier segment would otherwise paint the live wait onto a finished action.
            const attempt = latestAttemptByNode.get(nodeId);
            return attempt ? sessionActionProgress(attempt)?.wait ?? null : null;
          }}
          inspectorStatus={isLatest ? inspectorFooterStatus(detail.summary.gate) : null}
          inspectorDetail={isLatest && inspectorGate
            ? gateWaitSentence(inspectorGate.state.waitReason)
            : null}
          repair={detail.summary.maxRepairRounds > 0
            ? "Any fail returns the submission to Session for repair, then the whole pipeline runs again."
            : null}
          disabledNodeIds={detail.run.disabledNodeIds ?? []}
          disabledChipFor={(nodeId) =>
            // Scoped to the VIEWED round via `latestAttemptByNode`: scrubbing to an
            // earlier round shows that round's real outcomes under the red row treatment.
            disabledStatusFor(detail.run.disabledNodeIds, nodeId, latestAttemptByNode.get(nodeId))}
          onToggleNodes={onToggleNodesDisabled
            && !["completed", "cancelled", "failed"].includes(detail.run.status)
            ? onToggleNodesDisabled
            : undefined}
        />
      ) : (
        <p className="wf-run-error" role="alert">
          The immutable workflow version is missing or corrupt. This run cannot be resumed.
        </p>
      )}

      {inspectorOnly && (
        <p className="wf-run-notice" role="status">
          <strong>Persona review bypassed for Inspector repair.</strong>
          {" "}The audited repair submission moved from {shortSha(bypassSourceHead) ?? "an earlier head"} to{" "}
          {shortSha(viewed.prHeadSha) ?? "a newly observed head"} without Persona attempts.
        </p>
      )}

      {/* Its own section, above the verdicts. An action is what a round DID rather than what
          it decided, and folding it in under "Reviewer verdicts" would file a stage that
          returns no verdict under a heading that promises one. */}
      {actionAttempts.length > 0 && (
        <section className="wf-run-section">
          <h4>Session actions</h4>
          <div className="wf-run-cards">
            {actionAttempts.map((attempt) => {
              const state = sessionActionProgress(attempt);
              return (
                <SessionActionCard
                  key={attempt.id}
                  attempt={attempt}
                  state={state}
                  status={sessionActionStatus(attempt.state, state?.wait ?? null)}
                />
              );
            })}
          </div>
        </section>
      )}

      <section className="wf-run-section">
        <h4>Reviewer verdicts</h4>
        {reviewAttempts.length === 0 ? (
          <p className="wf-run-empty">
            {inspectorOnly
              ? "This Inspector repair round ran no Personas."
              // "Not yet" is a promise, and a graph with no reviewer in it is never going to keep
              // it. Worth its own sentence now that the structural attempts no longer fill this
              // list: a Session-to-End workflow used to look like it had reviewed twice.
              : reviewerlessVersion
                ? "This workflow has no reviewers - nothing in it produces a verdict."
                : "No reviewer has been activated in this round yet."}
          </p>
        ) : (
          <div className="wf-run-cards">
            {reviewAttempts.flatMap((attempt) => {
              // A check is asked FIRST, because it also carries a verdict - a synthetic one,
              // so the Join and the repair packet need no special case. Asking the verdict
              // first would draw every check as a Persona card with no Persona in it.
              const check = checkOutcomeOf(attempt);
              if (check) return [(<CheckCard key={attempt.id} attempt={attempt} outcome={check} />)];
              const verdict = verdictOf(attempt);
              return verdict
                ? [(
                    <VerdictCard
                      key={attempt.id}
                      attempt={attempt}
                      verdict={verdict}
                      meta={verdictMeta(attempt, calls)}
                    />
                  )]
                : [];
            })}
            {reviewAttempts.filter((attempt) => !verdictOf(attempt) && !checkOutcomeOf(attempt)).map((attempt) => (
              <article className="wf-run-card wf-run-attempt" key={`attempt:${attempt.id}`}>
                <header className="wf-run-card-head">
                  <strong>{attempt.persona?.name ?? nameOfNode(attempt.nodeId) ?? "Reviewer"}</strong>
                  <span>{attemptStateLabel(attempt.state)} · attempt {attempt.attempt}</span>
                </header>
                <p className="wf-run-meta">
                  {[
                    attempt.runner && attempt.model ? `${attempt.runner} · ${attempt.model}` : null,
                    attempt.persona ? `Persona revision ${attempt.persona.sourceRevision}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
                <ErrorLine raw={attempt.error} />
              </article>
            ))}
          </div>
        )}
        {version?.graph.nodes.filter((node) => node.kind === "all_pass").map((join) => {
          const incoming = version.graph.edges.filter((edge) => edge.target === join.id);
          const received = detail.receipts.filter((receipt) =>
            receipt.submissionId === viewed?.id
            && incoming.some((edge) => edge.id === receipt.edgeId));
          return (
            <details className="wf-run-packet" key={join.id}>
              <Tooltip label="Show the payloads each reviewer in this stage handed its join">
                <summary>
                  {nodeLabel(version.graph, join, [])} · {received.length} of{" "}
                  {new Set(incoming.map((edge) => edge.source)).size} reviewers reported
                </summary>
              </Tooltip>
              <pre>{JSON.stringify(received.map((receipt) => receipt.payload), null, 2)}</pre>
            </details>
          );
        }) ?? null}
        {detail.run.gateState && (
          <details className="wf-run-packet">
            <Tooltip label="Show the raw join and final-gate state for this run">
              <summary>Join and gate packet</summary>
            </Tooltip>
            <pre>{JSON.stringify(detail.run.gateState, null, 2)}</pre>
          </details>
        )}
      </section>

      {inspectorGate && (
        <section className={`wf-run-section wf-run-gate is-${detail.summary.gate}`}>
          <header className="wf-run-section-head">
            <h4>Inspector final gate</h4>
            <span className={`workflow-chip workflow-${gateSummaryStatus(detail.summary.gate).tone}`}>
              {gateSummaryStatus(detail.summary.gate).label}
            </span>
          </header>
          <p className="wf-run-sentence">{gateWaitSentence(inspectorGate.state.waitReason)}</p>
          <dl className="wf-run-facts-list">
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
            <div><dt>Adopted provenance</dt><dd>{inspectorGate.inspection?.source === "hook" ? "hook" : inspectorGate.inspection ? "legacy import" : "not adopted"}</dd></div>
            <div><dt>Inspector</dt><dd>{inspectorGate.inspector.enabled ? inspectorGate.inspector.mode : "disabled"} · {inspectorGate.inspector.posture ?? "unknown posture"}</dd></div>
            <div><dt>Review round</dt><dd>{inspectorGate.inspection?.round ?? 0}</dd></div>
            <div><dt>Target head</dt><dd><code>{shortSha(inspectorGate.state.targetHeadSha) ?? "not pinned"}</code></dd></div>
            <div><dt>Observed head</dt><dd><code>{shortSha(inspectorGate.state.observedHeadSha) ?? "not observed"}</code></dd></div>
            <div><dt>Reviewed head</dt><dd><code>{shortSha(inspectorGate.inspection?.headSha) ?? "not reviewed"}</code></dd></div>
            <div><dt>Observed</dt><dd>{inspectorGate.state.lastObservedAt ? when(inspectorGate.state.lastObservedAt) : "waiting for post-entry observation"}</dd></div>
            <div><dt>Backoff</dt><dd>{inspectorGate.inspection?.nextAttemptAt ? when(inspectorGate.inspection.nextAttemptAt) : "none"}</dd></div>
          </dl>
          <ErrorLine raw={inspectorGate.inspection?.lastError} alert />
          <p className="wf-run-meta">
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
          <div className="wf-run-findings">
            {inspectorGate.findings.length === 0 ? (
              <p className="wf-run-empty">No findings are recorded for this adopted pull request.</p>
            ) : inspectorGate.findings.map((finding) => (
              <article key={finding.id} className={`wf-run-card wf-run-finding is-${finding.severity}`}>
                <header className="wf-run-card-head">
                  <strong>{finding.severity} · {finding.title}</strong>
                  <span>{finding.status}</span>
                </header>
                <code>{finding.path ?? "general"}{finding.line ? `:${finding.line}` : ""}</code>
                <p>{finding.body ?? "Legacy finding: detail was not persisted by the Inspector version that created this row."}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {completionClaims.length > 0 && (
        <section className="wf-run-section">
          <h4>Foreman completion claim</h4>
          <div className="wf-run-cards">
            {completionClaims.map((claim) => (
              <article className="wf-run-card" key={claim.id}>
                <header className="wf-run-card-head">
                  <strong>{claim.completionKind} completion</strong>
                  <span>{claim.state.replaceAll("_", " ")}</span>
                </header>
                <p>{claim.summary}</p>
                <p className="wf-run-meta">Once-only guard <code>{claim.marker.slice(0, 12)}</code></p>
              </article>
            ))}
          </div>
        </section>
      )}

      {detail.deliveries.length > 0 && (
        <section className="wf-run-section">
          {/* "Repair delivery" was true while every packet was a repair. A session action's
              instruction travels this same path and is the opposite of a repair, so the
              heading follows what is actually in the list rather than naming one kind of it. */}
          <h4>
            {detail.deliveries.some((delivery) => delivery.kind === "session_action")
              ? "Deliveries to the session"
              : "Repair delivery"}
          </h4>
          <div className="wf-run-cards">
            {detail.deliveries.map((delivery) => {
              const view = deliveryStateView(delivery.state);
              return (
                <article className={`wf-run-card wf-run-delivery is-${delivery.state}`} key={delivery.id}>
                  <header className="wf-run-card-head">
                    <span className={`workflow-chip workflow-${
                      delivery.state === "delivered" ? "passed"
                        : delivery.state === "uncertain" || delivery.state === "refused" ? "failed"
                          : "waiting"}`}>
                      {view.label}
                    </span>
                    <strong>Round {roundOfSubmission(delivery.submissionId) ?? "?"}</strong>
                    <span>{deliveryKindLabel(delivery.kind)}</span>
                  </header>
                  <p className="wf-run-sentence">{view.sentence}</p>
                  <ErrorLine raw={delivery.error} />
                  <dl className="wf-run-facts-list">
                    <div><dt>Conversation</dt><dd>{delivery.noteKey}</dd></div>
                    <div><dt>Payload hash</dt><dd><code>{delivery.payloadSha256.slice(0, 16)}</code></dd></div>
                    <div><dt>Prepared</dt><dd>{when(delivery.createdAt)}</dd></div>
                    <div><dt>Last transition</dt><dd>{when(delivery.updatedAt)}</dd></div>
                    <div><dt>Delivered</dt><dd>{delivery.deliveredAt ? when(delivery.deliveredAt) : "not confirmed"}</dd></div>
                  </dl>
                  {delivery.payloadPrunedAt ? (
                    <p className="wf-run-pruned">
                      Payload pruned {when(delivery.payloadPrunedAt)}. SHA-256 and transition
                      metadata remain available.
                    </p>
                  ) : <pre>{delivery.payload}</pre>}
                  {delivery.state === "refused" && (
                    <Tooltip label={sessionBound
                      ? "Retry this packet after a positive delivery refusal"
                      : "The bound session is gone, so there is nowhere to send this packet"}>
                      <button
                        className="btn"
                        disabled={!sessionBound}
                        onClick={() => void onRetryDelivery(delivery.id)}
                      >
                        Retry refused delivery
                      </button>
                    </Tooltip>
                  )}
                  {delivery.state === "uncertain" && (
                    <div className="wf-run-recovery">
                      {deliveryResolutionActions(delivery, sessionBound).map((action) => {
                        const pending = isActionPending(action.id);
                        return (
                          <Tooltip
                            key={action.id}
                            label={runActionTooltip(action, pending)}
                          >
                            <button
                              className={action.confirm.danger
                                ? "btn btn-danger-ghost"
                                : "btn"}
                              disabled={action.disabled || pending}
                              onClick={() => onConfirm({
                                ...action.confirm,
                                onConfirm: () => void onResolveDelivery(
                                  action.deliveryId,
                                  action.resolution,
                                  action.confirm.requirePhrase,
                                ),
                              })}
                            >
                              {action.label}
                            </button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {detail.contextState === "not_captured" && (
        <section className="wf-run-section">
          <h4>Intent and evidence not captured</h4>
          <p className="wf-run-empty">This submission stopped before its immutable context snapshot was recorded.</p>
        </section>
      )}
      {detail.contextState === "corrupt" && (
        <section className="wf-run-section">
          <h4>Captured intent and evidence are corrupt</h4>
          <p className="wf-run-error" role="alert">
            The durable context does not match its submission mode. Check daemon logs or restore it from backup.
          </p>
        </section>
      )}
      {contextUnreadable && (
        <section className="wf-run-section">
          <h4>Captured intent and evidence</h4>
          <p className="wf-run-error" role="alert">
            This round's captured context is not readable by this build, though the run's
            newest one is. Check daemon logs or restore it from backup.
          </p>
        </section>
      )}
      {context && (
        <section className="wf-run-section wf-run-context">
          <header className="wf-run-section-head">
            <h4>Captured intent and evidence</h4>
            <span className="wf-run-meta">
              {context.compaction.status === "model" ? "Context compacted" : "Deterministic fallback"}
            </span>
            {context.evidence.retention?.state === "pruned" && (
              <span className="wf-run-pruned">
                Raw evidence pruned {when(context.evidence.retention.prunedAt)}
              </span>
            )}
          </header>
          <h5>Original goal</h5>
          <pre>{context.primaryGoal.rawPrompt || "(No captured goal)"}</pre>
          {context.primaryGoal.refined && <p><strong>Refined:</strong> {context.primaryGoal.refined}</p>}
          <h5>Human decisions and rationale</h5>
          {context.humanDecisions.length === 0 ? <p className="wf-run-empty">None captured.</p> : (
            <ul className="wf-run-decisions">
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
            <p className="wf-run-meta">Compaction fallback: {context.compaction.error}</p>
          )}
          <details>
            <Tooltip label="Show the exact repository state this review was given">
              <summary>Evidence snapshot</summary>
            </Tooltip>
            <dl className="wf-run-facts-list">
              <div><dt>HEAD</dt><dd>{shortSha(context.evidence.headSha) ?? "unavailable"}</dd></div>
              <div>
                <dt>Working tree</dt>
                <dd>
                  {context.evidence.workingTreeDirty ? "dirty" : "clean"}
                  {context.evidence.workingTreeStatusTruncated ? " · status truncated" : ""}
                </dd>
              </div>
              <div><dt>Fingerprint</dt><dd><code>{viewed?.evidenceFingerprint}</code></dd></div>
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

      <section className="wf-run-section">
        <header className="wf-run-section-head">
          <h4>Workflow-owned model calls</h4>
          <strong>
            {totalCost === null
              ? "Cost unavailable from this runner"
              : `$${totalCost.toFixed(4)}`}
          </strong>
        </header>
        {calls.length === 0 ? (
          <p className="wf-run-empty">No workflow-owned model calls are recorded for this run.</p>
        ) : (
          <div className="wf-run-table">
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
          </div>
        )}
        {detail.nextLlmCallAfter && (
          <Tooltip label="Load the next page of durable model-call accounting">
            <button className="btn btn-ghost" onClick={() => void onLoadCalls()}>
              Load more model calls
            </button>
          </Tooltip>
        )}
      </section>

      <section className="wf-run-section wf-run-timeline">
        <h4>Timeline</h4>
        {[...timeline.entries()]
          .filter(([round]) => round === 0 || round === viewed?.round)
          .sort(([a], [b]) => a - b)
          .map(([round, events]) => (
            <section key={round} className="wf-run-timeline-round">
              <h5>{round === 0 ? "Run-level events" : `Round ${round}`}</h5>
              <ol>
                {[...events].sort((a, b) => a.id - b.id).map((event) => {
                  const line = eventLine(
                    event,
                    { node: nameOfNode, round: roundOfSubmission },
                    round,
                  );
                  return (
                    <li key={event.id}>
                      <time>{when(event.timestamp)}</time>
                      <strong>{line.title}</strong>
                      {line.detail && <span>{line.detail}</span>}
                    </li>
                  );
                })}
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

/**
 * Nothing has run yet.
 *
 * Its own component because the sentence it replaced ("Bind an immutable published version
 * to a session, then submit a manual Preview.") was an instruction with nothing to click:
 * the binding dialog App already owns is two surfaces away, and an operator who has just
 * published their first workflow is exactly the person reading this.
 */
export function WorkflowRunsEmpty({
  onBindWorkflow,
}: {
  onBindWorkflow?: () => void;
}): React.JSX.Element {
  return (
    <section className="workflow-empty">
      <span className="workflow-empty-mark" aria-hidden>↻</span>
      <h3>No workflow runs yet</h3>
      <p>Bind a published version to a session, then submit a Preview to watch it here.</p>
      {onBindWorkflow && (
        <Tooltip label="Pick a session and a published version to run a workflow against">
          <button className="btn" onClick={onBindWorkflow}>Bind to a session…</button>
        </Tooltip>
      )}
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
  onBindWorkflow,
}: {
  runs: WorkflowRunSummary[];
  selectedRunId: string | null;
  filters?: WorkflowRunFilters;
  onSelectRun: (id: string) => void;
  onFilters?: (filters: WorkflowRunFilters | undefined) => void;
  onOpenSession?: (id: string) => void;
  onOpenInspectorSettings?: () => void;
  /** Opens the binding dialog with nothing pinned - the empty state's only affordance. */
  onBindWorkflow?: () => void;
}): React.JSX.Element {
  const [history, setHistory] = useState<WorkflowRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  // Which round the reader is scoped to. Owned here rather than inside the view so that
  // selecting another run resets it in the same commit the detail is cleared - a submission
  // id from the previous run would otherwise survive one render into the next one.
  const [roundId, setRoundId] = useState<string | null>(null);
  const [committedLoadGeneration, setCommittedLoadGeneration] = useState(0);
  const filterKey = JSON.stringify(filters ?? {});
  const ordered = useMemo(
    () => [...history].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
    [history],
  );
  const loadGeneration = useRef(0);
  const loadCommit = useRef(createWorkflowLoadCommitBarrier());
  const mounted = useRef(false);
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
  useEffect(() => {
    loadCommit.current.commit(committedLoadGeneration);
  }, [committedLoadGeneration]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current++;
      loadCommit.current.release();
    };
  }, []);
  /**
   * `keepError` is what makes a refused action VISIBLE.
   *
   * Every mutation reloads the run afterwards, including the failing ones - the daemon may
   * have moved the run before refusing. But this reload cleared the message the failure had
   * just set, in the same React batch, so the operator saw a button do nothing at all: no
   * error, no state change, no clue that the daemon said no. The failing path keeps its
   * sentence until the next successful action clears it.
   */
  const load = (clear = false, keepError = false): Promise<void> => {
    // A shared action can finish after this page has unmounted. It still succeeded, but there
    // is no Runs detail left to refresh and no future commit that could settle a new waiter.
    if (!mounted.current) return Promise.resolve();
    const generation = ++loadGeneration.current;
    // `waitFor` transfers every older waiter to this generation. Selection changes and SSE
    // summary updates can supersede a request, but the action remains guarded until their
    // replacement detail has actually committed.
    const committed = loadCommit.current.waitFor(generation);
    if (clear) setDetail(null);
    if (!selected) {
      setDetail(null);
      setCommittedLoadGeneration(generation);
      return committed;
    }
    if (!keepError) setError(null);
    void workflowRequest<WorkflowRunDetail>(
      `/api/workflow-runs/${encodeURIComponent(selected)}`,
    )
      .then((next) => {
        if (loadGeneration.current !== generation) return;
        setDetail(next);
        setCommittedLoadGeneration(generation);
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setDetail(null);
        setError(workflowRunLoadError(caught));
        setCommittedLoadGeneration(generation);
      });
    return committed;
  };
  useEffect(() => {
    setRoundId(null);
    setConfirm(null);
    void load(true);
    return () => { loadGeneration.current++; };
  }, [selected, selectedSummary]);
  const actionController = useRunActions(selected ?? "", () => load());

  const mutate = async (path: string, body: object): Promise<boolean> => {
    setError(null);
    try {
      await workflowRequest(path, { method: "POST", body: JSON.stringify(body) });
      void load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow action failed");
      void load(false, true);
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
      void load();
    } catch (caught) {
      if (
        caught instanceof WorkflowApiError
        && caught.body?.code === "workflow_unchanged_evidence"
      ) {
        unchangedRequest.current = { runId: detail.run.id, requestId };
      }
      setError(caught instanceof Error ? caught.message : "Workflow resubmission failed");
      void load(false, true);
    }
  };

  const copyFeedback = async (): Promise<void> => {
    if (!detail) return;
    try {
      await copyText(workflowFeedbackText(detail));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not copy workflow feedback");
      throw caught;
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
    return <WorkflowRunsEmpty onBindWorkflow={onBindWorkflow} />;
  }

  return (
    <section className="workflow-runs">
      <aside className="wf-run-rail">
        {listError && <p className="wf-run-error" role="alert">{listError}</p>}
        <div className="wf-run-chips" role="group" aria-label="Filter runs by state">
          {RUN_FILTER_CHIPS.map((chip) => (
            <Tooltip key={chip.label} label={chip.hint}>
              <button
                className={`wf-run-chip${filters?.status === chip.status ? " active" : ""}`}
                aria-pressed={filters?.status === chip.status}
                onClick={() => {
                  const next = { ...filters, status: chip.status };
                  onFilters(Object.values(next).some(Boolean) ? next : undefined);
                }}
              >
                {chip.label}
              </button>
            </Tooltip>
          ))}
        </div>
        <form
          className="wf-run-filters"
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
                ].map((status) => (
                  <option key={status} value={status}>
                    {runStatusLabel(status as WorkflowRunStatus)}
                  </option>
                ))}
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
          <div className="wf-run-empty-filter">
            <strong>No runs match these filters.</strong>
            <p>Clear a filter or wait for a matching run.</p>
          </div>
        )}
        {ordered.map((run) => (
          <Tooltip key={run.id} label={`Open this ${run.workflowName} run - ${runStatusLabel(run.status)}`}>
            <button
              className={`wf-run-row${selected === run.id ? " active" : ""}`}
              onClick={() => onSelectRun(run.id)}
            >
              <span className="wf-run-row-head">
                <strong>{run.workflowName}</strong>
                <span className="wf-run-version">v{run.workflowVersion}</span>
              </span>
              <span className={`workflow-chip workflow-${workflowRunTone(run)}`}>
                {runStatusLabel(run.status)}
              </span>
              <span className="wf-run-row-session">{run.noteKey}</span>
              {run.gate !== "none" && (
                <span className="wf-run-row-gate">
                  Inspector: {run.gate.replaceAll("_", " ")}
                  {run.gatePrNumber ? ` · #${run.gatePrNumber}` : ""}
                  {run.gateHeadShort ? ` · ${run.gateHeadShort}` : ""}
                </span>
              )}
              <small>{relativeTime(run.updatedAt)}</small>
            </button>
          </Tooltip>
        ))}
        {nextCursor && (
          <Tooltip label="Load the next page of Workflow run history">
            <button
              className="btn btn-ghost wf-run-more"
              disabled={listLoading}
              onClick={() => void listPage(nextCursor, true)}
            >
              {listLoading ? "Loading…" : "Load more runs"}
            </button>
          </Tooltip>
        )}
      </aside>
      <div className="wf-run-reader">
        {(error || actionController.error) && (
          <p className="wf-run-error" role="alert">{error ?? actionController.error}</p>
        )}
        {!detail && !error && !actionController.error && selected
          ? <p>Loading run…</p>
          : !detail && !error && !actionController.error
            ? <p>Select a workflow run to inspect its audit history.</p>
            : null}
        {detail && (
          <WorkflowRunView
            detail={detail}
            roundId={roundId}
            onRound={setRoundId}
            onConfirm={setConfirm}
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
              const action = inspectorGateActions(detail)
                .find((candidate) => candidate.kind === "prepare-pr");
              if (!action) return;
              actionController.run(action.id, (requestId) =>
                workflowRequest(`/api/workflow-runs/${detail.run.id}/prepare-pr`, {
                  method: "POST",
                  body: JSON.stringify({ requestId }),
                }));
            }}
            onRecheckInspector={async () => {
              const action = inspectorGateActions(detail)
                .find((candidate) => candidate.kind === "recheck-inspector");
              if (!action) return;
              actionController.run(action.id, (requestId) =>
                workflowRequest(`/api/workflow-runs/${detail.run.id}/recheck-inspector`, {
                  method: "POST",
                  body: JSON.stringify({ requestId }),
                }));
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
              const delivery = detail.deliveries.find((item) => item.id === deliveryId);
              const action = delivery
                ? deliveryResolutionActions(
                    delivery,
                    detail.binding.sessionId !== null,
                  ).find((candidate) => candidate.resolution === resolution)
                : null;
              if (!action || action.disabled) return;
              actionController.run(action.id, (requestId) =>
                workflowRequest(`/api/workflow-deliveries/${deliveryId}/resolve`, {
                  method: "POST",
                  body: JSON.stringify({
                    requestId,
                    resolution,
                    ...(confirmation ? { confirmation } : {}),
                    ...(resolution === "discard_and_new_round" && detail.binding.sessionId
                      ? {
                          expectedSessionId: detail.binding.sessionId,
                          expectedNoteKey: detail.binding.noteKey,
                        }
                      : {}),
                  }),
                }));
            }}
            onToggleNodesDisabled={(nodeIds, disabled) => {
              // One action id per target set AND direction. The action store retains a
              // request id across a failed response so a retry of the SAME intent replays
              // idempotently - but disable and enable are different intents, and a shared
              // key would replay the old request id, which the daemon would then correctly
              // ignore as already applied.
              actionController.run(
                `set-nodes-disabled:${disabled}:${nodeIds.join(",")}`,
                (requestId) =>
                  workflowRequest(`/api/workflow-runs/${detail.run.id}/set-nodes-disabled`, {
                    method: "POST",
                    body: JSON.stringify({ requestId, nodeIds, disabled }),
                  }),
              );
            }}
            isActionPending={actionController.isPending}
            onOpenSession={() => {
              // The BINDING's session, which is the one that goes null when a session
              // disappears. The summary carries the same column today, but it is also the
              // shape SSE caches per run, and offering to open a session that has gone is
              // the failure that costs an operator a click and a wrong selection.
              if (detail.binding.sessionId) onOpenSession(detail.binding.sessionId);
            }}
          />
        )}
      </div>
      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </section>
  );
}
