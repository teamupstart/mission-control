import type {
  PersonaVerdict,
  PublishedWorkflowGraph,
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
import { isVerdictNode, verdictAuthor } from "@shared/workflow.ts";
import type { Stage } from "@shared/workflow-stages.ts";
import {
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

/** The newest full-workflow submission before the round being viewed, by node id. */
export function previousFullWorkflowAttempts(
  detail: WorkflowRunDetail,
  submission: WorkflowSubmission | null,
): Map<string, WorkflowNodeAttempt> {
  if (!submission) return new Map();
  const ordered = orderedSubmissions(detail);
  const index = ordered.findIndex((candidate) => candidate.id === submission.id);
  if (index < 1) return new Map();
  const previous = ordered.slice(0, index).reverse()
    .find((candidate) => candidate.mode === "full_workflow");
  return latestAttemptsFor(detail, previous?.id ?? null);
}

/** Whether a prior attempt earned the green Inspector-repair bypass treatment. */
export function priorAttemptPassed(
  kind: "persona" | "check" | "session_action",
  attempt: WorkflowNodeAttempt | undefined,
): boolean {
  if (!attempt) return false;
  if (kind === "check") return checkOutcomeOf(attempt)?.status === "passed";
  if (kind === "session_action") return sessionActionProgress(attempt)?.complete === true;
  return verdictOf(attempt)?.verdict === "pass";
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
  const segmentsPerRound = new Map<number, number>();
  for (const submission of submissions) {
    segmentsPerRound.set(submission.round, (segmentsPerRound.get(submission.round) ?? 0) + 1);
  }
  return submissions.map((submission) => {
    const verdicts = attemptsFor(detail, submission.id).map(verdictOf);
    const changesRequested = verdicts.some((verdict) => verdict?.verdict === "fail");
    const inspectorOnly = submission.mode === "inspector_only";
    const continued = (segmentsPerRound.get(submission.round) ?? 1) > 1;
    return {
      submissionId: submission.id,
      round: submission.round,
      segment: submission.segment,
      label: `Round ${submission.round}`
        + (inspectorOnly ? " · Inspector" : "")
        // One-based for a human. `segment` is a durable zero-based index and stays that way
        // in the field beside this; the label is the only place it is counted for reading.
        + (continued ? ` · evidence ${submission.segment + 1}` : ""),
      status: submissionStatus(submission, changesRequested),
      inspectorOnly,
      continuedFrom: submission.continuationNodeId === null
        ? null
        : nameOfNode(submission.continuationNodeId),
    };
  });
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
  return "Persona review bypassed for Inspector repair.";
}

const INSPECTOR_ONLY_SKIP_TOOLTIP =
  "Skipped because this stage passed in the prior full workflow round. This Inspector repair round only rechecks Inspector.";

/** A previously-passed stage intentionally bypassed by an Inspector-only repair round. */
export function inspectorOnlySkipStatus(): PipelineStatus {
  return {
    tone: "passed",
    label: "Skipped",
    tooltip: INSPECTOR_ONLY_SKIP_TOOLTIP,
    skipKind: "inspector_repair",
  };
}

/**
 * Whether one authored pipeline member can inherit the prior-pass treatment in an
 * Inspector-only round.
 *
 * The Inspector-only policy proves why a valid, attempt-free node was bypassed. It says
 * nothing about a malformed pipeline member, so a missing id or a stale id that resolves to
 * no graph node must keep the ordinary waiting status instead of borrowing a green skip.
 */
export function canShowInspectorOnlySkip(
  inspectorOnly: boolean,
  memberNodeId: string | null,
  nodeExists: boolean,
  hasCurrentAttempt: boolean,
  passedPriorFullRound: boolean,
): boolean {
  return inspectorOnly
    && memberNodeId !== null
    && nodeExists
    && !hasCurrentAttempt
    && passedPriorFullRound;
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
  error: { tone: "failed", label: "Check failed to run" },
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
    tooltip: "Skipped because no command is configured for this check.",
    skipKind: "unconfigured_check",
    degraded: true,
  },
  unavailable: {
    tone: "waiting",
    label: "Not run",
    tooltip: "This check could not run. Open the run details for its recorded reason.",
    skipKind: "unavailable_check",
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
      ? "Skipped because no command is configured for the checks in this stage."
      : "One or more checks in this stage did not run. Hover each check for its reason.";
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
    return { tone: "waiting", label: "Inspector gate" };
  }
  if (submission?.status === "completed") return { tone: "passed", label: "Reached" };
  return { tone: "waiting", label: "Not reached" };
}

const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  capturing: "Capturing evidence",
  running: "Reviewing",
  waiting_for_session: "Waiting for the session",
  waiting_for_pr: "Waiting for a pull request",
  waiting_for_inspector: "Waiting for Inspector",
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
  inspector_round_limit: "out of Inspector rounds",
  infrastructure_error: "provider call failed",
  inspector_findings: "Inspector findings",
  inspector_disabled: "Inspector off",
  inspector_pr_closed: "PR closed",
  inspector_head_mismatch: "head moved",
  inspector_gate_context_invalid: "gate context lost",
  delivery_uncertain: "delivery unconfirmed",
  delivery_refused: "delivery refused",
  delivery_blocked: "delivery blocked",
  stale_capture: "evidence went stale",
  capture_error: "capture failed",
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
  unadopted_pr: "A pull request exists, but Inspector has not adopted it as one we opened.",
  inspector_disabled: "Inspector is switched off, so the gate cannot be evaluated.",
  awaiting_fresh_observation: "Waiting for Inspector's next sweep to observe the pushed head.",
  working_tree_not_pushed: "The captured working tree has changes that were never committed and pushed.",
  head_mismatch: "The pull request's head is not the commit this submission reviewed.",
  review_pending: "Inspector has the pull request and has not finished reviewing it.",
  review_backoff: "Inspector's review failed and is waiting out its retry backoff.",
  review_error: "Inspector's last review attempt errored.",
  findings: "Inspector left findings that have to be resolved.",
  pr_closed: "The adopted pull request was closed or switched.",
};

/** What the Inspector gate is waiting on, as a sentence. `null` means it is satisfied. */
export function gateWaitSentence(reason: WorkflowGateWaitReason | null): string {
  return reason === null
    ? "Inspector has reviewed the exact head this submission produced."
    : GATE_WAIT_SENTENCES[reason];
}

const GATE_SUMMARIES: Record<WorkflowGateSummary, PipelineStatus> = {
  none: { tone: "waiting", label: "No gate" },
  waiting_pr: { tone: "waiting", label: "Waiting for a PR" },
  waiting_inspector: { tone: "waiting", label: "Waiting for Inspector" },
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
  inspector_feedback: "Inspector findings",
  pr_handoff: "PR handoff",
  unchanged_evidence_nudge: "Nothing changed",
  session_action: "Session action",
};

export function deliveryKindLabel(kind: WorkflowDeliveryKind): string {
  return DELIVERY_KIND_LABELS[kind];
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
 * A `Record` over the durable enum, so a fifth status added to `WORKFLOW_CHECK_STATUSES`
 * fails typecheck here until somebody says what it means to a human - which is the whole
 * reason vocabulary lives in this file rather than inline in the component.
 *
 * Three of the four are passes, and each says so differently on purpose: a reader has to be
 * able to tell a gate that ran and was satisfied from one that never ran at all, and the
 * two ways of never running need different things done about them.
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
    sentence: "No command is configured for this slot here, so the gate passed without running.",
  },
  unavailable: {
    label: "Not run",
    sentence: "The gate could not run and passed rather than blocking. The note says why.",
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
 * the id is the wider half. Nothing is lost by phrasing it - **Export run** is the complete
 * durable record, and it is one click away in the header.
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
      tooltip: "Abandon this Inspector-only repair and rerun every Persona from fresh evidence",
      path: runPath("restart-full"),
      body: { confirmation: RESTART_FULL_PHRASE },
      confirm: {
        title: "Restart the full workflow",
        body: "This abandons the Inspector-only repair and reruns every Persona against"
          + " freshly captured evidence. The audited repair submissions stay in history.",
        confirmLabel: "Restart full workflow",
        confirmHint: "Abandons the Inspector-only repair and reruns every Persona",
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
  // which needs a session picker; `round_limit` needs a bigger repair budget, which is a
  // binding edit. Both are a click away through "Open run" - so what the drawer offers is
  // the other honest move: stop counting a run that is never going to move again.
  if (run.phase === "session_disappeared" || run.phase === "round_limit") {
    return {
      kind: "dismiss",
      label: "Dismiss",
      tooltip: "Stop this run - it will not resume",
      path: runPath("cancel"),
      body: {},
      confirm: {
        title: "Cancel this run",
        body: `Stop ${run.workflowName} v${run.workflowVersion} on ${name}?`
          + " It will not resume, and its evidence and verdicts stay in history.",
        confirmLabel: "Cancel run",
        confirmHint: "Stops the run for good",
        danger: true,
      },
    };
  }

  // Everything else - Inspector findings, a closed pull request, an unresolved delivery -
  // is blocked on a DECISION, and the material for that decision is the run page's. The row
  // still says why; it just does not pretend one button settles it.
  return null;
}
