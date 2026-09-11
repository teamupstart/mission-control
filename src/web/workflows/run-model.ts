import type {
  EvidenceRef,
  PersonaVerdict,
  PublishedWorkflowGraph,
  RequestedChange,
  WorkflowCheckOutcome,
  WorkflowCheckStatus,
  WorkflowContextSnapshot,
  WorkflowDeliveryKind,
  WorkflowDeliveryState,
  WorkflowGateSummary,
  WorkflowEvent,
  WorkflowGateWaitReason,
  WorkflowLlmCall,
  WorkflowNodeAttempt,
  SessionActionAttemptState,
  SessionActionBlockCode,
  SessionActionContinuationExpectation,
  SessionActionDeliveryAnchor,
  SessionActionWaitReason,
  WorkflowNodeAttemptState,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSubmission,
} from "@shared/workflow.ts";
import {
  WORKFLOW_RUN_SPENT_PHASES,
  WORKFLOW_UNCHANGED_REPOSITORY_PHASE,
  isVerdictNode,
  verdictAuthor,
  workflowResumptionWithheldSentence,
  workflowRunGaveUp,
  sessionActionContinuationReachesOnlyEnd,
} from "@shared/workflow.ts";
import type { Stage } from "@shared/workflow-stages.ts";
import {
  PersonaVerdictSchema,
  SessionActionAttemptStateSchema,
  SessionActionCompletedOutputSchema,
  WorkflowCheckOutcomeSchema,
} from "@shared/protocol.ts";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import type { WorkflowConfirmDescriptor } from "./run-actions.ts";
import { WorkflowApiError } from "./workflowApi.ts";

/**
 * Everything the runs monitor has to DECIDE, as pure functions over one run detail.
 *
 * It lives beside the reader rather than inside it for the reason the round scrubber
 * exists at all: which round is being viewed changes which member chips, verdicts and
 * timeline entries are true, and a rule spelled inline in JSX can only be checked by
 * rendering markup and reading it back. These are checked directly.
 *
 * The other thing this file owns is VOCABULARY. Every durable enum the reader prints -
 * run status, gate wait reason, attempt state, delivery state - is turned into a sentence
 * here, in one `Record<Enum, …>` per axis, so a new value added to `@shared/workflow.ts`
 * fails typecheck until someone says what it means to a human. The machine code is kept
 * beside the sentence as a detail affordance rather than thrown away: it is what an
 * operator quotes into a bug report.
 */

export function workflowRunLoadError(caught: unknown): string {
  if (
    caught instanceof WorkflowApiError
    && caught.body?.code === "workflow_run_corrupt"
  ) {
    return "This workflow run has malformed durable data. Check daemon logs or restore it from backup.";
  }
  if (caught instanceof WorkflowApiError && caught.status === 404) {
    return "This workflow run is no longer retained. Select another run from history.";
  }
  return caught instanceof Error ? caught.message : "Could not load workflow run";
}

/**
 * The exact repair packet Copy feedback carries on every workflow surface.
 *
 * Prefer the newest retained delivery payload because it is the packet the workflow prepared.
 * Older runs without one fall back to their retained Persona verdicts.
 */
export function workflowFeedbackText(detail: WorkflowRunDetail): string {
  const deliveryPayload = [...detail.deliveries].reverse()
    .find((delivery) => delivery.payload.length > 0)?.payload;
  return deliveryPayload ?? detail.attempts.flatMap((attempt) => {
    const verdict = verdictOf(attempt);
    const node = detail.version?.graph.nodes.find((candidate) => candidate.id === attempt.nodeId);
    if (!verdict || !node || !isVerdictNode(node)) return [];
    const author = verdictAuthor(node);
    if (verdict.verdict === "pass") {
      return [`${author}: PASS\n${verdict.summary}\n${verdict.approvalDetails.reason}`];
    }
    return [([
      `${author}: FAIL`,
      verdict.summary,
      ...verdict.requestedChanges.map((change) => `- ${change.title}: ${change.rationale}`),
    ].join("\n"))];
  }).join("\n\n");
}

/**
 * The run's total spend, or `null` when the figure would be a guess.
 *
 * A partial page, an unloaded page, or one call whose runner reports no price all make the
 * sum wrong in the same direction, and a wrong total is worse than an absent one - see the
 * README's "Cost unavailable from this runner".
 */
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

/**
 * Execution order, which is now two keys deep.
 *
 * `segment` before `createdAt` because it is the durable ordering the runtime wrote, and two
 * segments of one round can share a millisecond: a continuation reserves its child row inside
 * the same transaction that closes the parent's action attempt.
 */
function byRound(a: WorkflowSubmission, b: WorkflowSubmission): number {
  return a.round - b.round || a.segment - b.segment || a.createdAt - b.createdAt;
}

export function orderedSubmissions(detail: WorkflowRunDetail): WorkflowSubmission[] {
  return [...detail.submissions].sort(byRound);
}

/**
 * The submission the reader is scoped to: the requested one when it still exists, else the
 * latest.
 *
 * Falling back rather than showing an empty round matters because run detail is reloaded on
 * every mutation and over SSE-driven selection changes, so a round id held in component
 * state can outlive the run it came from.
 */
export function selectedSubmission(
  detail: WorkflowRunDetail,
  requestedId: string | null,
): WorkflowSubmission | null {
  const rounds = orderedSubmissions(detail);
  return rounds.find((submission) => submission.id === requestedId) ?? rounds.at(-1) ?? null;
}

const attemptsFor = (
  detail: WorkflowRunDetail,
  submissionId: string,
): WorkflowNodeAttempt[] =>
  detail.attempts.filter((attempt) => attempt.submissionId === submissionId);

/**
 * Node id -> the newest attempt on it in one submission.
 *
 * The only attempt whose state is current, and - the reason this is exported rather than
 * private to the status map - the only one whose runner and model are. A retry resolves the
 * provider again, so reading the status off the newest attempt while reading `runner · model`
 * off the first one puts a live chip beside stale metadata about a call that is over.
 */
export function latestAttemptsFor(
  detail: WorkflowRunDetail,
  submissionId: string | null,
): Map<string, WorkflowNodeAttempt> {
  const newest = new Map<string, WorkflowNodeAttempt>();
  if (!submissionId) return newest;
  for (const attempt of attemptsFor(detail, submissionId)) {
    const previous = newest.get(attempt.nodeId);
    if (previous && previous.attempt > attempt.attempt) continue;
    newest.set(attempt.nodeId, attempt);
  }
  return newest;
}

/** Whether a prior attempt is a pass this round is entitled to carry forward. */
export function priorAttemptPassed(
  kind: "persona" | "check" | "session_action",
  attempt: WorkflowNodeAttempt | undefined,
): boolean {
  if (!attempt) return false;
  if (kind === "check") return checkOutcomeOf(attempt)?.status === "passed";
  if (kind === "session_action") return sessionActionProgress(attempt)?.complete === true;
  return verdictOf(attempt)?.verdict === "pass";
}

/**
 * The submissions a round may inherit an outcome FROM, nearest first.
 *
 * Two shapes of submission legitimately leave an authored node with no attempt of its own,
 * and they are the only two - a repair round restarts the graph at Session and queues every
 * node again, so it inherits nothing and must never borrow a chip:
 *
 * - a CONTINUATION segment (`segment > 0`) resumes from one action's `complete` route, so the
 *   stages above it keep the attempts they earned on the evidence they actually reviewed. Its
 *   provenance is the durable `parentSubmissionId` chain rather than "whatever came before",
 *   because ordering alone cannot tell a parent from an unrelated sibling round;
 * - an INSPECTOR-ONLY round is inserted already complete with zero attempts, and the round it
 *   bypasses is the newest full-workflow one before it.
 *
 * The `seen` guard is not defensive noise: this walks persisted ids, and a cycle in them would
 * otherwise hang the reader rather than degrade it.
 */
function inheritanceSources(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission,
): WorkflowSubmission[] {
  if (submission.mode === "inspector_only") {
    const ordered = orderedSubmissions(detail);
    const index = ordered.findIndex((candidate) => candidate.id === submission.id);
    if (index < 1) return [];
    const previous = ordered.slice(0, index).reverse()
      .find((candidate) => candidate.mode === "full_workflow");
    return previous ? [previous] : [];
  }
  if (submission.segment === 0) return [];
  const byId = new Map(detail.submissions.map((candidate) => [candidate.id, candidate]));
  const chain: WorkflowSubmission[] = [];
  const seen = new Set<string>([submission.id]);
  let parentId = submission.parentSubmissionId;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parent.id);
    chain.push(parent);
    parentId = parent.parentSubmissionId;
  }
  return chain;
}

/** One node's outcome, earned in an earlier submission and still standing in this one. */
export interface InheritedPass {
  attempt: WorkflowNodeAttempt;
  /** The submission that earned it. The scrub target, so the proof is one click away. */
  submission: WorkflowSubmission;
  /** `Round 1 · evidence 1` - the round a reader has to be able to name and reach. */
  roundLabel: string;
}

/**
 * Node id -> the NEAREST attempt an earlier submission recorded for it, pass or not.
 *
 * This is the display fallback, and it is deliberately wider than `inheritedPasses`: a Check
 * whose command is not configured on this machine recorded `skipped` rather than `passed`, and
 * a round that inherits nothing for it drops the one sentence saying WHY it is amber. The
 * reader would get a bare wait where an explanation used to be.
 *
 * A node with an attempt in THIS submission inherits nothing - its own outcome is the truth,
 * whatever it is. And the walk stops at the first source that holds an attempt even when that
 * attempt failed, because the nearest recorded outcome is the current one; searching past it
 * for an older pass would resurrect a result the run has already superseded.
 */
export function inheritedAttempts(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission | null,
): Map<string, InheritedPass> {
  const inherited = new Map<string, InheritedPass>();
  const graph = detail.version?.graph;
  if (!submission || !graph) return inherited;
  const sources = inheritanceSources(detail, submission).map((source) => ({
    submission: source,
    attempts: latestAttemptsFor(detail, source.id),
  }));
  if (sources.length === 0) return inherited;
  const current = latestAttemptsFor(detail, submission.id);
  for (const node of graph.nodes) {
    if (node.kind !== "persona" && node.kind !== "check" && node.kind !== "session_action") {
      continue;
    }
    if (current.has(node.id)) continue;
    for (const source of sources) {
      const attempt = source.attempts.get(node.id);
      if (!attempt) continue;
      inherited.set(node.id, {
        attempt,
        submission: source.submission,
        roundLabel: submissionRoundLabel(detail, source.submission),
      });
      break;
    }
  }
  return inherited;
}

/**
 * Node id -> the pass this round carries forward rather than re-earning.
 *
 * This replaces the reader's trip to the previous round. A node that did not run here reads
 * "Not re-run" beside the round its pass came from, and neither the chip nor the sentence
 * claims the stage ran again: the tone stays neutral and the provenance line carries the tick.
 *
 * A SESSION ACTION is excluded, and not as an oversight. An action judges nothing - this app is
 * emphatic that nothing about one ever reads Passed, Failed or Changes requested - so
 * "✓ Passed in Round 1 · evidence 1" is the one vocabulary it must never be given. It is also
 * the wrong claim about the wrong node: a continuation segment exists BECAUSE that action
 * completed, so the reader's question there is "what did the action do", which its own lifecycle
 * chip already answers with `Complete`.
 */
export function inheritedPasses(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission | null,
): Map<string, InheritedPass> {
  const passes = new Map<string, InheritedPass>();
  const graph = detail.version?.graph;
  if (!graph) return passes;
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  for (const [nodeId, inherited] of inheritedAttempts(detail, submission)) {
    const kind = kinds.get(nodeId);
    if (kind !== "persona" && kind !== "check") continue;
    if (priorAttemptPassed(kind, inherited.attempt)) passes.set(nodeId, inherited);
  }
  // A repair round records its own receipt-bearing attempt while naming the earned pass.
  // Resolve that provenance even when a later action segment inherited the reused attempt.
  const candidates = new Map([
    ...[...passes].map(([nodeId, pass]) => [nodeId, pass.attempt] as const),
    ...latestAttemptsFor(detail, submission?.id ?? ""),
  ]);
  for (const [nodeId, candidate] of candidates) {
    const output = candidate.output;
    if (candidate.state !== "completed" || !output || typeof output !== "object" || Array.isArray(output)) continue;
    const source = detail.attempts.find((attempt) => attempt.id === output.reusedPassAttemptId);
    const sourceSubmission = source && detail.submissions.find((item) => item.id === source.submissionId);
    if (kinds.get(nodeId) !== "persona" || source?.nodeId !== nodeId || !sourceSubmission
      || !priorAttemptPassed("persona", source)) continue;
    passes.set(nodeId, {
      attempt: source,
      submission: sourceSubmission,
      roundLabel: submissionRoundLabel(detail, sourceSubmission),
    });
  }
  return passes;
}

const CARRIED_TOOLTIP_LEAD = "Not re-run in this round.";

/**
 * The chip for a stage this round did not run because an earlier one already passed it.
 *
 * The tone is deliberately NEUTRAL rather than green. A pass chip on a node that did not
 * execute is the same false assurance `degraded` exists to prevent, and the reader's actual
 * question - "did this pass, and where do I see it?" - is answered by the provenance line
 * beside it, which names the round and links to it. Amber `waiting`, the status this replaces,
 * was worse than either: it promised a stage was about to run that never will.
 */
export function carriedStatus(roundLabel: string): PipelineStatus {
  return {
    tone: "stopped",
    label: "Not re-run",
    tooltip: `${CARRIED_TOOLTIP_LEAD} It passed in ${roundLabel}, and that pass still stands.`,
    skipKind: "carried_pass",
  };
}

/** The stage-header chip for a stage whose every member was carried forward. */
export function carriedStageStatus(roundLabels: readonly string[]): PipelineStatus {
  const distinct = [...new Set(roundLabels)];
  if (distinct.length === 1) return carriedStatus(distinct[0]!);
  return {
    tone: "stopped",
    label: "Not re-run",
    tooltip: `${CARRIED_TOOLTIP_LEAD} Every member passed in an earlier round, and those`
      + " passes still stand.",
    skipKind: "carried_pass",
  };
}

/**
 * The one carried source worth naming on a surface that has room for exactly one.
 *
 * The NEWEST, because a stage carried across several segments is most usefully traced to the
 * round nearest the reader; the older ones are reachable from there by the same control.
 */
export function newestInheritedSource(
  passes: readonly InheritedPass[],
): InheritedPass | null {
  return passes.reduce<InheritedPass | null>((newest, pass) => {
    if (!newest) return pass;
    const better = pass.submission.round > newest.submission.round
      || (pass.submission.round === newest.submission.round
        && pass.submission.segment > newest.submission.segment);
    return better ? pass : newest;
  }, null);
}

export function verdictOf(attempt: WorkflowNodeAttempt): PersonaVerdict | null {
  return attempt.verdict as unknown as PersonaVerdict | null;
}

/**
 * The attempts "Reviewer verdicts" is about: the ones on a node that can hold an opinion.
 *
 * Every node in a graph owns attempt rows, including the three that are pure structure. The
 * engine writes a `completed` attempt for the Session the moment a submission is captured
 * (`submitted` needs a receipt to hang off), one for each `all_pass` join when it aggregates, and
 * one for the End when the run terminates. Listed beside the reviewers, those read as verdicts
 * nobody gave - "Session completed · attempt 1", "Stage 2 completed · attempt 1", "Complete
 * completed · attempt 1" - which is exactly as much noise as the graph has structure, and their
 * real state is already drawn on the pipeline strip above the list.
 *
 * The filter is by NODE KIND rather than by the absence of a verdict, because a reviewer with no
 * verdict is the case that most needs showing: queued, running, retrying, or errored. And a
 * structural attempt that is anything OTHER than quietly complete is kept too - if a join ever
 * does hold an error, a reader has to see it rather than have this hide it.
 */
export function reviewerAttempts(
  attempts: readonly WorkflowNodeAttempt[],
  graph: PublishedWorkflowGraph | null | undefined,
): WorkflowNodeAttempt[] {
  if (!graph) return [...attempts];
  const structural = new Set(
    graph.nodes
      .filter((node) => node.kind === "session" || node.kind === "all_pass" || node.kind === "end")
      .map((node) => node.id),
  );
  return attempts.filter((attempt) =>
    !(structural.has(attempt.nodeId) && attempt.state === "completed" && !attempt.error));
}

/**
 * Node id -> runtime status for ONE submission.
 *
 * The verdict wins over the attempt state when there is one, because "completed" says the
 * reviewer or command finished and says nothing about whether the member passed. Taking a
 * submission id rather than digging out the newest one is the round scrubber's whole
 * premise: an attempt from round 1 says nothing about a node in round 3, and a map merged
 * across rounds shows a member as passed while it is being re-run.
 */
export function nodeStatusesForSubmission(
  detail: WorkflowRunDetail,
  submissionId: string | null,
): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const [nodeId, attempt] of latestAttemptsFor(detail, submissionId)) {
    statuses[nodeId] = verdictOf(attempt)?.verdict ?? attempt.state;
  }
  // The action that authorized this segment, carried across from the parent - see
  // `continuationSourceAttempt` for why a strictly scoped map is not enough here.
  const source = continuationSourceAttempt(detail, submissionId);
  if (source && !(source.nodeId in statuses)) statuses[source.nodeId] = source.state;
  return statuses;
}

/**
 * The action attempt whose completion AUTHORIZED this segment, or null at segment zero.
 *
 * A continuation segment holds no attempt for that action: it ran against the PARENT
 * evidence, and keeping it there is exactly what makes the split honest - upstream work is
 * not relabelled as having reviewed evidence it never saw. But every surface scoped strictly
 * to the viewed segment then draws the stage that produced this very evidence as never having
 * happened: "Not started" on the newest view of a finished run, and no attempt card at all.
 *
 * So the one deliberate cross-submission read is shared here rather than repeated at each
 * surface. The link is the submission's OWN columns, written by the runtime inside the
 * continuation transaction - this is server-recorded provenance, not a relationship inferred
 * from ordering or timestamps. Both the named attempt AND its parent submission are checked,
 * so a corrupt row cannot pull an unrelated node into the segment.
 */
export function continuationSourceAttempt(
  detail: WorkflowRunDetail,
  submissionId: string | null,
): WorkflowNodeAttempt | null {
  const submission = detail.submissions.find((candidate) => candidate.id === submissionId);
  if (!submission?.continuationNodeId || !submission.continuationNodeAttemptId) return null;
  return detail.attempts.find((attempt) =>
    attempt.id === submission.continuationNodeAttemptId
    && attempt.nodeId === submission.continuationNodeId
    && attempt.submissionId === submission.parentSubmissionId) ?? null;
}

export interface RoundView {
  submissionId: string;
  round: number;
  /** The evidence snapshot inside `round`, zero-based as the runtime counts it. */
  segment: number;
  /** `Round 2`, `Round 2 · Inspector`, and `Round 1 · evidence 2` for a continuation. */
  label: string;
  status: PipelineStatus;
  inspectorOnly: boolean;
  /**
   * How this evidence came to exist, or null at segment zero. The name of the action whose
   * completion authorized it, when the version can supply one.
   */
  continuedFrom: string | null;
  refinementReason: WorkflowSubmission["refinementReason"];
  /** A completed PR continuation whose only reachable consumer is End. */
  verifiedShipping: boolean;
}

function submissionIsVerifiedShipping(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission,
): boolean {
  if (
    submission.refinementReason !== "session_action"
    || submission.continuationNodeId === null
    || detail.version === null
  ) return false;
  const continuation = continuationSourceAttempt(detail, submission.id);
  const proof = continuation ? provenPullRequest(sessionActionProgress(continuation)) : null;
  return continuation?.state === "completed"
    && proof?.acceptedContentTreeOid != null
    && sessionActionContinuationReachesOnlyEnd(
      detail.version.graph,
      submission.continuationNodeId,
    );
}

/**
 * The scrubber's entries, in execution order - one per SUBMISSION, which is no longer one per
 * round.
 *
 * A round is "failed" when a member failed - a reviewer asked for changes or a Check rejected
 * the submission - which is NOT the same as the submission failing: a round that returned to
 * Session is a healthy repair loop and its submission status is `waiting_for_session`.
 * Marking it from the submission status alone would leave every repair round unmarked, which
 * is the one thing the mark is for.
 *
 * The evidence suffix appears only on rounds that actually HAVE more than one snapshot. A
 * lone `Round 1` needs no disambiguation, and stamping "evidence 1" on every ordinary run
 * would spend the reader's attention on a distinction that is not being drawn.
 */
export function runRounds(
  detail: WorkflowRunDetail,
  /** Node id -> human name, for naming the action a continuation came from. */
  nameOfNode: (nodeId: string) => string | null = () => null,
): RoundView[] {
  const submissions = orderedSubmissions(detail);
  const segmentsPerRound = segmentCounts(submissions);
  return submissions.map((submission) => {
    const verdicts = attemptsFor(detail, submission.id).map(verdictOf);
    const changesRequested = verdicts.some((verdict) => verdict?.verdict === "fail");
    const verifiedShipping = submissionIsVerifiedShipping(detail, submission);
    return {
      submissionId: submission.id,
      round: submission.round,
      segment: submission.segment,
      label: roundLabelFor(
        submission,
        (segmentsPerRound.get(submission.round) ?? 1) > 1,
        verifiedShipping,
      ),
      status: submissionStatus(submission, changesRequested),
      inspectorOnly: submission.mode === "inspector_only",
      continuedFrom: submission.continuationNodeId === null
        ? null
        : nameOfNode(submission.continuationNodeId),
      refinementReason: submission.refinementReason ?? null,
      verifiedShipping,
    };
  });
}

/**
 * One round, with every evidence snapshot it took, for a scrubber that draws ONE TILE PER
 * ROUND.
 *
 * `runRounds` answers per submission because that is what every scoped section is keyed on,
 * and it stays that way. What it cannot say is how many tiles to draw: a run that captured
 * evidence eleven times inside round 2 produced eleven entries, and a strip of them reads as
 * eleven rounds - which is the opposite of what the segment model exists to convey, and on a
 * three-round run it filled the header with twenty-three tiles that had to wrap three deep.
 *
 * So the round is the unit of the tile, and the snapshots inside it are the unit of
 * SELECTION. The group wears the newest snapshot's status, because that is what the round is
 * doing now; the older ones keep their own, because "round 2 took eleven captures and one of
 * them failed" is exactly the sentence a collapsed tile must not swallow.
 */
export interface RoundGroupView {
  round: number;
  /** `Round 2`, or `Round 2 · GitHub Inspector`, taken from the newest snapshot. */
  label: string;
  /** The newest snapshot: what the tile selects, and whose status it wears. */
  head: RoundView;
  /** Every snapshot of this round in execution order, oldest first. Never empty. */
  segments: readonly RoundView[];
  status: PipelineStatus;
}

/**
 * Fold `runRounds` into one entry per round, keeping execution order in both directions.
 *
 * Grouped by round NUMBER rather than by adjacency. The rows arrive ordered, so the two agree
 * today; keyed on the number they still agree if a later feature ever interleaves them, and a
 * duplicate `Round 2` tile is the one failure a reader could not diagnose from the screen.
 */
export function runRoundGroups(rounds: readonly RoundView[]): RoundGroupView[] {
  const groups = new Map<number, RoundView[]>();
  for (const round of rounds) {
    const segments = groups.get(round.round);
    if (segments) segments.push(round);
    else groups.set(round.round, [round]);
  }
  return [...groups.values()].map((segments) => {
    const head = segments[segments.length - 1]!;
    return {
      round: head.round,
      label: `Round ${head.round}`
        + (head.inspectorOnly ? " · GitHub Inspector" : ""),
      head,
      segments,
      status: head.status,
    };
  });
}

/**
 * The tile's badge: how many times this round captured evidence.
 *
 * Deliberately INDEPENDENT of what is selected. The tray below names the snapshot being read,
 * so a badge that also changed with the selection would only make the tile's own width move
 * under a reader clicking along the chips - the tiles beside it shifting sideways on every
 * pick. Static text keeps the whole strip still while the tray does the talking.
 */
export function roundEvidenceCountLabel(group: RoundGroupView): string {
  if (group.segments.some((segment) => segment.verifiedShipping)) return "review + shipping";
  return `${group.segments.length} evidence`;
}

/** A tray chip's own name: one-based for a human, as the round label counts it. */
export function evidenceChipLabel(segment: RoundView): string {
  if (segment.verifiedShipping) return "verified shipping";
  return `evidence ${segment.segment + 1}`;
}

/**
 * How many of this round's captures failed.
 *
 * The tile wears the NEWEST capture's status, and only the open round draws a tray - so
 * without this a failure that happened mid-round vanished the moment the reader looked at a
 * different round. Round 2 could hold a failed capture while round 3 is on screen, and
 * round 2's tile would report nothing but its newest state. That is the one thing collapsing
 * a round must not hide, and it is what the marker beside the count badge exists to say.
 *
 * Counts every failed capture in the round, including the newest. A round parked on a failure
 * says so twice - once in its status line, once here - which is redundant rather than wrong,
 * and the alternative (excluding the head) makes the number mean "failures you cannot already
 * see", which is a rule a reader would have to be told.
 */
export function roundFailedCaptureCount(group: RoundGroupView): number {
  return group.segments.filter((segment) => segment.status.tone === "failed").length;
}

/**
 * The tile's failure marker, or null when nothing in the round failed.
 *
 * Selection-independent for the same reason the count badge is: it must not move the strip
 * when a reader clicks along the chips.
 */
export function roundFailedCaptureLabel(group: RoundGroupView): string | null {
  const failed = roundFailedCaptureCount(group);
  return failed === 0 ? null : `${failed} failed`;
}

/**
 * Does this round hold the submission being read?
 *
 * The ownership rule, and the ONE place it is decided. The tile reads it for its pressed and
 * active states; `openEvidenceTray` below reads the same function to pick the tray. Written
 * twice - once here and once inline in the tile's own render - the two drifted the moment
 * either changed, and the tie-break the comment on `runRoundGroups` anticipates for duplicate
 * round numbers is exactly the change that would do it: a tile claiming to be the active
 * round while a different round's tray is the one on screen.
 */
export function roundHoldsViewedSubmission(
  group: RoundGroupView,
  viewedSubmissionId: string | null,
): boolean {
  return group.segments.some((segment) => segment.submissionId === viewedSubmissionId);
}

/**
 * Has this round more than one capture, so a tray has something to offer?
 *
 * The eligibility threshold, and the ONE place it lives. It gates three things that must
 * agree or the tile lies about itself: whether the count badge is drawn, whether the tile
 * reports `aria-expanded` at all, and whether a tray is rendered underneath.
 */
export function roundOpensEvidenceTray(group: RoundGroupView): boolean {
  return group.segments.length > 1;
}

/**
 * Whose tray is open: the round holding the submission being read.
 *
 * One tray at a time, and it belongs to the round on screen rather than to a separate
 * disclosure the reader has to keep in their head. A round with a single snapshot opens
 * nothing - there is no choice to offer - which is why this can answer null for a round that
 * is perfectly well selected, and why the tile cannot derive its OWN ownership from this
 * result: a lone viewed snapshot owns the view while opening no tray. That is the trap this
 * function is composed from the two predicates above rather than duplicating them.
 */
export function openEvidenceTray(
  groups: readonly RoundGroupView[],
  viewedSubmissionId: string | null,
): RoundGroupView | null {
  const group = groups.find((candidate) =>
    roundHoldsViewedSubmission(candidate, viewedSubmissionId));
  return group && roundOpensEvidenceTray(group) ? group : null;
}

function segmentCounts(submissions: readonly WorkflowSubmission[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const submission of submissions) {
    counts.set(submission.round, (counts.get(submission.round) ?? 0) + 1);
  }
  return counts;
}

function roundLabelFor(
  submission: WorkflowSubmission,
  continued: boolean,
  verifiedShipping = false,
): string {
  return `Round ${submission.round}`
    + (submission.mode === "inspector_only" ? " · GitHub Inspector" : "")
    // One-based for a human. `segment` is a durable zero-based index and stays that way in the
    // field beside this; the label is the only place it is counted for reading.
    + (continued
      ? verifiedShipping ? " · verified shipping" : ` · evidence ${submission.segment + 1}`
      : "");
}

/**
 * One submission's round label, for a surface that names a round it is not currently showing.
 *
 * Shared with the scrubber rather than reimplemented beside it: a carried stage that cites
 * "Round 1 · evidence 1" and a scrubber tab reading something else for the same submission
 * would be two dialects for one fact, and the link between them would look broken.
 */
export function submissionRoundLabel(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission,
): string {
  const counts = segmentCounts(detail.submissions);
  return roundLabelFor(
    submission,
    (counts.get(submission.round) ?? 1) > 1,
    submissionIsVerifiedShipping(detail, submission),
  );
}

/**
 * What an evidence segment IS, for the reader who has just scrubbed onto one.
 *
 * The sentence an operator most needs is the one that says this is NOT a repair: a run whose
 * scrubber has grown a second entry looks exactly like a run that failed review, and the
 * difference - a spent repair round versus a free continuation - is the thing the whole
 * segment model exists to keep straight.
 */
export function segmentProvenanceSentence(round: RoundView): string | null {
  if (round.segment === 0) return null;
  if (round.verifiedShipping) {
    return "Verified shipping completion. The pull request is open at the captured commit, "
      + "its published content matches the content accepted by the prior review, and this "
      + "continuation reached End without another evidence review.";
  }
  if (round.refinementReason === "evidence_preflight") {
    return `Evidence ${round.segment + 1} of round ${round.round}, captured to repair evidence preflight gaps. This refinement does not spend a Persona repair round.`;
  }
  const source = round.continuedFrom ?? "a session action";
  return `Evidence ${round.segment + 1} of round ${round.round}, captured after ${source}`
    + " finished. Continuing after an action does not spend a repair round, and only the"
    + " stages after it run again.";
}

/** The Session terminus's chip: what this submission is doing right now. */
export function submissionStatus(
  submission: WorkflowSubmission | null,
  changesRequested: boolean,
): PipelineStatus {
  if (!submission) return { tone: "waiting", label: "No submission yet" };
  switch (submission.status) {
    case "capturing":
      return { tone: "running", label: "Capturing evidence" };
    case "running":
      return { tone: "running", label: "Under review" };
    case "waiting_for_session":
      return changesRequested
        ? { tone: "failed", label: "Changes requested" }
        : { tone: "waiting", label: "Waiting for the session" };
    case "waiting_for_evidence_readiness":
      return { tone: "waiting", label: "Waiting for evidence readiness" };
    case "completed":
      return { tone: "passed", label: "Passed" };
    case "cancelled":
      return { tone: "waiting", label: "Cancelled" };
    case "failed":
      return { tone: "failed", label: "Failed" };
  }
}

/** The latest round intentionally skipped Personas and exists only to re-audit an Inspector fix. */
export function inspectorOnlyRoundSentence(): string {
  return "Persona review bypassed for GitHub Inspector repair.";
}

const REVIEWER_STATUSES: Record<
  WorkflowNodeAttemptState | PersonaVerdict["verdict"],
  PipelineStatus
> = {
  pass: { tone: "passed", label: "Passed" },
  fail: { tone: "failed", label: "Changes requested" },
  queued: { tone: "waiting", label: "Queued" },
  running: { tone: "running", label: "Reviewing" },
  retry_wait: { tone: "waiting", label: "Retrying" },
  // A reviewer never waits on a session, so this row exists only because the state tuple is
  // shared. It reads as a wait rather than an outcome so a mislabelled row can never appear
  // to be an earned pass.
  waiting: { tone: "waiting", label: "Waiting" },
  // Completed with no verdict is a reply the verdict parser rejected; the attempt row below
  // the strip carries the reason, so the chip only has to stop claiming an outcome.
  completed: { tone: "waiting", label: "No verdict" },
  error: { tone: "failed", label: "Provider error" },
  cancelled: { tone: "waiting", label: "Cancelled" },
};

const CHECK_STATUSES: Record<
  WorkflowNodeAttemptState | PersonaVerdict["verdict"],
  PipelineStatus
> = {
  pass: { tone: "passed", label: "Passed" },
  fail: { tone: "failed", label: "Failed" },
  queued: { tone: "waiting", label: "Queued" },
  running: { tone: "running", label: "Running" },
  retry_wait: { tone: "waiting", label: "Retrying" },
  waiting: { tone: "waiting", label: "Waiting" },
  completed: { tone: "waiting", label: "No result" },
  error: { tone: "failed", label: "Command failed to run" },
  cancelled: { tone: "waiting", label: "Cancelled" },
};

/**
 * One reviewer's chip. An absent status is a reviewer this round has not reached, which is
 * a different thing from one that finished with nothing to say.
 */
export function reviewerStatus(raw: string | undefined): PipelineStatus {
  if (!raw) return { tone: "waiting", label: "Not started" };
  return REVIEWER_STATUSES[raw as keyof typeof REVIEWER_STATUSES]
    ?? { tone: "waiting", label: raw.replaceAll("_", " ") };
}

/**
 * The chip for a check whose gate did NOT actually run, which is a different claim from
 * "passed" and must never be collapsed into it.
 *
 * Three of the four check outcomes advance the graph (`checkOutcomePasses`), and only ONE of
 * them means the command ran and succeeded. A slot with no command configured is `skipped`,
 * and a build with no execution runtime records `unavailable` - both pass so a workflow is
 * not broken on an unconfigured machine, and both would otherwise render as a green "Passed"
 * telling an operator that typecheck and test succeeded when neither was ever spawned. That
 * is precisely the assurance the shipped No-Mistakes Review v2 must not fake, so the outcome
 * travels to the chip rather than being reduced to the attempt's synthetic verdict.
 *
 * `degraded` marks "this advanced the pipeline without being earned", which is what lets the
 * stage fold below say so without matching on label text.
 */
const CHECK_OUTCOME_STATUSES: Record<WorkflowCheckStatus, PipelineStatus | null> = {
  // Ran and succeeded: the ordinary verdict mapping already says it correctly.
  passed: null,
  failed: null,
  skipped: {
    tone: "waiting",
    label: "Skipped",
    tooltip: "Skipped because this machine configures nothing for this Command.",
    skipKind: "unconfigured_check",
    degraded: true,
  },
  unavailable: {
    tone: "waiting",
    label: "Not run",
    tooltip: "This Command could not run. Open the run details for its recorded reason.",
    skipKind: "unavailable_check",
    degraded: true,
  },
  // Configured, authorized, and genuinely run earlier in THIS run - so the tooltip names the
  // cap and where to change it rather than describing an absence. Still `degraded`: the stage
  // fold must keep counting this as a gate that did not run, because it did not.
  budget_spent: {
    tone: "waiting",
    label: "Skipped",
    tooltip: "Already ran the most times this run allows. Change the limit in Library › "
      + "Commands.",
    skipKind: "budget_check",
    degraded: true,
  },
};

/**
 * One check's chip.
 *
 * `outcome` is the status the runner recorded, when this attempt carries one. It WINS over
 * the attempt state, because a check that never ran still finishes as a passing attempt and
 * the attempt state alone cannot tell that apart from a command that ran green.
 */
export function checkStatus(
  raw: string | undefined,
  outcome: WorkflowCheckStatus | null = null,
): PipelineStatus {
  const degraded = outcome ? CHECK_OUTCOME_STATUSES[outcome] : null;
  if (degraded) return degraded;
  if (!raw) return { tone: "waiting", label: "Not started" };
  return CHECK_STATUSES[raw as keyof typeof CHECK_STATUSES]
    ?? { tone: "waiting", label: raw.replaceAll("_", " ") };
}

/**
 * The chip for a member the operator disabled for this run.
 *
 * The red tone is deliberate and is NOT "failed": red is the colour of a gate an operator
 * has to notice, and a review switched off is exactly that. `degraded` keeps the claim
 * honest downstream - the stage fold counts a disabled member with the not-run gates
 * rather than calling the stage failed or laundering it into "All passed".
 */
export function disabledMemberStatus(): PipelineStatus {
  return { tone: "failed", label: "Disabled", degraded: true };
}

/**
 * The chip override for an operator-disabled node in ONE viewed round, or `null` when the
 * round's real outcome must show.
 *
 * The disable's promise is scoped to work that has not happened yet, so the chip follows
 * the SAME boundary the engine enforces at claim time. A node the auto-pass will convert -
 * no attempt, a queued or retrying attempt, or one cancelled before any verdict - reads
 * Disabled. A node that already ran this round - completed with a real verdict, still
 * running, or errored - keeps its real chip: painting a recorded failure as Disabled would
 * claim the toggle rewrote an outcome, which is exactly what it never does. The one
 * completed attempt that DOES read Disabled is the engine's own synthetic auto-pass, which
 * marks itself in `output.disabled` so this never has to guess from a verdict's prose.
 * The ROW's red treatment stays either way; only the chip is the round's history.
 */
export function disabledStatusFor(
  disabledNodeIds: readonly string[] | undefined,
  nodeId: string | null | undefined,
  attempt: Pick<WorkflowNodeAttempt, "state" | "verdict" | "output"> | undefined,
): PipelineStatus | null {
  if (!nodeId || !(disabledNodeIds ?? []).includes(nodeId)) return null;
  if (
    !attempt
    || attempt.state === "queued"
    || attempt.state === "retry_wait"
    || (attempt.state === "cancelled" && attempt.verdict === null)
  ) {
    return disabledMemberStatus();
  }
  const output = attempt.output;
  const autoPassed = output !== null
    && typeof output === "object"
    && !Array.isArray(output)
    && output.disabled === true;
  return autoPassed ? disabledMemberStatus() : null;
}

/**
 * A stage's own chip, folded from its members: the worst thing that happened wins, then
 * whatever is still moving, and "passed" only once every member of the stage passed - which
 * is exactly the all-pass rule the stage is compiled from.
 *
 * A member that advanced without running is neither: the stage is finished, so calling it
 * "Waiting" would read as still in flight, and calling it "All passed" would launder the very
 * claim the member chip refuses to make. It gets its own sentence, and the count is what an
 * operator needs to know how much of the gate was real.
 *
 * A degraded red chip - a disabled member - is excluded from the failed fold on purpose:
 * disabling is how an operator forces the stage PAST a member, and a stage that still read
 * "Failed" afterwards would say the toggle did nothing.
 */
export function stageStatus(
  members: readonly PipelineStatus[],
  /**
   * Which kind of stage these members belong to. Omitting it reads as an evaluation wave,
   * which is what every caller predating session actions is.
   */
  kind: Stage["kind"] = "evaluation",
): PipelineStatus {
  // A session action stage IS its one member, so the fold is the identity. Running it through
  // the all-pass logic below turned a finished action into a stage headed "Passed" - the
  // exact claim the member's own chip refuses to make, restated one line above it.
  if (kind === "session_action") return members[0] ?? { tone: "waiting", label: "Not started" };
  if (members.length === 0) return { tone: "waiting", label: "No members" };
  if (members.some((status) => status.tone === "failed" && !status.degraded)) {
    return { tone: "failed", label: "Failed" };
  }
  if (members.some((status) => status.tone === "running")) {
    return { tone: "running", label: "Running" };
  }
  const notRun = members.filter((status) => status.degraded).length;
  if (members.every((status) => status.tone === "passed" || status.degraded)) {
    if (notRun === 0) {
      return { tone: "passed", label: members.length > 1 ? "All passed" : "Passed" };
    }
    const skipped = members.filter((status) =>
      status.skipKind === "unconfigured_check").length;
    const allSkipped = skipped === members.length;
    const tooltip = allSkipped
      ? "Skipped because this machine configures nothing for the Commands in this stage."
      : "One or more Commands in this stage did not run. Hover each one for its reason.";
    return notRun === members.length
      ? {
          tone: "waiting",
          label: allSkipped ? "Skipped" : notRun > 1 ? "None ran" : "Did not run",
          tooltip,
          ...(allSkipped ? { skipKind: "unconfigured_check" as const } : {}),
          degraded: true,
        }
      : {
          tone: "waiting",
          label: `Passed, ${notRun} ${skipped === notRun ? "skipped" : "not run"}`,
          tooltip,
          degraded: true,
        };
  }
  return { tone: "waiting", label: "Waiting" };
}

/**
 * The End terminus's chip. The LIVE run decides it only while the newest round is being
 * viewed: an older round that returned to Session never reached the End, and reading the
 * run's current status onto it would show a completed run's End as reached on the round
 * that failed.
 */
export function endStatus(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission | null,
  isLatest: boolean,
): PipelineStatus {
  if (isLatest && detail.run.status === "completed") {
    return { tone: "passed", label: "Completed" };
  }
  if (isLatest && detail.summary.gate !== "none" && detail.summary.gate !== "clean") {
    return { tone: "waiting", label: "GitHub Inspector gate" };
  }
  if (submission?.status === "completed") return { tone: "passed", label: "Reached" };
  return { tone: "waiting", label: "Not reached" };
}

const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  capturing: "Capturing evidence",
  running: "Reviewing",
  waiting_for_session: "Waiting for the session",
  waiting_for_pr: "Waiting for a pull request",
  waiting_for_inspector: "Waiting for GitHub Inspector",
  waiting_for_new_head: "Waiting for a new pushed head",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  // Deliberately distinct from "Waiting for the session": that one is a parked repair round
  // a human can resubmit, while this is one authored instruction the daemon is watching to
  // finish. A reader who cannot tell them apart cannot tell whether the run owes them
  // anything.
  waiting_for_action: "Waiting for a session action",
  waiting_for_evidence_readiness: "Waiting for evidence readiness",
};

export function runStatusLabel(status: WorkflowRunStatus): string {
  return RUN_STATUS_LABELS[status];
}

/**
 * Why a stopped run stopped, as a short clause to hang off its status word.
 *
 * The sibling of `GATE_WAIT_SENTENCES` below, and deliberately a different grain: those are
 * whole sentences for a run's own page, these are three or four words for a triage column
 * that is 240px of 10px mono. "Blocked" alone is the complaint this map answers - it is true
 * of thirty rows at once and actionable on none of them.
 *
 * `phase` is a free `string` and NOT a union: `orphanBinding` and every `setRunState` caller
 * write their own reason code into it, and new ones appear without this map hearing about
 * it. So the lookup FALLS BACK to `phase.replaceAll("_", " ")`, which is the same fallback
 * `alerts.ts` already prints reasons with - two surfaces reading one field must not disagree
 * about what an unmapped code looks like, and an unmapped code has to degrade to readable
 * text rather than to `undefined`.
 */
const BLOCKED_PHASE_CLAUSES: Record<string, string> = {
  session_disappeared: "session gone",
  round_limit: "out of rounds",
  // Written by the gate as an EVENT kind today rather than as a phase (the phase it sets is
  // `round_limit`), so this entry is insurance rather than a live case. It costs one line and
  // it means a later code change cannot silently produce "inspector round limit" prose.
  inspector_round_limit: "out of GitHub Inspector rounds",
  infrastructure_error: "review execution failed",
  evidence_reconciliation_error: "criterion mapping unavailable",
  inspector_findings: "GitHub Inspector findings",
  inspector_disabled: "GitHub Inspector off",
  inspector_pr_closed: "PR closed",
  inspector_head_mismatch: "head moved",
  inspector_gate_context_invalid: "gate context lost",
  delivery_uncertain: "delivery unconfirmed",
  delivery_refused: "delivery refused",
  delivery_blocked: "delivery blocked",
  stale_capture: "evidence went stale",
  capture_error: "capture failed",
  // The manager's two refusals for an evidence snapshot that did not move between rounds. Both
  // were missing, so a run parked on either printed the raw phase code through the fallback
  // below - "unchanged evidence exhausted" - in the one column whose whole job is being read.
  unchanged_evidence: "evidence unchanged",
  unchanged_evidence_exhausted: "evidence never changed",
  // Not a block at all: the binding was reattached to a live session and the run is parked
  // until somebody opens the next round. The clause says what HAPPENED; the remedy button
  // beside it says what to do about it, which is why this is not "reattached, needs
  // resubmit" - the second half would be the button repeating itself into a column that
  // cannot hold it.
  reattached_resubmit_required: "reattached",
};

/** The short cause for `phase`, or the phase code made readable when it is unmapped. */
export function blockedPhaseClause(phase: string): string {
  return BLOCKED_PHASE_CLAUSES[phase] ?? phase.replaceAll("_", " ");
}

const GATE_WAIT_SENTENCES: Record<WorkflowGateWaitReason, string> = {
  missing_pr: "No pull request has been opened for this work yet.",
  unadopted_pr: "A pull request exists, but GitHub Inspector has not adopted it as one we opened.",
  inspector_disabled: "GitHub Inspector is switched off, so the gate cannot be evaluated.",
  awaiting_fresh_observation: "Waiting for GitHub Inspector's next sweep to observe the pushed head.",
  working_tree_not_pushed: "The captured working tree has changes that were never committed and pushed.",
  head_mismatch: "The pull request's head is not the commit this submission reviewed.",
  review_pending: "GitHub Inspector has the pull request and has not finished reviewing it.",
  review_backoff: "GitHub Inspector's review failed and is waiting out its retry backoff.",
  review_error: "GitHub Inspector's last review attempt errored.",
  findings: "GitHub Inspector left findings that have to be resolved.",
  pr_closed: "The adopted pull request was closed or switched.",
};

/** What the Inspector gate is waiting on, as a sentence. `null` means it is satisfied. */
export function gateWaitSentence(reason: WorkflowGateWaitReason | null): string {
  return reason === null
    ? "GitHub Inspector has reviewed the exact head this submission produced."
    : GATE_WAIT_SENTENCES[reason];
}

/** Why a spent Inspector-only gate cannot treat the current ledger as clean proof. */
export type SpentInspectorEvidenceProblem =
  | "missing_inspection"
  | "pull_request_mismatch"
  | "pull_request_closed"
  | "missing_observation"
  | "head_mismatch"
  | "review_not_live"
  | "review_error"
  | "finding_ledger_inconsistent";

/**
 * The current Inspector condition beside a spent gate's immutable historical observation.
 *
 * This is presentation only. In particular, `clean_exact_head` does not pass the gate: it
 * merely earns the contextual label on the existing grant route. The daemon still re-enters
 * the gate, observes the head again and owns the immutable Inspector-only submission.
 */
export type SpentInspectorGateCondition =
  | {
      kind: "historical_findings_open";
      currentOpenFindings: number;
      historicalOpenFindings: number;
    }
  | { kind: "current_findings_open"; currentOpenFindings: number }
  | { kind: "awaiting_current_review"; observedHeadSha: string }
  | { kind: "clean_exact_head"; headSha: string }
  | { kind: "evidence_unavailable"; problem: SpentInspectorEvidenceProblem };

/**
 * Reconcile one spent Inspector-only gate with the CURRENT Inspector ledger.
 *
 * Every clean prerequisite is positive: an open observed PR, identical observed and reviewed
 * heads, a live review under a currently live Inspector posture, no review error, zero open
 * findings, tally agreement, and a resolved row for every historical fingerprint. A missing
 * or contradictory fact fails closed instead of promoting historical state into current truth.
 */
export function spentInspectorGateCondition(
  detail: WorkflowRunDetail,
): SpentInspectorGateCondition | null {
  const gate = detail.inspectorGate;
  const latest = orderedSubmissions(detail).at(-1);
  if (
    !gate
    || latest?.mode !== "inspector_only"
    || !workflowRunGaveUp({
      status: detail.run.status,
      phase: detail.run.currentPhase,
      round: detail.summary.round,
      maxRepairRounds: detail.summary.maxRepairRounds,
    })
  ) return null;

  const inspection = gate.inspection;
  if (!inspection) return { kind: "evidence_unavailable", problem: "missing_inspection" };
  if (!gate.state.prKey || inspection.key !== gate.state.prKey) {
    return { kind: "evidence_unavailable", problem: "pull_request_mismatch" };
  }
  if (inspection.state !== "open" || inspection.observedState !== "OPEN") {
    return { kind: "evidence_unavailable", problem: "pull_request_closed" };
  }
  if (!inspection.observedHeadSha) {
    return { kind: "evidence_unavailable", problem: "missing_observation" };
  }

  const openRows = gate.findings.filter((finding) => finding.status !== "resolved");
  const resolvedRows = gate.findings.filter((finding) => finding.status === "resolved");
  const findingsByFingerprint = new Map(
    gate.findings.map((finding) => [finding.fingerprint, finding]),
  );
  const historicalRows = gate.state.findingFingerprints.map((fingerprint) =>
    findingsByFingerprint.get(fingerprint));
  if (
    openRows.length !== inspection.openFindings
    || resolvedRows.length !== inspection.resolvedFindings
    || historicalRows.some((finding) => !finding)
  ) {
    return { kind: "evidence_unavailable", problem: "finding_ledger_inconsistent" };
  }

  const historicalOpenFindings = historicalRows.filter((finding) =>
    finding?.status !== "resolved").length;
  if (historicalOpenFindings > 0) {
    return {
      kind: "historical_findings_open",
      currentOpenFindings: openRows.length,
      historicalOpenFindings,
    };
  }
  if (openRows.length > 0) {
    return { kind: "current_findings_open", currentOpenFindings: openRows.length };
  }
  if (inspection.lastError !== null) {
    return { kind: "evidence_unavailable", problem: "review_error" };
  }
  if (inspection.headSha === null) {
    return {
      kind: "awaiting_current_review",
      observedHeadSha: inspection.observedHeadSha,
    };
  }
  if (inspection.headSha !== inspection.observedHeadSha) {
    return { kind: "evidence_unavailable", problem: "head_mismatch" };
  }
  if (inspection.reviewPosture !== "live" || gate.inspector.posture !== "live") {
    return { kind: "evidence_unavailable", problem: "review_not_live" };
  }
  return { kind: "clean_exact_head", headSha: inspection.observedHeadSha };
}

const SPENT_EVIDENCE_SENTENCES: Record<SpentInspectorEvidenceProblem, string> = {
  missing_inspection: "Current Inspector evidence is unavailable for this stopped workflow.",
  pull_request_mismatch: "Current Inspector evidence belongs to a different pull request than this workflow's historical gate.",
  pull_request_closed: "Current Inspector reports that the pull request is no longer open.",
  missing_observation: "Current Inspector has not recorded an open pull-request head yet.",
  head_mismatch: "Current Inspector has not reviewed the exact pull-request head it most recently observed.",
  review_not_live: "Current Inspector's exact-head review was not produced under a live review posture.",
  review_error: "Current Inspector's latest review evidence includes an error and cannot be adopted.",
  finding_ledger_inconsistent: "Current Inspector finding totals do not reconcile with this workflow's historical finding record.",
};

/** The current-truth sentence for a spent gate, with live-gate wording left unchanged. */
export function inspectorGateSentence(detail: WorkflowRunDetail): string {
  const condition = spentInspectorGateCondition(detail);
  if (!condition) return gateWaitSentence(detail.inspectorGate?.state.waitReason ?? null);
  switch (condition.kind) {
    case "historical_findings_open":
      return `Current Inspector still has ${condition.currentOpenFindings} open finding${condition.currentOpenFindings === 1 ? "" : "s"}; ${condition.historicalOpenFindings} ${condition.historicalOpenFindings === 1 ? "was" : "were"} recorded when this workflow stopped.`;
    case "current_findings_open":
      return `The workflow's historical findings are resolved, but Current Inspector has ${condition.currentOpenFindings} open finding${condition.currentOpenFindings === 1 ? "" : "s"}.`;
    case "awaiting_current_review":
      return `The workflow's historical findings are resolved. Current Inspector has observed ${shortSha(condition.observedHeadSha) ?? condition.observedHeadSha}, but has not reviewed that exact head yet.`;
    case "clean_exact_head":
      return `Current Inspector reviewed the exact open pull-request head ${shortSha(condition.headSha) ?? condition.headSha} live with no open findings. The workflow remains stopped until you adopt it.`;
    case "evidence_unavailable":
      return SPENT_EVIDENCE_SENTENCES[condition.problem];
  }
}

/** Compact current-state status for spent gate surfaces; `null` keeps ordinary gate status. */
export function spentInspectorGateStatus(detail: WorkflowRunDetail): PipelineStatus | null {
  const condition = spentInspectorGateCondition(detail);
  if (!condition) return null;
  switch (condition.kind) {
    case "historical_findings_open":
    case "current_findings_open":
      return { tone: "failed", label: "Findings remain" };
    case "awaiting_current_review":
      return { tone: "waiting", label: "Review pending" };
    case "clean_exact_head":
      // Deliberately not green: the durable workflow and its Shipping veto are still active.
      return { tone: "waiting", label: "Clean head ready" };
    case "evidence_unavailable":
      return { tone: "failed", label: "Evidence unavailable" };
  }
}

const GATE_SUMMARIES: Record<WorkflowGateSummary, PipelineStatus> = {
  none: { tone: "waiting", label: "No gate" },
  waiting_pr: { tone: "waiting", label: "Waiting for a PR" },
  waiting_inspector: { tone: "waiting", label: "Waiting for GitHub Inspector" },
  findings: { tone: "failed", label: "Findings" },
  clean: { tone: "passed", label: "Clean" },
  blocked: { tone: "failed", label: "Blocked" },
};

/** The gate's one-word state, for a chip. The sentence beside it says what it is waiting on. */
export function gateSummaryStatus(gate: WorkflowGateSummary): PipelineStatus {
  return GATE_SUMMARIES[gate];
}

/**
 * The same chip, for the fixed footer, where `none` means something different.
 *
 * The footer only exists when the workflow's completion policy IS Inspector, so `none` there
 * cannot mean "this workflow has no gate" - it means the run has not reached it yet. Printing
 * "No gate" under a card that says it reviews the pull request is the surface contradicting
 * itself, and it is what a live run shows for most of its life. "Not reached" is the End
 * terminus's own word for exactly this state, so the two read as one sentence.
 */
export function inspectorFooterStatus(gate: WorkflowGateSummary): PipelineStatus {
  return gate === "none" ? { tone: "waiting", label: "Not reached" } : GATE_SUMMARIES[gate];
}

const DELIVERY_SENTENCES: Record<WorkflowDeliveryState, { label: string; sentence: string }> = {
  prepared: {
    label: "Prepared",
    sentence: "The exact repair packet is stored. Preview never types it into the session.",
  },
  sending: { label: "Sending", sentence: "The packet is being typed into the session's pane." },
  delivered: { label: "Delivered", sentence: "The packet reached the session and was credited to the workflow." },
  refused: {
    label: "Refused",
    sentence: "Nothing was written: the pane refused before a single character was typed, so this can be retried safely.",
  },
  uncertain: {
    label: "Delivery uncertain",
    sentence: "The write was lost or may have landed. It is never sent again automatically - inspect the pane, then resolve it below.",
  },
  cancelled: { label: "Cancelled", sentence: "This packet was superseded before it was sent." },
};

export function deliveryStateView(state: WorkflowDeliveryState): { label: string; sentence: string } {
  return DELIVERY_SENTENCES[state];
}

/**
 * What each packet IS, for the header of its card.
 *
 * A `Record` over the durable enum rather than `kind.replaceAll("_", " ")`, which this replaced:
 * that rendered `unchanged evidence nudge` at a reader with no way to tell it apart from a
 * review, and a fifth kind would have appeared as raw snake_case with nobody noticing. Now a new
 * kind fails typecheck here until someone says what it means to a human.
 */
const DELIVERY_KIND_LABELS: Record<WorkflowDeliveryKind, string> = {
  persona_feedback: "Review feedback",
  inspector_feedback: "GitHub Inspector findings",
  pr_handoff: "PR handoff",
  unchanged_evidence_nudge: "Nothing changed",
  session_action: "Session action",
  parked_repair_reminder: "Reminder",
  evidence_readiness: "Evidence preflight",
};

export function deliveryKindLabel(kind: WorkflowDeliveryKind): string {
  return DELIVERY_KIND_LABELS[kind];
}

/**
 * Everything the run record's tab bar and its panes need to COUNT, derived once.
 *
 * The tab labels carry counts and an amber badge, and a closed pane still has to report
 * honestly - which makes every one of these numbers a claim a reader acts on without opening
 * the pane that holds the rows behind it. A count computed inline in JSX can only be checked
 * by rendering markup and reading a digit back out, and "the collapsed row states a wrong
 * number" is the new failure this consolidation introduces. So they are derived here, once,
 * and the view prints them.
 *
 * `blocking` is the sharp one and it means exactly "this pane holds something that STOPS the
 * run", never "this pane has warnings". A refused or uncertain delivery has stopped the packet
 * reaching the session; a captured context this build cannot read has stopped the round being
 * auditable. A pruned payload, a truncated diff and a deterministic compaction fallback are
 * all facts a reader may want and none of them stops anything, so none of them raises a badge.
 */
export interface RunRecordDeliverySummary {
  total: number;
  delivered: number;
  refused: number;
  uncertain: number;
  /** `prepared` and `sending` together: in flight, and not yet an outcome either way. */
  inFlight: number;
  cancelled: number;
  /** The newest CONFIRMED delivery, which is a different fact from the newest row. */
  newestDeliveredAt: number | null;
  /** How many of these packets belong to the round being read. */
  inViewedRound: number;
  blocking: boolean;
}

/** What the Intent pane is, before any of its bodies are read. */
export type RunRecordIntentState = "captured" | "not_captured" | "corrupt" | "unreadable";

export interface RunRecordIntentSummary {
  state: RunRecordIntentState;
  /** Null on every state but `captured`, and on a captured snapshot with no refinement. */
  refinedGoal: string | null;
  rawGoalCharacters: number;
  hasOpeningAsk: boolean;
  openingAskCharacters: number;
  decisionCount: number;
  /** Total characters across every decision body and rationale - the block this phase bounds. */
  decisionCharacters: number;
  decisionsWithRationale: number;
  constraintCount: number;
  acceptanceCriterionCount: number;
  /** Null unless the snapshot is readable. `model` names the runner that compacted it. */
  compaction: { status: "model" | "fallback"; runner: string | null; model: string | null } | null;
  evidencePruned: boolean;
  blocking: boolean;
}

export interface RunRecordSummary {
  deliveries: RunRecordDeliverySummary;
  intent: RunRecordIntentSummary;
}

/**
 * The intent state of the ROUND being read, which is not the same question as `contextState`.
 *
 * `detail.contextState` is the run's verdict - the newest full submission's kind, or `corrupt`
 * if any of them is - so it cannot say whether the round a scrubber selected is readable. A
 * round that says `captured` and does not parse is `unreadable`, which is a state the pane
 * draws rather than a crash.
 */
function runRecordIntentState(
  detail: WorkflowRunDetail,
  viewed: WorkflowSubmission | null,
): { state: RunRecordIntentState; context: WorkflowContextSnapshot | null } {
  if (detail.contextState === "not_captured") return { state: "not_captured", context: null };
  if (detail.contextState === "corrupt") return { state: "corrupt", context: null };
  const round = viewed?.mode === "full_workflow" ? viewed : null;
  if (!round) return { state: "not_captured", context: null };
  const context = readCapturedContext(round.context);
  return context ? { state: "captured", context } : { state: "unreadable", context: null };
}

export function runRecordSummary(
  detail: WorkflowRunDetail,
  viewed: WorkflowSubmission | null,
): RunRecordSummary {
  const deliveries = detail.deliveries;
  const byState = (state: WorkflowDeliveryState): number =>
    deliveries.filter((delivery) => delivery.state === state).length;
  const refused = byState("refused");
  const uncertain = byState("uncertain");
  const delivered = deliveries.filter((delivery) => delivery.state === "delivered");
  const viewedRound = viewed
    ? detail.submissions.find((submission) => submission.id === viewed.id)?.round ?? null
    : null;
  const roundOf = (submissionId: string): number | null =>
    detail.submissions.find((submission) => submission.id === submissionId)?.round ?? null;
  const { state, context } = runRecordIntentState(detail, viewed);
  const decisions = context?.humanDecisions ?? [];
  return {
    deliveries: {
      total: deliveries.length,
      delivered: delivered.length,
      refused,
      uncertain,
      inFlight: byState("prepared") + byState("sending"),
      cancelled: byState("cancelled"),
      // `deliveredAt`, never `updatedAt`: a refused packet transitions too, and the strip's
      // "Newest" is the last time something actually reached the session.
      newestDeliveredAt: delivered.reduce<number | null>(
        (newest, delivery) => delivery.deliveredAt !== null
          && (newest === null || delivery.deliveredAt > newest)
          ? delivery.deliveredAt
          : newest,
        null,
      ),
      inViewedRound: viewedRound === null
        ? 0
        : deliveries.filter((delivery) => roundOf(delivery.submissionId) === viewedRound).length,
      blocking: refused > 0 || uncertain > 0,
    },
    intent: {
      state,
      refinedGoal: context?.primaryGoal.refined ?? null,
      rawGoalCharacters: context?.primaryGoal.rawPrompt.length ?? 0,
      hasOpeningAsk: Boolean(context?.primaryGoal.openingAsk),
      openingAskCharacters: context?.primaryGoal.openingAsk?.length ?? 0,
      decisionCount: decisions.length,
      decisionCharacters: decisions.reduce(
        (total, decision) => total + decision.decision.length + (decision.rationale?.length ?? 0),
        0,
      ),
      decisionsWithRationale: decisions.filter((decision) => Boolean(decision.rationale)).length,
      constraintCount: context?.constraints.length ?? 0,
      acceptanceCriterionCount: context?.acceptanceCriteria.length ?? 0,
      compaction: context
        ? {
            status: context.compaction.status,
            runner: context.compaction.runner,
            model: context.compaction.model,
          }
        : null,
      evidencePruned: context?.evidence.retention?.state === "pruned",
      // `not_captured` is a round that stopped before its snapshot was written - a fact, and
      // one the pane states - but `corrupt` and `unreadable` are a durable record this build
      // cannot audit, which is the thing that stops a reader dead.
      blocking: state === "corrupt" || state === "unreadable",
    },
  };
}

/**
 * How many decisions, and how much prose, the collapsed list is standing in for.
 *
 * One sentence rather than two numbers on the page, because the point of collapsing nine
 * bodies is that the closed summary answers without being opened - and "9 recorded" alone
 * does not say that opening them costs twenty-one thousand characters of reading.
 */
export function humanDecisionsSummary(intent: RunRecordIntentSummary): string {
  if (intent.decisionCount === 0) return "None captured.";
  return `${intent.decisionCount} recorded, `
    + `${intent.decisionCharacters.toLocaleString()} characters in total`;
}

/** One decision's own summary line, for the row that opens it. */
export function humanDecisionSummary(decision: {
  decision: string;
  rationale: string | null;
}): string {
  const characters = decision.decision.length + (decision.rationale?.length ?? 0);
  return `${characters.toLocaleString()} characters`
    + (decision.rationale ? " · has rationale" : "");
}

/**
 * The first line of a body, for a row a reader scans before deciding to open it.
 *
 * Trimmed and cut at the first newline rather than at a character count, because the first
 * line of a recorded decision is a sentence somebody wrote and the first eighty characters of
 * it are not. The cap is the fallback for a body with no newline at all; the row clamps to one
 * line in CSS, so this is about what reaches the markup, not about what fits.
 */
export function firstLineOf(body: string, cap = 160): string {
  const line = body.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

/**
 * Which pane the container opens on, resolved ONCE per run.
 *
 * The amber badge alone does not satisfy "a blocking state cannot hide": a badge on a tab
 * nobody clicks is still a click away from the thing that stopped the run. So the order is:
 *
 *  1. the pane the route names, WHEN that pane is offered for this run. An explicit pane wins
 *     over a blocking one, so a link and the back button stay honest. The presence guard is
 *     load-bearing rather than defensive: a pane is conditional, so a stale or hand-typed
 *     name would otherwise select a tab that is not in the bar and leave the container drawing
 *     nothing. An unavailable name is IGNORED here rather than acted on, and the container
 *     spends no history entry putting the reader somewhere else - the router's own
 *     canonicalization drops an unrecognised query value with `replaceState`, exactly as it
 *     already drops an unknown run `status`, so the back button survives either way;
 *  2. the worklist, when the worklist itself is blocking. It is the primary object, and a run
 *     with both an open change and a refused delivery must not bury the change;
 *  3. the first blocking pane in tab order;
 *  4. the worklist.
 *
 * It is an INITIAL selection. A delivery that turns refused while someone is reading Intent
 * raises the badge on Deliveries and does not move them; re-deriving this on every detail
 * refresh would yank a reader out of the pane they chose.
 */
export function initialRunRecordPane<Pane extends string>(
  panes: readonly { id: Pane; blocking: boolean }[],
  routePane: Pane | null | undefined,
  fallback: Pane,
): Pane {
  if (routePane && panes.some((pane) => pane.id === routePane)) return routePane;
  const worklist = panes.find((pane) => pane.id === fallback);
  if (worklist?.blocking) return worklist.id;
  return panes.find((pane) => pane.blocking)?.id ?? fallback;
}

/**
 * Why a parked run is standing still, in one sentence, or nothing.
 *
 * The gap this closes is the quietest one on the page. A parked round shows a status and a
 * primary and says nothing at all about the observer that is supposed to pick it up - so a
 * run whose session simply never acted looked exactly like a run whose session was busy,
 * for as long as it took the operator to give up and click. Every one of the observer's
 * gates now records why it held, and this turns the last one into prose.
 *
 * The posture clause is appended rather than rendered separately because the two are one
 * thought: "waiting on the session" is a promise on a self-resuming run and an instruction
 * on every other kind, and an operator who cannot see which reads the first as the second.
 * It is stated only when the loop does NOT close itself, since that is the case the page has
 * never mentioned and the one where waiting is the wrong thing to do.
 */
export function runParkedSentence(detail: WorkflowRunDetail): string | null {
  const resumption = detail.resumption;
  if (!resumption) return null;
  /*
   * One statement of one fact. The pre-capture refusal above says the repository has not
   * moved, in the operator's own terms and about the round they just tried to open; the
   * observer's withheld reason is the same finding on a fifteen-second timer. Printing both
   * reads as two separate problems, and the older half is the less useful one.
   */
  if (
    resumption.reason === "repository_unchanged"
    && detail.run.currentPhase === WORKFLOW_UNCHANGED_REPOSITORY_PHASE
  ) return null;
  const sentence = workflowResumptionWithheldSentence(
    resumption.reason,
    resumption.round ?? detail.summary.round,
  );
  if (!sentence) return null;
  return resumption.resumesItself
    ? sentence
    : `${sentence} This review does not resume on its own, so the next round is yours to start.`;
}

/**
 * Why the last resubmission was refused, for a run that still has a move.
 *
 * The header's existing sentence is the NO-MOVE one: it explains an empty action row. A
 * refused resubmission is the opposite shape - the daemon said no, and put a different button
 * in place of the one that was clicked - so nothing drew the reason, and the repaint from
 * "Start repair round 2" to "Review it anyway" read as a click that had done something
 * unexplained. That is the same complaint the grant's silence produced, one screen along.
 *
 * Two phases, two sentences, because the two refusals cost different things: one was declined
 * before any round was opened, the other after a snapshot was already captured. Saying "no
 * round was spent" about the second would be false.
 */
export function runRefusedSentence(detail: WorkflowRunDetail): string | null {
  const round = detail.summary.round;
  switch (detail.run.currentPhase) {
    case WORKFLOW_UNCHANGED_REPOSITORY_PHASE:
      return `The repository has not changed since round ${round} - same commit, same working`
        + " tree - so that round was refused before it could be opened, and nothing was spent.";
    case "unchanged_evidence":
      return `The evidence captured for round ${round} is identical to the round before it,`
        + " so the reviewers were not run against it.";
    default:
      return null;
  }
}

/**
 * What the grant did, for as long as it is still the last thing that happened.
 *
 * The grant was the one primary on this page with no visible result. It raises a number and,
 * for a self-resuming run, hands the run back to its observer - and neither of those draws
 * anything, so the click read as a click that failed. It was reported as exactly that.
 *
 * Derived from the ledger and the current round rather than held in component state, which is
 * what makes it correct rather than merely present. A grant whose HTTP response was lost, a
 * grant replayed under its retained request id, and a grant applied from another tab all
 * produce the same event and therefore the same notice; and the notice disappears on its own
 * the moment the round it bought actually starts, with nothing to remember to clear.
 */
export function runGrantNotice(detail: WorkflowRunDetail): string | null {
  /*
   * `detail.repairGrant`, NOT a scan of `detail.events`.
   *
   * The first version scanned the events, and they are a page - the oldest two hundred rows,
   * with a cursor for the rest. A grant cannot happen until a run has exhausted its repair
   * budget, so it is always a late event, and a run that spent five rounds keeps it outside
   * that page entirely. The notice would have been missing on every run long enough to have
   * been granted anything, which is the silence this whole thing exists to end.
   */
  const grant = detail.repairGrant;
  if (!grant) return null;
  // Stale the instant a later round exists: the grant has been spent and the run's own state
  // is the better story from then on.
  if (detail.summary.round > grant.round) return null;
  const budget = grant.to;
  /*
   * Stated as the round it reaches, not as the budget it raised, because the eyebrow three
   * lines above already prints `round N of ${maxRepairRounds + 1}`. Both numbers are correct
   * and they are not the same number - the budget counts REPAIRS, the eyebrow counts rounds
   * including the first submission - so a notice that said "raised to 3 rounds" beside an
   * eyebrow reading "round 2 of 4" would make a reader stop and work out which one lied.
   */
  return `Repair budget raised. Round ${budget + 1} is now the last this run can reach.`;
}

const ATTEMPT_STATE_LABELS: Record<WorkflowNodeAttemptState, string> = {
  queued: "queued",
  running: "reviewing",
  retry_wait: "waiting to retry",
  completed: "completed",
  error: "errored",
  cancelled: "cancelled",
  waiting: "waiting for the session action",
};

/**
 * What a waiting session action is waiting FOR, as the sentence a reader gets.
 *
 * A `Record` over the durable enum for `DELIVERY_KIND_LABELS`' reason: a wait reason added
 * to the runtime fails typecheck here until somebody says what it means to a human. The
 * wording never claims progress the runtime has not proven - "sent" is not "read", and
 * "read" is not "finished".
 */
const ACTION_WAIT_SENTENCES: Record<SessionActionWaitReason, string> = {
  preparing: "Preparing the instruction for the bound session.",
  awaiting_send: "The instruction is ready and has not been sent to the session yet.",
  awaiting_pickup: "Sent. Waiting for the session to pick the instruction up.",
  working: "The session is working on the instruction.",
  needs_operator: "The session is waiting on an answer from you before it can continue.",
  awaiting_proof: "The turn finished. Waiting for the proof this action requires.",
  capturing: "Capturing fresh evidence before the downstream stages run.",
  awaiting_pull_request:
    "The turn finished. Waiting for a pull request on this branch that Mission Control opened.",
  awaiting_pushed_head:
    "The pull request is open. Waiting for the reviewed commit to reach it.",
  pull_request_wrong_repository:
    "This turn opened a pull request in a different repository, so it is not the one this "
    + "action is for. Open one on this repository, or reset the run.",
  pull_request_wrong_branch:
    "This turn opened a pull request from a different branch, so it does not carry the "
    + "reviewed commit. Open one from this branch, or reset the run.",
  queued_for_conversation:
    "Ready to send, and waiting for another repository's review to finish using this "
    + "session's turn. It goes out on its own; nothing is needed from you.",
};

export function actionWaitSentence(reason: SessionActionWaitReason): string {
  return ACTION_WAIT_SENTENCES[reason];
}

/**
 * The CHIP a waiting session action carries, in two or three words.
 *
 * A separate table from `REVIEWER_STATUSES` and `CHECK_STATUSES`, and the separation is the
 * point of this whole axis: those two answer "what did it decide", and an action decides
 * nothing. Every label here is a stage of one turn's lifecycle, and none of them is a
 * verdict - there is no Passed, no Failed and no "Changes requested" in this table, because
 * a chip that said any of them would claim the action judged the work.
 *
 * `capturing` is the one worth reading twice: it is the moment between "the turn finished"
 * and "the stages below can start", and calling it Complete there would put a finished mark
 * on a stage whose downstream evidence does not exist yet.
 */
const ACTION_WAIT_STATUSES: Record<SessionActionWaitReason, PipelineStatus> = {
  preparing: { tone: "waiting", label: "Preparing" },
  awaiting_send: { tone: "waiting", label: "Ready to send" },
  awaiting_pickup: { tone: "running", label: "Sent" },
  working: { tone: "running", label: "Session working" },
  // Amber-as-attention, the tone the fleet uses for a gate a human has to clear. Deliberately
  // not "failed": nobody has decided anything, the turn is simply parked on a question.
  needs_operator: { tone: "waiting", label: "Needs you" },
  awaiting_proof: { tone: "running", label: "Verifying" },
  capturing: { tone: "running", label: "Capturing evidence" },
  // Both are `awaiting_proof` with the pull request's own vocabulary, and both stay in the
  // running tone: neither is a gate a human has to clear. The split exists because the two
  // point at different work - one is "no pull request yet", the other is "the commit has not
  // reached the pull request" - and a single "Verifying" chip left an operator with no way to
  // tell a session that never ran the skill from one whose push had not landed.
  awaiting_pull_request: { tone: "running", label: "Awaiting PR" },
  awaiting_pushed_head: { tone: "running", label: "Awaiting push" },
  // The one pair here that is NOT the running tone. Everything else in this table is the
  // runtime working and needing nothing; these two are a turn that finished and put its pull
  // request somewhere else, which no amount of waiting corrects on its own. Amber-as-attention
  // is the tone the fleet already uses for that - and deliberately not "failed", because
  // nothing has judged the work and a later adoption can still resolve it.
  pull_request_wrong_repository: { tone: "waiting", label: "PR on another repo" },
  pull_request_wrong_branch: { tone: "waiting", label: "PR on another branch" },
  // The RUNNING tone, not the waiting one, and the distinction is the same one `awaiting_send`
  // draws: this action is authorized and its turn is coming. A multi-repo task's reviews share
  // one pane, so one of them holds the turn and the rest queue - which is the runtime working,
  // not a gate anybody has to clear. Amber here would put "needs you" on the majority of a
  // two-repo task's life and teach an operator to ignore the colour.
  queued_for_conversation: { tone: "running", label: "Queued" },
};

/**
 * One session action's chip.
 *
 * `wait` wins over the attempt state when there is one, because `waiting` alone is the
 * runtime saying "the observer owns this now" and says nothing about how far the turn has
 * got. A completed attempt is Complete rather than Passed - the action ran, and running is
 * all it ever claims.
 */
export function sessionActionStatus(
  raw: string | undefined,
  wait: SessionActionWaitReason | null = null,
): PipelineStatus {
  if (wait) return ACTION_WAIT_STATUSES[wait];
  switch (raw) {
    case undefined: return { tone: "waiting", label: "Not started" };
    case "queued": return { tone: "waiting", label: "Queued" };
    case "running": return { tone: "running", label: "Preparing" };
    case "retry_wait": return { tone: "waiting", label: "Retrying" };
    // Waiting with no reason attached: an attempt written by an older daemon, or one read
    // before its state landed. Honest and non-committal rather than guessed at.
    case "waiting": return { tone: "waiting", label: "Waiting" };
    case "completed": return { tone: "passed", label: "Complete" };
    case "error": return { tone: "failed", label: "Could not run" };
    case "cancelled": return { tone: "waiting", label: "Cancelled" };
    default: return { tone: "waiting", label: raw.replaceAll("_", " ") };
  }
}

/**
 * Why a session action stopped, as a sentence.
 *
 * A `Record` over `SESSION_ACTION_BLOCK_CODES` for `ACTION_WAIT_SENTENCES`' reason: a code
 * appended to the runtime fails typecheck here until somebody says what it means. Every one
 * of them describes a DELIVERY or INFRASTRUCTURE problem, and the wording keeps it that way -
 * none of these is the session doing badly at the work, so none of them may read as one.
 */
const ACTION_BLOCK_SENTENCES: Record<SessionActionBlockCode, string> = {
  adapter_unavailable: "This build cannot prove the completion this action asks for.",
  prompt_too_large: "The authored instruction is larger than one delivery can carry.",
  required_skill_unavailable: "The skill this action requires is not loaded in the bound session.",
  session_lost: "The bound session was gone before the turn finished.",
  conversation_changed: "The session's conversation was replaced, so the turn cannot be attributed.",
  delivery_refused: "The session's pane refused the write, so nothing was typed.",
  delivery_uncertain: "The write may or may not have landed. Check the pane, then resolve it below.",
  capture_failed: "The turn finished, but fresh evidence could not be captured afterwards.",
  expectation_unmet: "The turn finished without the proof this action's completion requires.",
  published_content_changed:
    "The pull request content differs from the content accepted by the prior review, so it must be reviewed again.",
  pull_request_closed:
    "The pull request for this branch is closed or already merged, so this action cannot "
    + "finish against it.",
};

export function actionBlockSentence(code: SessionActionBlockCode): string {
  return ACTION_BLOCK_SENTENCES[code];
}

/**
 * A durable action attempt's observation state, or null when this attempt is not one.
 *
 * Parsed rather than cast, for `checkOutcomeOf`'s reason: this is `output_json` written by a
 * daemon that may be older or newer than the browser reading it, and the render walks into
 * `blocked.code` and `anchor.deliveredAt`. An unreadable shape is reported as absent, which
 * every caller already draws, instead of taking the run view down.
 *
 * This reads the WAITING shape, which a block also keeps (`blockSessionActionAttempt` writes
 * `{...state, blocked}`). A COMPLETED attempt carries a different record entirely - see
 * `sessionActionProgress`, which is what every surface should call.
 */
export function sessionActionStateOf(
  attempt: Pick<WorkflowNodeAttempt, "output">,
): SessionActionAttemptState | null {
  const parsed = SessionActionAttemptStateSchema.safeParse(attempt.output);
  return parsed.success ? (parsed.data as SessionActionAttemptState) : null;
}

/**
 * How far one action attempt got, whichever of the two durable shapes it carries.
 *
 * The runtime writes `output_json` twice and differently: the observation state while the
 * action is waiting (and again, with `blocked` added, when it stops), then a record of what
 * HAPPENED when it completes. One reader for both, because every caller wants the same four
 * facts and the alternative is what shipped first: surfaces that parsed only the waiting
 * shape, so a finished action printed the bare attempt-state word "completed" and threw away
 * the anchor the store had deliberately preserved for exactly this line, and a blocked one -
 * which the runtime records as `state: "error"` - never reached the sentence explaining why.
 */
export interface SessionActionProgress {
  /** What it is waiting FOR, or null once it is no longer waiting. */
  wait: SessionActionWaitReason | null;
  /** Why it stopped, or null. */
  blocked: { code: SessionActionBlockCode; detail: string } | null;
  anchor: SessionActionDeliveryAnchor | null;
  pickedUpAt: number | null;
  settledAt: number | null;
  /**
   * What the completion adapter requires of the capture, or has already proven.
   *
   * The same field on both durable shapes, which is what lets one card explain a waiting
   * action and a finished one without asking which it is reading. `{ kind: "none" }` and null
   * are both "nothing to show" - a `session_turn` action constrains nothing, and a row written
   * by an older daemon recorded nothing.
   */
  expectation: SessionActionContinuationExpectation | null;
  /** The action ran to completion and authorized a continuation segment. */
  complete: boolean;
}

export function sessionActionProgress(
  attempt: Pick<WorkflowNodeAttempt, "output">,
): SessionActionProgress | null {
  const waiting = sessionActionStateOf(attempt);
  if (waiting) {
    return {
      wait: waiting.blocked ? null : waiting.wait,
      blocked: waiting.blocked,
      anchor: waiting.anchor,
      pickedUpAt: waiting.pickedUpAt,
      settledAt: waiting.settledAt,
      expectation: waiting.expectation,
      complete: false,
    };
  }
  const done = SessionActionCompletedOutputSchema.safeParse(attempt.output);
  if (!done.success) return null;
  return {
    wait: null,
    blocked: null,
    anchor: done.data.anchor,
    pickedUpAt: done.data.pickedUpAt,
    settledAt: done.data.settledAt,
    expectation: done.data.expectation,
    complete: true,
  };
}

/**
 * The pull request an action proved, or null when this action proved no such thing.
 *
 * One narrowing helper rather than a `expectation?.kind === "pull_request"` check at each
 * surface, so the ladder, the peek and the run card cannot disagree about when there is a
 * pull request to name.
 */
export function provenPullRequest(
  state: SessionActionProgress | null,
): Extract<SessionActionContinuationExpectation, { kind: "pull_request" }> | null {
  return state?.expectation?.kind === "pull_request" ? state.expectation : null;
}

export function attemptStateLabel(state: WorkflowNodeAttemptState): string {
  return ATTEMPT_STATE_LABELS[state];
}

/**
 * What each check status MEANS, as the sentence a reader gets under the outcome.
 *
 * A `Record` over the durable enum, so a status added to `WORKFLOW_CHECK_STATUSES` fails
 * typecheck here until somebody says what it means to a human - which is the whole reason
 * vocabulary lives in this file rather than inline in the component. `budget_spent` arrived
 * through exactly that door.
 *
 * Four of the five are passes, and each says so differently on purpose: a reader has to be
 * able to tell a gate that ran and was satisfied from one that never ran at all, and the
 * three ways of never running need different things done about them - configure a command,
 * authorize the repository, or raise the run budget.
 */
const CHECK_STATUS_SENTENCES: Record<WorkflowCheckStatus, { label: string; sentence: string }> = {
  passed: {
    label: "Passed",
    sentence: "The configured command ran in this repository and exited zero.",
  },
  failed: {
    label: "Failed",
    sentence: "The configured command ran and exited non-zero. Its output is below.",
  },
  skipped: {
    label: "Skipped",
    sentence: "No Command is configured for this slot on this machine, so the gate passed "
      + "without running.",
  },
  unavailable: {
    label: "Not run",
    sentence: "The gate could not run and passed rather than blocking. The note says why.",
  },
  budget_spent: {
    label: "Skipped",
    sentence: "This Command already ran the most times this run allows, so the gate passed "
      + "without running it again. CI still runs the full suite against the merge commit.",
  },
};

export function checkStatusView(status: WorkflowCheckStatus): { label: string; sentence: string } {
  return CHECK_STATUS_SENTENCES[status];
}

/**
 * The check outcome an attempt recorded, or null when this attempt is not a check.
 *
 * Read from `output_json` rather than re-derived from the synthetic verdict's prose: the
 * exit code and the omitted-byte count are facts the runner measured, and parsing them back
 * out of a sentence is how a display and a gate come to disagree.
 */
export function checkOutcomeOf(
  attempt: Pick<WorkflowNodeAttempt, "output">,
): WorkflowCheckOutcome | null {
  const parsed = WorkflowCheckOutcomeSchema.safeParse(attempt.output);
  return parsed.success ? parsed.data : null;
}

export interface ErrorView {
  sentence: string;
  /** The durable machine string, when the sentence is not simply it. Demoted, never dropped. */
  code: string | null;
}

const ERROR_SENTENCES: Record<string, string> = {
  session_unavailable: "The bound session was gone when the packet was sent.",
  pane_blocked: "The session's pane could not take the write - another write held it, or a dialog was open.",
  delivery_refused: "The pane refused the write before anything was typed.",
  delivery_outcome_unknown: "The write may or may not have landed.",
  outcome_unknown: "The write may or may not have landed.",
};

/**
 * A durable error string as a sentence, keeping the raw string as a detail.
 *
 * The daemon stores two different kinds of thing in these columns - a stable snake_case
 * code it chose, and an exception message it did not - so this decides by shape rather than
 * by asking every call site to know which one it has. A code becomes a sentence when one is
 * written for it and readable words when it is not; a message is already a sentence and is
 * shown as it stands.
 */
export function errorView(raw: string | null | undefined): ErrorView | null {
  if (!raw) return null;
  const isCode = /^[a-z0-9]+(_[a-z0-9]+)*$/.test(raw);
  if (!isCode) return { sentence: raw, code: null };
  return { sentence: ERROR_SENTENCES[raw] ?? sentence(raw.replaceAll("_", " ")), code: raw };
}

/** Capitalise and full-stop a phrase built from a machine string. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** A git object id, shortened for reading. The durable value is never this. */
export function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 12) : null;
}

export interface VerdictMeta {
  runner: string | null;
  model: string | null;
  durationMs: number | null;
  costUsd: number | null;
}

/**
 * The `runner · model · duration · cost` line under a verdict.
 *
 * Runner and model come off the ATTEMPT, which recorded what actually resolved at attempt
 * start - re-deriving them from current settings would relabel history every time an
 * operator changes a default. Cost is summed from the workflow-owned calls this attempt
 * made, and stays `null` unless every one of them reported a price.
 */
export function verdictMeta(
  attempt: WorkflowNodeAttempt,
  calls: readonly WorkflowLlmCall[],
): VerdictMeta {
  const mine = calls.filter((call) => call.nodeAttemptId === attempt.id);
  const priced = mine.length > 0 && mine.every((call) => call.costUsd !== null);
  return {
    runner: attempt.runner,
    model: attempt.model,
    durationMs: attempt.startedAt !== null && attempt.finishedAt !== null
      ? Math.max(0, attempt.finishedAt - attempt.startedAt)
      : null,
    costUsd: priced ? mine.reduce((total, call) => total + (call.costUsd ?? 0), 0) : null,
  };
}

/**
 * What makes two requested changes, raised in two different rounds, THE SAME CHANGE.
 *
 * The prior art is `src/server/inspector/marker.ts`, which fingerprints a pull-request
 * finding over its file plus a normalized title and DELIBERATELY EXCLUDES THE LINE NUMBER.
 * Its comment gives the reason and it holds here unchanged: a finding is anchored to a line,
 * the next edit moves that line, and a location-sensitive identity re-raises every finding
 * on every round - the single most obnoxious thing an automated reviewer can do.
 *
 * Two deliberate divergences from that module, stated here so they read as decisions rather
 * than as drift:
 *
 * - IT LEADS WITH THE OWNING NODE. Exactly one Inspector authors findings on a pull request,
 *   so file plus title cannot collide across authors there. A run has several Personas
 *   reviewing at once, and two of them can object about one file in words that normalize
 *   identically. Folded into one row, that row would carry a single `nodeId`: the losing
 *   reviewer's evidence would vanish and its objection would become un-actionable, because
 *   the worklist's per-row actions - disable this reviewer, give it feedback - act on that
 *   node. A Persona's node id is stable across the rounds of one run, since the version is
 *   immutable, so the node component costs cross-round matching nothing and only ever
 *   prevents cross-reviewer merging.
 * - IT IS NOT HASHED. `marker.ts` digests with `node:crypto`, which the browser bundle cannot
 *   take, and a grouping key has no need to be a digest.
 *
 * The normalization is `marker.ts`'s with one ordering fix: the trim runs before the
 * trailing-punctuation strip as well as after it, so a title ending `". "` loses the period
 * rather than keeping it because a space stood in the way.
 */
export function requestedChangeKey(nodeId: string, change: RequestedChange): string {
  const normalized = change.title
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
  return `${nodeId}\n${change.path ?? ""}\n${normalized}`;
}

/** The attempt that ends one round for one node, with its verdict already read. */
interface FoldedAttempt {
  attempt: WorkflowNodeAttempt;
  /**
   * Parsed ONCE, here, rather than at each of the questions asked of it below.
   *
   * Not an optimization for its own sake: every row's `changeState` interrogates every later
   * round of its own node, so a ten-round run with a full worklist would otherwise re-parse
   * the same verdicts thousands of times on every render of the reader pane.
   */
  verdict: PersonaVerdict | null;
}

/** The run folded to one entry per round per node, plus the anchor every window starts from. */
interface FoldedRun {
  /** Round -> node id -> the attempt that ENDS that round for the node. */
  rounds: Map<number, Map<string, FoldedAttempt>>;
  /**
   * The latest submission's round, WHETHER OR NOT it has produced an attempt yet, or null on
   * a run with no submissions. Same anchor as `repeat-offender.ts`'s `ordered[0].round`.
   */
  latestRound: number | null;
}

/**
 * A REPAIR ROUND, not a submission - the same fold `src/server/workflows/repeat-offender.ts`
 * performs, duplicated here on purpose and to the letter.
 *
 * A session action splits one round into several evidence segments, so walking submissions
 * sees two rows of one round, decides the sequence broke, and reports a reviewer that has
 * failed five rounds running as having failed one. That module's comment says it at length.
 * The rows are folded to one entry per round first, keeping each node's newest attempt across
 * that round's segments, ordered by `segment` then `attempt` exactly as it orders them - down
 * to the guard that keeps a higher-numbered attempt from an earlier segment, so the two
 * derivations cannot disagree about which answer ended a round.
 *
 * DUPLICATED RATHER THAN IMPORTED because that module is server-side - it reads
 * `normalizePersonaVerdict`, which pulls in the model-JSON parser - and this one has to stay
 * in the browser bundle. The duplication is the reason `test/workflow-change-worklist.test.ts`
 * pins `runStalemates` against `repeatOffenders` output rather than against a hand-written
 * expectation: changing the rule in one place has to fail in the other.
 */
function foldRun(detail: WorkflowRunDetail): FoldedRun {
  const ordered = [...detail.submissions].sort((left, right) =>
    right.round - left.round
    || right.segment - left.segment
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id));
  const roundOf = new Map(ordered.map((submission) => [submission.id, submission.round]));
  const segmentOf = new Map(ordered.map((submission) => [submission.id, submission.segment]));
  const byRound = new Map<number, WorkflowNodeAttempt[]>();
  for (const attempt of detail.attempts) {
    const round = roundOf.get(attempt.submissionId);
    if (round === undefined) continue;
    byRound.set(round, [...(byRound.get(round) ?? []), attempt]);
  }
  const rounds = new Map<number, Map<string, FoldedAttempt>>();
  for (const [round, roundAttempts] of byRound) {
    const newest = new Map<string, WorkflowNodeAttempt>();
    const sorted = [...roundAttempts].sort((left, right) =>
      (segmentOf.get(left.submissionId) ?? 0) - (segmentOf.get(right.submissionId) ?? 0)
      || left.attempt - right.attempt);
    for (const attempt of sorted) {
      const previous = newest.get(attempt.nodeId);
      if (previous && previous.attempt > attempt.attempt) continue;
      newest.set(attempt.nodeId, attempt);
    }
    rounds.set(round, new Map([...newest].map(([nodeId, attempt]) => [
      nodeId,
      { attempt, verdict: parsedVerdict(attempt) },
    ])));
  }
  return { rounds, latestRound: ordered[0]?.round ?? null };
}

/**
 * The last round a windowed derivation may look at.
 *
 * The default is the LATEST SUBMISSION'S ROUND, whether or not it has produced an attempt -
 * `repeat-offender.ts` anchors on exactly that, and its `if (!latestAttempts) return []` is a
 * BAIL-OUT rather than a fallback to an older round. Defaulting to "the newest round carrying
 * attempts" would make this file report a stalemate for a round nobody is viewing at the one
 * moment a new round has opened and Stage 1 has not run, while `detail.repeatOffenders` says
 * nothing at all.
 *
 * A requested round above the run's own is clamped rather than emptied, so a stale scrubber
 * selection behaves like `null` instead of blanking the section.
 */
function horizonRound(folded: FoldedRun, asOfRound: number | null): number | null {
  if (folded.latestRound === null) return null;
  return asOfRound === null ? folded.latestRound : Math.min(asOfRound, folded.latestRound);
}

/**
 * A Persona verdict READ rather than cast, for the cross-round derivations only.
 *
 * `verdictOf` above stays an unchecked cast: it feeds per-round display, where an unreadable
 * shape still has an attempt state to draw beside it. These functions walk every round of a
 * run and reach into `requestedChanges[]`, so a row written by an older or newer daemon has to
 * be skipped rather than take the page down - the posture `normalizePersonaVerdict` holds on
 * the server. `PersonaVerdictSchema` is that same strict schema, minus the model-facing
 * leniency a durable row has already been through on its way in.
 */
function parsedVerdict(attempt: WorkflowNodeAttempt): PersonaVerdict | null {
  const parsed = PersonaVerdictSchema.safeParse(attempt.verdict);
  return parsed.success ? parsed.data : null;
}

/**
 * A PERSONA failure. `persona !== null` is not defensive noise, it is the filter.
 *
 * A failing Check writes a synthetic fail verdict carrying one requested change - "Fix the
 * failing lint check", from `engine.ts`'s `checkVerdict` - and this model covers Persona
 * changes only. A check belongs to the reader's own `checkOutcomeOf` path, which keeps the
 * exit code and the output tail that a row keyed on a title could not carry.
 * `repeat-offender.ts` excludes checks by the same test.
 */
function failedPersonaAttempt(folded: FoldedAttempt | undefined): boolean {
  return folded?.attempt.persona != null && folded.verdict?.verdict === "fail";
}

/**
 * What is known about a requested change that is no longer being raised.
 *
 * `open` and `resolved` are the obvious two. `unconfirmed` is the honest third: the owning
 * reviewer ran again and did not pass, so the change was never confirmed fixed. It
 * deliberately does NOT claim the finding was rephrased - a reviewer that stops raising A
 * because A is fixed, while raising an unrelated C, is indistinguishable from one that
 * reworded A into C, and title-based identity cannot separate them.
 */
export type ChangeWorklistState = "open" | "resolved" | "unconfirmed";

/** One distinct requested change, as it stood at the end of the window's horizon round. */
export interface ChangeWorklistRow {
  /** `requestedChangeKey` - stable across renders, usable as a React key and as selection. */
  key: string;
  /** The newest wording, so a reviewer that sharpens a title shows the current sentence. */
  title: string;
  rationale: string;
  path: string | null;
  line: number | null;
  evidence: EvidenceRef[];
  /**
   * The reviewer that raised it. Part of the key, so this is a fact rather than
   * last-writer-wins, and NON-NULLABLE: a row is only ever accumulated from a Persona
   * attempt's fail verdict, so a `| null` here would only buy Phase 2 a dead fallback string
   * to render.
   */
  nodeId: string;
  personaName: string;
  confidence: number;
  /** The first round inside the window that raised it. */
  firstRound: number;
  /** The last round inside the window that raised it. */
  lastRound: number;
  /**
   * The round the owning reviewer PASSED in, or null unless `state` is `"resolved"`.
   *
   * Not the same fact as `lastRound`, and the difference is the sentence "Resolved in round N":
   * `lastRound` is the last round the change was still being ASKED FOR, so a reviewer that
   * dropped it in round 3 and passed in round 5 has `lastRound: 2` and `resolvedRound: 5`.
   * Rendering the former under that wording would name a round the change was open in.
   */
  resolvedRound: number | null;
  /**
   * How many rounds RAISED it between `firstRound` and `lastRound` inclusive - a count of
   * appearances, never a span, so it cannot claim a round its reviewer stayed silent in.
   */
  roundsOpen: number;
  state: ChangeWorklistState;
}

/** Sort order: descending by how much the reader still has to care. */
const CHANGE_STATE_ORDER: Record<ChangeWorklistState, number> = {
  open: 0,
  unconfirmed: 1,
  resolved: 2,
};

/**
 * Resolution decided PER OWNING PERSONA, never against a global round number.
 *
 * Stage 3 Personas do not finish together, so while a round is in flight one reviewer can
 * have posted its fail before another has run at all. Comparing each change's last-seen round
 * against the run's newest round would archive every change owned by a reviewer that has not
 * re-attempted yet - not because the issue is gone but because nobody has looked, which is the
 * question this worklist exists to answer, answered backwards.
 *
 * So a later ROUND is worth nothing; a later VERDICT FROM THIS NODE is everything. No later
 * verdict at all means `open`, however many rounds have passed. Once the node has spoken
 * again, a pass means `resolved` and never having passed means `unconfirmed`. This mirrors
 * `repeat-offender.ts`'s posture of saying nothing about a node that did not run, rather than
 * inventing a recovery for it.
 *
 * A node the operator disabled auto-passes, and that counts as a pass here exactly as it does
 * on the ladder and in the repeat-offender streak: one synthetic verdict, read the same way by
 * every surface.
 */
function changeState(
  folded: FoldedRun,
  inWindow: readonly number[],
  row: { nodeId: string; lastRound: number },
): Pick<ChangeWorklistRow, "state" | "resolvedRound"> {
  const later = inWindow
    .filter((round) => round > row.lastRound)
    .map((round) => ({ round, verdict: folded.rounds.get(round)?.get(row.nodeId)?.verdict }))
    .filter((spoke): spoke is { round: number; verdict: PersonaVerdict } =>
      spoke.verdict != null);
  if (later.length === 0) return { state: "open", resolvedRound: null };
  // The EARLIEST later pass, because that is the round the reviewer confirmed in. A pass says
  // it has nothing left to ask, which settles every earlier ask along with this one.
  const passed = later.find((spoke) => spoke.verdict.verdict === "pass");
  return passed
    ? { state: "resolved", resolvedRound: passed.round }
    : { state: "unconfirmed", resolvedRound: null };
}

/**
 * One row per distinct requested change, as the run stood at the end of `asOfRound`.
 *
 * This is the derivation the Blocker Worklist is built on, and the only thing on this page
 * that can say a change raised in round 1 is still the change being raised in round 10.
 * Identity is `requestedChangeKey`; a round is `foldRun`'s round; resolution is `changeState`'s
 * per-reviewer question. Each of those three carries its own comment, because each is a place
 * a reasonable implementation goes wrong.
 *
 * `asOfRound` IS NOT OPTIONAL DECORATION. The rest of the reader pane is round-scoped - the
 * verdict list is filtered to the scrubber's viewed submission - so a whole-run worklist beside
 * it would put counts describing two different moments on one segmented control: scrub to
 * round 3 and `Passed` follows you while `Blocking` stays on round 10. Null means the latest
 * submission's round. Nothing here may read a round above the horizon: a row that knows the
 * future is exactly the incoherence the parameter exists to prevent.
 *
 * The rows come back sorted for display - `open`, then `unconfirmed`, then `resolved`, then
 * oldest grievance first - and the order is independent of map iteration.
 *
 * REQUESTED CHANGES ONLY. Check outcomes and passing reviewers are not rows here and never
 * will be: they carry no requested change, and folding them in would turn a change model into
 * a view model.
 */
export function runChangeWorklist(
  detail: WorkflowRunDetail,
  /** The round the reader is looking at. Null means the latest submission's round. */
  asOfRound: number | null,
): ChangeWorklistRow[] {
  const folded = foldRun(detail);
  const horizon = horizonRound(folded, asOfRound);
  if (horizon === null) return [];
  const inWindow = [...folded.rounds.keys()]
    .filter((round) => round <= horizon)
    .sort((left, right) => left - right);

  const raised = new Map<
    string,
    Omit<ChangeWorklistRow, "roundsOpen" | "state" | "resolvedRound"> & { rounds: Set<number> }
  >();
  for (const round of inWindow) {
    for (const { attempt, verdict } of folded.rounds.get(round)?.values() ?? []) {
      if (!attempt.persona) continue;
      if (verdict?.verdict !== "fail") continue;
      for (const change of verdict.requestedChanges) {
        const key = requestedChangeKey(attempt.nodeId, change);
        const previous = raised.get(key);
        // Ascending rounds, so the newest occurrence overwrites the wording while the first
        // round it was ever raised in is carried forward.
        raised.set(key, {
          key,
          title: change.title,
          rationale: change.rationale,
          path: change.path ?? null,
          line: change.line ?? null,
          evidence: change.evidence,
          nodeId: attempt.nodeId,
          personaName: attempt.persona.name,
          confidence: verdict.confidence,
          firstRound: previous?.firstRound ?? round,
          lastRound: round,
          rounds: (previous?.rounds ?? new Set<number>()).add(round),
        });
      }
    }
  }

  return [...raised.values()]
    .map(({ rounds, ...row }): ChangeWorklistRow => ({
      ...row,
      roundsOpen: rounds.size,
      ...changeState(folded, inWindow, row),
    }))
    .sort((left, right) =>
      CHANGE_STATE_ORDER[left.state] - CHANGE_STATE_ORDER[right.state]
      || left.firstRound - right.firstRound
      || left.nodeId.localeCompare(right.nodeId)
      || left.title.localeCompare(right.title)
      || left.key.localeCompare(right.key));
}

export interface WorklistStalemate {
  nodeId: string;
  personaName: string;
  /** Consecutive rounds this member failed, ending at the window's horizon. Always >= 2. */
  rounds: number;
}

/**
 * Consecutive Persona failures ending at the window's horizon - the windowed twin of
 * `src/server/workflows/repeat-offender.ts`.
 *
 * WHY THIS EXISTS RATHER THAN RENDERING `detail.repeatOffenders`. That field is computed by
 * the store over the run's whole submission list and anchored on its newest one, so it is
 * always "as of the latest round" and this window cannot re-scope it. Drawn under a worklist
 * scrubbed to round 4 of a ten-round run it would read "failed 10 rounds running" - a fact six
 * rounds in the reader's future, on the one rail this design keeps insisting must not
 * contradict itself. The payload field keeps serving the ladder and the alert engine, which
 * genuinely do want the latest-anchored answer.
 *
 * Same rule as the server's, so the sentence this feeds means what the ladder's means:
 * candidates are the nodes failing at the horizon, walk back while each keeps failing, keep
 * those with `rounds >= 2`. INCLUDING THE BAIL-OUT - a horizon round carrying no folded
 * attempts returns `[]` rather than stepping back to an older round. That has a visible
 * consequence worth stating rather than discovering: when a new round opens, the stalemate
 * card disappears until that round produces its first attempt, then comes back. The ladder
 * already flickers exactly so, from the same anchor, and matching it is the point.
 *
 * At the default window the output equals `detail.repeatOffenders`, which the unit suite pins
 * against the server derivation itself rather than assuming.
 */
export function runStalemates(
  detail: WorkflowRunDetail,
  /** The round the reader is looking at. Null means the latest submission's round. */
  asOfRound: number | null,
): WorklistStalemate[] {
  const folded = foldRun(detail);
  const horizon = horizonRound(folded, asOfRound);
  if (horizon === null) return [];
  const atHorizon = folded.rounds.get(horizon);
  if (!atHorizon) return [];
  return [...atHorizon.values()]
    .filter(failedPersonaAttempt)
    .map(({ attempt }) => attempt)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .flatMap((candidate): WorklistStalemate[] => {
      let rounds = 0;
      for (let round = horizon; round >= 1; round -= 1) {
        if (!failedPersonaAttempt(folded.rounds.get(round)?.get(candidate.nodeId))) break;
        rounds++;
      }
      if (rounds < 2) return [];
      return [{
        nodeId: candidate.nodeId,
        personaName: candidate.persona!.name,
        rounds,
      }];
    });
}

/**
 * Events grouped by the round they belong to, in one forward pass.
 *
 * Most payloads name their round or their submission; the ones that name neither (a
 * delivery transition, an adapter error) belong to whatever round was running when they
 * were written, which is what the carried-forward cursor is. Round 0 is everything before
 * the first submission existed - run creation, binding changes - and stays visible on every
 * round because it belongs to none of them.
 */
export function eventsByRound(detail: WorkflowRunDetail): Map<number, WorkflowEvent[]> {
  const roundBySubmission = new Map(detail.submissions.map((submission) => [
    submission.id,
    submission.round,
  ]));
  const grouped = new Map<number, WorkflowEvent[]>();
  let round = 0;
  for (const event of [...detail.events].sort((a, b) => a.id - b.id)) {
    const payload = eventPayload(event);
    const submissionId = payload && typeof payload.submissionId === "string"
      ? payload.submissionId
      : null;
    const payloadRound = payload && typeof payload.round === "number" ? payload.round : null;
    round = payloadRound
      ?? (submissionId ? roundBySubmission.get(submissionId) ?? round : round);
    const group = grouped.get(round) ?? [];
    group.push(event);
    grouped.set(round, group);
  }
  return grouped;
}

function eventPayload(event: WorkflowEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * One submission's captured context, or `null` when this build cannot read it.
 *
 * `contextState` is the daemon's verdict about the RUN - the newest full submission's kind,
 * or `corrupt` if any submission is - so it cannot answer for the round a scrubber selected.
 * A three-key shape check plus a cast used to stand in for that, which is a crash waiting for
 * a run whose rounds disagree: the render reads `humanDecisions.length` and maps `constraints`
 * into JSX, so a snapshot missing an array takes the whole Runs view down with it, and one
 * holding a non-string in `constraints` hands React an object as a child.
 *
 * So every field the render touches is checked before the cast. An unreadable snapshot is
 * reported as unreadable, which is a state this surface already knows how to draw.
 */
export function readCapturedContext(context: unknown): WorkflowContextSnapshot | null {
  if (!isObject(context)) return null;
  const { primaryGoal, humanDecisions, constraints, acceptanceCriteria, evidence, compaction } =
    context;
  if (!isObject(primaryGoal) || typeof primaryGoal.rawPrompt !== "string") return null;
  if (!isStringArray(constraints) || !isStringArray(acceptanceCriteria)) return null;
  if (
    !Array.isArray(humanDecisions)
    // Each decision is rendered with its source, so a decision without one is unreadable
    // rather than merely sparse.
    || !humanDecisions.every((decision) => isObject(decision) && isObject(decision.source))
  ) return null;
  if (!isObject(evidence) || !isStringArray(evidence.workingTreeStatus)) return null;
  if (!isObject(compaction) || typeof compaction.status !== "string") return null;
  return context as unknown as WorkflowContextSnapshot;
}

export interface EventNames {
  /** The human name of a node id, or null when this build cannot resolve it. */
  node: (nodeId: string) => string | null;
  /** The round a submission id belongs to, or null when it is not in this detail. */
  round: (submissionId: string) => number | null;
}

export interface EventLine {
  title: string;
  /** Facts worth reading, already phrased. Empty when the kind says everything. */
  detail: string;
}

/**
 * Keys that carry an identity nothing human reads. `nodeId` and `submissionId` are
 * TRANSLATED rather than dropped; the rest are durable handles the export carries and the
 * timeline does not.
 */
const OPAQUE_KEYS = new Set([
  "nodeId", "edgeId", "submissionId", "runId", "deliveryId", "requestId", "attemptId",
  "bindingId", "nodeAttemptId", "triggerKey", "prKey", "fingerprint", "findingFingerprints",
  "priorFindingFingerprints", "marker",
]);

/**
 * One timeline entry, in names.
 *
 * The previous reader printed `JSON.stringify(event.payload)`, which is where most of the
 * UUID wall came from: `persona_verdict` reads `{"nodeId":"7f3e…","persona":"Quality"}` and
 * the id is the wider half. Nothing is lost by phrasing it - the complete durable record is
 * the run history JSON, one disclosure away under the Timeline.
 */
export function eventLine(
  event: WorkflowEvent,
  names: EventNames,
  /** The round this line is being read UNDER. Its own round is stated only if it differs. */
  groupRound: number,
): EventLine {
  const payload = eventPayload(event);
  const title = sentence(event.kind.replaceAll("_", " ")).replace(/\.$/, "");
  if (!payload) return { title, detail: "" };
  const facts: string[] = [];
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : null;
  const named = typeof payload.persona === "string"
    ? payload.persona
    : nodeId ? names.node(nodeId) : null;
  if (named) facts.push(named);
  if (nodeId && !named) facts.push("a reviewer");
  const submissionId = typeof payload.submissionId === "string" ? payload.submissionId : null;
  const round = typeof payload.round === "number"
    ? payload.round
    : submissionId ? names.round(submissionId) : null;
  // Said only when it is NOT the round being read: every line under "Round 2" repeating
  // "round 2" is noise, but an event filed into a carried-forward group while naming a
  // different round is the one case a reader has to be told about.
  if (round !== null && round !== groupRound) facts.push(`round ${round}`);
  for (const [key, value] of Object.entries(payload)) {
    if (key === "persona" || key === "round" || OPAQUE_KEYS.has(key)) continue;
    if (value === null || typeof value === "object") continue;
    if (typeof value === "boolean" && !value) continue;
    const text = typeof value === "boolean"
      ? key.replaceAll("_", " ")
      : /Sha$/.test(key) && typeof value === "string"
        ? `${label(key)} ${shortSha(value)}`
        : `${label(key)} ${String(value).replaceAll("_", " ")}`;
    facts.push(text.slice(0, 160));
  }
  return { title, detail: facts.join(" · ") };
}

/** `completionKind` -> `completion kind`, `round` -> `round`. */
function label(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/* ============================================================================
   TRIAGE - one run, read off its SUMMARY alone
   ----------------------------------------------------------------------------
   Everything above this line reads a `WorkflowRunDetail`: the graph, the round's
   attempts, the verdicts, the receipts. That is the right material for the reader,
   and the wrong material for the Line's Review drawer, which lists EVERY live run
   at once. A drawer that fetched a detail per row would put N bounded HTTP reads
   behind one click on a strip, and the row it drew from them would be a smaller,
   slower copy of the ladder that is already one click deeper.

   So the projection below takes exactly what SSE already delivers for every run in
   the fleet. The consequence is honest and worth stating: it cannot say "reviewers
   2/4", because a summary does not carry the graph and therefore does not know the
   denominator. It says what it can prove - who is reviewing right now, whether a
   session action is parked, and where the Inspector gate stands - and points at the
   run for the rest.
   ============================================================================ */

/** One chip in a triage row's compact pipeline. `key` is stable for React and tests. */
export interface RunTriageStep {
  key: "evidence" | "reviewers" | "action" | "inspector";
  status: PipelineStatus;
}

function reviewerTriageStatus(summary: WorkflowRunSummary): PipelineStatus {
  if (summary.bypassedPersonaReview) {
    return {
      tone: "passed",
      label: "Reviewers skipped",
      // Degraded, not plain passed: this round advanced without the reviewers running, and
      // the flag is what lets the chip be green without claiming they agreed.
      degraded: true,
      tooltip: inspectorOnlyRoundSentence(),
    };
  }
  if (summary.failedPersonaCount > 0) {
    const n = summary.failedPersonaCount;
    return { tone: "failed", label: `${n} reviewer${n === 1 ? "" : "s"} failed` };
  }
  const running = summary.activePersonaNames;
  if (running.length > 0) {
    return {
      tone: "running",
      label: running.length === 1 ? "1 reviewing" : `${running.length} reviewing`,
      tooltip: running.join(" · "),
    };
  }
  if (summary.status === "completed") return { tone: "passed", label: "Reviewers passed" };
  // A blocked run with nobody running and nobody failed did not leave its reviewers waiting -
  // it left them CANCELLED. `orphanBinding` marks every queued and retrying attempt
  // `cancelled` on its way past, which is precisely why `activePersonaNames` is empty here,
  // and an amber "Reviewers" chip on that row promises a queue that will never move. Derived
  // from what the summary already proves rather than from a new field.
  if (summary.status === "blocked") return { tone: "stopped", label: "Reviewers stopped" };
  return { tone: "waiting", label: "Reviewers" };
}

/**
 * The compact pipeline for one live run: evidence, reviewers, the action if there is one,
 * the Inspector gate if the workflow has one.
 *
 * The last two are CONDITIONAL rather than always drawn grey, which is the difference
 * between a row that reads and a row that lies. A summary cannot see the graph, so an
 * always-present "Session action" chip would appear on every run of every workflow that has
 * no action stage at all - and the absent chip is exactly the signal a triage reader wants:
 * four chips means this run has somewhere further to go than two.
 */
export function runTriageSteps(summary: WorkflowRunSummary): RunTriageStep[] {
  const steps: RunTriageStep[] = [
    {
      key: "evidence",
      status: summary.status === "capturing"
        ? { tone: "running", label: "Capturing" }
        : { tone: "passed", label: "Evidence" },
    },
    { key: "reviewers", status: reviewerTriageStatus(summary) },
  ];
  // `actionWait` is the compact fact the summary carries for exactly this purpose; the status
  // is the fallback for a run whose daemon predates the field, where "there is an action and
  // it is waiting" is still true and only the reason is missing.
  const wait = summary.actionWait ?? null;
  if (wait || summary.status === "waiting_for_action") {
    steps.push({ key: "action", status: sessionActionStatus(wait ? undefined : "waiting", wait) });
  }
  if (summary.gate !== "none") {
    steps.push({ key: "inspector", status: gateSummaryStatus(summary.gate) });
  }
  return steps;
}

/**
 * What this run is doing, in one clipped line under the chips.
 *
 * The run's own status word leads, because it is the one fact that is true of the whole run
 * rather than of one stage. What follows is only ever something the chips could not say: WHY
 * a stopped run stopped, WHO is reviewing (the chip has the count, not the names, and on a
 * narrow row the tooltip is unreachable by keyboard), and deliveries whose landing is
 * unknown - the one state where doing nothing is the wrong answer and no chip above owns it.
 *
 * The cause is appended for exactly the two states a run can be PARKED in, and for no
 * others. A run that is still moving has no cause to state - its phase is the stage it is
 * in, which the chips already draw - and printing one on every row would turn a reason into
 * furniture. `Blocked` alone was the original complaint; `Blocked · session gone` is the
 * answer to it.
 */
export function runTriageSentence(summary: WorkflowRunSummary): string {
  const parts = [runStatusLabel(summary.status)];
  if (runIsParked(summary)) parts.push(blockedPhaseClause(summary.phase));
  const running = summary.activePersonaNames;
  if (running.length > 0) parts.push(`${running.join(", ")} running`);
  const uncertain = summary.uncertainDeliveryCount ?? 0;
  if (uncertain > 0) parts.push(`${uncertain} uncertain deliver${uncertain === 1 ? "y" : "ies"}`);
  return parts.join(" · ");
}

/**
 * The round line: which repair round this run is on, out of what it is allowed.
 *
 * `round` is `MAX(submission.round)` and `maxRepairRounds` is the binding's budget, so the
 * pair says how much rope is left - which is the fact that decides whether a failing run is
 * about to give up. The denominator is the budget itself and not one more than it: the
 * manager blocks a run when `round > maxRepairRounds`, so the last round it can spend IS
 * that number. Round 1 of a run that has spent nothing prints bare, because "round 1/3" on
 * every freshly submitted run is noise on every row.
 */
export function runTriageRound(summary: WorkflowRunSummary): string {
  return summary.round <= 1 ? "round 1" : `round ${summary.round}/${summary.maxRepairRounds}`;
}

/**
 * Whether this run is PARKED: the daemon has stopped working on it and will not resume on
 * its own.
 *
 * Two states qualify and no more. `blocked` is the obvious one. The second is a run whose
 * binding was reattached to a fresh session: `reattach` leaves it `waiting_for_session` at
 * `reattached_resubmit_required` and deliberately does not open the next round itself,
 * because a reattached conversation is a different pane and re-sending into it without being
 * asked is the one thing the delivery model refuses to do.
 *
 * Every other `waiting_*` status is a run waiting on something that genuinely arrives -
 * a reviewer, Inspector's next sweep, a pushed head - and calling those parked would put a
 * cause and a control on rows that need neither.
 */
function runIsParked(summary: Pick<WorkflowRunSummary, "status" | "phase">): boolean {
  return summary.status === "blocked"
    || (summary.status === "waiting_for_session"
      && summary.phase === "reattached_resubmit_required");
}

/** How a triage row identifies one run, and whether what it found is a title or an id. */
export interface RunRowIdentity {
  name: string;
  /**
   * True when `name` is the conversation key - a GUID. The row draws it as a dim mono
   * identifier rather than a bold title, because rendering an id in the slot where a title
   * goes is what made thirty rows unreadable in the first place.
   */
  isIdentifier: boolean;
}

/**
 * Who a run is, in three steps: the LIVE session's display name, then the binding's captured
 * title, then the conversation key.
 *
 * The middle step is the one that was missing, and the GUID is its consequence rather than a
 * design choice: a run outlives the session it reviewed, so resolving a name only from live
 * sessions means every run whose session was removed - which is every blocked run in the
 * fleet - falls straight past a perfectly good durable title to an id.
 *
 * The live name still leads, because a renamed session should read under its current name.
 */
export function runRowIdentity(
  run: Pick<WorkflowRunSummary, "sessionId" | "sessionName" | "noteKey">,
  liveSessionName: string | null | undefined,
): RunRowIdentity {
  const live = run.sessionId ? liveSessionName ?? "" : "";
  if (live) return { name: live, isIdentifier: false };
  const captured = run.sessionName ?? "";
  if (captured) return { name: captured, isIdentifier: false };
  return { name: run.noteKey, isIdentifier: true };
}

/**
 * The single argument-free action a parked run's state actually takes, or `null`.
 *
 * A descriptor rather than a click handler so the decision is testable without rendering,
 * and so the Line's Review drawer and any later batch surface cannot disagree about which
 * runs may be dismissed.
 *
 * Two rules decide what is here, and both are narrow on purpose:
 *
 *  1. **The route must need nothing but a run id.** That is what keeps `Reattach` out (it
 *     needs a session id, which means a picker), `Resolve delivery` out (a delivery id and a
 *     choice) and `Disable a reviewer` out (a node id). A triage row has no room for a form,
 *     and a control that opens one is the run page wearing a disguise.
 *  2. **The SUMMARY must prove the daemon will accept it.** A button that always answers 409
 *     is worse than no button, so each guard below mirrors the manager's own refusals rather
 *     than the run page's - the run page reads run DETAIL, which a fleet-wide summary does
 *     not carry.
 */
export interface RunRemedy {
  /**
   * Stable, and doubles as the `RunActionId` the action store keys pending state and request
   * ids by - so it is ONE ID PER INTENT, never one per surface.
   */
  kind: "dismiss" | "retry" | "resubmit" | "restart-full";
  label: string;
  tooltip: string;
  /** The POST path, run id already interpolated. */
  path: string;
  /** Everything the route needs beyond `requestId`. Empty for three of the four. */
  body: Record<string, string>;
  /** `null` fires immediately; anything destructive confirms first. */
  confirm: WorkflowConfirmDescriptor | null;
}

const RESTART_FULL_PHRASE = "RESTART FULL WORKFLOW";

/**
 * The pull request a cancel would unblock, when cancelling is the RETIRE of a spent gate.
 *
 * Cancelling a run out of rounds is not only tidying a queue - it is the act that releases
 * the Shipping veto its gate holds, and doing that to somebody's pull request without saying
 * so is how a confirmation becomes a trap. It is also half of the answer the Merge queue
 * sends operators here for: `workflow-gate-spent` reads "open the run to grant more rounds
 * or retire it", and the retire it names is this.
 *
 * Null where it would not be true: a run still inside its budget releases nothing by
 * stopping, and a `session_disappeared` run reaching the drawer's dismiss may hold no gate
 * at all. Shared by the drawer's `Dismiss` and run detail's `Cancel run` rather than spelled
 * in both, because two surfaces describing the same destructive act must not be able to
 * disagree about whether it touches a pull request.
 */
export function cancelReleasesGate(run: {
  phase: string;
  gatePrNumber: number | null;
}): number | null {
  // Both spent spellings, from the shared list, rather than the one string the gate happens
  // to write today - the whole point of this predicate is that no surface carries its own
  // idea of which runs are holding a pull request hostage.
  return (WORKFLOW_RUN_SPENT_PHASES as readonly string[]).includes(run.phase)
    ? run.gatePrNumber
    : null;
}

/** The clause the two cancel confirmations append when a gate veto goes with the run. */
export function cancelGateSentence(prNumber: number | null): string {
  return prNumber === null
    ? ""
    : ` It also lifts the merge block this run holds on #${prNumber},`
      + " which no longer waits on a review that has stopped.";
}

/** The one-line hint beside those confirmations' button. */
export function cancelGateHint(prNumber: number | null): string {
  return prNumber === null ? "Stops the run for good" : "Stops the run and unblocks the PR";
}

export function runRemedy(
  run: WorkflowRunSummary,
  /**
   * What to call this run in a confirmation. Defaults to the summary-only name so the
   * signature stays callable with a summary alone; a surface that resolved a live session
   * name should pass it, or the dialog and the row it opened from would disagree.
   */
  name: string = run.sessionName || run.noteKey,
): RunRemedy | null {
  const runPath = (action: string): string =>
    `/api/workflow-runs/${encodeURIComponent(run.id)}/${action}`;

  // Reattached and parked. `manager.resubmit` accepts an attached, waiting run with budget
  // left that nobody else claimed; `sessionId` is the summary's proof the binding is still
  // attached, since orphaning is what nulls it.
  if (run.status === "waiting_for_session" && run.phase === "reattached_resubmit_required") {
    if (!run.sessionId || run.externalSource || run.round > run.maxRepairRounds) return null;
    return {
      kind: "resubmit",
      label: "Resubmit",
      tooltip: "Open the next repair round in the session this binding was reattached to",
      path: runPath("resubmit"),
      body: {},
      confirm: null,
    };
  }

  // The one state `restart-full` genuinely accepts. Its other arm - an Inspector-only repair
  // still in flight - is `latest.mode`, which lives on run detail; this arm is a status, so
  // the summary can prove it on its own. Both of the manager's numeric refusals are checked
  // here too, which is why a run out of rounds is NOT offered a restart: `restartFull`
  // refuses when `round > maxRepairRounds`, and that inequality is the definition of the
  // `round_limit` block, so the button could never once have succeeded there.
  if (run.status === "waiting_for_new_head" && run.round <= run.maxRepairRounds) {
    return {
      kind: "restart-full",
      // The ellipsis is the promise that a dialog follows. The daemon demands the phrase
      // itself (`manager.restartFull`), so this is not a confirmation the drawer chose.
      label: "Restart…",
      tooltip: "Abandon this GitHub Inspector-only repair and rerun every Persona from fresh evidence",
      path: runPath("restart-full"),
      body: { confirmation: RESTART_FULL_PHRASE },
      confirm: {
        title: "Restart the full workflow",
        body: "This abandons the GitHub Inspector-only repair and reruns every Persona against"
          + " freshly captured evidence. The audited repair submissions stay in history.",
        confirmLabel: "Restart full workflow",
        confirmHint: "Abandons the GitHub Inspector-only repair and reruns every Persona",
        danger: true,
        requirePhrase: RESTART_FULL_PHRASE,
      },
    };
  }

  if (run.status !== "blocked") return null;

  // `manager.retry` is available for exactly this phase, and the optional `nodeAttemptId` is
  // omitted: it comes off run detail's attempts, and leaving it out makes the daemon pick the
  // newest errored attempt itself - which is the one the run page's own default picks too.
  if (run.phase === "infrastructure_error") {
    return {
      kind: "retry",
      label: "Retry",
      tooltip: "Run the failed provider call again from where it stopped",
      path: runPath("retry"),
      body: {},
      confirm: null,
    };
  }

  // The two blocks nothing argument-free revives. `session_disappeared` needs a Reattach,
  // which needs a session picker; `round_limit` needs a bigger repair budget, which is the
  // run page's grant. Both are a click away through "Open run" - so what the drawer offers
  // is the other honest move: stop counting a run that is never going to move again.
  //
  // Which, for a run out of rounds, is also the RETIRE half of the two controls that clear
  // a spent gate. See `cancelReleasesGate`.
  if (run.phase === "session_disappeared" || run.phase === "round_limit") {
    const release = cancelReleasesGate(run);
    return {
      kind: "dismiss",
      label: "Dismiss",
      tooltip: "Stop this run - it will not resume",
      path: runPath("cancel"),
      body: {},
      confirm: {
        title: "Cancel this run",
        body: `Stop ${run.workflowName} v${run.workflowVersion} on ${name}?`
          + " It will not resume, and its evidence and verdicts stay in history."
          + cancelGateSentence(release),
        confirmLabel: "Cancel run",
        confirmHint: cancelGateHint(release),
        danger: true,
      },
    };
  }

  // Everything else - Inspector findings, a closed pull request, an unresolved delivery -
  // is blocked on a DECISION, and the material for that decision is the run page's. The row
  // still says why; it just does not pretend one button settles it.
  return null;
}
