import type {
  PersonaVerdict,
  WorkflowDeliveryState,
  WorkflowGateSummary,
  WorkflowEvent,
  WorkflowGateWaitReason,
  WorkflowLlmCall,
  WorkflowNodeAttempt,
  WorkflowNodeAttemptState,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowSubmission,
} from "@shared/workflow.ts";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import { WorkflowApiError } from "./workflowApi.ts";

/**
 * Everything the runs monitor has to DECIDE, as pure functions over one run detail.
 *
 * It lives beside the reader rather than inside it for the reason the round scrubber
 * exists at all: which round is being viewed changes which reviewer chips, verdicts and
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

/** Newest first is how history reads; the scrubber re-sorts into execution order itself. */
function byRound(a: WorkflowSubmission, b: WorkflowSubmission): number {
  return a.round - b.round || a.createdAt - b.createdAt;
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

/** The newest attempt per node, which is the only one whose state is current. */
function latestAttempts(attempts: readonly WorkflowNodeAttempt[]): WorkflowNodeAttempt[] {
  const newest = new Map<string, WorkflowNodeAttempt>();
  for (const attempt of attempts) {
    const previous = newest.get(attempt.nodeId);
    if (previous && previous.attempt > attempt.attempt) continue;
    newest.set(attempt.nodeId, attempt);
  }
  return [...newest.values()];
}

export function verdictOf(attempt: WorkflowNodeAttempt): PersonaVerdict | null {
  return attempt.verdict as unknown as PersonaVerdict | null;
}

/**
 * Node id -> runtime status for ONE submission.
 *
 * The verdict wins over the attempt state when there is one, because "completed" says the
 * provider replied and says nothing about whether the reviewer approved. Taking a
 * submission id rather than digging out the newest one is the round scrubber's whole
 * premise: an attempt from round 1 says nothing about a node in round 3, and a map merged
 * across rounds shows a reviewer as passed while it is being re-run.
 */
export function nodeStatusesForSubmission(
  detail: WorkflowRunDetail,
  submissionId: string | null,
): Record<string, string> {
  const statuses: Record<string, string> = {};
  if (!submissionId) return statuses;
  for (const attempt of latestAttempts(attemptsFor(detail, submissionId))) {
    statuses[attempt.nodeId] = verdictOf(attempt)?.verdict ?? attempt.state;
  }
  return statuses;
}

export interface RoundView {
  submissionId: string;
  round: number;
  /** `Round 2`, and `Round 2 · Inspector` for an attempt-free Inspector repair. */
  label: string;
  status: PipelineStatus;
  inspectorOnly: boolean;
}

/**
 * The scrubber's segments, in execution order.
 *
 * A round is "failed" when its reviewers asked for changes, which is NOT the same as the
 * submission failing: a round that returned to Session is a healthy repair loop and its
 * submission status is `waiting_for_session`. Marking it from the submission status alone
 * would leave every repair round unmarked, which is the one thing the mark is for.
 */
export function runRounds(detail: WorkflowRunDetail): RoundView[] {
  return orderedSubmissions(detail).map((submission) => {
    const verdicts = attemptsFor(detail, submission.id).map(verdictOf);
    const changesRequested = verdicts.some((verdict) => verdict?.verdict === "fail");
    const inspectorOnly = submission.mode === "inspector_only";
    return {
      submissionId: submission.id,
      round: submission.round,
      label: `Round ${submission.round}${inspectorOnly ? " · Inspector" : ""}`,
      status: submissionStatus(submission, changesRequested),
      inspectorOnly,
    };
  });
}

/** The Session terminus's chip: what this submission is doing right now. */
export function submissionStatus(
  submission: WorkflowSubmission,
  changesRequested: boolean,
): PipelineStatus {
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

const REVIEWER_STATUSES: Record<
  WorkflowNodeAttemptState | PersonaVerdict["verdict"],
  PipelineStatus
> = {
  pass: { tone: "passed", label: "Passed" },
  fail: { tone: "failed", label: "Changes requested" },
  queued: { tone: "waiting", label: "Queued" },
  running: { tone: "running", label: "Reviewing" },
  retry_wait: { tone: "waiting", label: "Retrying" },
  // Completed with no verdict is a reply the verdict parser rejected; the attempt row below
  // the strip carries the reason, so the chip only has to stop claiming an outcome.
  completed: { tone: "waiting", label: "No verdict" },
  error: { tone: "failed", label: "Provider error" },
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
 * A stage's own chip, folded from its reviewers: the worst thing that happened wins, then
 * whatever is still moving, and "passed" only once every member of the stage passed - which
 * is exactly the all-pass rule the stage is compiled from.
 */
export function stageStatus(members: readonly PipelineStatus[]): PipelineStatus {
  if (members.length === 0) return { tone: "waiting", label: "No reviewers" };
  if (members.some((status) => status.tone === "failed")) {
    return { tone: "failed", label: "Changes requested" };
  }
  if (members.some((status) => status.tone === "running")) {
    return { tone: "running", label: "Reviewing" };
  }
  if (members.every((status) => status.tone === "passed")) {
    return { tone: "passed", label: members.length > 1 ? "All passed" : "Passed" };
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
};

export function runStatusLabel(status: WorkflowRunStatus): string {
  return RUN_STATUS_LABELS[status];
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

const ATTEMPT_STATE_LABELS: Record<WorkflowNodeAttemptState, string> = {
  queued: "queued",
  running: "reviewing",
  retry_wait: "waiting to retry",
  completed: "completed",
  error: "errored",
  cancelled: "cancelled",
};

export function attemptStateLabel(state: WorkflowNodeAttemptState): string {
  return ATTEMPT_STATE_LABELS[state];
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
