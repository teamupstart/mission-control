import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowContextSnapshot,
  WorkflowDelivery,
  WorkflowHumanDecision,
  WorkflowCheckOutcome,
  WorkflowExternalSource,
  WorkflowGoalProvenanceVerdict,
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowRunPage,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowEventPage,
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceImage,
  WorkflowEvidenceReadinessResult,
  WorkflowLlmCallPage,
  WorkflowUploadEvidenceLocator,
  WorkflowVersion,
} from "@shared/workflow.ts";
import {
  WORKFLOW_LIMITS,
  formatCheckCommand,
  isVerdictNode,
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
  workflowEvidenceReadinessPolicyEnforces,
} from "@shared/workflow.ts";
import {
  WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE,
  blockedPhaseClause,
} from "@shared/workflow-lifecycle.ts";
import { nodeLabel } from "@shared/workflow-stages.ts";
import { workflowRequest } from "./workflowApi.ts";
import { RunPipeline } from "./RunPipeline.tsx";
import { PersonaDirectiveEditor } from "./PersonaDirectiveEditor.tsx";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import type { SessionActionProgress } from "./run-model.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { captureFocusBookmark, restoreFocusBookmark } from "../tour/focus-containment.ts";
import type { FocusBookmark } from "../tour/focus-containment.ts";
import { workflowRunTone } from "../components/session-bits.tsx";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { formatBytes, relativeTime, repoLeaf } from "../lib/format.ts";
import type { RunRecordPane, WorkflowRunFilters } from "./useWorkflowRoute.ts";
import { requestWorkflowVersionOpen } from "./workflowSelection.ts";
import {
  useWorkflowEvidenceDraft,
  workflowBindingEvidenceOwner,
  workflowEvidenceScopes,
} from "./WorkflowEvidenceComposer.tsx";
import type {
  ChangeWorklistRow,
  ChangeWorklistState,
  RunCompletionClaim,
  RunRecordCompletionSummary,
  RunRecordDeliverySummary,
  RunRecordEvidenceSummary,
  RunRecordIntentSummary,
} from "./run-model.ts";
import {
  actionBlockSentence,
  actionWaitSentence,
  attemptStateLabel,
  cancelGateHint,
  cancelGateSentence,
  cancelReleasesGate,
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  completionClaimOutcomeSentences,
  completionClaimStatus,
  continuationSourceAttempt,
  disabledStatusFor,
  endStatus,
  errorView,
  evidenceCitationSentence,
  evidenceClaimStatus,
  evidenceCodeLabel,
  eventLine,
  eventsByRound,
  deliveryKindLabel,
  deliveryStateView,
  firstLineOf,
  humanDecisionSummary,
  humanDecisionsSummary,
  initialRunRecordPane,
  gateWaitSentence,
  inheritedAttempts,
  inheritedPasses,
  inspectorFindingBody,
  inspectorFindingLocation,
  inspectorFindingSeverityStatus,
  inspectorFindingStatusStatus,
  inspectorGateSentence,
  inspectorFooterStatus,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  readCapturedContext,
  readinessActionLabel,
  readinessGapCriteria,
  readinessOverrideDisabled,
  restageDisabled,
  restageLabel,
  restageOffered,
  reviewerAttempts,
  reviewerStatus,
  runChangeWorklist,
  runCompletionClaims,
  runGrantNotice,
  runParkedSentence,
  evidenceChipLabel,
  openEvidenceTray,
  roundEvidenceCountLabel,
  roundFailedCaptureLabel,
  roundHoldsViewedSubmission,
  roundOpensEvidenceTray,
  runEvidenceCitations,
  runIsParked,
  runRefusedCompletionSentence,
  runRefusedSentence,
  runRecordSummary,
  runRoundGroups,
  runRounds,
  runStalemates,
  runStatusLabel,
  runTriageSentence,
  segmentProvenanceSentence,
  selectedSubmission,
  submissionRoundLabel,
  provenPullRequest,
  sessionActionProgress,
  sessionActionStatus,
  shortSha,
  submissionStatus,
  spentInspectorGateCondition,
  spentInspectorGateStatus,
  verdictMeta,
  verdictOf,
  workflowCallCost,
  workflowFeedbackText,
  workflowRunLoadError,
} from "./run-model.ts";
import {
  BROWSER_IMAGE_SERVICES,
  closePreview,
  frozenImageBodiesLifecycle,
  openPreview,
  restageErrorFor,
  restagePress,
  runReadinessAction,
  startFrozenImageLoads,
  withRestageBusy,
  withRestageFailure,
} from "./evidence-pane-controller.ts";
import {
  copyFeedbackAction,
  deliveryResolutionActions,
  inspectorGateActions,
  refusedUnchangedRequestId,
  runActionTooltip,
  runNextMove,
  runNoMoveReason,
  type RunActionId,
  type RunNextMove,
} from "./run-actions.ts";
import { useRunActions } from "./run-action-store.ts";
import { createWorkflowLoadCommitBarrier } from "./workflow-load-commit.ts";
import { moveWorkflowRunSelection } from "./run-navigation.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";

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
/**
 * One check's chip, derived from the OUTCOME - the fact that also picks its segment.
 *
 * Shared by the rail row and the card behind it, because they were deriving it twice and
 * disagreeing. The card asked `outcome.status === "failed" ? failed : passed`, which paints a
 * gate that NEVER RAN in the green of one that ran and succeeded - the exact false assurance
 * `CHECK_OUTCOME_STATUSES` exists to prevent, and the opposite of what the row beside it said.
 * Routed through `checkStatus`, `skipped` and `unavailable` keep the degraded amber they are
 * entitled to, and the four labels are unchanged.
 */
const checkChip = (outcome: WorkflowCheckOutcome): PipelineStatus =>
  checkStatus(outcome.status === "failed" ? "fail" : "pass", outcome.status);

function CheckCard({
  attempt,
  outcome,
}: {
  attempt: WorkflowNodeAttempt;
  outcome: WorkflowCheckOutcome;
}): React.JSX.Element {
  const view = checkStatusView(outcome.status);
  const chip = checkChip(outcome);
  const parts = [
    outcome.command ? formatCheckCommand(outcome.command) : "no command configured",
    outcome.exitCode === null ? null : `exit ${outcome.exitCode}`,
    `attempt ${attempt.attempt}`,
  ].filter((part): part is string => part !== null);
  return (
    <article className={`wf-run-card wf-run-check is-${outcome.status}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${chip.tone}`}>{chip.label}</span>
        <strong>Command · {outcome.slot}</strong>
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
  verifiedShipping,
}: {
  attempt: WorkflowNodeAttempt;
  status: PipelineStatus;
  state: SessionActionProgress | null;
  verifiedShipping: boolean;
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
              ? verifiedShipping
                ? "The pull request was verified open at the captured commit, its content matched the prior review, and the workflow reached End."
                : "The turn finished, and the fresh evidence the stages below it review was captured."
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
      <PersonaReadinessInput attempt={attempt} />
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

/**
 * A reviewer this round produced no readable opinion for.
 *
 * Extracted from the old verdict list unchanged, class name included, because it is the one
 * card that says something the pipeline strip above cannot: the durable `error` string behind
 * a provider failure, and the runner and revision that were resolved for the attempt that
 * failed.
 */
function PersonaReadinessInput({ attempt }: { attempt: WorkflowNodeAttempt }): React.JSX.Element | null {
  if (!attempt.persona) return null;
  return <p className="wf-run-meta">Structural readiness at review: {attempt.reviewInput?.status ?? "unknown"}
    {attempt.reviewInput ? ` · policy ${attempt.reviewInput.policy} · contract v${attempt.reviewInput.version}` : " · legacy input"}.
    {" Readiness checks registration; the Persona checks whether the evidence proves the work."}</p>;
}

function AttemptCard({
  attempt,
  name,
}: {
  attempt: WorkflowNodeAttempt;
  name: string;
}): React.JSX.Element {
  return (
    <article className="wf-run-card wf-run-attempt">
      <header className="wf-run-card-head">
        <strong>{name}</strong>
        <span>{attemptStateLabel(attempt.state)} · attempt {attempt.attempt}</span>
      </header>
      <p className="wf-run-meta">
        {[
          attempt.runner && attempt.model ? `${attempt.runner} · ${attempt.model}` : null,
          attempt.persona ? `Persona revision ${attempt.persona.sourceRevision}` : null,
        ].filter(Boolean).join(" · ")}
      </p>
      <PersonaReadinessInput attempt={attempt} />
      {(attempt.reviewRejections?.length ?? 0) > 0 && (
        <details>
          <Tooltip label="Show the review responses rejected by the review contract">
            <summary>Rejected review responses</summary>
          </Tooltip>
          <pre>{JSON.stringify(attempt.reviewRejections, null, 2)}</pre>
        </details>
      )}
      <ErrorLine raw={attempt.error} />
    </article>
  );
}

/**
 * One selectable line in the worklist rail.
 *
 * A DISCRIMINATED UNION rather than a bare key, because `Blocking` holds two unrelated id
 * spaces at once: a `ChangeWorklistRow.key` is `nodeId + path + title`, and a check is
 * identified by its attempt id. Nothing stops those colliding as raw strings, so the keys are
 * namespaced by kind and every consumer branches on `kind` instead of sniffing the shape.
 */
export type WorklistItem =
  | { kind: "change"; key: string; row: ChangeWorklistRow }
  | { kind: "check"; key: string; attempt: WorkflowNodeAttempt; outcome: WorkflowCheckOutcome }
  | { kind: "verdict"; key: string; attempt: WorkflowNodeAttempt; verdict: PersonaVerdict }
  | { kind: "attempt"; key: string; attempt: WorkflowNodeAttempt; name: string };

export type WorklistSegment = "blocking" | "passed" | "archive";

/*
 * A row's identity is its ID SPACE, never its kind.
 *
 * Two spaces reach this rail and nothing stops them colliding as raw strings, so each is
 * prefixed: `ChangeWorklistRow.key` is `nodeId + path + title`, and everything else is an
 * attempt row. That is the whole reason the prefixes exist.
 *
 * It has to be the SPACE and not the KIND, because a row changes kind under a reader without
 * changing identity. An attempt keeps its id for its whole lifecycle - `store.ts` writes the
 * verdict with `UPDATE workflow_node_attempts ... WHERE id = ?`, and only a retry ever inserts
 * a new row - so a reviewer selected while it is still reporting nothing is `attempt` one
 * moment and `verdict` the next, and a Command is `attempt` until its outcome lands and `check`
 * after. Keyed by kind, the selection stopped resolving at exactly that moment and snapped to
 * the head of the list: the reader watching a reviewer resolve lost it the instant it did.
 */
const attemptKey = (attempt: WorkflowNodeAttempt): string => `attempt:${attempt.id}`;
const changeKey = (row: ChangeWorklistRow): string => `change:${row.key}`;

/** The reviewer a row belongs to, whichever of the two id spaces the row came from. */
const nodeOf = (item: WorklistItem): string =>
  item.kind === "change" ? item.row.nodeId : item.attempt.nodeId;

const SEGMENTS = ["blocking", "passed", "archive"] as const;

/** The first worklist row owned by any requested pipeline node, in displayed priority. */
export function worklistSelectionForNodes(
  nodeIds: readonly string[],
  bySegment: Record<WorklistSegment, WorklistItem[]>,
): { segment: WorklistSegment; item: WorklistItem } | null {
  const requested = new Set(nodeIds);
  for (const segment of SEGMENTS) {
    const item = bySegment[segment].find((candidate) => requested.has(nodeOf(candidate)));
    if (item) return { segment, item };
  }
  return null;
}

/** The first worklist row owned by one pipeline node, in the worklist's displayed priority. */
export function worklistSelectionForNode(
  nodeId: string,
  bySegment: Record<WorklistSegment, WorklistItem[]>,
): { segment: WorklistSegment; item: WorklistItem } | null {
  return worklistSelectionForNodes([nodeId], bySegment);
}

/**
 * Where a selection went when the row holding it stopped existing.
 *
 * One key namespace per id space is enough while a row stays in its own space, and a reviewer
 * that reports a PASS does: it is `attempt:<id>` pending and `attempt:<id>` afterwards. A
 * reviewer that reports a FAIL changes space entirely. Its attempt stops being an item at all -
 * a parseable fail verdict is represented by the changes it raised, not by itself - so the row
 * a reader was watching becomes one or more `change:` rows, in `Blocking` rather than `Passed`.
 * No key rewrite can bridge that; the successor has a different identity because it IS a
 * different thing.
 *
 * So the selection follows the REVIEWER. The attempt row survives in `detail.attempts` with its
 * id and its node, and the changes it raised carry that node too, which is the thread between
 * them. When the followed row lives in another segment the rail goes there, because a selection
 * pointing somewhere the reader cannot see is not a selection.
 *
 * Only ever when the key resolves NOWHERE. A key that still resolves in another segment is a
 * reader who moved segments with a row still selected behind them, and dragging them back would
 * overrule a choice rather than preserve one.
 */
export function followSelection(
  selectedKey: string,
  attempts: readonly WorkflowNodeAttempt[],
  bySegment: Record<WorklistSegment, WorklistItem[]>,
): { segment: WorklistSegment; item: WorklistItem } | null {
  const prefix = "attempt:";
  if (!selectedKey.startsWith(prefix)) return null;
  const nodeId = attempts.find((attempt) => attempt.id === selectedKey.slice(prefix.length))?.nodeId;
  if (nodeId === undefined) return null;
  // Pre-sorted, so the first row this reviewer owns is the one it leads with.
  return worklistSelectionForNode(nodeId, bySegment);
}

/**
 * What each state of a requested change CLAIMS, in a chip and a colour.
 *
 * `unconfirmed` is the one worth reading twice, and both halves of it are load-bearing. It is
 * NOT green: green would tell an operator a reviewer is satisfied while the stalemate card at
 * the foot of the same rail says that reviewer has failed every round. And it is not worded as
 * *rephrased* either, which is the opposite error and just as wrong - a reviewer that stops
 * raising a change BECAUSE it is fixed, while separately raising something unrelated, lands in
 * this same state, and telling that operator their fix was merely reworded is a false claim
 * about their own work. The state means *not known*, so the chip says not known.
 */
const CHANGE_STATE_CHIPS: Record<ChangeWorklistState, { label: string; tone: string }> = {
  open: { label: "Blocker", tone: "failed" },
  unconfirmed: { label: "Unconfirmed", tone: "waiting" },
  resolved: { label: "Resolved", tone: "passed" },
};

/**
 * A reviewer that produced no readable opinion and is not going to.
 *
 * `error` is a provider failure with no retry left - the engine only leaves a row in that state
 * once it has stopped scheduling successors - and a `completed` attempt with no verdict is a
 * reply the parser rejected. Both stop the run, and both carry a durable string that is the only
 * explanation on the page. Everything else verdict-less (queued, running, retrying, cancelled)
 * has simply not reported, which is a different claim and a different segment.
 *
 * "Carries an error string" is deliberately NOT part of this. A scheduled retry is inserted
 * `retry_wait` WITH one - `Retry scheduled after infrastructure failure: …` - so testing the
 * field would file every node that is about to try again under the heading for the ones that
 * cannot. The reason still reaches the reader: the row prints that sentence under its `Retrying`
 * chip, and the card behind it prints the whole thing.
 */
function stalledReviewer(attempt: WorkflowNodeAttempt): boolean {
  return attempt.state === "error" || attempt.state === "completed";
}

/**
 * The file a change cites, or null - and EMPTY IS ABSENT.
 *
 * `WorkflowRequestedChangeSchema.path` is `.optional()` with no `.min(1)`, so a reviewer may
 * legally emit `path: ""`, and `change.path ?? null` keeps it: `??` coalesces null and undefined,
 * not the empty string. Read directly, the row and the copy text called it absent while the
 * detail pane drew an `Open file` button with nothing in its tooltip that revealed an empty path
 * in the Files tab. One rule in one place, so the four readers cannot disagree again.
 */
const citedPath = (row: ChangeWorklistRow): string | null =>
  row.path === null || row.path === "" ? null : row.path;

/** The exact repair text one change copies, so a session gets the ask rather than the page. */
function changeCopyText(row: ChangeWorklistRow): string {
  const path = citedPath(row);
  return [
    row.title,
    path === null ? null : `${path}${row.line === null ? "" : `:${row.line}`}`,
    "",
    row.rationale,
  ].filter((part) => part !== null).join("\n");
}

/**
 * The attempt that last raised one change, for the reviewer's own summary and meta line.
 *
 * `ChangeWorklistRow` deliberately carries the CHANGE rather than the verdict around it, so
 * the summary has to be looked back up - at `row.lastRound`, which is the round the row's
 * wording came from, never the viewed round: a change carried forward from round 4 into a
 * round its reviewer has not re-run would otherwise show no summary at all.
 *
 * The fold matches `foldRun`'s to the letter - ascending segment, then ascending attempt, with
 * the guard that keeps a higher-numbered attempt from an earlier segment - because a summary
 * read off a different attempt than the one the row was accumulated from is the two-derivations
 * disagreement this whole surface is built to avoid.
 */
function raisingAttempt(
  detail: WorkflowRunDetail,
  nodeId: string,
  round: number,
): WorkflowNodeAttempt | null {
  const segmentOf = new Map(detail.submissions
    .filter((submission) => submission.round === round)
    .map((submission) => [submission.id, submission.segment]));
  let newest: WorkflowNodeAttempt | null = null;
  const ordered = detail.attempts
    .filter((candidate) => candidate.nodeId === nodeId && segmentOf.has(candidate.submissionId))
    .sort((left, right) =>
      (segmentOf.get(left.submissionId) ?? 0) - (segmentOf.get(right.submissionId) ?? 0)
      || left.attempt - right.attempt);
  for (const candidate of ordered) {
    if (newest && newest.attempt > candidate.attempt) continue;
    newest = candidate;
  }
  return newest;
}

/** One rail line. The chip is the row's own claim; the lines under it are its provenance. */
function WorklistRailRow({
  item,
  selected,
  onSelect,
}: {
  item: WorklistItem;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const view = ((): {
    chip: { label: string; tone: string };
    title: string;
    lines: string[];
    hint: string;
  } => {
    switch (item.kind) {
      case "change": {
        const { row } = item;
        const path = citedPath(row);
        return {
          chip: CHANGE_STATE_CHIPS[row.state],
          title: row.title,
          hint: `Show what ${row.personaName} asked for, in full`,
          lines: [
            ...(path === null ? [] : [path]),
            row.state === "resolved" && row.resolvedRound !== null
              ? `Resolved in round ${row.resolvedRound}`
              : row.state === "unconfirmed"
                ? `Last raised in round ${row.lastRound}`
                : `${row.personaName} · round ${row.firstRound}`,
            // The reviewer is never dropped from an archived row either: two reviewers can ask
            // for the same thing on the same file, so the name is what tells the two rows apart.
            ...(row.state === "unconfirmed"
              ? [`${row.personaName} has not passed since, so this was never confirmed fixed.`]
              : row.state === "resolved"
                ? [row.personaName]
                : []),
          ],
        };
      }
      case "check": {
        /*
         * The OUTCOME decides the chip, because the outcome decides the segment.
         *
         * A check's attempt also carries a synthetic verdict, and reading the chip off that -
         * which is what the pipeline strip above does, correctly, since it has no segment to
         * agree with - would let a row sitting in `Blocking` because the command exited
         * non-zero draw itself "Passed" whenever the two disagree. `checkStatus` still gets the
         * outcome as well, so `skipped` and `unavailable` keep their degraded amber chips
         * rather than being flattened into the green of a command that really ran.
         */
        const status = checkChip(item.outcome);
        return {
          chip: { label: status.label, tone: status.tone },
          title: `Command · ${item.outcome.slot}`,
          hint: `Show the ${item.outcome.slot} Command's result, output included`,
          lines: [
            item.outcome.command
              ? formatCheckCommand(item.outcome.command)
              : "no command configured",
            ...(item.outcome.exitCode === null ? [] : [`exit ${item.outcome.exitCode}`]),
          ],
        };
      }
      case "verdict":
        return {
          chip: {
            label: item.verdict.verdict === "pass" ? "Passed" : "Changes requested",
            tone: item.verdict.verdict === "pass" ? "passed" : "failed",
          },
          title: item.attempt.persona?.name ?? "Missing persona",
          hint: item.verdict.verdict === "pass"
            ? "Show this reviewer's approval rationale and the evidence behind it"
            : "Show this reviewer's whole verdict",
          lines: [item.verdict.summary],
        };
      case "attempt": {
        const status = reviewerStatus(item.attempt.state);
        return {
          chip: { label: status.label, tone: status.tone },
          title: item.name,
          hint: `Show what is recorded for ${item.name} in this round`,
          lines: item.attempt.error ? [errorView(item.attempt.error)?.sentence ?? ""] : [],
        };
      }
    }
  })();
  return (
    <li>
      <Tooltip label={view.hint}>
        <button
          type="button"
          /* The tone comes off the SAME chip the row draws, so the left accent and the word
             beside it can never disagree about what this row is. `is-{kind}` and the change's
             `is-{state}` stay for the selectors the specs read; neither carries a colour. */
          className={`wf-run-worklist-row is-${item.kind}${
            item.kind === "change" ? ` is-${item.row.state}` : ""
          } is-tone-${view.chip.tone}${selected ? " active" : ""}`}
          aria-current={selected}
          onClick={onSelect}
        >
          <span className="wf-run-worklist-row-head">
            <span className={`workflow-chip workflow-${view.chip.tone}`}>{view.chip.label}</span>
            <strong>{view.title}</strong>
          </span>
          {view.lines.filter(Boolean).map((line) => (
            <span className="wf-run-worklist-row-line" key={line}>{line}</span>
          ))}
        </button>
      </Tooltip>
    </li>
  );
}

/**
 * The Blocker Worklist: what this run is asking for, and what it is no longer asking for.
 *
 * This replaces a section that rendered every reviewer's whole card whether it had anything to
 * say or not - measured at 11,445 characters to convey about 480 on a live ten-round run. The
 * reorganisation is the point: a PASS costs one line here and its full card only when somebody
 * asks for it, while a change gets a row of its own carrying the round it was first raised in,
 * which no round-scoped card could say at all.
 *
 * Everything in here answers for the ROUND THE SCRUBBER POINTS AT, the stalemate card included.
 * `runChangeWorklist` and `runStalemates` both take that round, so scrubbing back moves all
 * three segment counts and the card together; nothing in this section may state a fact from a
 * round later than the one being viewed.
 */
/**
 * The worklist's four buckets, classified without rendering.
 *
 * Lifted out of `RunWorklist` when the run record grew a tab bar, and lifted rather than
 * copied on purpose: the worklist's tab label carries a count and an amber badge, and both are
 * claims about the same classification the rail draws. A second derivation of "how many things
 * are blocking" would be two answers to one question, and the label - the half a reader trusts
 * without opening the pane - is the half that would be wrong.
 *
 * `passed` and `pending` are handed back separately rather than pre-merged: the rail shows them
 * in one panel and counts only the real passes, because a queued reviewer counted as a pass
 * would claim an outcome nobody reached.
 */
export interface WorklistSegments {
  /** What this run is still asking for: failed commands, stalled reviewers, open changes. */
  blocking: WorklistItem[];
  /** Reviewers and commands that are not asking for anything in this round. */
  passed: WorklistItem[];
  /** Reviewers this round has not heard from yet. Not blocking, and not a pass either. */
  pending: WorklistItem[];
  /** Changes a later verdict from their own reviewer settled, or left unconfirmed. */
  archive: WorklistItem[];
}

export function runWorklistSegments(
  detail: WorkflowRunDetail,
  /** The viewed round. `null` means the latest submission's round. */
  round: number | null,
  /** This round's non-action attempts, with the structural nodes already filtered out. */
  attempts: readonly WorkflowNodeAttempt[],
  nameOfNode: (nodeId: string) => string | null,
): WorklistSegments {
  const worklist = runChangeWorklist(detail, round);

  /*
   * Checks never flow through the change model and never will - a row keyed on a title cannot
   * carry an exit code or an output tail. So `checkOutcomeOf` is asked FIRST, exactly as the
   * old section asked it, and the outcome's own `status` picks the segment: `failed` is a
   * blocker because it is why the run stopped, and `passed`, `skipped` and `unavailable` are
   * passes - the last two degraded ones, which keep their amber chip rather than being drawn
   * green for a command that never ran.
   */
  const checks: { attempt: WorkflowNodeAttempt; outcome: WorkflowCheckOutcome }[] = [];
  const verdicts: { attempt: WorkflowNodeAttempt; verdict: PersonaVerdict }[] = [];
  const bare: WorkflowNodeAttempt[] = [];
  for (const attempt of attempts) {
    // The check is asked FIRST, because a check also carries a verdict - a synthetic one, so
    // the join and the repair packet need no special case. Asking the verdict first would draw
    // every command gate as a Persona row with no Persona in it.
    const outcome = checkOutcomeOf(attempt);
    if (outcome) {
      checks.push({ attempt, outcome });
      continue;
    }
    const verdict = verdictOf(attempt);
    if (verdict) verdicts.push({ attempt, verdict });
    else bare.push(attempt);
  }

  const open = worklist.filter((row) => row.state === "open");
  const archived = worklist.filter((row) => row.state !== "open");
  /*
   * A fail verdict this round that produced no row is not dropped on the floor.
   *
   * `runChangeWorklist` reads verdicts through the strict schema and skips a durable row it
   * cannot parse, and it skips an attempt with no Persona snapshot; the display cast here is
   * looser. Either gap would silently delete a reviewer's whole objection from the one section
   * that is supposed to list it, so anything that failed at the viewed round without landing a
   * row keeps its full verdict card in `Blocking`.
   *
   * The dedupe is per (NODE, VIEWED ROUND), and the round half is the load-bearing part. Keyed
   * on the node alone it also matched a row carried forward from an EARLIER round, so a
   * reviewer with a round-1 objection still open whose round-2 reply the strict parser rejected
   * had that reply swallowed: no card for it, and the model cannot update the round-1 row from
   * a verdict it could not read either, so the page showed a stale objection with no sign the
   * reviewer had answered at all. `round` needs no clamping to compare against `lastRound` -
   * it IS the viewed submission's round, and when it is null there are no submissions and
   * therefore no attempts to classify.
   */
  const raisedInViewedRound = new Set(
    worklist.filter((row) => row.lastRound === round).map((row) => row.nodeId),
  );
  const unmodelledFailures = verdicts.filter(({ attempt, verdict }) =>
    verdict.verdict === "fail" && !raisedInViewedRound.has(attempt.nodeId));

  const blocking: WorklistItem[] = [
    ...checks
      .filter(({ outcome }) => outcome.status === "failed")
      .map(({ attempt, outcome }): WorklistItem => ({
        kind: "check",
        key: attemptKey(attempt),
        attempt,
        outcome,
      })),
    /*
     * A reviewer that errored, or that answered in a shape the verdict parser rejected, is a
     * blocker with no change attached: the run cannot pass it and its durable error string is
     * the only thing on the page saying why. It sorts up here with the failed commands for the
     * same reason they do - a stage that could not run is why the run stopped, and the
     * objections underneath it are from a round that is no longer moving.
     */
    ...bare
      .filter(stalledReviewer)
      .map((attempt): WorklistItem => ({
        kind: "attempt",
        key: attemptKey(attempt),
        attempt,
        name: attempt.persona?.name ?? nameOfNode(attempt.nodeId) ?? "Reviewer",
      })),
    ...open.map((row): WorklistItem => ({ kind: "change", key: changeKey(row), row })),
    ...unmodelledFailures.map(({ attempt, verdict }): WorklistItem => ({
      kind: "verdict",
      key: attemptKey(attempt),
      attempt,
      verdict,
    })),
  ];
  const passed: WorklistItem[] = [
    ...verdicts
      .filter(({ verdict }) => verdict.verdict === "pass")
      .map(({ attempt, verdict }): WorklistItem => ({
        kind: "verdict",
        key: attemptKey(attempt),
        attempt,
        verdict,
      })),
    ...checks
      .filter(({ outcome }) => outcome.status !== "failed")
      .map(({ attempt, outcome }): WorklistItem => ({
        kind: "check",
        key: attemptKey(attempt),
        attempt,
        outcome,
      })),
  ];
  /*
   * Reviewers this round has not heard from yet, kept OUT of the `Passed` count.
   *
   * They are in the `Passed` panel because they are not blocking anything - the changes still
   * open while they re-review are already carried into `Blocking` by the model above. But a
   * queued reviewer counted as a pass would be the surface claiming an outcome nobody reached,
   * which is the one thing every chip in this app refuses to do, so the count is over real
   * passes and these sit under their own label with their own chips.
   */
  const pending: WorklistItem[] = bare
    .filter((attempt) => !stalledReviewer(attempt))
    .map((attempt): WorklistItem => ({
      kind: "attempt",
      key: attemptKey(attempt),
      attempt,
      name: attempt.persona?.name ?? nameOfNode(attempt.nodeId) ?? "Reviewer",
    }));
  const archive: WorklistItem[] = archived
    .map((row): WorklistItem => ({ kind: "change", key: changeKey(row), row }));
  return { blocking, passed, pending, archive };
}

function RunWorklist({
  detail,
  round,
  attempts,
  calls,
  nameOfNode,
  inspectorOnly,
  reviewerlessVersion,
  personaNodeIds,
  disabledNodeIds,
  initialNodeIds = [],
  onOpenFile,
  onCopyChange,
  changeCopied = false,
  onOpenPersonaDirective,
  onToggleNodesDisabled,
}: {
  detail: WorkflowRunDetail;
  /** The viewed round. `null` means the latest submission's round. */
  round: number | null;
  /** This round's non-action attempts, with the structural nodes already filtered out. */
  attempts: readonly WorkflowNodeAttempt[];
  calls: NonNullable<WorkflowRunDetail["llmCalls"]>;
  nameOfNode: (nodeId: string) => string | null;
  inspectorOnly: boolean;
  reviewerlessVersion: boolean;
  personaNodeIds: ReadonlySet<string>;
  disabledNodeIds: readonly string[];
  /** Settled pipeline nodes requested before this keyed worklist instance mounted. */
  initialNodeIds?: readonly string[];
  onOpenFile?: (path: string) => void;
  onCopyChange?: (text: string) => void;
  changeCopied?: boolean;
  onOpenPersonaDirective?: (nodeId: string) => void;
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
}): React.JSX.Element {
  const stalemates = runStalemates(detail, round);
  const { blocking, passed, pending, archive } =
    runWorklistSegments(detail, round, attempts, nameOfNode);
  const bySegment: Record<WorklistSegment, WorklistItem[]> = {
    blocking,
    passed: [...passed, ...pending],
    archive,
  };
  const initialSelection = worklistSelectionForNodes(initialNodeIds, bySegment);

  /** The reader's own pick, and the round they made it in. Both, for the scrub rule below. */
  const [chosenSegment, setChosenSegment] = useState<
    { segment: WorklistSegment; round: number | null } | null
  >(initialSelection ? { segment: initialSelection.segment, round } : null);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelection?.item.key ?? null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const counts: Record<WorklistSegment, number> = {
    blocking: blocking.length,
    passed: passed.length + pending.length,
    archive: archive.length,
  };
  /*
   * The first segment that has anything in it, and then whatever the reader picked.
   *
   * A run with nothing outstanding opens on `Passed` rather than on an empty agenda, and one
   * whose reviewers have all gone quiet opens on `Archive` rather than on two empty panes. The
   * final fallback is `Passed`, which is where the three empty-state sentences live.
   *
   * A PICK HOLDS IN THE ROUND IT WAS MADE IN, and survives a scrub only while it still has
   * something to show. Held unconditionally it strands the reader: pick `Archive` on round 10,
   * scrub to round 1, and the counts beside them update while the pane stays empty - which
   * reads as "round 1 asked for nothing" on the very control built to say what a round is
   * asking for. Cleared unconditionally it would break comparing one segment across rounds,
   * which is what the scrubber is for. Scoping it to the round keeps both, and keeps clicking
   * an empty segment doing exactly what it says - the reader who wants to look at `Archive 0`
   * gets `Archive 0`, and only a scrub can overrule them.
   *
   * This is the same shape `selectedKey` already has: the reader's choice, with a fallback for
   * when the round it belongs to no longer holds it.
   *
   * Selection is LOCAL state, exactly like the round - there is no precedent for a sub-run
   * selection in `MissionRoute`, and deep-linking one change is a deliberate non-goal.
   */
  const autoSegment: WorklistSegment = counts.blocking > 0
    ? "blocking"
    : counts.passed > 0 ? "passed" : counts.archive > 0 ? "archive" : "passed";
  const picked = chosenSegment === null
    ? autoSegment
    : chosenSegment.round === round || counts[chosenSegment.segment] > 0
      ? chosenSegment.segment
      : autoSegment;
  /*
   * A selection that no longer resolves ANYWHERE is followed to whatever now represents its
   * reviewer - but only inside THIS ROUND, and the scoping is the whole correctness of it.
   *
   * A key stops resolving for two unrelated reasons, and only one of them is a reviewer
   * reporting. The other is the reader scrubbing: `selectedKey` deliberately carries no round,
   * so a row selected in round 10 names nothing in round 4. Handed every attempt in the run, the
   * follow resolved that stale id to its node anyway and matched it against whatever that node
   * owns in the round now on screen - dropping the reader onto a row and a segment they never
   * chose there, as though a verdict had just landed, when all they did was scrub.
   *
   * Scoped to the viewed round, an id from another round simply is not found, so the follow says
   * nothing and the round's own rules decide. Every attempt of the round is included rather than
   * the newest per node, so a row superseded by a retry is still followed to its successor.
   */
  const viewedSubmissions = new Set(detail.submissions
    .filter((submission) => submission.round === round)
    .map((submission) => submission.id));
  const roundAttempts = detail.attempts
    .filter((attempt) => viewedSubmissions.has(attempt.submissionId));
  const followed = selectedKey !== null
    && !SEGMENTS.some((entry) => bySegment[entry].some((item) => item.key === selectedKey))
    ? followSelection(selectedKey, roundAttempts, bySegment)
    : null;
  const segment = followed?.segment ?? picked;
  const items = bySegment[segment];
  /*
   * Resolved rather than stored, so scrubbing keeps a change that exists in both rounds
   * selected and falls back to the head of the list when it does not - never to an empty pane.
   */
  const selected = items.find((item) => item.key === selectedKey)
    ?? followed?.item
    ?? items[0]
    ?? null;
  const selectedIndex = selected ? items.indexOf(selected) : -1;
  /*
   * Moving the selection PINS the segment it moved within, and every control that moves it goes
   * through here.
   *
   * A follow is transient by construction: it holds only while `selectedKey` names a row that
   * resolves nowhere. The instant any control writes a live key the follow stops firing, and
   * without this the segment fell back to whatever the reader had picked BEFORE the follow moved
   * them - so `Next` from a followed row in `Blocking` wrote a real Blocking key, the rail
   * snapped back to `Passed`, and the reader landed on an unrelated row instead of the next
   * blocker.
   *
   * Pinning the DISPLAYED segment is the honest reading of the gesture: whatever moved the
   * reader here, they are acting on the list in front of them. The segment buttons keep their
   * own handler, because picking a segment clears the selection rather than moving it.
   */
  const selectIn = (key: string | null): void => {
    setSelectedKey(key);
    setChosenSegment({ segment, round });
  };

  const terminalRun = ["completed", "cancelled", "failed"].includes(detail.run.status);
  const segments: { id: WorklistSegment; label: string; count: number; hint: string }[] = [
    {
      id: "blocking",
      label: "Blocking",
      count: blocking.length,
      hint: "The changes and failed commands this run is still asking for",
    },
    {
      id: "passed",
      label: "Passed",
      count: passed.length,
      hint: "Reviewers and commands that are not asking for anything in this round",
    },
    {
      id: "archive",
      label: "Archive",
      count: archive.length,
      hint: "Changes that stopped being raised, and what is known about why",
    },
  ];

  return (
    <div className="wf-run-worklist">
      <div className="wf-run-worklist-rail">
        <div className="wf-run-worklist-seg" role="group" aria-label="Worklist segment">
          {segments.map((entry) => (
            <Tooltip key={entry.id} label={entry.hint}>
              <button
                type="button"
                className={segment === entry.id ? "active" : ""}
                aria-pressed={segment === entry.id}
                onClick={() => {
                  setChosenSegment({ segment: entry.id, round });
                  setSelectedKey(null);
                }}
              >
                {entry.label} {entry.count}
              </button>
            </Tooltip>
          ))}
        </div>

        <div className="wf-run-worklist-list">
          {items.length === 0 && (
            <p className="wf-run-empty">
              {segment === "blocking"
                ? "Nothing is blocking this run in this round."
                : segment === "archive"
                  ? "No change has stopped being raised as of this round."
                  // The three arms the old section had, scoped to `Passed`, where they are
                  // still true. "This Inspector repair round ran no Personas" is NOT true of
                  // `Blocking`, which legitimately carries forward what is still outstanding.
                  : inspectorOnly
                    ? "This GitHub Inspector repair round ran no Personas."
                    : reviewerlessVersion
                      ? "This workflow has no reviewers - nothing in it produces a verdict."
                      : "No reviewer has been activated in this round yet."}
            </p>
          )}
          {(segment === "passed" ? passed : items).length > 0 && (
            <ul className="wf-run-worklist-rows">
              {(segment === "passed" ? passed : items).map((item) => (
                <WorklistRailRow
                  key={item.key}
                  item={item}
                  selected={selected?.key === item.key}
                  onSelect={() => selectIn(item.key)}
                />
              ))}
            </ul>
          )}
          {segment === "passed" && pending.length > 0 && (
            <>
              <p className="wf-run-worklist-group">No verdict in this round yet</p>
              <ul className="wf-run-worklist-rows">
                {pending.map((item) => (
                  <WorklistRailRow
                    key={item.key}
                    item={item}
                    selected={selected?.key === item.key}
                    onSelect={() => selectIn(item.key)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* The fact that never reached this page. `detail.repeatOffenders` is computed over the
            run's whole submission list and anchored on its newest one, so it cannot be
            re-scoped by the viewed round; `runStalemates` is its windowed twin, and the
            sentence is the ladder's own so one fact is worded one way on both surfaces. */}
        {stalemates.length > 0 && (
          <div className="wf-run-worklist-stalemate" role="status">
            <strong>Stalemate</strong>
            {stalemates.map((offender) => (
              <p key={offender.nodeId}>
                {offender.personaName} has failed {offender.rounds} rounds running.
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Deliberately EMPTY rather than repeating the rail: an empty segment already says what
          it is, and printing "nothing outstanding" beside "nothing is blocking this run" is one
          fact stated twice on a surface whose whole complaint is duplication. */}
      <div className="wf-run-worklist-detail">
        {selected !== null && (
          <>
            <div className="wf-run-worklist-detail-body">
              {selected.kind === "check" && (
                <CheckCard attempt={selected.attempt} outcome={selected.outcome} />
              )}
              {selected.kind === "verdict" && (
                <VerdictCard
                  attempt={selected.attempt}
                  verdict={selected.verdict}
                  meta={verdictMeta(selected.attempt, calls)}
                />
              )}
              {selected.kind === "attempt" && (
                <AttemptCard attempt={selected.attempt} name={selected.name} />
              )}
              {selected.kind === "change" && (
                <ChangeDetail
                  row={selected.row}
                  attempt={raisingAttempt(detail, selected.row.nodeId, selected.row.lastRound)}
                  calls={calls}
                  disabled={disabledNodeIds.includes(selected.row.nodeId)}
                  copied={changeCopied && copiedKey === selected.key}
                  onCopy={onCopyChange
                    ? () => {
                        setCopiedKey(selected.key);
                        onCopyChange(changeCopyText(selected.row));
                      }
                    : undefined}
                  onOpenFile={onOpenFile}
                  onOpenPersonaDirective={!terminalRun
                    && onOpenPersonaDirective
                    && personaNodeIds.has(selected.row.nodeId)
                    ? onOpenPersonaDirective
                    : undefined}
                  onToggleNodesDisabled={!terminalRun && onToggleNodesDisabled
                    ? onToggleNodesDisabled
                    : undefined}
                />
              )}
            </div>
            {/* Previous and next walk the CURRENT segment across every kind in it, so a reader
                can page from a failed command straight into the objections underneath it
                without changing segment. */}
            <div className="wf-run-worklist-walk">
              <span className="wf-run-meta">{selectedIndex + 1} of {items.length}</span>
              <Tooltip label="Show the previous item in this segment">
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Previous item"
                  disabled={selectedIndex <= 0}
                  onClick={() => selectIn(items[selectedIndex - 1]?.key ?? null)}
                >
                  ← Previous
                </button>
              </Tooltip>
              <Tooltip label="Show the next item in this segment">
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Next item"
                  disabled={selectedIndex < 0 || selectedIndex >= items.length - 1}
                  onClick={() => selectIn(items[selectedIndex + 1]?.key ?? null)}
                >
                  Next →
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One requested change in full, with the four things a person can do about it.
 *
 * The two MUTATING actions are withheld rather than disabled once the run is terminal, matching
 * the per-node menus on the strip: a finished run can no longer be affected, and a greyed-out
 * button that could never become enabled is a worse answer than no button. `Open file` is
 * withheld for the same reason when the change cites none - the type makes `path` optional and
 * plenty of real changes carry none.
 */
function ChangeDetail({
  row,
  attempt,
  calls,
  disabled,
  copied,
  onCopy,
  onOpenFile,
  onOpenPersonaDirective,
  onToggleNodesDisabled,
}: {
  row: ChangeWorklistRow;
  /** The attempt that last raised it, for the reviewer's own summary and meta. */
  attempt: WorkflowNodeAttempt | null;
  calls: NonNullable<WorkflowRunDetail["llmCalls"]>;
  disabled: boolean;
  copied: boolean;
  onCopy?: () => void;
  onOpenFile?: (path: string) => void;
  onOpenPersonaDirective?: (nodeId: string) => void;
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
}): React.JSX.Element {
  const chip = CHANGE_STATE_CHIPS[row.state];
  const meta = attempt ? verdictMeta(attempt, calls) : null;
  const summary = attempt ? verdictOf(attempt)?.summary ?? null : null;
  const path = citedPath(row);
  return (
    <article className={`wf-run-card wf-run-change is-${row.state}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${chip.tone}`}>{chip.label}</span>
        <strong>{row.personaName}</strong>
        <span className="wf-run-confidence">{Math.round(row.confidence * 100)}% confident</span>
        {meta?.runner && meta.model && (
          <span className="wf-run-meta">{meta.runner} · {meta.model}</span>
        )}
      </header>
      {attempt && <PersonaReadinessInput attempt={attempt} />}
      <h5 className="wf-run-change-title">{row.title}</h5>
      {summary && <p className="wf-run-summary">{summary}</p>}
      <dl className="wf-run-facts-list">
        <div>
          <dt>File</dt>
          <dd>
            {path === null
              ? "No file cited"
              : <code>{path}{row.line === null ? "" : `:${row.line}`}</code>}
          </dd>
        </div>
        <div>
          <dt>First raised</dt>
          <dd>Round {row.firstRound}</dd>
        </div>
        <div>
          {/* A count of the rounds that RAISED it, never the span between them, so it cannot
              claim a round its reviewer stayed silent in. */}
          <dt>Rounds open</dt>
          <dd>{row.roundsOpen}</dd>
        </div>
        <div>
          <dt>Evidence refs</dt>
          <dd>{row.evidence.length}</dd>
        </div>
        {row.state === "resolved" && row.resolvedRound !== null && (
          <div>
            <dt>Resolved in</dt>
            <dd>Round {row.resolvedRound}</dd>
          </div>
        )}
        {row.state === "unconfirmed" && (
          <div>
            <dt>Last raised</dt>
            <dd>Round {row.lastRound}</dd>
          </div>
        )}
      </dl>
      <div className="wf-run-card-body">
        <h5>What the reviewer wants</h5>
        <p>{row.rationale}</p>
      </div>
      {row.evidence.length > 0 && (
        <div className="wf-run-card-body">
          <h5>Cited evidence</h5>
          <EvidenceList evidence={row.evidence} />
        </div>
      )}
      <div className="wf-run-change-acts">
        {onCopy && (
          <Tooltip label="Copy this one change - its title, file and rationale - to the clipboard">
            <button className="btn" type="button" onClick={onCopy}>
              {copied ? COPY_FEEDBACK_LABEL : "Copy this change"}
            </button>
          </Tooltip>
        )}
        {onOpenFile && path !== null && (
          <Tooltip label={`Open ${path} in the bound session's Files tab`}>
            <button className="btn btn-ghost" type="button" onClick={() => onOpenFile(path)}>
              Open file
            </button>
          </Tooltip>
        )}
        {onOpenPersonaDirective && (
          <Tooltip label={`Give ${row.personaName} feedback that applies to every later round`}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => onOpenPersonaDirective(row.nodeId)}
            >
              Give this reviewer feedback
            </button>
          </Tooltip>
        )}
        {onToggleNodesDisabled && (
          <Tooltip label={`${disabled ? "Enable" : "Disable"} ${row.personaName} for this workflow run`}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => onToggleNodesDisabled([row.nodeId], !disabled)}
            >
              {disabled ? `Enable ${row.personaName}` : `Disable ${row.personaName}`}
            </button>
          </Tooltip>
        )}
      </div>
    </article>
  );
}

/**
 * The run record's tab bar and one pane of it.
 *
 * A pane is `{ id, label, count, blocking, render }` and that shape is the contract every
 * later pane joins by. `render` returning null means the pane is not offered AT ALL - not
 * disabled, not empty - which is how a conditional record (a gate that was never adopted, a
 * completion nobody claimed) stays absent from the bar instead of being a tab that draws
 * nothing.
 *
 * `blocking` drives the amber badge and it means "this pane holds something that STOPS the
 * run". It never means "this pane has warnings". Every pane sets it honestly; none of them
 * adds a selection rule of its own.
 */
interface RunRecordPaneSpec {
  id: RunRecordPane;
  label: string;
  /** What this pane answers, on the tab itself. */
  hint: string;
  /** The count on the label. `null` for a pane whose contents are not a countable set. */
  count: number | null;
  blocking: boolean;
  /** Called during the container's render. Must create elements only - never call a hook. */
  render: () => React.JSX.Element | null;
}

const runRecordTabId = (pane: RunRecordPane): string => `run-record-tab-${pane}`;
const runRecordPaneId = (pane: RunRecordPane): string => `run-record-pane-${pane}`;

function RunRecordTabs({
  panes,
  routePane,
  onPane,
}: {
  panes: readonly RunRecordPaneSpec[];
  /** The pane the address bar names, or null. Ignored when this run does not offer it. */
  routePane: RunRecordPane | null;
  /**
   * Ask the host to route to a pane. Absent on a host that does not route, in which case the
   * bar keeps the pick in local state - which is what makes the tabs work in a markup test.
   *
   * When it IS present the ROUTE is the source of truth and no local pick is kept, and that is
   * what makes the back button move the tab: a reader who clicked Intent and then went back has
   * changed nothing about this component, only the hash, so anything remembered here would
   * fight the history entry they just asked for.
   */
  onPane?: (pane: RunRecordPane) => void;
}): React.JSX.Element {
  const offered = panes
    .map((pane) => ({ pane, content: pane.render() }))
    .filter((entry): entry is { pane: RunRecordPaneSpec; content: React.JSX.Element } =>
      entry.content !== null);
  const offers = (pane: RunRecordPane | null): boolean =>
    pane !== null && offered.some((entry) => entry.pane.id === pane);
  /*
   * Resolved ONCE, at mount, and this component mounts once per run: the host nulls `detail`
   * when another run is selected, so the view under it is destroyed and rebuilt.
   *
   * That is the whole of why a delivery turning refused under a reader raises the badge and
   * does not move them. `detail` is refreshed in place from the run's SSE summary, so
   * re-deriving this on every commit would drag anyone reading Intent onto Deliveries the
   * moment a packet failed.
   */
  const [initial] = useState(() => initialRunRecordPane(
    offered.map((entry) => ({ id: entry.pane.id, blocking: entry.pane.blocking })),
    routePane,
    "worklist",
  ));
  const [pick, setPick] = useState<RunRecordPane | null>(null);
  const routed = offers(routePane) ? routePane : null;
  const localPick = offers(pick) ? pick : null;
  // `initial` was resolved against the registry this run mounted with, so it is guarded again
  // rather than trusted: a pane can stop being offered under a live update - a delivery ledger
  // does not empty, but a later phase's conditional pane may - and a selection naming a tab
  // that is no longer in the bar would draw nothing at all.
  const fallback = offers(initial) ? initial : offered[0]?.pane.id ?? "worklist";
  const selected = routed ?? localPick ?? fallback;
  const tabs = useRef(new Map<RunRecordPane, HTMLButtonElement>());
  const select = (pane: RunRecordPane): void => {
    if (pane === selected) return;
    if (onPane) onPane(pane);
    else setPick(pane);
  };
  /**
   * Arrow keys move between tabs, which is the half of `role="tablist"` a plain row of buttons
   * does not get for free. Home and End are included because a bar that grows a fifth pane
   * makes "the first one" a real destination.
   *
   * The move SELECTS as well as focusing, which is the automatic-activation pattern: every
   * pane here is already rendered from records in hand, so there is nothing to load and
   * nothing that a separate confirming keystroke would protect.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const target = event.key === "Home"
      ? 0
      : event.key === "End"
        ? offered.length - 1
        : step === 0 ? -1 : (index + step + offered.length) % offered.length;
    if (target < 0) return;
    const next = offered[target];
    if (!next) return;
    event.preventDefault();
    select(next.pane.id);
    tabs.current.get(next.pane.id)?.focus();
  };
  const active = offered.find((entry) => entry.pane.id === selected) ?? offered[0];
  return (
    <section className="wf-run-section wf-run-record">
      <div className="workflow-tabs" role="tablist" aria-label="Run record">
        {offered.map(({ pane }, index) => (
          <Tooltip key={pane.id} label={pane.hint}>
            <button
              type="button"
              role="tab"
              id={runRecordTabId(pane.id)}
              aria-selected={pane.id === selected}
              aria-controls={runRecordPaneId(pane.id)}
              // Roving tabindex: one stop for the whole bar, and the arrows move within it.
              tabIndex={pane.id === selected ? 0 : -1}
              className={pane.id === selected ? "active" : ""}
              ref={(node) => {
                if (node) tabs.current.set(pane.id, node);
                else tabs.current.delete(pane.id);
              }}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              onClick={() => select(pane.id)}
            >
              {pane.label}
              {(pane.count !== null || pane.blocking) && (
                // Amber ONLY when something in there stops the run. A count is not an attention
                // fact, which is the same call `RunsKindTabs` made about its own run counts.
                //
                // `!` is the fallback for a pane that blocks over something it cannot count -
                // a corrupt context is one unreadable record, not "one" of anything - and it
                // reaches the accessible name rather than being a colour nobody can hear.
                <span className={pane.blocking ? "workflow-tab-badge" : "wf-run-tab-count"}>
                  {pane.count ?? "!"}
                </span>
              )}
            </button>
          </Tooltip>
        ))}
      </div>
      {active && (
        <div
          className="wf-run-pane"
          role="tabpanel"
          id={runRecordPaneId(active.pane.id)}
          aria-labelledby={runRecordTabId(active.pane.id)}
        >
          {active.content}
        </div>
      )}
    </section>
  );
}

/** One labelled number in a pane's stat strip. */
function RunStat({
  label,
  value,
  tone = null,
}: {
  label: string;
  value: string | number;
  /** `alert` for a number that stops the run, `ok` for one that says it did not. */
  tone?: "alert" | "ok" | null;
}): React.JSX.Element {
  return (
    <div className="wf-run-stat">
      <span className="wf-run-stat-key">{label}</span>
      <strong className={tone ? `wf-run-stat-value is-${tone}` : "wf-run-stat-value"}>
        {value}
      </strong>
    </div>
  );
}

/**
 * Every packet this run sent, as a ledger.
 *
 * This section was four cards of exactly 560px each - 2,331px on the run this was measured
 * against, of which the payloads were already the capped part. The cost was the card: a
 * five-field definition list and a state sentence before the payload started, per packet, so
 * ten deliveries would have cost 5,600px without one extra character of payload. The fields
 * are all still here; they moved behind the row's own disclosure.
 *
 * What does NOT move behind a disclosure is a refused or uncertain packet. Its sentence, its
 * durable error and its recovery buttons sit open under the row, because the run is stopped on
 * exactly that and a control a reader has to go looking for is a control that was hidden.
 */
function DeliveriesPane({
  detail,
  summary,
  viewedRound,
  sessionBound,
  isActionPending,
  onConfirm,
  onRetryDelivery,
  onResolveDelivery,
}: {
  detail: WorkflowRunDetail;
  summary: RunRecordDeliverySummary;
  /** The round the scrubber is on, so the ledger can open on it. `null` shows every row. */
  viewedRound: number | null;
  sessionBound: boolean;
  isActionPending: (id: RunActionId) => boolean;
  onConfirm: (request: WorkflowConfirmRequest) => void;
  onRetryDelivery: (deliveryId: string) => Promise<void>;
  onResolveDelivery: (
    deliveryId: string,
    resolution: "mark_delivered" | "discard_and_new_round",
    confirmation?: string,
  ) => Promise<void>;
}): React.JSX.Element {
  /*
   * EVERY round by default, with the viewed round one click away - which is the opposite of
   * what the phase document proposed, and the repository is why.
   *
   * A delivery is not scoped to the round being read. This file's own rule, and the sentence
   * the scrubber prints when an older round is selected, both say so: "the Inspector gate,
   * deliveries and every recovery action are always the live run's". Opening this ledger
   * pre-filtered would answer "did the packets reach the session" with the packets of one
   * round - and on the common case, a reader scrubbed back to round 1 of a three-round run,
   * it would answer with an EMPTY table under a tab labelled 4.
   *
   * So the ledger is the whole ledger, each row carrying the round it belongs to, and the
   * narrowing is offered rather than assumed. The mockups drew it this way too.
   */
  const [thisRoundOnly, setThisRoundOnly] = useState(false);
  const [openPacket, setOpenPacket] = useState<string | null>(null);
  const roundOf = (submissionId: string): number | null =>
    detail.submissions.find((submission) => submission.id === submissionId)?.round ?? null;
  // A refused or uncertain packet forces the whole ledger open: a refusal in an unread round
  // is exactly the thing that must not hide behind a filter.
  const scoped = viewedRound !== null && thisRoundOnly && !summary.blocking;
  const rows = scoped
    ? detail.deliveries.filter((delivery) => roundOf(delivery.submissionId) === viewedRound)
    : detail.deliveries;
  const labelOf = (delivery: WorkflowDelivery): string => {
    const submission = detail.submissions.find((entry) => entry.id === delivery.submissionId);
    return submission ? submissionRoundLabel(detail, submission) : "Round unknown";
  };
  return (
    <>
      <div className="wf-run-strip">
        <RunStat label="Delivered" value={summary.delivered} tone={summary.delivered > 0 ? "ok" : null} />
        <RunStat label="Refused" value={summary.refused} tone={summary.refused > 0 ? "alert" : null} />
        <RunStat
          label="Uncertain"
          value={summary.uncertain}
          tone={summary.uncertain > 0 ? "alert" : null}
        />
        <RunStat
          label="Newest"
          value={summary.newestDeliveredAt === null
            ? "none confirmed"
            : new Date(summary.newestDeliveredAt).toLocaleTimeString()}
        />
      </div>
      {scoped ? (
        <p className="wf-run-meta">
          {`Showing round ${viewedRound}'s ${rows.length} of ${detail.deliveries.length} packets. `}
          <Tooltip label="Show every packet this run has sent, in every round">
            <button className="btn btn-ghost" onClick={() => setThisRoundOnly(false)}>
              Show every round
            </button>
          </Tooltip>
        </p>
      ) : viewedRound !== null && summary.inViewedRound < detail.deliveries.length && (
        <p className="wf-run-meta">
          {`Showing all ${detail.deliveries.length} packets, every round. `}
          {summary.blocking
            ? "A refused or uncertain packet keeps the whole ledger open."
            : (
              <Tooltip label="Show only the packets belonging to the round being read">
                <button className="btn btn-ghost" onClick={() => setThisRoundOnly(true)}>
                  Show round {viewedRound} only
                </button>
              </Tooltip>
            )}
        </p>
      )}
      <div className="wf-run-table wf-run-ledger">
        <table>
          <caption className="sr-only">Packets this run sent to the session</caption>
          <thead>
            <tr>
              <th>Round</th>
              <th>Kind</th>
              <th>State</th>
              <th>Delivered</th>
              <th>Payload</th>
              <th>Size</th>
              <th>Packet</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((delivery) => {
              const view = deliveryStateView(delivery.state);
              const open = openPacket === delivery.id;
              const alarming = delivery.state === "refused" || delivery.state === "uncertain";
              return (
                <Fragment key={delivery.id}>
                  <tr className={`wf-run-ledger-row is-${delivery.state}`}>
                    <td>{labelOf(delivery)}</td>
                    <td>{deliveryKindLabel(delivery.kind)}</td>
                    <td>
                      <span className={`workflow-chip workflow-${
                        delivery.state === "delivered" ? "passed"
                          : alarming ? "failed" : "waiting"}`}>
                        {view.label}
                      </span>
                    </td>
                    <td>{delivery.deliveredAt ? when(delivery.deliveredAt) : "not confirmed"}</td>
                    <td><code>{delivery.payloadSha256.slice(0, 16)}</code></td>
                    <td>
                      {delivery.payloadPrunedAt
                        ? "pruned"
                        : `${delivery.payload.length.toLocaleString()} ch`}
                    </td>
                    <td>
                      <Tooltip label={open
                        ? "Hide this packet's payload and transition record"
                        : "Show this packet's exact payload and its transition record"}>
                        <button
                          className="btn btn-ghost wf-run-ledger-toggle"
                          aria-expanded={open}
                          aria-controls={`wf-run-packet-${delivery.id}`}
                          onClick={() => setOpenPacket(open ? null : delivery.id)}
                        >
                          {open ? "Hide packet" : "Show packet"}
                        </button>
                      </Tooltip>
                    </td>
                  </tr>
                  {/* Never behind the disclosure: this is why the run is standing still. */}
                  {alarming && (
                    <tr className="wf-run-ledger-alert">
                      <td colSpan={7}>
                        <p className="wf-run-sentence">{view.sentence}</p>
                        <ErrorLine raw={delivery.error} />
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
                                <Tooltip key={action.id} label={runActionTooltip(action, pending)}>
                                  <button
                                    className={action.confirm.danger ? "btn btn-danger-ghost" : "btn"}
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
                      </td>
                    </tr>
                  )}
                  {open && (
                    <tr className="wf-run-ledger-detail" id={`wf-run-packet-${delivery.id}`}>
                      <td colSpan={7}>
                        {!alarming && <p className="wf-run-sentence">{view.sentence}</p>}
                        {!alarming && <ErrorLine raw={delivery.error} />}
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
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}


/**
 * Every frozen image body for one submission, fetched once and shared by everything that draws it.
 *
 * This replaces a per-thumbnail fetch, and the reason is the feature rather than tidiness: the
 * same picture is now drawn in three places at once - its card in the strip, a small copy on
 * every claim row that cites it, and the preview - and three components each owning a `fetch`
 * and an object URL would pull the same body down three times and paint three decodes of it.
 *
 * WHAT STARTS A FETCH also moved, and this is the part that had to change. The old ledger
 * observed each frame scrolling into view. That cannot survive the move into a pane: the tab
 * container sits well below the pipeline, so a reader who selects Evidence is looking at a pane
 * whose strip is under the fold, and an intersection trigger leaves every thumbnail saying
 * "Loading image…" until they scroll - which is the exact defect this phase exists to remove.
 *
 * So the trigger is the pane itself being rendered, and there is no observer at all. The phase
 * document proposed keeping one for a long strip, and the repository says there cannot be one:
 * `WORKFLOW_IMAGE_LIMITS.maxCount` is 8 and `WorkflowContextSnapshotSchema` caps the frozen
 * array at the same number, carried-forward records included. Withholding at most eight small
 * bodies inside a pane somebody deliberately opened buys nothing and costs the thing the pane
 * is for.
 *
 * Revoking is the owner's job and the owner is this hook: every URL it created is released when
 * the pane unmounts, which is the same commit that destroys every consumer of them.
 */
/** A resolved body, either way. An image with no entry yet has not answered. */
export interface FrozenImageBody {
  url: string | null;
  error: string | null;
}

function useFrozenImageBodies(
  runId: string,
  images: readonly WorkflowEvidenceImage[],
): ReadonlyMap<string, FrozenImageBody> {
  const [bodies, setBodies] = useState<ReadonlyMap<string, FrozenImageBody>>(() => new Map());
  const started = useRef(new Set<string>());
  const urls = useRef<string[]>([]);
  const alive = useRef(true);
  /*
   * A pruned body is not a failure and there is nothing to ask the daemon for; the frame says so
   * on its own. The ids are joined into ONE string rather than passed as an array because
   * `images` is a fresh array on any render that resolved it through a `?? []` - a dependency on
   * the array itself would restart this effect on every commit, which is a re-entrant fetch loop
   * rather than a re-render.
   */
  const retained = images
    .filter((image) => image.availability === "retained")
    .map((image) => image.id)
    .join(",");
  // `started` is what makes a request happen once, and the map below holds only ANSWERS, so a
  // frame with no entry is one still waiting - there is no third state to keep in step. Both
  // rules live in `startFrozenImageLoads`, which has its own cases.
  useEffect(() => startFrozenImageLoads({
    runId,
    // `filter(Boolean)` rather than a guard: `"".split(",")` is `[""]`, and an id of the empty
    // string is not an id. The empty case then needs no branch of its own.
    retained: retained.split(",").filter(Boolean),
    started: started.current,
    ...BROWSER_IMAGE_SERVICES,
    isAlive: () => alive.current,
    keepUrl: (url) => urls.current.push(url),
    onLoaded: (id, url) => setBodies((now) => new Map(now).set(id, { url, error: null })),
    onFailed: (id, error) => setBodies((now) => new Map(now).set(id, { url: null, error })),
  }), [retained, runId]);
  useEffect(() => frozenImageBodiesLifecycle({
    alive,
    urls,
    started,
    revokeObjectURL: BROWSER_IMAGE_SERVICES.revokeObjectURL,
  }), []);
  return bodies;
}

/**
 * One frozen image in a frame, in whichever of its four states it is actually in.
 *
 * A pruned record keeps its frame and says so, rather than becoming a broken-image icon that
 * reads as "the page is broken" beside a card whose every other field is intact. That arm and
 * the error arm are both carried over from the ledger this replaces.
 */
export function FrozenImageFrame({
  image,
  body,
  className,
  alt,
  ...rest
}: {
  image: WorkflowEvidenceImage;
  body: FrozenImageBody | undefined;
  className: string;
  /** Empty where the picture sits beside text that already names it. */
  alt: string;
  /*
   * Everything else lands on the frame element itself, which is what lets `Tooltip` wrap one:
   * it clones its child and merges `aria-describedby` and its hover handlers onto it, and a
   * component that swallowed them would take the tooltip with them.
   */
} & React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span className={className} {...rest}>
      {image.availability === "pruned" ? (
        <span className="wf-image-pruned" aria-label={`${image.displayName} body pruned`}>
          Body pruned
        </span>
      ) : body?.url ? (
        <img src={body.url} alt={alt} />
      ) : body?.error ? (
        <span className="wf-image-error" role="alert">{body.error}</span>
      ) : (
        <span className="wf-image-loading">Loading image…</span>
      )}
    </span>
  );
}

/** The restage action's whole state, so the strip and the preview cannot disagree about it. */
export interface RestageControl {
  offered: (image: WorkflowEvidenceImage) => boolean;
  /** The image ids with a staging request in flight. Two can overlap. */
  busy: ReadonlySet<string>;
  settled: ReadonlySet<string>;
  run: (image: WorkflowEvidenceImage) => void;
  /**
   * Why staging each image was refused, keyed by image id.
   *
   * Per image rather than one pane-wide value, because two surfaces read it for two different
   * images - the preview for the one it is showing, the strip card for its own - and because a
   * press on one image must not erase what the daemon said about another.
   */
  failures: ReadonlyMap<string, string>;
}

/**
 * One frozen image at full size, over whatever was on screen.
 *
 * The shape is `AttachmentPreview`'s, deliberately: `Overlay` with `.modal attach-preview`, a
 * `.modal-head` carrying the name and an autofocused close control, and a
 * `.modal-body attach-preview-body` whose own dark backdrop is what keeps a dark screenshot's
 * edges visible against the panel. Escape, the close control and the backdrop all dismiss it,
 * and Escape closes THIS layer only.
 *
 * Two things differ from the dispatch case and both are forced by the data. The dispatch
 * preview paints a blob already in memory; this one shows the body the strip already fetched,
 * so opening it costs no second request. And a frozen image has a caption, an item id, a scope,
 * a MIME type, a size, an availability, a digest and a re-stage action that a dropped file does
 * not - all of which used to be printed on a ledger card. They move into the footer, which is
 * what lets the strip stay scannable without a single field being dropped.
 *
 * Nothing here re-declares a horizontal inset. `.modal` owns `--modal-inset` and `.modal-head`,
 * `.modal-body` and `.modal-foot` already apply it.
 */
export function FrozenImagePreview({
  image,
  body,
  scopeLabel,
  clientItemId,
  citation,
  restage,
  onClose,
}: {
  image: WorkflowEvidenceImage;
  body: FrozenImageBody | undefined;
  scopeLabel: string;
  /** The author's own id for this evidence, when the reconciliation resolved one. */
  clientItemId: string | null;
  citation: string | null;
  restage: RestageControl;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Overlay
      id={OVERLAY_IDS.workflowEvidenceImage}
      onClose={onClose}
      className="modal attach-preview wf-image-preview"
      role="dialog"
      ariaModal
      ariaLabel={`Preview of ${image.displayName}`}
    >
      <header className="modal-head">
        <strong className="attach-preview-name">{image.displayName}</strong>
        <Tooltip label="Close the preview (Escape)">
          <button type="button" className="icon-btn" aria-label="Close" autoFocus onClick={onClose}>
            ✕
          </button>
        </Tooltip>
      </header>
      <div className="modal-body attach-preview-body">
        {image.availability === "pruned" ? (
          // The footer carries the date and what survives pruning; this frame only has to
          // explain why there is no picture in it.
          <span className="wf-image-pruned" role="status">Body pruned</span>
        ) : body?.url ? (
          // Named, not decorative: in the strip the picture sits beside a caption that reads
          // it out, and here it IS the content of the dialog.
          <img className="attach-preview-image" src={body.url} alt={image.caption} />
        ) : body?.error ? (
          <span className="wf-image-error" role="alert">{body.error}</span>
        ) : (
          <span className="wf-image-loading">Loading image…</span>
        )}
      </div>
      <footer className="modal-foot">
        <p className="wf-image-preview-caption">{image.caption}</p>
        <dl className="wf-run-facts-list">
          {/* Two identifier spaces, named apart rather than folded into one row: `Item` is the
              author's own id, the one their claims cite and the only one that means anything
              outside this run, and it is absent when the reconciliation resolved none. `Evidence
              id` is the daemon's durable row, which is what the body route and the audit trail
              are keyed on. */}
          <div>
            <dt>Item</dt>
            <dd>{clientItemId ? <code>{clientItemId}</code> : "not resolved to a claim"}</dd>
          </div>
          <div><dt>Evidence id</dt><dd><code>{image.id}</code></dd></div>
          <div><dt>Scope</dt><dd>{scopeLabel}</dd></div>
          <div><dt>Type</dt><dd>{image.mimeType}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(image.bytes)}</dd></div>
          <div><dt>Availability</dt><dd>{image.availability}</dd></div>
          <div><dt>Digest</dt><dd><code>{image.sha256}</code></dd></div>
        </dl>
        {image.availability === "pruned" && (
          <p className="wf-run-pruned">
            Raw body pruned {image.prunedAt ? when(image.prunedAt) : "by retention policy"}.
            Caption, scope, MIME, size, and SHA-256 remain auditable.
          </p>
        )}
        {image.inheritedFrom && (
          <p className="wf-run-pruned">
            Carried forward from round {image.inheritedFrom.round}. These exact bytes were
            captured for an earlier submission of this run, and the submission that captured
            them is where they can be staged again.
          </p>
        )}
        {/* IN THE DIALOG, beside the button that produced it. This is the only place a re-stage
            can be pressed from, and this dialog draws a backdrop over the pane, so an error
            painted onto the pane behind it is an explanation the operator cannot read without
            first closing the thing they were acting in. */}
        {restageErrorFor(restage.failures, image.id) && (
          <p className="wf-run-error" role="alert">
            {restageErrorFor(restage.failures, image.id)}
          </p>
        )}
        <div className="wf-image-preview-actions">
          {restage.offered(image) && (
            <Tooltip label="Stage these exact retained bytes, caption, and scope for the next fresh review">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={restageDisabled(
                  restage.busy.has(image.id),
                  restage.settled.has(image.id),
                )}
                onClick={() => restage.run(image)}
              >
                {restageLabel(restage.settled.has(image.id))}
              </button>
            </Tooltip>
          )}
          {citation && <span className="wf-run-meta">{citation}.</span>}
        </div>
      </footer>
    </Overlay>
  );
}

/**
 * What this submission proved, and what it did not: readiness, coverage, reconciliation and the
 * frozen pictures, in one pane.
 *
 * Two sections became one. They measured 1,420px between them and read as near-duplicates on a
 * submission where nothing was wrong, because on THAT submission every author claim matched a
 * canonical criterion and the two card lists said the same thing twice. They are not duplicates
 * where it matters: on a submission with gaps, five of six canonical criteria can have no author
 * claim at all, and there is no claim row for such a criterion to hang under. So the
 * reconciliation keeps a block of its own, at the top, named as what it is.
 *
 * The part that is new rather than rewritten is the pictures. A frozen image used to be
 * reachable only by scrolling past the deliveries into a section of its own, and its link to
 * the claim it proved was a bare `clientItemId` in a chip that a reader had to match by eye.
 * Now it is a thumbnail above the claims, a small copy on every claim row citing it, and one
 * click from full size.
 */
function EvidencePane({
  runId,
  summary,
  images,
  coverage,
  readiness,
  enforced,
  scopeOptions,
  canRestage,
  overrideReason,
  onRestage,
  onRetry,
  onOverride,
  recovery,
  onRecover,
}: {
  runId: string;
  summary: RunRecordEvidenceSummary;
  images: readonly WorkflowEvidenceImage[];
  coverage: readonly WorkflowEvidenceCoverageClaim[];
  readiness: WorkflowEvidenceReadinessResult | null | undefined;
  enforced: boolean;
  scopeOptions: readonly { value: string; label: string }[];
  canRestage: boolean;
  overrideReason: string | null;
  onRestage?: (image: WorkflowEvidenceImage, clientItemId: string) => Promise<void>;
  onRetry?: () => Promise<void>;
  onOverride?: (reason: string) => Promise<void>;
  recovery?: WorkflowRunDetail["evidenceRecovery"];
  onRecover?: (submissionId: string) => Promise<void>;
}): React.JSX.Element {
  const bodies = useFrozenImageBodies(runId, images);
  const [preview, setPreview] = useState<string | null>(null);
  const returnFocus = useRef<FocusBookmark | null>(null);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"retry" | "override" | null>(null);
  const [restageBusy, setRestageBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [restaged, setRestaged] = useState<ReadonlySet<string>>(() => new Set());
  const [restageFailures, setRestageFailures] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const itemIds = useRef(new Map<string, string>());
  const citations = runEvidenceCitations({ images, coverage, readiness });
  const scopeLabel = (scope: string): string =>
    scopeOptions.find((option) => option.value === scope)?.label ?? scope;
  const gapCriteria = readinessGapCriteria(readiness);
  const previewImage = images.find((image) => image.id === preview) ?? null;
  const citationOf = (image: WorkflowEvidenceImage): string | null =>
    evidenceCitationSentence(citations.citationFor(image.id));

  // Whatever had focus when the preview was asked for, so closing puts it back - in practice
  // the card itself, which both routes focus before they fire. The round trip is
  // `openPreview`/`closePreview`, which have their own cases.
  const open = (image: WorkflowEvidenceImage): void => openPreview({
    imageId: image.id,
    bookmark: returnFocus,
    capture: () => captureFocusBookmark(document.activeElement),
    show: (imageId) => setPreview(imageId),
  });
  const close = (): void => void closePreview({
    bookmark: returnFocus,
    hide: () => setPreview(null),
    restore: restoreFocusBookmark,
  });
  /*
   * A carried record offers no restage button of its own. It is the same digest the capturing
   * submission already offers, so a second button would stage the same bytes twice over and
   * imply this submission captured them itself.
   */
  const restage: RestageControl = {
    offered: (image) => restageOffered(image, canRestage, Boolean(onRestage)),
    busy: restageBusy,
    settled: restaged,
    failures: restageFailures,
    run: (image) => restagePress({
      image,
      minted: itemIds.current,
      onRestage,
      // Both setters close over THIS image, so a press reports only its own outcome. The
      // controller speaks in "started" and "finished" and does not know there are others.
      setBusy: (id) => setRestageBusy((now) => withRestageBusy(now, image.id, id !== null)),
      setError: (message) =>
        setRestageFailures((now) => withRestageFailure(now, image.id, message)),
      settle: (imageId) => setRestaged((current) => new Set(current).add(imageId)),
    }),
  };

  return (
    <>
      <div className="wf-run-strip">
        <RunStat
          label="Readiness"
          value={summary.status ? evidenceCodeLabel(summary.status) : "not evaluated"}
          /*
           * Amber on a verdict a reader should act on, which is a WIDER set than the amber
           * badge on the tab: `gaps` on a run that is still moving has not stopped anything,
           * so it never seizes the reader's attention from the bar - but inside the pane it is
           * the headline, and printing it in the same neutral ink as "ready" would bury it.
           * `overridden` is settled by a human and stays neutral.
           */
          tone={summary.status === "ready"
            ? "ok"
            : summary.status === "gaps" || summary.status === "unavailable" ? "alert" : null}
        />
        <RunStat label="Author claims" value={summary.claimCount} />
        <RunStat
          label="Gaps"
          value={summary.gapCount}
          tone={summary.gapCount > 0 ? "alert" : null}
        />
        <RunStat label="Warnings" value={summary.warningCount} />
        <RunStat
          label="Images"
          value={summary.imageCount}
          tone={summary.imageCount > 0 ? "ok" : null}
        />
      </div>
      <p className="wf-run-meta">{enforced
        ? "Structural only. Test Evidence Auditor still judges whether the proof is relevant and sufficient."
        : "Advisory only. This result did not block workflow execution."}</p>
      {readiness?.status === "unavailable" && (
        <p className="wf-run-error" role="alert">
          Unavailable: {readiness.unavailableReason
            ?? "Context compaction did not return canonical criteria."}
        </p>
      )}
      {overrideReason && (
        <p className="wf-run-notice" role="status">
          Operator continued despite gaps: {overrideReason}
        </p>
      )}
      {gapCriteria.length > 0 && (
        <section className="wf-evidence-gaps" aria-label="Unmatched canonical criteria">
          <h5>What the reconciliation could not match</h5>
          <p className="wf-run-meta">
            These are canonical criteria, not author claims. A criterion with no claim at all has
            no row below to sit under, which is why they are named here.
          </p>
          {gapCriteria.map((criterion) => (
            <div className="wf-evidence-gap-row" key={criterion.criterionId}>
              <span className="wf-evidence-gap-text">{criterion.criterion}</span>
              <span className="wf-evidence-gap-codes">
                {criterion.gaps.map((gap) => (
                  <span className="workflow-chip workflow-failed" key={gap}>
                    {evidenceCodeLabel(gap)}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      )}
      {summary.blocking && onOverride && (
        <div className="wf-readiness-override" role="region" aria-label="Evidence readiness override">
          <h5>Continue despite gaps</h5>
          {summary.refinementsExhausted && (
            <p className="wf-run-notice" role="status">
              This round has spent its evidence preflight refinements without closing these gaps,
              so the run is blocked for you rather than refining again. Continue despite gaps to
              review this packet as it stands, or start a new round.
            </p>
          )}
          <label>
            Reason
            <textarea
              value={reason}
              maxLength={WORKFLOW_LIMITS.readinessOverrideReason}
              placeholder="Why this structurally incomplete packet should continue"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className="wf-checkbox-label">
            <Tooltip label="Acknowledge that readiness gaps remain visible to the Test Evidence Auditor">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
            </Tooltip>
            Test Evidence Auditor may still reject this packet.
          </label>
          <div className="wf-run-actions">
            {onRetry && (
              <Tooltip label="Capture newly staged evidence and evaluate this round again">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy !== null}
                  onClick={() => void runReadinessAction("retry", onRetry, setBusy)}
                >
                  {readinessActionLabel("retry", busy)}
                </button>
              </Tooltip>
            )}
            <Tooltip label="Record this reason and continue the current submission despite readiness gaps">
              <button
                type="button"
                className="btn"
                disabled={readinessOverrideDisabled(busy, acknowledged, reason)}
                onClick={() => void runReadinessAction(
                  "override",
                  () => onOverride(reason.trim()),
                  setBusy,
                )}
              >
                {readinessActionLabel("override", busy)}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {recovery && onRecover && (
        <section className="wf-run-section" aria-label="Evidence recovery">
          <h4>Evidence recovery</h4>
          <p>Retry with this submission's frozen evidence and criteria in a new segment of the same round. Earlier reviews remain available.</p>
          {recovery.kind === "review" && <p>Inspect the prior finding before re-reviewing. Structural readiness does not establish substantive correctness; legacy finding reasons may be unknown.</p>}
          <Tooltip label="Retry with the frozen evidence in a new segment without spending an author repair">
            <button type="button" className="btn btn-ghost" onClick={() => void onRecover(recovery.submissionId)}>{recovery.label}</button>
          </Tooltip>
        </section>
      )}
      <h5 className="wf-evidence-head">Frozen images</h5>
      {images.length === 0 ? (
        <p className="wf-run-empty">No image evidence was attached to this submission.</p>
      ) : (
        <>
          <div className="wf-evidence-strip">
            {images.map((image) => {
              const citation = citations.citationFor(image.id);
              const sentence = citationOf(image);
              return (
                /*
                 * A SINGLE click, which is deliberately not what `AttachmentStrip` does.
                 *
                 * That strip opens on double-click because a single click there would land the
                 * second click of a double on the backdrop that has just appeared. An evidence
                 * thumbnail has no second gesture competing for the single click, and the ask
                 * is that clicking a thumbnail opens it. The `detail === 0` route is kept, so
                 * Enter, Space and a synthesised activation still open it too.
                 */
                <Tooltip
                  key={image.id}
                  label={`${image.displayName} - click to open it full size`}
                >
                  <button
                    type="button"
                    className={`wf-evidence-card is-${image.availability}`}
                    aria-label={`Preview ${image.displayName}`}
                    onClick={() => open(image)}
                  >
                    <FrozenImageFrame
                      image={image}
                      body={bodies.get(image.id)}
                      className="wf-image-frame"
                      alt=""
                    />
                    <span className="wf-evidence-card-meta">
                      <strong>{image.displayName}</strong>
                      <span className="wf-evidence-card-caption">{image.caption}</span>
                      <span className="wf-evidence-card-facts">
                        {citation.clientItemId && <><code>{citation.clientItemId}</code>{" · "}</>}
                        {scopeLabel(image.repositoryScope)}
                        {` · ${formatBytes(image.bytes)}`}
                        {image.inheritedFrom ? ` · from round ${image.inheritedFrom.round}` : ""}
                      </span>
                      {sentence && <span className="wf-evidence-card-cite">{sentence}</span>}
                      {/* On the CARD, because a press outlives the dialog it was made in. An
                          operator who closes the preview before the request settles would
                          otherwise be told nothing at all, and walk away believing these bytes
                          are queued for the next review when the daemon refused them. */}
                      {restage.busy.has(image.id) && (
                        <span className="wf-evidence-card-restage">Staging…</span>
                      )}
                      {restageErrorFor(restage.failures, image.id) && (
                        <span className="wf-evidence-card-restage is-alert" role="alert">
                          Re-stage failed
                        </span>
                      )}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
          {/* The action is named only where it exists. On history no session can stage from -
              which is most of the runs list - promising a control the dialog will not offer
              sends a reader looking for it. */}
          <p className="wf-run-meta">
            Click a thumbnail to open it full size. Caption, item id, scope, MIME type, size,
            availability and SHA-256 are in that dialog
            {images.some((image) => restage.offered(image))
              ? ", with Use in next review."
              : "."}
          </p>
        </>
      )}
      <h5 className="wf-evidence-head">Frozen author claims</h5>
      {coverage.length === 0 ? (
        <p className="wf-run-empty">
          No acceptance criterion coverage was frozen for this submission.
        </p>
      ) : (
        <div className="wf-evidence-claims">
          {coverage.map((claim) => {
            const status = evidenceClaimStatus(claim, readiness);
            const cited = citations.byClaim.get(claim.clientCriterionId) ?? [];
            return (
              <div className="wf-evidence-claim" key={claim.clientCriterionId}>
                <div className="wf-evidence-claim-body">
                  <span className="wf-evidence-claim-text">{claim.criterion}</span>
                  <span className="wf-evidence-claim-facts">
                    {evidenceCodeLabel(claim.proofClass)}
                    {` · ${claim.repositoryScope}`}
                    {claim.links.length === 0 ? " · no evidence linked" : ""}
                    {claim.links.map((link) => (
                      <code key={`${link.clientItemId}:${link.role}`}>{link.clientItemId}</code>
                    ))}
                    {status.notes.length > 0 && (
                      <span className="wf-evidence-claim-note">{status.notes.join(", ")}</span>
                    )}
                  </span>
                </div>
                <div className="wf-evidence-claim-side">
                  {/* The point of a screenshot as evidence is that it can be seen BESIDE the
                      claim it proves. `alt=""`, because the row already names the claim these
                      pictures are under; which picture each one IS comes from the tooltip. */}
                  {cited.map((image) => (
                    /* `Tooltip`, not a `title` attribute, which this codebase does not use and
                       pins a test against. It also does the job better here: the label is
                       always rendered into a hidden node the frame points `aria-describedby`
                       at, so this 34px copy IS named in the accessible tree even though its
                       `alt` is empty - which is the only way a reader who cannot see it can
                       tell which of four screenshots the row is carrying. */
                    <Tooltip key={image.id} label={image.displayName}>
                      <FrozenImageFrame
                        image={image}
                        body={bodies.get(image.id)}
                        className="wf-evidence-mini"
                        alt=""
                      />
                    </Tooltip>
                  ))}
                  <span className={`workflow-chip workflow-${status.tone}`}>{status.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {readiness && readiness.criteria.length > 0 && (
        <RunDisclosure
          title="Canonical reconciliation"
          meta={`${readiness.criteria.length} criteria · ${readiness.evaluatorVersion}`}
          tooltip="Show every canonical criterion, what it matched, and the evidence it resolved to"
        >
          {readiness.criteria.map((criterion) => (
            <article key={criterion.criterionId} className="wf-run-card">
              <header className="wf-run-card-head">
                <strong>{criterion.criterion}</strong>
                <span>{criterion.material ? "material" : "supporting"}</span>
              </header>
              {criterion.gaps.length > 0 && (
                <p className="wf-run-error">
                  Gaps: {criterion.gaps.map(evidenceCodeLabel).join(", ")}
                </p>
              )}
              {criterion.warnings.length > 0 && (
                <p className="wf-run-notice">
                  Warnings: {criterion.warnings.map(evidenceCodeLabel).join(", ")}
                </p>
              )}
              <div className="wf-evidence-links">
                {criterion.links.map((link) => (
                  <span
                    className="workflow-chip workflow-completed"
                    key={`${link.evidenceId}:${link.role}`}
                  >
                    {evidenceCodeLabel(link.role)}: {link.clientItemId}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </RunDisclosure>
      )}
      {previewImage && (
        <FrozenImagePreview
          image={previewImage}
          body={bodies.get(previewImage.id)}
          scopeLabel={scopeLabel(previewImage.repositoryScope)}
          clientItemId={citations.citationFor(previewImage.id).clientItemId}
          citation={citationOf(previewImage)}
          restage={restage}
          onClose={close}
        />
      )}
    </>
  );
}

/**
 * One human decision, as a row that opens.
 *
 * The submitted decision, and the largest single win on the page: nine of these rendered as
 * flowing prose measured 2,996px, which was more than a third of the whole run detail below the
 * scrubber. Nothing is truncated on expansion - the row is a summary of a body that is still
 * printed in full underneath it.
 */
function CapturedDecision({ decision }: { decision: WorkflowHumanDecision }): React.JSX.Element {
  return (
    <details className="wf-run-disclosure wf-run-decision">
      <Tooltip label="Show this decision's full body and its rationale">
        <summary>
          <span className="wf-run-disclosure-title">
            {firstLineOf(decision.decision) || "(Empty decision)"}
          </span>
          <span className="wf-run-disclosure-meta">
            <code>{decision.source.kind}:{decision.source.id}</code>
            {" · "}
            {humanDecisionSummary(decision)}
          </span>
        </summary>
      </Tooltip>
      <div className="wf-run-disclosure-body">
        <p>{decision.decision}</p>
        {decision.rationale && <small>Rationale: {decision.rationale}</small>}
      </div>
    </details>
  );
}

/** A labelled disclosure whose closed state states what opening it costs. */
function RunDisclosure({
  title,
  meta,
  children,
  tooltip,
}: {
  title: string;
  meta: string;
  children: React.ReactNode;
  tooltip: string;
}): React.JSX.Element {
  return (
    <details className="wf-run-disclosure">
      <Tooltip label={tooltip}>
        <summary>
          <span className="wf-run-disclosure-title">{title}</span>
          <span className="wf-run-disclosure-meta">{meta}</span>
        </summary>
      </Tooltip>
      <div className="wf-run-disclosure-body">{children}</div>
    </details>
  );
}

/** What each provenance verdict is called on screen. `objective` never reaches here. */
const GOAL_PROVENANCE_LABELS: Record<
  Exclude<WorkflowGoalProvenanceVerdict, "objective">,
  string
> = {
  automation: "Ask looks machine-authored",
  implausible: "Ask looks too short to review against",
  unreconciled: "Ask frozen before the newest instruction was reconciled",
};

/**
 * A run that froze something other than a durable objective, said on the screen.
 *
 * Draws NOTHING for a healthy run and nothing for a run that predates the verdict. A badge on
 * the ordinary case is a badge on every run, which is how the defect behind this survived for
 * months: it was visible to anyone who queried for it and announced by nothing.
 *
 * The label is the one-word answer and the accessible name carries the whole reason, because
 * the reason names every check that matched and a chip that printed all of it would push the
 * ask it is about off the screen. `role="note"` rather than an alert: this is ancillary
 * information about a run that is running perfectly well, and it never blocks it.
 */
function GoalProvenanceBadge(
  { intent }: { intent: RunRecordIntentSummary },
): React.JSX.Element | null {
  const verdict = intent.provenanceVerdict;
  if (verdict === null || verdict === "objective") return null;
  return (
    <p className="wf-run-chiprow">
      <span
        className="workflow-chip workflow-stopped"
        role="note"
        aria-label={intent.provenanceReason ?? GOAL_PROVENANCE_LABELS[verdict]}
      >
        {GOAL_PROVENANCE_LABELS[verdict]}
      </span>
    </p>
  );
}

/**
 * What this round was trying to do, and who decided it.
 *
 * Leads with the refined goal, because that is the one sentence answering "what was this round
 * for". Everything else is a disclosure whose closed state carries its own size, so a reader
 * can tell that the original goal is 2,566 characters of repair packet before opening it.
 *
 * The three degraded arms are STATES OF THIS PANE rather than sections of their own: a round
 * that never captured a snapshot, a durable context that does not match its submission mode,
 * and a round this build cannot read are all answers to "what was the intent", and each keeps
 * the copy and the `role="alert"` it had as a section.
 */
function IntentPane({
  detail,
  intent,
  context,
  evidenceFingerprint,
}: {
  detail: WorkflowRunDetail;
  intent: RunRecordIntentSummary;
  /** The parsed snapshot. Non-null exactly when `intent.state` is `captured`. */
  context: WorkflowContextSnapshot | null;
  evidenceFingerprint: string | undefined;
}): React.JSX.Element {
  if (intent.state === "not_captured") {
    return (
      <>
        <h5>Intent and evidence not captured</h5>
        <p className="wf-run-empty">
          This submission stopped before its immutable context snapshot was recorded.
        </p>
      </>
    );
  }
  if (intent.state === "corrupt") {
    return (
      <>
        <h5>Captured intent and evidence are corrupt</h5>
        <p className="wf-run-error" role="alert">
          The durable context does not match its submission mode. Check daemon logs or restore it from backup.
        </p>
      </>
    );
  }
  if (intent.state === "unreadable" || !context) {
    return (
      <>
        <h5>Captured intent and evidence</h5>
        <p className="wf-run-error" role="alert">
          This round's captured context is not readable by this build, though the run's
          newest one is. Check daemon logs or restore it from backup.
        </p>
      </>
    );
  }
  const chip = (label: string): React.JSX.Element => (
    <span className="workflow-chip workflow-stopped" key={label}>{label}</span>
  );
  return (
    <>
      <p className="wf-run-chiprow">
        {chip(context.compaction.status === "model"
          ? `Compacted by ${context.compaction.model ?? context.compaction.runner ?? "a model"}`
          : "Deterministic fallback")}
        {chip(`HEAD ${shortSha(context.evidence.headSha) ?? "unavailable"}`)}
        {chip(`tree ${context.evidence.workingTreeDirty ? "dirty" : "clean"}`)}
        {chip(`diff ${context.evidence.diffTruncated ? "truncated" : "complete"}`)}
        {chip(`transcript ${context.evidence.transcriptTruncated ? "truncated" : "complete"}`)}
        {chip(`standards ${context.evidence.standardsTruncated ? "truncated" : "complete"}`)}
        {intent.evidencePruned && context.evidence.retention?.state === "pruned" && (
          <span className="wf-run-pruned">
            Raw evidence pruned {when(context.evidence.retention.prunedAt)}
          </span>
        )}
      </p>
      <div className="wf-run-lead">
        <p className="wf-run-meta">Refined goal</p>
        <p className="wf-run-lead-text">
          {intent.refinedGoal ?? "No refined goal was recorded for this round."}
        </p>
      </div>
      <GoalProvenanceBadge intent={intent} />
      <RunDisclosure
        title="Review contract"
        meta={`${intent.rawGoalCharacters.toLocaleString()} characters`}
        tooltip="Show the frozen objective this round reviews; historical runs retain their captured goal"
      >
        <pre>{context.primaryGoal.rawPrompt || "(No captured goal)"}</pre>
      </RunDisclosure>
      {intent.hasOpeningAsk && (
        <RunDisclosure
          title="Opening request"
          meta={`${intent.openingAskCharacters.toLocaleString()} characters`}
          tooltip="Show the human's opening request as recorded by the Goal pipeline"
        >
          <pre>{context.primaryGoal.openingAsk}</pre>
        </RunDisclosure>
      )}
      {context.primaryGoal.intentSource && (
        <p className="wf-run-meta">
          Objective version {context.primaryGoal.intentSource.objectiveVersion}
          {` · prompt revision ${context.primaryGoal.intentSource.promptRevision}`}
          {` · resolved revision ${context.primaryGoal.intentSource.resolvedPromptRevision}`}
          {` · ${context.primaryGoal.intentSource.relationship ?? "unresolved"}`}
        </p>
      )}
      {!!context.steering?.length && (
        <RunDisclosure
          title="Human steering context"
          meta={`${context.steering.length} instruction${context.steering.length === 1 ? "" : "s"}`}
          tooltip="Show frozen method, sequence and priority changes that do not move the acceptance contract"
        >
          <p>Steering does not add, remove or narrow acceptance criteria.</p>
          <p className="wf-run-meta">Frozen through resolved prompt revision {context.steeringResolvedRevision}.</p>
          {context.steering.map((note) => (
            <div key={note.revision}>
              <p className="wf-run-meta">Revision {note.revision} · <time dateTime={new Date(note.timestamp).toISOString()}>{when(note.timestamp)}</time></p>
              <pre>{note.instruction}</pre>
              <p>{note.rationale}</p>
            </div>
          ))}
        </RunDisclosure>
      )}
      <RunDisclosure
        title="Human decisions and rationale"
        meta={humanDecisionsSummary(intent)}
        tooltip="Show every decision a human recorded for this work, one row each"
      >
        {context.humanDecisions.length === 0 ? (
          <p className="wf-run-empty">None captured.</p>
        ) : context.humanDecisions.map((decision) => (
          <CapturedDecision
            key={`${decision.source.kind}:${decision.source.id}`}
            decision={decision}
          />
        ))}
      </RunDisclosure>
      {intent.acceptanceCriterionCount > 0 && (
        <RunDisclosure
          title="Acceptance criteria"
          meta={`${intent.acceptanceCriterionCount}`}
          tooltip="Show the criteria this round's evidence is judged against"
        >
          <ul>{context.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul>
        </RunDisclosure>
      )}
      {intent.constraintCount > 0 && (
        <RunDisclosure
          title="Compacted constraints"
          meta={`${intent.constraintCount}`}
          tooltip="Show the constraints the compaction carried into this round"
        >
          <ul>{context.constraints.map((item) => <li key={item}>{item}</li>)}</ul>
        </RunDisclosure>
      )}
      {context.compaction.status === "fallback" && context.compaction.error && (
        <p className="wf-run-meta">Compaction fallback: {context.compaction.error}</p>
      )}
      <details className="wf-run-disclosure">
        <Tooltip label="Show the exact repository state this review was given">
          <summary>
            <span className="wf-run-disclosure-title">Evidence snapshot</span>
            <span className="wf-run-disclosure-meta">
              {shortSha(context.evidence.headSha) ?? "no HEAD"}
              {` · ${detail.submissions.length} submission${detail.submissions.length === 1 ? "" : "s"} in this run`}
            </span>
          </summary>
        </Tooltip>
        <div className="wf-run-disclosure-body">
          <dl className="wf-run-facts-list">
            <div><dt>HEAD</dt><dd>{shortSha(context.evidence.headSha) ?? "unavailable"}</dd></div>
            <div>
              <dt>Working tree</dt>
              <dd>
                {context.evidence.workingTreeDirty ? "dirty" : "clean"}
                {context.evidence.workingTreeStatusTruncated ? " · status truncated" : ""}
              </dd>
            </div>
            <div><dt>Fingerprint</dt><dd><code>{evidenceFingerprint}</code></dd></div>
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
        </div>
      </details>
    </>
  );
}

/**
 * How this run finishes: the GitHub Inspector final gate and the Foreman completion claim.
 *
 * Two sections became one pane, and both had the same shape of problem as the other three - a
 * small amount of decisive information wrapped in a large amount of chrome. The gate was a
 * status sentence, two fact ledgers of sixteen fields between them, a findings-policy line, a
 * settings button and one CARD per finding; on the run in the mockups that was ten cards across
 * eight Inspector rounds. The claims were one card each, and four of that run's five were
 * `already_claimed` restating the same completion - five near-identical paragraphs saying what
 * one counting sentence says.
 *
 * Nothing here re-decides the gate. The Inspector's adoption, its posture, its retry schedule
 * and its completion policy are untouched; every fact those two ledgers carried is still drawn,
 * inside one disclosure, under the accessible names the specs already reach them by.
 *
 * Findings stay OUT of the Review worklist deliberately. `runChangeWorklist` is built from
 * Persona attempt verdicts only - it skips an attempt with no persona - so an Inspector finding
 * has never appeared there, and folding it in would change what that list means and what its
 * segment counts count. This pane is the one place they appear.
 */
function CompletionPane({
  detail,
  summary,
  claims,
  version,
  onOpenInspectorSettings,
}: {
  detail: WorkflowRunDetail;
  summary: RunRecordCompletionSummary;
  claims: readonly RunCompletionClaim[];
  version: WorkflowVersion | null;
  onOpenInspectorSettings: () => void;
}): React.JSX.Element {
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const gate = detail.inspectorGate;
  const spentGateCondition = spentInspectorGateCondition(detail);
  return (
    <>
      {gate && summary.gate && (
        <div className="wf-run-strip">
          <RunStat
            label="Gate"
            value={summary.gate.label}
            tone={summary.gate.tone === "passed" ? "ok" : summary.gate.tone === "failed" ? "alert" : null}
          />
          <RunStat
            label="Open findings"
            value={summary.openFindings}
            tone={summary.openFindings > 0 ? "alert" : null}
          />
          <RunStat
            label="Resolved"
            value={summary.resolvedFindings}
            tone={summary.resolvedFindings > 0 ? "ok" : null}
          />
          <RunStat
            label="Pull request"
            value={summary.pullRequest === null
              ? "not resolved"
              : `${summary.pullRequest.number === null ? "adopted" : `#${summary.pullRequest.number}`}${
                summary.pullRequest.state ? ` ${summary.pullRequest.state.toLowerCase()}` : ""}`}
          />
          <RunStat
            label="Inspector round"
            value={summary.inspectorRound ?? "not adopted"}
          />
        </div>
      )}
      {gate && (
        <>
          <p className="wf-run-sentence">{inspectorGateSentence(detail)}</p>
          <h5 className="wf-run-subhead">Findings</h5>
          {gate.findings.length === 0 ? (
            <p className="wf-run-empty">No findings are recorded for this adopted pull request.</p>
          ) : (
            <div className="wf-run-table wf-run-ledger">
              <table>
                <caption className="sr-only">
                  {spentGateCondition
                    ? "Current Inspector findings"
                    : "GitHub Inspector findings on the adopted pull request"}
                </caption>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Finding</th>
                    <th>Where</th>
                    <th>Round</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {gate.findings.map((finding) => {
                    const severity = inspectorFindingSeverityStatus(finding.severity);
                    const status = inspectorFindingStatusStatus(finding.status);
                    const open = openFinding === finding.id;
                    // An UNRESOLVED finding is why the gate has not passed, so its body is
                    // never behind a disclosure - the same rule the delivery ledger applies to
                    // a refused packet, and for the same reason: a reader should not have to go
                    // looking for the thing that stopped the run.
                    const unresolved = finding.status !== "resolved";
                    return (
                      <Fragment key={finding.id}>
                        <tr className={`wf-run-ledger-row wf-run-finding-row is-${finding.severity}`}>
                          <td>
                            <span className={`workflow-chip workflow-${severity.tone}`}>
                              {severity.label}
                            </span>
                          </td>
                          <td>{finding.title}</td>
                          <td><code>{inspectorFindingLocation(finding)}</code></td>
                          <td>{finding.round}</td>
                          <td>
                            <span className={`workflow-chip workflow-${status.tone}`}>
                              {status.label}
                            </span>
                          </td>
                          <td>
                            <Tooltip label={open
                              ? "Hide this finding's fingerprint and its timestamps"
                              : "Show the fingerprint the gate tracks this finding by, and when it moved"}>
                              <button
                                className="btn btn-ghost wf-run-ledger-toggle"
                                aria-expanded={open}
                                aria-controls={`wf-run-finding-${finding.id}`}
                                onClick={() => setOpenFinding(open ? null : finding.id)}
                              >
                                {open ? "Hide finding" : "Show finding"}
                              </button>
                            </Tooltip>
                          </td>
                        </tr>
                        {unresolved && (
                          <tr className="wf-run-ledger-alert">
                            <td colSpan={6}>
                              <p className="wf-run-sentence">{inspectorFindingBody(finding)}</p>
                            </td>
                          </tr>
                        )}
                        {open && (
                          <tr className="wf-run-ledger-detail" id={`wf-run-finding-${finding.id}`}>
                            <td colSpan={6}>
                              {/* A resolved finding's body opens here; an unresolved one is
                                  already printed above rather than twice. */}
                              {!unresolved && <p>{inspectorFindingBody(finding)}</p>}
                              <dl className="wf-run-facts-list">
                                <div><dt>Fingerprint</dt><dd><code>{finding.fingerprint}</code></dd></div>
                                <div><dt>Recorded</dt><dd>{when(finding.createdAt)}</dd></div>
                                <div><dt>Last change</dt><dd>{when(finding.updatedAt)}</dd></div>
                              </dl>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="wf-run-meta">
            Findings are not in the Review worklist - that list is built from Persona verdicts
            only - so this is the one place they appear.
          </p>
        </>
      )}
      {claims.length > 0 && (
        <>
          <h5 className="wf-run-subhead">Foreman completion claims</h5>
          <div className="wf-run-rowlist" role="list" aria-label="Foreman completion claims">
            {claims.map((claim) => (
              <div className="wf-run-rowlist-row" role="listitem" key={claim.id}>
                <div className="wf-run-rowlist-body">
                  {/*
                    * The FIRST LINE on the row, the WHOLE summary in the tooltip - and the
                    * tooltip is what keeps this from being a field dropped. `Tooltip` renders
                    * its label into a hidden node the row points `aria-describedby` at, so the
                    * paragraph is in the document and in the accessible tree whether or not
                    * anyone hovers. Five claims restating one completion differ in their first
                    * sentence and nowhere else, which is what makes the first line the right
                    * thing to print.
                    */}
                  <Tooltip label={claim.summary}>
                    <span className="wf-run-rowlist-title">{firstLineOf(claim.summary)}</span>
                  </Tooltip>
                  <span className="wf-run-rowlist-facts">
                    {claim.completionKind}
                    {" · once-only guard "}
                    <code>{claim.marker.slice(0, 12)}</code>
                  </span>
                </div>
                <span className={`workflow-chip workflow-${completionClaimStatus(claim.state).tone}`}>
                  {completionClaimStatus(claim.state).label}
                </span>
              </div>
            ))}
          </div>
          {summary.claimSentence && <p className="wf-run-meta">{summary.claimSentence}</p>}
          {/* One sentence per STATE present, not per claim. `completionClaimOutcome` gives
              every claim a sentence and the card printed it on each one, so four claims sharing
              a state printed one identical sentence four times. It is a fact about the state,
              so it is said once and the chips point at it. */}
          {completionClaimOutcomeSentences(claims).map((sentence) => (
            <p className="wf-run-meta" key={sentence}>{sentence}</p>
          ))}
        </>
      )}
      {gate && (
        <RunDisclosure
          title="Gate ledgers"
          meta={spentGateCondition
            ? "last workflow observation and current Inspector, 16 facts"
            : "the adopted pull request and its review, 9 facts"}
          tooltip="Show every fact the final gate records about the pull request and the Inspector that reviewed it"
        >
          {spentGateCondition ? (
            <div className="wf-run-gate-ledgers">
              <section className="wf-run-gate-ledger is-history" aria-label="Last workflow observation">
                <h5>Last workflow observation</h5>
                <dl className="wf-run-facts-list">
                  <div>
                    <dt>Pull request</dt>
                    <dd>
                      {gate.state.prUrl ? (
                        <Tooltip label="Open the adopted pull request on GitHub">
                          <a href={gate.state.prUrl} target="_blank" rel="noreferrer">
                            #{gate.inspection?.number ?? detail.summary.gatePrNumber ?? "unknown"}
                          </a>
                        </Tooltip>
                      ) : "not resolved"}
                    </dd>
                  </div>
                  <div><dt>Failed head</dt><dd><code>{shortSha(gate.state.failedHeadSha ?? gate.state.targetHeadSha) ?? "not pinned"}</code></dd></div>
                  <div><dt>Observed head</dt><dd><code>{shortSha(gate.state.observedHeadSha) ?? "not observed"}</code></dd></div>
                  <div><dt>Stopped on</dt><dd>{gateWaitSentence(gate.state.waitReason)}</dd></div>
                  <div><dt>Observed</dt><dd>{gate.state.lastObservedAt ? when(gate.state.lastObservedAt) : "waiting for post-entry observation"}</dd></div>
                  <div><dt>Historical findings</dt><dd>{gate.state.findingFingerprints.length}</dd></div>
                </dl>
                {gate.state.findingFingerprints.length > 0 && (
                  <ul className="wf-run-gate-fingerprints" aria-label="Historical finding fingerprints">
                    {gate.state.findingFingerprints.map((fingerprint) => {
                      const finding = gate.findings.find((row) => row.fingerprint === fingerprint);
                      return (
                        <li key={fingerprint}>
                          <span>{finding?.title ?? "Finding not present in current ledger"}</span>
                          <code>{fingerprint}</code>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="wf-run-gate-ledger is-current" aria-label="Current Inspector">
                <h5>Current Inspector</h5>
                <dl className="wf-run-facts-list">
                  <div><dt>Adopted provenance</dt><dd>{gate.inspection?.source === "hook" ? "hook" : gate.inspection?.source === "pipeline" ? "pipeline" : gate.inspection ? "legacy import" : "not adopted"}</dd></div>
                  <div><dt>Current posture</dt><dd>{gate.inspector.enabled ? gate.inspector.mode : "disabled"} · {gate.inspector.posture ?? "unknown posture"}</dd></div>
                  <div><dt>Review posture</dt><dd>{gate.inspection?.reviewPosture ?? "not reviewed"}</dd></div>
                  <div><dt>Review round</dt><dd>{gate.inspection?.round ?? 0}</dd></div>
                  <div><dt>Observed head</dt><dd><code>{shortSha(gate.inspection?.observedHeadSha) ?? "not observed"}</code></dd></div>
                  <div><dt>Reviewed head</dt><dd><code>{shortSha(gate.inspection?.headSha) ?? "not reviewed"}</code></dd></div>
                  <div><dt>Pull request state</dt><dd>{gate.inspection?.observedState ?? "not observed"}</dd></div>
                  <div><dt>Open findings</dt><dd>{gate.inspection?.openFindings ?? "unknown"}</dd></div>
                  <div><dt>Resolved findings</dt><dd>{gate.inspection?.resolvedFindings ?? "unknown"}</dd></div>
                  <div><dt>Backoff</dt><dd>{gate.inspection?.nextAttemptAt ? when(gate.inspection.nextAttemptAt) : "none"}</dd></div>
                </dl>
                <ErrorLine raw={gate.inspection?.lastError} alert />
              </section>
            </div>
          ) : (
            <>
              <dl className="wf-run-facts-list">
                <div>
                  <dt>Pull request</dt>
                  <dd>
                    {gate.state.prUrl ? (
                      <Tooltip label="Open the adopted pull request on GitHub">
                        <a href={gate.state.prUrl} target="_blank" rel="noreferrer">
                          #{gate.inspection?.number ?? detail.summary.gatePrNumber ?? "unknown"}
                        </a>
                      </Tooltip>
                    ) : "not resolved"}
                  </dd>
                </div>
                <div><dt>Adopted provenance</dt><dd>{gate.inspection?.source === "hook" ? "hook" : gate.inspection?.source === "pipeline" ? "pipeline" : gate.inspection ? "legacy import" : "not adopted"}</dd></div>
                <div><dt>GitHub Inspector</dt><dd>{gate.inspector.enabled ? gate.inspector.mode : "disabled"} · {gate.inspector.posture ?? "unknown posture"}</dd></div>
                <div><dt>Review round</dt><dd>{gate.inspection?.round ?? 0}</dd></div>
                <div><dt>Target head</dt><dd><code>{shortSha(gate.state.targetHeadSha) ?? "not pinned"}</code></dd></div>
                <div><dt>Observed head</dt><dd><code>{shortSha(gate.state.observedHeadSha) ?? "not observed"}</code></dd></div>
                <div><dt>Reviewed head</dt><dd><code>{shortSha(gate.inspection?.headSha) ?? "not reviewed"}</code></dd></div>
                <div><dt>Observed</dt><dd>{gate.state.lastObservedAt ? when(gate.state.lastObservedAt) : "waiting for post-entry observation"}</dd></div>
                <div><dt>Backoff</dt><dd>{gate.inspection?.nextAttemptAt ? when(gate.inspection.nextAttemptAt) : "none"}</dd></div>
              </dl>
              <ErrorLine raw={gate.inspection?.lastError} alert />
            </>
          )}
        </RunDisclosure>
      )}
      {gate && (
        <>
          <p className="wf-run-meta">
            Findings policy: <strong>{version?.completionPolicy.kind === "inspector"
              ? version.completionPolicy.onFindings.replaceAll("_", " ")
              : "none"}</strong>
            {" · "}Missing PR: <strong>{version?.completionPolicy.kind === "inspector"
              ? version.completionPolicy.missingPrAction.replaceAll("_", " ")
              : "wait"}</strong>
          </p>
          <Tooltip label="Open GitHub Inspector settings to review its enablement, mode, and allowlist">
            <button className="btn btn-ghost" onClick={onOpenInspectorSettings}>Open GitHub Inspector settings</button>
          </Tooltip>
        </>
      )}
    </>
  );
}

export function WorkflowRunView({
  detail,
  roundId = null,
  pane = null,
  onPane,
  onRound = () => {},
  onNextMove = () => {},
  onCancel,
  onConfirm = () => {},
  onCopyFeedback = () => {},
  onCopyRunId = () => {},
  onCopyChange,
  feedbackCopied = false,
  runIdCopied = false,
  changeCopied = false,
  onOpenFile,
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
  onRestartFull = async () => {},
  onRetryDelivery = async () => {},
  onResolveDelivery = async () => {},
  onRetryEvidenceReadiness = async () => {},
  onRecoverEvidence,
  onOverrideEvidenceReadiness = async () => {},
  onLoadEvents = async () => {},
  onLoadCalls = async () => {},
  onToggleNodesDisabled,
  onSetPersonaDirective,
  onRemovePersonaDirective,
  evidenceScopeOptions = [{ value: "repo-01", label: "Primary repository" }],
  onRestageImage,
  actionError = null,
  isActionPending = () => false,
}: {
  detail: WorkflowRunDetail;
  /** The submission being read. `null` means the newest one. */
  roundId?: string | null;
  /**
   * The pane of the run record the address bar names, or null for "let the run decide".
   *
   * Null is NOT the same as `"worklist"`: a run whose blocking state is not in the worklist
   * opens on the pane holding it, and an explicit `worklist` overrules that. A name this run
   * does not offer is ignored rather than rewritten out of the hash.
   */
  pane?: RunRecordPane | null;
  /**
   * Route to a pane. Absent on a host that does not route, in which case the tab bar keeps the
   * reader's pick in its own state - which is what makes the tabs work in a markup test.
   */
  onPane?: (pane: RunRecordPane) => void;
  onRound?: (submissionId: string) => void;
  /**
   * Dispatch the ONE move `runNextMove` derived for this run - the only run-advancing intent
   * this header offers, so the host wires one callback rather than one per control.
   *
   * The descriptor carries its own `path` and `body`, so the host sends it uniformly through the
   * shared action store. Two arms need more than that and the host owns both: the resubmission
   * family, because the page resolves the request id that keeps an unchanged resubmit inside its
   * round, and `run-again`, because the run it creates is a different one to route to.
   */
  onNextMove?: (move: RunNextMove, evidence?: WorkflowUploadEvidenceLocator[]) => void;
  onCancel: () => Promise<void>;
  /** Destructive confirmations, hosted by the overlay registry rather than `window.confirm`. */
  onConfirm?: (request: WorkflowConfirmRequest) => void;
  /**
   * Ask the host to copy. A callback rather than a `copyText()` call in here because the
   * clipboard can refuse, and the sentence saying so belongs on the page's own error surface,
   * which the host owns.
   */
  onCopyFeedback?: () => void;
  /** Copy the durable run id. Same division of labour as `onCopyFeedback`. */
  onCopyRunId?: () => void;
  /**
   * Whether each copy is inside its confirmation hold, from the host's `useCopyFeedback`.
   *
   * A PROP rather than state in here, which is what makes the `Copied` flip honest: the flag
   * and the `copyText` call it reports on now belong to one hook in the host, so a copy that
   * refused cannot flip it. This view used to hold both flags and set them after awaiting the
   * callback, which worked only as long as that callback remembered to re-throw - and then
   * swallowed the reason in a bare `catch`. `WorkflowLadder` already took `feedbackCopied`
   * this way; these two are the same arrangement.
   */
  feedbackCopied?: boolean;
  runIdCopied?: boolean;
  /**
   * Copy ONE requested change, rather than the whole repair packet the header copies.
   *
   * Its own callback for `onCopyFeedback`'s reason - the clipboard can refuse, and the sentence
   * saying so belongs on the page's error surface, which the host owns.
   */
  onCopyChange?: (text: string) => void;
  changeCopied?: boolean;
  /**
   * Reveal a cited file in the bound session's Files tab. Absent on a host with no Files
   * surface, in which case the worklist withholds the control rather than drawing a dead one.
   */
  onOpenFile?: (path: string) => void;
  onOpenSession?: () => void;
  onOpenInspectorSettings?: () => void;
  onRestartFull?: (confirmation?: string) => Promise<void>;
  onRetryDelivery?: (deliveryId: string) => Promise<void>;
  onResolveDelivery?: (
    deliveryId: string,
    resolution: "mark_delivered" | "discard_and_new_round",
    confirmation?: string,
  ) => Promise<void>;
  onRetryEvidenceReadiness?: (submissionId: string) => Promise<void>;
  onRecoverEvidence?: (submissionId: string) => Promise<void>;
  onOverrideEvidenceReadiness?: (submissionId: string, reason: string) => Promise<void>;
  onLoadEvents?: () => Promise<void>;
  onLoadCalls?: () => Promise<void>;
  /**
   * Toggle the per-run auto-pass on verdict nodes. Optional so read-only hosts render the
   * disabled set without offering the switch; the view itself withholds it once the run is
   * terminal, because a finished run can no longer be affected.
   */
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
  onSetPersonaDirective?: (nodeId: string, feedback: string, intentKey: string) => void;
  onRemovePersonaDirective?: (nodeId: string, revision: number) => void;
  evidenceScopeOptions?: readonly { value: string; label: string }[];
  onRestageImage?: (
    image: WorkflowEvidenceImage,
    clientItemId: string,
  ) => Promise<void>;
  actionError?: string | null;
  isActionPending?: (id: RunActionId) => boolean;
}): React.JSX.Element {
  const version = detail.version;
  // Declared before the scrubber rather than beside the timeline, because a continuation
  // entry names the action it came from and a published action node carries its own snapshot
  // name - so the resolver is the one thing standing between "evidence 2" and "evidence 2,
  // after Open the pull request".
  const nodeById = new Map((version?.graph.nodes ?? []).map((node) => [node.id, node]));
  // Which nodes can actually take a directive. The worklist offers "Give this reviewer
  // feedback" off a row's own node, and a row whose node is not a Persona - an older run whose
  // version no longer carries it - would otherwise open an editor with nothing to save to.
  const personaNodeIds = new Set((version?.graph.nodes ?? [])
    .filter((node) => node.kind === "persona")
    .map((node) => node.id));
  /** The guided tour's handle on the worklist. Inert unless a tour is running. */
  const tourWorklistRef = useTourTargetRef<HTMLElement>("library:run-worklist");
  const [directiveNodeId, setDirectiveNodeId] = useState<string | null>(null);
  const [worklistFocus, setWorklistFocus] = useState<{
    runId: string;
    nodeIds: readonly string[];
    sequence: number;
  } | null>(null);
  useEffect(() => setDirectiveNodeId(null), [detail.run.id]);
  const currentWorklistFocus = worklistFocus?.runId === detail.run.id ? worklistFocus : null;
  const directiveNode = directiveNodeId ? nodeById.get(directiveNodeId) : null;
  const directiveTarget = directiveNode?.kind === "persona" ? directiveNode : null;
  const activeDirective = directiveTarget
    ? (detail.run.personaDirectives ?? []).find((item) => item.nodeId === directiveTarget.id) ?? null
    : null;
  const nameOfNode = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    return node && version ? nodeLabel(version.graph, node, []) : null;
  };
  const rounds = runRounds(detail, nameOfNode);
  const roundGroups = runRoundGroups(rounds);
  const viewed = selectedSubmission(detail, roundId);
  // Which round's tray is open. Declared beside `viewed` because it IS a fact about the
  // viewed submission, not a second piece of disclosure state a reader could get out of sync.
  const openTray = openEvidenceTray(roundGroups, viewed?.id ?? null);
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
  const submissionImages = viewed
    ? detail.evidenceImages?.find((group) => group.submissionId === viewed.id)?.images ?? []
    : [];
  const submissionCoverage = viewed
    ? detail.evidenceCoverage?.find((group) => group.submissionId === viewed.id)?.coverage ?? []
    : [];
  const inspectorGate = detail.inspectorGate;
  const spentGateStatus = spentInspectorGateStatus(detail);
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
  const latestAttemptByNode = latestAttemptsFor(detail, viewed?.id ?? null);
  /*
   * Session actions leave; the Session, join and End attempts never belonged here at all - see
   * `reviewerAttempts`, which is also what keeps a queued or errored reviewer in the list.
   *
   * ONE ATTEMPT PER NODE, the newest, which is the same rule the strip above reads and for the
   * same reason: it is the only one whose state is current. A retry does not replace the row it
   * retries - `engine.ts` marks that row `error` and INSERTS a successor at `attempt + 1` in
   * the same submission - so both survive, and classifying every row put one reviewer in two
   * segments at once. A transient provider error followed by a pass on the automatic retry
   * counted as a blocker AND as a pass in the same round, which is the one thing `Blocking` may
   * not say. Nothing is hidden by this: the strip carries every node's live state, the card
   * prints which attempt it is, and the audit disclosure keeps the whole record.
   */
  const reviewAttempts = reviewerAttempts(
    [...latestAttemptByNode.values()].filter((attempt) => attempt.sessionAction === null),
    version?.graph,
  );
  /** A published graph that CANNOT produce a verdict, which is a different empty than "not yet". */
  const reviewerlessVersion = version ? !version.graph.nodes.some(isVerdictNode) : false;
  // Every pass this round carries rather than re-earns, with the round each came from. One
  // derivation for both shapes that produce them - a continuation segment and an
  // Inspector-only round - so the two cannot drift into two ways of saying "did not run here".
  const inherited = inheritedPasses(detail, viewed);
  // The wider set behind it, for rows that need the nearest recorded OUTCOME rather than a pass.
  const inheritedOutcomes = inheritedAttempts(detail, viewed);
  const statuses = nodeStatusesForSubmission(detail, viewed?.id ?? null);
  const calls = detail.llmCalls ?? [];
  const completionClaims = runCompletionClaims(detail);
  const feedbackAction = copyFeedbackAction(detail, feedbackCopied);
  /**
   * The one thing to do about this run, and the sentence for when there is nothing.
   *
   * Exactly one of the two is ever non-null - `runNoMoveReason` returns `null` whenever a move
   * exists - so the header cannot show a primary and an excuse for not having one at once.
   */
  const nextMove = runNextMove(detail);
  const noMoveReason = runNoMoveReason(detail);
  // No `!`: `inspectorGateActions` pushes `open-pr` only when there is a pull request to open,
  // so this is `undefined` on every run with no adopted one - which is most of them.
  const openPrAction = inspectorGateActions(detail)
    .find((action) => action.kind === "open-pr");
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
  const parkedSentence = runParkedSentence(detail);
  const refusedSentence = runRefusedSentence(detail);
  const refusedClaimSentence = runRefusedCompletionSentence(detail);
  /*
   * Every count and every summary sentence the tab bar and its panes print, derived once.
   *
   * The bar's labels are claims a reader acts on WITHOUT opening the pane behind them, so a
   * wrong number here is worse than the long page this replaced. They are pure selectors with
   * their own cases in `test/workflow-runs-model.test.ts`; nothing below counts anything.
   */
  const record = runRecordSummary(detail, viewed);
  // Through the worklist's own classifier rather than a second count of "things that block":
  // the label and the rail have to agree, and the label is the half nobody can check by eye.
  const worklistBlocking = runWorklistSegments(
    detail,
    viewed?.round ?? null,
    reviewAttempts,
    nameOfNode,
  ).blocking.length;
  /*
   * The grant's result, drawn and announced.
   *
   * Every other primary on this page produces something a person can see: a round starts, a
   * status changes, a section fills in. The grant produces one larger integer, and its only
   * visible consequence was the button quietly becoming a different button - which reads
   * exactly like a click that did nothing, and was reported as one.
   *
   * `runGrantNotice` is the derived, self-clearing half. This announcement is the half a
   * screen reader needs, and it fires on the TRANSITION rather than on the notice being
   * present, so arriving at an already-granted run does not read a stale result aloud.
   */
  const grantNotice = runGrantNotice(detail);
  const announcedGrant = useRef<string | null>(null);
  const [grantAnnouncement, setGrantAnnouncement] = useState("");
  useEffect(() => {
    if (announcedGrant.current === grantNotice) return;
    const first = announcedGrant.current === null;
    announcedGrant.current = grantNotice;
    if (first || !grantNotice) return;
    setGrantAnnouncement(`${grantNotice} ${parkedSentence ?? "The review can continue."}`);
  }, [grantNotice, parkedSentence]);
  return (
    <section className="wf-run-detail">
      <p className="sr-only" aria-live="assertive">{uncertainAnnouncement}</p>
      <p className="sr-only" aria-live="polite">{grantAnnouncement}</p>
      <header className="wf-run-head">
        <div className="wf-run-identity">
          <p className="workflow-eyebrow">
            {preview ? "Preview" : "Live"} · round {detail.summary.round} of {detail.summary.maxRepairRounds + 1}
          </p>
          <h3>{detail.summary.workflowName}</h3>
          <p className="wf-run-facts">
            {/* The badge IS the link to the composer. It already displayed the version, so a
                separate `Open version` button in the action row was a second control for the
                same fact, competing with the ones that change the run. */}
            <Tooltip label={version
              ? `Open workflow version ${version.version} in the composer`
              : "The immutable published version is missing or corrupt"}>
              <button
                className="wf-run-version"
                aria-label={`Open workflow version ${detail.summary.workflowVersion} in the composer`}
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
                v{detail.summary.workflowVersion}
              </button>
            </Tooltip>
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
            {/* One run is one repository, and a conversation running a multi-repo task has a
                sibling run reviewing a different one. Named beside the session rather than
                instead of it: which conversation and which checkout are different facts, and
                only the pair identifies this run. */}
            {detail.summary.repoRoot && (
              <Tooltip label={`This run reviews ${detail.summary.repoRoot}`}>
                <span className="wf-run-repo">{repoLeaf(detail.summary.repoRoot)}</span>
              </Tooltip>
            )}
          </p>
          {/* The sentence that replaces a disabled button.
              A stopped run's reason belongs in the page, not in a tooltip on a control that
              refuses - and naming where the decision lives is what keeps the header from
              pretending one button settles an Inspector finding or an uncertain delivery. It
              renders only when `runNextMove` found nothing, so it never argues with a primary. */}
          {noMoveReason && (
            <p className="wf-run-why">
              <b>{noMoveReason.cause}</b> {noMoveReason.consequence}
            </p>
          )}
          {/* What the grant just did, then why the run is still standing still.
              Both sit BELOW the no-move sentence and neither replaces it: that one explains
              why there is no button, and these explain what happened and what is being waited
              on. A run can legitimately want all three - it was just granted rounds, it is
              parked, the observer is withholding, and the header still offers a manual round.
              In that order, because it is the order the events happened in. */}
          {grantNotice && <p className="wf-run-granted">{grantNotice}</p>}
          {refusedSentence && <p className="wf-run-refused">{refusedSentence}</p>}
          {/* Under the refusal: that one says what to fix, this one says the session has
              already done its half. */}
          {refusedClaimSentence && <p className="wf-run-refused-claim">{refusedClaimSentence}</p>}
          {parkedSentence && <p className="wf-run-parked">{parkedSentence}</p>}
          {detail.externalSource && <ExternalProvenance source={detail.externalSource} />}
          <small>Started {when(detail.run.startedAt)} · updated {relativeTime(detail.run.updatedAt)}</small>
        </div>

        <div className="wf-run-actions">
          {/* ONE next move, derived rather than assembled.
              This row used to offer every control the run might accept - five conditional
              blocks, all `btn` and `btn-ghost` peers, with the one that resolved the run last
              and furthest right. `runNextMove` answers the question the reader actually has, and
              because it returns at most one descriptor there is no arrangement of state in which
              two primaries can appear. */}
          {nextMove && (
            <Tooltip label={runActionTooltip(nextMove, isActionPending(nextMove.id))}>
              <button
                className="btn btn-primary"
                disabled={isActionPending(nextMove.id)}
                onClick={() => {
                  if (!nextMove.confirm) {
                    onNextMove(nextMove);
                    return;
                  }
                  onConfirm({
                    ...nextMove.confirm,
                    onConfirm: (evidence) => onNextMove(nextMove, evidence),
                  });
                }}
              >
                {nextMove.label}
              </button>
            </Tooltip>
          )}
          <Tooltip label={feedbackAction.tooltip}>
            <button
              className="btn btn-ghost"
              disabled={feedbackAction.disabled}
              onClick={onCopyFeedback}
            >
              {feedbackAction.label}
            </button>
          </Tooltip>
          {/* Absent, not disabled, when there is no pull request to open - which is what the
              descriptor's own existence now means. A greyed-out `Open PR` was the header
              repeating a fact the Inspector gate section states properly a few sections down,
              and it stood on the `waiting_for_pr` runs that are parked precisely BECAUSE no
              pull request is adopted yet. */}
          {openPrAction && (
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
          )}
          {/* The run id and both JSON downloads are NOT here: they answer nobody reading a run,
              so they sit in `.wf-run-audit` at the foot of the page beside the Timeline. This
              row is for controls that change the run, plus the two links that reach the work. */}
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
                  body: "This abandons the GitHub Inspector-only repair and reruns every Persona against"
                    + " freshly captured evidence. The audited repair submissions stay in history.",
                  confirmLabel: "Restart full workflow",
                  confirmHint: "Abandons the GitHub Inspector-only repair and reruns every Persona",
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
                    + " verdicts stay in history."
                    // The RETIRE half of the two controls that clear a spent gate, and the
                    // one the Merge queue sends people here for - "open the run to grant more
                    // rounds or retire it". Through the same derivation the drawer's Dismiss
                    // uses, so the two cannot disagree about whether stopping this run
                    // touches a pull request.
                    + cancelGateSentence(cancelReleasesGate(detail.summary)),
                  confirmLabel: "Cancel run",
                  confirmHint: cancelGateHint(cancelReleasesGate(detail.summary)),
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
          {/* One tile per ROUND. Eleven captures in one repair round is a detail OF that
              round, and drawn as eleven tiles it claimed eleven rounds had happened - so the
              tile carries a COUNT, and the captures themselves live in a tray below that
              opens for the round being read. One tray at a time, so the strip stays three
              tiles on one row whatever a round spent getting its evidence. */}
          <div className="wf-run-scrubber" role="group" aria-label="Select a round">
            {roundGroups.map((group) => {
              // Both facts come from the model, which is also what `openEvidenceTray` above
              // is built from - so the tile's pressed, active, badge and `aria-expanded`
              // states cannot disagree with which tray is actually rendered.
              const ownsViewed = roundHoldsViewedSubmission(group, viewed?.id ?? null);
              const opens = roundOpensEvidenceTray(group);
              // Only the OPEN round draws a tray, so a failure that happened mid-round is
              // invisible while a different round is being read. The marker is what keeps it
              // on the collapsed tile.
              const failed = roundFailedCaptureLabel(group);
              return (
                <Tooltip
                  key={group.round}
                  label={[
                    `${group.label}: ${group.status.label}`,
                    opens
                      ? `Captured evidence ${group.segments.length} times;`
                        + " opens the newest and lists them all."
                      : null,
                    failed ? `${failed} of this round's captures.` : null,
                  ].filter(Boolean).join(". ")}
                >
                  <button
                    className={`wf-run-round workflow-${group.status.tone}${
                      ownsViewed ? " active" : ""}`}
                    // The ROUND is pressed whichever of its snapshots is being read: this
                    // selects the newest, and a reader who then picked a chip is still
                    // reading this round. `aria-expanded` is what says the tray is theirs.
                    aria-pressed={ownsViewed}
                    {...(opens ? { "aria-expanded": ownsViewed } : {})}
                    onClick={() => onRound(group.head.submissionId)}
                  >
                    <span className="wf-run-round-line">
                      <span className="wf-run-round-name">{group.label}</span>
                      {opens && (
                        <span className="wf-run-round-count">
                          {roundEvidenceCountLabel(group)}
                        </span>
                      )}
                      {/* Drawn whether or not the round opens a tray: a single-capture round
                          that failed is still a failure a reader must see from the strip. */}
                      {failed && (
                        <span className="wf-run-round-failed workflow-failed">{failed}</span>
                      )}
                    </span>
                    <span className="wf-run-round-state">{group.status.label}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
          {/* The open round's captures. Below the strip rather than inside a tile, because a
              tray inside one would either widen that tile past its neighbours or wrap the
              strip - and the strip staying one row is the whole point of the tile above. */}
          {openTray && (
            <div
              className="wf-run-tray"
              role="group"
              aria-label={`Select evidence in round ${openTray.round}`}
            >
              <p className="wf-run-tray-label">
                {`Round ${openTray.round} evidence`}
              </p>
              <div className="wf-run-tray-chips">
                {openTray.segments.map((segment) => (
                  <Tooltip
                    key={segment.submissionId}
                    // The provenance ADDS to the snapshot and its status rather than
                    // replacing them: a continuation is still an entry whose state a
                    // reader wants, and the chip prints only a short form of it.
                    label={[
                      `${segment.label}: ${segment.status.label}`,
                      segmentProvenanceSentence(segment),
                    ].filter(Boolean).join(". ")}
                  >
                    <button
                      className={`wf-run-tray-chip workflow-${segment.status.tone}${
                        segment.submissionId === viewed?.id ? " active" : ""}`}
                      aria-pressed={segment.submissionId === viewed?.id}
                      onClick={() => onRound(segment.submissionId)}
                    >
                      <span className="wf-run-tray-chip-name">
                        {evidenceChipLabel(segment)}
                      </span>
                      <span className="wf-run-tray-chip-state">{segment.status.label}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
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
            // The wider `inheritedAttempts` rather than the carried PASSES, because an
            // unconfigured command records `skipped` and never `passed`: reading this from the
            // pass map would drop the sentence explaining why the row is amber.
            const attempt = latestAttemptByNode.get(nodeId);
            const previous = inheritedOutcomes.get(nodeId)?.attempt;
            return attempt
              ? checkOutcomeOf(attempt)?.status ?? null
              : previous ? checkOutcomeOf(previous)?.status ?? null : null;
          }}
          inherited={inherited}
          onOpenRound={onRound}
          actionWaitFor={(nodeId) => {
            // The attempt's OWN durable state, not `summary.actionWait`. A repair round can
            // run several actions in turn and the summary carries one; scrubbing to an
            // earlier segment would otherwise paint the live wait onto a finished action.
            const attempt = latestAttemptByNode.get(nodeId);
            return attempt ? sessionActionProgress(attempt)?.wait ?? null : null;
          }}
          inspectorStatus={isLatest
            ? spentGateStatus ?? inspectorFooterStatus(detail.summary.gate)
            : null}
          inspectorDetail={isLatest && inspectorGate
            ? inspectorGateSentence(detail)
            : null}
          repair={detail.summary.maxRepairRounds > 0
            ? "Any fail returns the submission to Session for repair, then a new round starts."
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
          directiveFor={(nodeId) => (detail.run.personaDirectives ?? [])
            .some((directive) => directive.nodeId === nodeId)}
          onOpenPersonaDirective={onSetPersonaDirective
            && onRemovePersonaDirective
            && !["completed", "cancelled", "failed"].includes(detail.run.status)
            ? setDirectiveNodeId
            : undefined}
          onOpenNode={(nodeId) => setWorklistFocus((current) => ({
            runId: detail.run.id,
            nodeIds: [nodeId],
            sequence: (current?.sequence ?? 0) + 1,
          }))}
          onOpenStage={(nodeIds) => setWorklistFocus((current) => ({
            runId: detail.run.id,
            nodeIds: [...nodeIds],
            sequence: (current?.sequence ?? 0) + 1,
          }))}
        />
      ) : (
        <p className="wf-run-error" role="alert">
          The immutable workflow version is missing or corrupt. This run cannot be resumed.
        </p>
      )}

      {inspectorOnly && (
        <p className="wf-run-notice" role="status">
          <strong>Persona review bypassed for GitHub Inspector repair.</strong>
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
                  verifiedShipping={Boolean(
                    viewedRound?.verifiedShipping
                    && continuationSourceAttempt(detail, viewedRound.submissionId)?.id === attempt.id
                  )}
                />
              );
            })}
          </div>
        </section>
      )}

      {/*
        * The run's record, offered rather than stacked.
        *
        * Measured on one real run, the four sections below the scrubber came to 7,997px - 8.9
        * screens at a 900px viewport - to carry three sentences of verdict. The worklist was
        * the only one already behaving: a bounded rail and detail at 220px. So it keeps its
        * place as the first and default pane and the others join it as siblings, each rewritten
        * from a stack of cards into a ledger.
        *
        * The bar is `.workflow-tabs`, which the Runs page already ships; nothing here is a
        * second tab family. Below this container the page is now only the workflow-owned model
        * calls and the Timeline, both deliberately unchanged.
        */}
      <RunRecordTabs
        routePane={pane}
        onPane={onPane}
        panes={[
          {
            id: "worklist",
            label: "Review worklist",
            hint: "The changes, failed commands and stalled reviewers this run is still asking for",
            // The BLOCKING count, and withheld at zero: this label answers "is anything still
            // being asked for", and "Review worklist 0" reads as "no reviewers" rather than as
            // "nothing outstanding". The rail's own segment control carries the full tallies.
            count: worklistBlocking > 0 ? worklistBlocking : null,
            blocking: worklistBlocking > 0,
            render: () => (
        <section
          className="wf-run-worklist-pane"
          aria-label="Review worklist"
          ref={tourWorklistRef}
        >
          {/* Keyed on the run so selecting another run resets the list, and on a pipeline-tile
              request so repeated clicks remount with that node as the initial worklist choice. */}
          <RunWorklist
            key={`${detail.run.id}:${currentWorklistFocus?.sequence ?? 0}`}
            detail={detail}
            round={viewed?.round ?? null}
            attempts={reviewAttempts}
            calls={calls}
            nameOfNode={nameOfNode}
            inspectorOnly={inspectorOnly}
            reviewerlessVersion={reviewerlessVersion}
            personaNodeIds={personaNodeIds}
            disabledNodeIds={detail.run.disabledNodeIds ?? []}
            initialNodeIds={currentWorklistFocus?.nodeIds ?? []}
            onOpenFile={onOpenFile}
            onCopyChange={onCopyChange}
            changeCopied={changeCopied}
            onOpenPersonaDirective={onSetPersonaDirective && onRemovePersonaDirective
              ? setDirectiveNodeId
              : undefined}
            onToggleNodesDisabled={onToggleNodesDisabled}
          />
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
            ),
          },
          {
            id: "deliveries",
            label: "Deliveries",
            hint: "Every packet this run sent to the session, and what became of each",
            count: record.deliveries.total,
            blocking: record.deliveries.blocking,
            // Absent, not empty: a run that sent nothing has no delivery ledger to read, and a
            // tab reading "Deliveries 0" is a control that answers a question nobody asked.
            render: () => detail.deliveries.length === 0 ? null : (
              <DeliveriesPane
                detail={detail}
                summary={record.deliveries}
                viewedRound={viewed?.round ?? null}
                sessionBound={sessionBound}
                isActionPending={isActionPending}
                onConfirm={onConfirm}
                onRetryDelivery={onRetryDelivery}
                onResolveDelivery={onResolveDelivery}
              />
            ),
          },
          {
            id: "evidence",
            label: "Evidence",
            hint: "What this submission proved, the pictures it froze, and what the reconciliation could not match",
            /*
             * The AUTHOR CLAIM count, withheld at zero.
             *
             * It is what this pane is for: how many things the packet says it proves. Withheld
             * at zero because a submission can freeze four screenshots and no claims, and
             * "Evidence 0" printed over four visible thumbnails is exactly the lie a collapsed
             * summary exists not to tell.
             */
            count: record.evidence.claimCount > 0 ? record.evidence.claimCount : null,
            blocking: record.evidence.blocking,
            // A submission is the unit this pane reports on, so a run with no submission
            // selected has no evidence record to offer rather than an empty one.
            render: () => !viewed ? null : (
              <EvidencePane
                key={viewed.id}
                runId={detail.run.id}
                summary={record.evidence}
                images={submissionImages}
                coverage={submissionCoverage}
                readiness={viewed.readiness}
                enforced={workflowEvidenceReadinessPolicyEnforces(
                  version?.evidenceReadinessPolicy,
                )}
                scopeOptions={evidenceScopeOptions}
                canRestage={detail.binding.state === "active" && !detail.externalSource}
                overrideReason={(detail.readinessOverrides ?? [])
                  .filter((entry) => entry.submissionId === viewed.id)
                  .at(-1)?.reason ?? null}
                onRestage={onRestageImage}
                recovery={isLatest ? detail.evidenceRecovery : undefined}
                onRecover={onRecoverEvidence}
                /*
                 * The block is what stopped the refinements, so the button that asks for
                 * another one is withdrawn with it. The override stays, because the decision
                 * the block exists to ask for is exactly the one that button records.
                 */
                onRetry={record.evidence.refinementsExhausted
                  ? undefined
                  : () => onRetryEvidenceReadiness(viewed.id)}
                onOverride={(reason) => onOverrideEvidenceReadiness(viewed.id, reason)}
              />
            ),
          },
          {
            id: "intent",
            label: "Intent",
            hint: "What this round was trying to do, and the decisions a human recorded for it",
            // The decision count, because that is what the pane is FOR - the goal is one
            // sentence and the decisions are the record a reader came to check.
            count: record.intent.state === "captured" ? record.intent.decisionCount : null,
            blocking: record.intent.blocking,
            render: () => (
              <IntentPane
                detail={detail}
                intent={record.intent}
                context={context}
                evidenceFingerprint={viewed?.evidenceFingerprint}
              />
            ),
          },
          {
            id: "completion",
            label: "Completion",
            hint: "The GitHub Inspector final gate, and what Foreman claimed about finishing",
            /*
             * OPEN FINDINGS, withheld at zero - not the claim count, and not the finding count.
             *
             * This pane answers "did this run finish", and an open finding is the only countable
             * thing that answers "no". The claims are the wrong number to print: on the run this
             * was measured against five of them restated ONE completion, so "Completion 5" would
             * report a single finish five times. A blocking pane with nothing to count still
             * earns its badge - the container prints `!` for exactly that.
             */
            count: record.completion.openFindings > 0 ? record.completion.openFindings : null,
            blocking: record.completion.blocking,
            // The ONE conditional pane in the bar. A run with no Inspector gate and no Foreman
            // claim has no record of how it finishes, so it is offered no tab rather than an
            // empty one - which is Phase 1's null-render rule rather than a flag of its own.
            render: () => !record.completion.present ? null : (
              <CompletionPane
                detail={detail}
                summary={record.completion}
                claims={completionClaims}
                version={version}
                onOpenInspectorSettings={onOpenInspectorSettings}
              />
            ),
          },
        ]}
      />

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

      {directiveTarget && onSetPersonaDirective && onRemovePersonaDirective && (
        <PersonaDirectiveEditor
          workflowName={detail.summary.workflowName}
          runId={detail.run.id}
          round={detail.summary.round}
          personaName={directiveTarget.persona.name}
          directive={activeDirective}
          pendingFor={(intentKey) =>
            isActionPending(`set-persona-directive:${directiveTarget.id}:${intentKey}`)
            || isActionPending(`remove-persona-directive:${directiveTarget.id}:${activeDirective?.revision ?? 0}`)}
          error={actionError}
          onSave={(feedback, intentKey) => onSetPersonaDirective(
            directiveTarget.id,
            feedback,
            intentKey,
          )}
          onRemove={() => onRemovePersonaDirective(
            directiveTarget.id,
            activeDirective?.revision ?? 0,
          )}
          onClose={() => setDirectiveNodeId(null)}
        />
      )}

      {/*
        Developer material, named for who it is for.

        None of these three answers any question a person reading a run has - is it moving, why
        did it stop, what do I do, where is the work. The id has no filter to be pasted into
        (the rail filters by state, workflow and session) and the route already carries it; the
        two exports have no importer anywhere in the product by deliberate design, so both are
        bug-report attachments. Attachments do not belong beside `Cancel run`, and they are not
        worth deleting either - hence a disclosure, collapsed, beside the Timeline, where the
        rest of the audit material already lives.
      */}
      <details className="wf-run-audit">
        <Tooltip label="The run id and the JSON a bug report needs, out of the way of the run's own controls">
          <summary>
            Audit and bug reports
            <span> - the run id and the complete JSON records</span>
          </summary>
        </Tooltip>
        <dl className="wf-run-audit-body">
          <div className="wf-run-audit-row">
            <dt>Run id</dt>
            <dd className="wf-run-audit-id">{detail.run.id}</dd>
            <dd className="wf-run-audit-act">
              <Tooltip label="Copy this durable workflow run id">
                <button className="btn btn-ghost" onClick={onCopyRunId}>
                  {runIdCopied ? COPY_FEEDBACK_LABEL : "Copy"}
                </button>
              </Tooltip>
            </dd>
          </div>
          <div className="wf-run-audit-row">
            <dt>Run history</dt>
            <dd>Every retained event, verdict, delivery and model call</dd>
            <dd className="wf-run-audit-act">
              <Tooltip label="Download this run's complete retained audit history as JSON">
                {/* Two things this anchor carries beyond its href. The `download` name matches
                    the route's own `Content-Disposition`, which `test/workflows-http.test.ts`
                    pins - a file must not be named two ways. And the `aria-label` names it
                    apart from the version download below, which reads identically on screen:
                    two controls called only "Download JSON" are one control to anybody
                    listening to the page rather than looking at it. */}
                <a
                  className="btn btn-ghost"
                  aria-label="Download the run history as JSON"
                  href={`/api/workflow-runs/${encodeURIComponent(detail.run.id)}/export`}
                  download={`workflow-run-${detail.run.id}.json`}
                >
                  Download JSON
                </a>
              </Tooltip>
            </dd>
          </div>
          <div className="wf-run-audit-row">
            <dt>Workflow v{detail.summary.workflowVersion}</dt>
            <dd>The immutable published definition this run was pinned to</dd>
            <dd className="wf-run-audit-act">
              {version ? (
                <Tooltip label={`Download immutable workflow version ${version.version} as JSON`}>
                  <a
                    className="btn btn-ghost"
                    aria-label={`Download workflow version ${version.version} as JSON`}
                    href={`/api/workflows/${encodeURIComponent(version.workflowId)}/versions/${version.version}/export`}
                    download={`workflow-version-${version.version}.json`}
                  >
                    Download JSON
                  </a>
                </Tooltip>
              ) : (
                /* Disabled rather than absent: the row is what says this run HAS a pinned
                   version, and a missing definition is a fault to see, not to hide. */
                <Tooltip label="The immutable published version is missing or corrupt">
                  <button
                    className="btn btn-ghost"
                    aria-label={`Download workflow version ${detail.summary.workflowVersion} as JSON`}
                    disabled
                  >
                    Download JSON
                  </button>
                </Tooltip>
              )}
            </dd>
          </div>
        </dl>
      </details>
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
  sessions = [],
  selectedRunId,
  pane = null,
  filters,
  onSelectRun,
  onPane,
  onFilters = () => {},
  onOpenSession = () => {},
  onOpenSessionPath,
  onOpenInspectorSettings = () => {},
  onBindWorkflow,
}: {
  runs: WorkflowRunSummary[];
  /** Live session projections issue the primary-first repository slots used by evidence scope. */
  sessions?: Session[];
  selectedRunId: string | null;
  /** Which pane of the open run's record the address bar names. Null lets the run decide. */
  pane?: RunRecordPane | null;
  filters?: WorkflowRunFilters;
  onSelectRun: (id: string) => void;
  /**
   * Route to a pane of the open run's record, with the run the RAIL resolved.
   *
   * The pane lives in the ROUTE rather than in this page's state for the reason the run id
   * does: three of the panes are invisible until clicked, so a link that does not carry which
   * one is showing is a link to a different page than the one being shared.
   *
   * The run id is handed over rather than read back out of the route, and that is the whole
   * point of the second argument. `#/runs` carries no run id - it is how the page opens from
   * the Line and from the nav - and this component still draws a reader there, because
   * `selected` falls back to the newest run. A host that rebuilt the route from `route.runId`
   * would produce a pane with no run to attach it to, `missionRouteHash` would drop it, the
   * hash would not change, and every tab on the bare rail would be a control that does
   * nothing. Only this component knows which run the rail picked, so only it can say.
   */
  onPane?: (pane: RunRecordPane, runId: string) => void;
  onFilters?: (filters: WorkflowRunFilters | undefined) => void;
  onOpenSession?: (id: string) => void;
  /**
   * Reveal a path in the bound session's Files surface, for the worklist's "Open file".
   *
   * Takes the session as well as the path because the host that owns the Files tab is keyed by
   * session, and a run names its own binding rather than whatever session happens to be
   * selected. Optional, so a host with no Files surface simply withholds the control.
   */
  onOpenSessionPath?: (sessionId: string, path: string) => void;
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
  const page = useRef<HTMLElement>(null);
  const runRows = useRef(new Map<string, HTMLButtonElement>());
  const pendingKeyboardFocus = useRef<string | null>(null);
  const selected = selectedRunId ?? ordered[0]?.id ?? null;
  const selectedSummary = ordered.find((run) => run.id === selected) ?? null;
  const evidenceSession = sessions.find((session) => session.id === detail?.binding.sessionId) ?? null;
  const evidenceScopeSet = useMemo(
    () => workflowEvidenceScopes(evidenceSession, detail?.summary.repoRoot),
    [evidenceSession, detail?.summary.repoRoot],
  );
  const evidenceDraft = useWorkflowEvidenceDraft(
    workflowBindingEvidenceOwner(detail?.binding.id),
    evidenceScopeSet.defaultScope,
  );
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
  /**
   * The Runs page owns its two keyboard zones while it is mounted. Vertical arrows on the rail
   * select and load a run immediately; Tab on that selected row crosses into the first authored
   * stage. Once focus is in the reader, the pipeline owns its own arrows and tabs.
   *
   * Inputs keep their native arrows, and a dialog owns every key while it is open. The global
   * App handler deliberately stands down off the Fleet, so this listener has no competing
   * session cursor to suppress.
   */
  useEffect(() => {
    const ids = ordered.map((run) => run.id);
    function onKey(event: KeyboardEvent): void {
      if (
        event.defaultPrevented
        || confirm !== null
      ) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) {
        return;
      }
      if (
        event.key === "Tab"
        && !event.shiftKey
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && target?.closest(".wf-run-row") === (selected ? runRows.current.get(selected) : null)
      ) {
        const firstStage = page.current?.querySelector<HTMLElement>(
          '.wf-run-reader [data-focus-key="run-stage:0"]',
        );
        if (!firstStage) return;
        event.preventDefault();
        firstStage.focus({ preventScroll: true });
        firstStage.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || target?.closest(".wf-run-reader")
      ) return;
      if (ids.length === 0) return;
      const next = moveWorkflowRunSelection(ids, selected, event.key);
      event.preventDefault();
      if (!next || next === selected) return;
      pendingKeyboardFocus.current = next;
      onSelectRun(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, onSelectRun, ordered, selected]);
  // Keep route, DOM focus, and the independently scrolling rail on the same row after a key.
  // Non-keyboard arrivals still scroll a bookmarked or palette-selected run into view, but do
  // not steal focus from the control that opened it.
  useEffect(() => {
    if (!selected) return;
    const row = runRows.current.get(selected);
    row?.scrollIntoView({ block: "nearest" });
    if (pendingKeyboardFocus.current !== selected || !row) return;
    pendingKeyboardFocus.current = null;
    row.focus({ preventScroll: true });
  }, [ordered.length, selected]);
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
  // A DIFFERENT run is being read: drop the previous one's detail and round in the same commit,
  // because a submission id from the old run must not survive one render into the new one.
  useEffect(() => {
    setRoundId(null);
    setConfirm(null);
    void load(true);
    return () => { loadGeneration.current++; };
  }, [selected]);
  /**
   * The SAME run's summary moved. Refresh IN PLACE.
   *
   * This shared the effect above until the audit disclosure made it visible, and sharing it
   * meant every summary bump ran `load(true)` - which nulls the detail, and the view is
   * rendered under `{detail && …}`, so the whole reader was destroyed and rebuilt. Everything
   * the reader had opened closed: the audit disclosure, the evidence and gate-packet
   * disclosures, and the scrubbed round, which snapped back to the newest. On a live run that
   * happens on every SSE bump, and even on a finished one it happens about a second after
   * arrival, when the first list page lands and gives the selected run a summary at last.
   *
   * News about the run is not a new run. The guard is what keeps them apart: it fires only for
   * the run already on screen, so first mount (no detail yet) is left to the effect above and
   * does not fetch twice.
   */
  useEffect(() => {
    if (!selectedSummary || selectedSummary.id !== detail?.run.id) return;
    void load();
  }, [selectedSummary]);
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

  const resubmit = async (
    unchanged: boolean,
    evidence: WorkflowUploadEvidenceLocator[] = [],
    actionId = "resubmit",
  ): Promise<void> => {
    if (!detail) return;
    /*
     * Replaying the refused submission's own request id is what keeps an unchanged resubmission
     * INSIDE its round - the daemon finds that submission by trigger key and revives it, where a
     * fresh id opens a repair round and spends one of the binding's.
     *
     * That id is DERIVED from the run rather than remembered from the request that earned the
     * refusal. A `useRef` here was empty after any reload, and the header went on offering to
     * review "this snapshot" while the daemon quietly opened a new round instead - a promise the
     * label made and the mechanism could not keep. `refusedUnchangedRequestId` reads it off the
     * refused submission's trigger key, so it survives a remount, a new tab, and a second
     * operator arriving at the same run.
     *
     * `null` means no revivable submission, which is a correct answer rather than a failure: a
     * fresh id is what the daemon accepts there.
    */
    if (!unchanged) {
      actionController.run(actionId, async (requestId) => {
        await workflowRequest(`/api/workflow-runs/${detail.run.id}/resubmit`, {
          method: "POST",
          body: JSON.stringify({ requestId, resubmitUnchanged: false, evidence }),
        });
        evidenceDraft.clear();
      });
      return;
    }
    const replay = refusedUnchangedRequestId(detail);
    const requestId = replay ?? crypto.randomUUID();
    setError(null);
    try {
      await workflowRequest(`/api/workflow-runs/${detail.run.id}/resubmit`, {
        method: "POST",
        body: JSON.stringify({ requestId, resubmitUnchanged: unchanged }),
      });
      void load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow resubmission failed");
      void load(false, true);
    }
  };

  /*
   * Both clipboard controls on this page, hosted here rather than in the view.
   *
   * `useCopyFeedback` owns the write and the confirmation together, so `Copied` cannot flip on
   * a copy that did not happen. That used to be a contract rather than a structure: the view
   * held the flag, this host held the `copyText` call, and only a documented re-throw across
   * the prop boundary connected them - with the view's `catch` then swallowing the reason.
   * The flag comes down as a prop now, which is the arrangement `WorkflowLadder` already had.
   *
   * The failure sentence still lands in this page's own `error` slot, read off `copy()`'s
   * return. It keeps naming WHICH copy failed, because the reason `copyText` throws ("The
   * browser refused the clipboard copy") describes the mechanism and not the button that was
   * pressed.
   *
   * Both clear that slot before they attempt, which is what actually makes it last-write-wins:
   * writing only on failure leaves a refusal on screen through every later copy that worked,
   * and the audit disclosure on a finished run may never fire another action to clear it. That
   * is `mutate` and the resubmit handler's own pattern above, and `WorkflowLadder`'s.
   *
   * `resetOn` is load-bearing and not decoration. The view used to hold these flags and
   * `setDetail(null)` unmounted it on every run change, so selecting another run cleared them
   * for free; this host stays mounted across that, so without the reset a run nobody copied
   * would read `Copied` for the rest of the previous run's hold.
   *
   * TWO instances, deliberately, and they do NOT share a generation counter.
   *
   * They copy different things, so each reports its own outcome and neither speaks for the
   * other. Clicking Copy on the run id, then Copy feedback while the first is still stalled on
   * a permission prompt, can leave `Copied` on the header button while the error line says the
   * RUN ID copy failed - and every part of that is true: the feedback copy did succeed, the
   * run-id button is sitting at its resting label claiming nothing, and the sentence names
   * which copy it is about. That naming is why it reads as two outcomes rather than as a
   * contradiction.
   *
   * A shared generation across the two would suppress the later-settling one, which here is a
   * REAL failure of a copy the reader asked for - reintroducing exactly the silent-copy class
   * this whole change exists to delete. One shared controller would be worse still: the two
   * would share `copied`, so a successful feedback copy would flip the run-id button to
   * `Copied` when nothing had been written for it.
   *
   * What the shared `error` slot genuinely costs is a message, not a lie: whichever copy
   * settles last owns the line, and either one's `setError(null)` can clear a refusal the
   * reader has not read yet. Fixing THAT means an error surface per control, the way
   * `ReportPanel` and `FileWorkspace` render `error` beside their own buttons - new UI on this
   * page, which this phase ships none of. Recorded as follow-up rather than done here.
   */
  const feedbackCopy = useCopyFeedback({ resetOn: selected });
  const runIdCopy = useCopyFeedback({ resetOn: selected });
  const changeCopy = useCopyFeedback({ resetOn: selected });

  const copyFeedback = (): void => {
    if (!detail) return;
    setError(null);
    void feedbackCopy.copy(() => workflowFeedbackText(detail))
      .then(({ error: caught }) => {
        if (caught !== null) setError(`Could not copy workflow feedback. ${caught}`);
      });
  };

  /**
   * The audit disclosure's run-id copy.
   *
   * Through `copyText()` - via the hook - like every other clipboard control in the app. The
   * button it replaced called `navigator.clipboard.writeText` behind a `void`, so in the
   * Electron renderer, where the async Clipboard API can be permission-blocked even after a
   * direct click, it copied nothing and said nothing.
   */
  const copyRunId = (): void => {
    if (!detail) return;
    setError(null);
    void runIdCopy.copy(() => detail.run.id)
      .then(({ error: caught }) => {
        if (caught !== null) setError(`Could not copy the run id. ${caught}`);
      });
  };

  /**
   * The worklist's per-change copy, kept apart from the header's repair packet.
   *
   * Its own `useCopyFeedback` because the two confirmations are independent controls that can
   * be up at once, and sharing one would flip `Copied` on a button nobody pressed.
   */
  const copyChange = (text: string): void => {
    setError(null);
    void changeCopy.copy(text)
      .then(({ error: caught }) => {
        if (caught !== null) setError(`Could not copy this change. ${caught}`);
      });
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
    <section ref={page} className="workflow-runs">
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
        <div className="wf-run-list" role="list" aria-label="Workflow runs">
          {ordered.map((run) => (
            <div role="listitem" key={run.id}>
              <Tooltip label={`Open this ${run.workflowName} run - ${runTriageSentence(run)}`}>
                <button
                  ref={(node) => {
                    if (node) runRows.current.set(run.id, node);
                    else runRows.current.delete(run.id);
                  }}
                  aria-current={selected === run.id}
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
                  {/* WHY it stopped, beside the chip that says THAT it stopped.
                      The chip has always been able to say "Blocked", which is true of every
                      stopped run at once and actionable on none of them - so a rail of them
                      was a column of one word and a reader who had to open each in turn to
                      find out which was theirs. `runIsParked` rather than `status ===
                      "blocked"`, and `blockedPhaseClause` rather than a second lookup, so
                      this row and the Review drawer's cannot disagree about one field. */}
                  {runIsParked(run) && (
                    <span className="wf-run-row-why">{blockedPhaseClause(run.phase)}</span>
                  )}
                  <span className="wf-run-row-session">{run.noteKey}</span>
                  {run.repoRoot && (
                    <span className="wf-run-row-repo">{repoLeaf(run.repoRoot)}</span>
                  )}
                  {run.gate !== "none" && (
                    <span className="wf-run-row-gate">
                      GitHub Inspector: {run.gate.replaceAll("_", " ")}
                      {run.gatePrNumber ? ` · #${run.gatePrNumber}` : ""}
                      {run.gateHeadShort ? ` · ${run.gateHeadShort}` : ""}
                    </span>
                  )}
                  <small>{relativeTime(run.updatedAt)}</small>
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
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
            pane={pane}
            // Closed over the run the rail resolved, so the view's own callback stays
            // one-argument: a pane is a fact about the record in front of the reader, and
            // nothing inside the view should have to know how its run was addressed.
            onPane={onPane && selected ? (next) => onPane(next, selected) : undefined}
            onRound={setRoundId}
            onConfirm={setConfirm}
            /*
             * One dispatch for the one derived move.
             *
             * Every arm but the resubmissions goes through the shared action store from the
             * descriptor's own `path` and `body`, which is what keeps `RunNextMove` POST-only:
             * there is no kind this site special-cases, so a new row in `runNextMove` needs no
             * new wiring here.
             *
             * The resubmission family is routed to the page's own handler rather than sent from
             * here, and NOT for tidiness: that handler resolves the request id that keeps an
             * unchanged resubmission inside the round it is repairing. Sending it generically
             * would mint a fresh id and burn a repair round every time.
             */
            onNextMove={(move, evidence = []) => {
              if (move.kind === "resubmit" || move.kind === "resubmit-unchanged") {
                void resubmit(move.kind === "resubmit-unchanged", evidence, move.id);
                return;
              }
              /*
               * The only move whose success lands on a DIFFERENT run.
               *
               * Every other arm advances the run being read, so settling it means reloading this
               * page. This one asks the BINDING for a new run, so the run it returns is the one
               * the reader now wants: staying put would leave them on the finished run they just
               * asked to repeat, watching nothing happen.
               *
               * Through the shared store like every other arm, and not for symmetry - it is what
               * retains the request id across a failed response. A network error here with a
               * fresh id per click is how one intent becomes two runs and two rounds of model
               * spend; replaying the same id is answered idempotently with the run already made.
               * `run_active` and `inactive_binding` cannot be ruled out from run detail alone
               * (it carries no sibling runs), and they surface as the daemon's own sentence on
               * the page's error line.
               *
               * `onSelectRun` rather than a hash write: it is the router's own entry point, so
               * this leaves a history step back to the finished run and honours the same
               * navigation gate every other move on this page does.
               */
              if (move.kind === "run-again") {
                actionController.run(move.id, async (requestId) => {
                  // `idempotent: true` arrives on a replay and is not an error - the run in the
                  // body is the one this intent made, so it is the one to open.
                  const started = await workflowRequest<{ run: { id: string } }>(move.path, {
                    method: "POST",
                    body: JSON.stringify({ requestId, ...move.body, evidence }),
                  });
                  evidenceDraft.clear();
                  onSelectRun(started.run.id);
                });
                return;
              }
              actionController.run(move.id, (requestId) =>
                workflowRequest(move.path, {
                  method: "POST",
                  body: JSON.stringify({ requestId, ...move.body }),
                }));
            }}
            onCancel={async () => {
              await mutate(`/api/workflow-runs/${detail.run.id}/cancel`, {
                requestId: crypto.randomUUID(),
              });
            }}
            onCopyFeedback={copyFeedback}
            onCopyRunId={copyRunId}
            onCopyChange={copyChange}
            feedbackCopied={feedbackCopy.copied}
            runIdCopied={runIdCopy.copied}
            changeCopied={changeCopy.copied}
            // The BINDING's session, for `onOpenSession`'s reason: it is the column that goes
            // null when a session disappears, and a file cannot be revealed in a pane that is
            // gone.
            onOpenFile={onOpenSessionPath && detail.binding.sessionId
              ? (path) => onOpenSessionPath(detail.binding.sessionId!, path)
              : undefined}
            onLoadEvents={loadMoreEvents}
            onLoadCalls={loadMoreCalls}
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
            onRecoverEvidence={async (submissionId) => {
              actionController.run(`evidence-recovery:${submissionId}`, (requestId) =>
                workflowRequest(`/api/workflow-runs/${detail.run.id}/submissions/${submissionId}/evidence-recovery`, {
                  method: "POST", body: JSON.stringify({ requestId }),
                }));
            }}
            onRetryEvidenceReadiness={async (submissionId) => {
              await mutate(
                `/api/workflow-runs/${detail.run.id}/submissions/${submissionId}/evidence-readiness/retry`,
                { requestId: crypto.randomUUID() },
              );
            }}
            onOverrideEvidenceReadiness={async (submissionId, reason) => {
              await mutate(
                `/api/workflow-runs/${detail.run.id}/submissions/${submissionId}/evidence-readiness/override`,
                { requestId: crypto.randomUUID(), reason, acknowledgedRisk: true },
              );
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
            onSetPersonaDirective={(nodeId, feedback, intentKey) => {
              actionController.run(
                `set-persona-directive:${nodeId}:${intentKey}`,
                (requestId) => workflowRequest(
                  `/api/workflow-runs/${detail.run.id}/set-persona-directive`,
                  {
                    method: "POST",
                    body: JSON.stringify({ requestId, nodeId, feedback }),
                  },
                ),
              );
            }}
            onRemovePersonaDirective={(nodeId, revision) => {
              actionController.run(
                `remove-persona-directive:${nodeId}:${revision}`,
                (requestId) => workflowRequest(
                  `/api/workflow-runs/${detail.run.id}/remove-persona-directive`,
                  {
                    method: "POST",
                    body: JSON.stringify({ requestId, nodeId }),
                  },
                ),
              );
            }}
            evidenceScopeOptions={evidenceScopeSet.options}
            onRestageImage={async (image, clientItemId) => {
              await workflowRequest(
                `/api/workflow-bindings/${encodeURIComponent(detail.binding.id)}/evidence/reattach`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    imageId: image.id,
                    clientItemId,
                    caption: image.caption,
                    repositoryScope: image.repositoryScope,
                  }),
                },
              );
              evidenceDraft.refreshStaged();
            }}
            actionError={error ?? actionController.error}
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
        <WorkflowConfirmModal
          request={confirm}
          onClose={() => setConfirm(null)}
          evidence={confirm.captureEvidence
            ? { controller: evidenceDraft, scopes: evidenceScopeSet.options }
            : undefined}
        />
      )}
    </section>
  );
}
