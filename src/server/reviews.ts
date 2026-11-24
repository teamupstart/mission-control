import { transferForSource, runtimeTransferSuccessor } from "./session-transfers/store.ts";
import { randomUUID } from "node:crypto";
import type {
  PlanDecision,
  PlanDecisionAnswer,
  ReviewActor,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
} from "@shared/types.ts";
import { isHumanResolvedReview, deliversContinuation, reviewToolResult } from "@shared/review-item.ts";
import {
  ASYNC_INPUT_FLAG, asyncInputAnswer, asyncInputReceipt, filedPlanAnswer, filedPlanReceipt,
  isAgentAsk, isFiledGate, isRequestInputQuestion, MAX_OPEN_QUESTIONS, questionHoldsCompletion,
  type ReviewWaitResponse, withdrawnByItsAgent,
} from "@shared/async-input.ts";
import { isStandingFollowUp } from "./plans/publication.ts";
import { restoreRequestInputText } from "@shared/request-input.ts";
import {
  snoozeMeanwhileProblem,
  snoozedContinuationLead,
  snoozedInstructionText,
  type ReviewSnoozeMeanwhile,
} from "@shared/review-snooze.ts";
import { noteKeyFor, type Registry } from "./registry.ts";
import {
  blockReviewVoiceConversion,
  fileReviewByVoice,
  hasQueuedSpeechForReview,
  inTransaction,
  insertReview,
  loadReview,
  reviewRevisedBy,
  transferPendingReviews,
  loadReviewContinuationCandidates,
  loadSnoozeInstructionCandidates,
  markReviewWaitAttached,
  reviewWaitAttached,
  markReviewWaitDetached,
  cancelUnclaimedSnoozeInstruction,
  snoozeReviewRow,
  updateReviewStatus,
  wakeReviewRow,
} from "./db.ts";
import { unref } from "./util/timers.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { isRewordedRetry } from "./review-retry.ts";

/**
 * How often the daemon looks for snoozed questions that are due. A sweep rather than one timer
 * per question, because a timer measures elapsed process time and a laptop that slept through a
 * reminder would otherwise hold it for as long as it slept. Fifteen seconds is well inside the
 * shortest delay anyone can pick.
 */
export const SNOOZE_SWEEP_MS = 15_000;

/**
 * How close together two `request_input` asks from one session must arrive to be parallel calls
 * rather than a retry (`ReviewManager.retriesReplacedBy`).
 *
 * A call-mode ask blocks, so an agent still waiting on one question can only ask another in the
 * same batch of parallel tool calls, which reach the daemon within milliseconds of each other.
 * A retry comes after the MCP client has given up, which takes minutes: five, in every
 * duplicate the live database recorded. Thirty seconds sits far from both.
 */
export const PARALLEL_ASK_WINDOW_MS = 30_000;

export type ReviewAction = "approve" | "reject" | "answer" | "dismiss";

type Waiter = { convertible: boolean; finish: (r: ReviewWaitResponse) => void };

export function filedReviewReceipt(review: ReviewItem): string {
  return isFiledGate(review)
    ? filedPlanReceipt(review, { bundleApproved: isStandingFollowUp(review.id) })
    : asyncInputReceipt(review);
}

function convertedResponse(review: ReviewItem): ReviewWaitResponse {
  return { ...review, converted: { receipt: filedReviewReceipt(review) } };
}

/**
 * Which review message is being handed to the outbox: a human resolution that arrived after the
 * agent's wait ended, or a snoozed question's "carry on" instruction that the agent never got
 * as a tool result.
 */
export type ReviewContinuationKind = "answer" | "snooze-instruction";
type ContinuationDelivery = (review: ReviewItem, text: string, kind: ReviewContinuationKind) => boolean;

export class ReviewResolutionError extends Error {}
class VoiceFiledCallRefusal extends ReviewResolutionError {
  constructor(id: string) {
    super(`Review ${id} was already filed by voice. Its answer is delivered as a message in the conversation.`);
  }
}
export class OpenQuestionLimitError extends Error {}

/**
 * A `revises` that names no form this ask may revise. Nothing was filed, and the message says why
 * in words the agent can act on.
 */
export class RevisionRefusal extends Error {}

/**
 * The review manager's agent withdrawal in two halves, like `mergeClosure`: `persist` writes the
 * status `withdrawn` with the reason and cancels an unclaimed snooze instruction, and must run
 * inside a transaction; `publish` broadcasts it, refreshes the pending turn and releases the
 * waiters, and runs only after the commit.
 */
type AgentWithdrawal = { persist: () => void; publish: () => ReviewItem };

/** What a valid `revises` resolves to: the link to store, and the open form to withdraw with it. */
type Revision = { link: NonNullable<ReviewItem["revision"]>; withdrawal: AgentWithdrawal | null };

/** A merge could not close a session's questions yet (a runtime transfer is moving them). */
export class MergeClosureDeferred extends Error {}

/**
 * "Remind me later" asked for by anyone but the operator. Parking a question tells its agent to
 * carry on without a person, which a session driving another through session control, or
 * Foreman, does not get to decide for them.
 */
export class SnoozeActorRefusal extends ReviewResolutionError {}

/**
 * Owns the review lifecycle and the long-poll waiters that let an agent block on
 * a human decision. The agent (via MCP) creates a review and calls `wait`; the
 * human resolves it from the UI, which unblocks every waiter. This is the
 * generalized approval and input channel for agents.
 */
/**
 * Do two asks offer the human the same choice?
 *
 * Compared through a canonical serialization rather than `deepEqual` on the parsed value,
 * because the two sides are the same JSON payload sent twice and re-parsed - identical in
 * content, and with no guarantee of identical key order or of which optional keys survived
 * as `undefined`. Sorting keys and dropping `undefined` makes the comparison about what the
 * human would read, which is the only thing that decides whether these are one question.
 */
function sameDecisions(a: PlanDecision[] | null | undefined, b: PlanDecision[] | null): boolean {
  return canonical(a ?? null) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

/** Why a settled filed plan form that its agent did not withdraw cannot be revised. */
function revisionRefusalFor(target: ReviewItem): string {
  switch (target.status) {
    case "answered":
    case "approved":
    case "rejected":
      return "was already answered. File the new plan as a new form, without revises.";
    case "dismissed":
      return "the operator dismissed. File the new plan as a new form, without revises.";
    case "orphaned":
      return target.closedReason === "merged"
        ? "was closed when the task's pull request merged. File the new plan as a new form, without revises."
        : "was closed when its session went away. File the new plan as a new form, without revises.";
    case "superseded":
      return "was replaced by a reworded retry. File the new plan as a new form, without revises.";
    case "withdrawn":
      return "was not withdrawn by its own agent, so it cannot be revised. File the new plan as a new form, without revises.";
    case "pending":
    case "snoozed":
      return "is not open for revision. File the new plan as a new form, without revises.";
  }
}

export class ReviewManager {
  private waiters = new Map<string, Set<Waiter>>();
  private continuationDelivery: ContinuationDelivery | null = null;
  private owedContinuationSessions = new Set<string>();
  private continuationAddenda: Array<(review: ReviewItem) => string | null> = [];

  constructor(private registry: Registry) {
    // A review is durable state BOUND TO A SESSION, so it needs the same two halves every
    // other such subscriber has (see `Registry.beginEviction`). Without them a pending row
    // outlived its agent for ever: `remove` clears seven session-scoped maps and never
    // touched this one, and `loadPendingReviews()` restores every pending row at boot
    // whether or not the process that asked still exists. That is a topbar counting eight
    // agents "waiting on your review" when all of them exited days ago - and counting them
    // is the lesser half of it, because the chip opens the modal keyed on the review's
    // session, which is no longer in the session list, so the click does nothing at all.
    //
    // While the daemon is UP: `session_remove`, which the Registry emits only from its
    // eviction timer. Keying on `state === "exited"` instead would settle a live agent's
    // question on one hiccuping sweep, and there is no way back from a terminal status.
    this.registry.subscribe((e) => {
      if (e.type === "session_remove") this.orphanReviewsFor(e.id);
      if (e.type === "session_transfers" && e.changed?.state === "adopted") this.retryContinuations(e.changed.sourceSessionId);
      if (e.type === "session_upsert" && this.owedContinuationSessions.has(e.session.id)) {
        this.retryContinuations(e.session.id);
      }
    });
    // And one whose session went away while the daemon was DOWN is in no map at all until
    // discovery rebuilds it, so the same reconciliation waits for the first COMPLETED
    // sweep. Running it any earlier would orphan the questions of every agent that
    // outlived the restart, which are exactly the ones still worth answering.
    this.registry.onSessionsObserved(() => this.orphanReviewsWithNoLiveSession());
  }

  /**
   * Arm the durable fallback after the daemon has won its port and the pending-turn owner
   * has started.
   *
   * Every pending review restored at process startup has lost its former stdio request:
   * that MCP child was connected to the daemon process that stopped. Marking those rows
   * detached makes an answer after restart resumable instead of merely historical.
   */
  startContinuationRecovery(deliver: ContinuationDelivery): void {
    this.continuationDelivery = deliver;
    const now = Date.now();
    for (const review of this.registry.pendingReviews()) markReviewWaitDetached(review.id, now);
    for (const review of loadSnoozeInstructionCandidates()) this.deliverSnoozeInstruction(review);
    for (const review of loadReviewContinuationCandidates()) this.deliverContinuation(review);
  }

  /**
   * The MCP host canceled the blocking request. Persist the transport handoff, then deliver
   * immediately when the human answer won the race and is already stored.
   */
  detachWait(id: string, sessionId: string): ReviewItem | null {
    const current = this.registry.getReview(id);
    if (!current || current.sessionId !== sessionId) return null;
    const review = markReviewWaitDetached(id, Date.now());
    const candidate = loadReviewContinuationCandidates(id)[0];
    if (candidate) this.deliverContinuation(candidate);
    return review;
  }

  /**
   * Let the owner of a review's side effects say what the answer did, in the continuation an
   * agent receives when its blocking tool call ended before the human answered. The tool would
   * have reported that itself; a detached wait has nobody left to ask, so the owner says it here.
   */
  addContinuationAddendum(addendum: (review: ReviewItem) => string | null): void {
    this.continuationAddenda.push(addendum);
  }

  private continuationText(review: ReviewItem): string {
    const result = reviewToolResult(review);
    const addenda = this.continuationAddenda.flatMap((addendum) => {
      try {
        return addendum(review) ?? [];
      } catch (error) {
        console.error(`Failed to describe review continuation ${review.id}:`, error);
        return [];
      }
    });
    // A snoozed question's agent stopped waiting because the operator told it to, so its answer
    // is news about work already done, not the late result of a call.
    const lead = review.snooze
      ? snoozedContinuationLead(review)
      : `Mission Control review ${review.id} was ${review.status === "dismissed" ? "dismissed" : "answered"} after its MCP wait ended. ` +
        "Treat this as the result of your earlier review tool call:";
    // Only settled, deliverable answers use the answer formatter. Snooze instructions have
    // their own delivery path and must never acquire an answer heading.
    const answer = review.waitMode === "message" && deliversContinuation(review);
    // A filed plan form's agent stopped on it, so its answer restates the plan and each decision
    // rather than reconciling work done meanwhile.
    const text = !answer ? `${lead}\n\n${result.text}` : isFiledGate(review) ? filedPlanAnswer(review) : asyncInputAnswer(review);
    return text + addenda.map((addendum) => `\n\n${addendum}`).join("");
  }

  private deliverContinuation(review: ReviewItem): void {
    this.deliverToOutbox(review, this.continuationText(review), "answer");
  }

  /**
   * A snoozed question's "carry on" instruction, for an agent whose wait had already ended when
   * the operator snoozed it. Without this the agent is told nothing until the answer, and goes
   * on without the operator's choice - including "hold the work that depends on this".
   */
  private deliverSnoozeInstruction(review: ReviewItem): void {
    this.deliverToOutbox(review, snoozedInstructionText(review), "snooze-instruction");
  }

  private deliverToOutbox(review: ReviewItem, text: string, kind: ReviewContinuationKind): void {
    if (transferForSource(review.sessionId)) { this.owedContinuationSessions.add(review.sessionId); return; }
    if (!this.continuationDelivery) {
      this.owedContinuationSessions.add(review.sessionId);
      return;
    }

    let delivered = false;
    try {
      delivered = this.continuationDelivery({ ...review, sessionId: runtimeTransferSuccessor(review.sessionId) }, text, kind);
    } catch (error) {
      console.error(`Failed to queue review ${kind === "answer" ? "continuation" : "snooze instruction"} ${review.id}:`, error);
    }
    if (!delivered) {
      this.owedContinuationSessions.add(review.sessionId);
      return;
    }

    if (this.owedFor(review.sessionId).length > 0) this.owedContinuationSessions.add(review.sessionId);
    else this.owedContinuationSessions.delete(review.sessionId);
  }

  /** Everything still owed to one session's agent, instructions before answers. */
  private owedFor(sessionId: string): Array<{ review: ReviewItem; kind: ReviewContinuationKind }> {
    const mine = (review: ReviewItem) => review.sessionId === sessionId;
    return [
      ...loadSnoozeInstructionCandidates().filter(mine).map((review) => ({ review, kind: "snooze-instruction" as const })),
      ...loadReviewContinuationCandidates().filter(mine).map((review) => ({ review, kind: "answer" as const })),
    ];
  }

  private retryContinuations(sessionId: string): void {
    const owed = this.owedFor(sessionId);
    if (owed.length === 0) {
      this.owedContinuationSessions.delete(sessionId);
      return;
    }
    for (const { review, kind } of owed) {
      if (kind === "snooze-instruction") this.deliverSnoozeInstruction(review);
      else this.deliverContinuation(review);
    }
  }

  /**
   * Open a question and publish it - or hand back the identical one already open.
   *
   * The re-attach is the whole point, and it is not a nicety. Every tool that lands here
   * (`request_input` in call mode, `request_plan_decisions`, `request_review`) BLOCKS until a human
   * decides, for as long as that takes. The MCP client in front of it does not wait that
   * long: it abandons the tool call on its own timeout and hands the model an error, and
   * the model's natural recovery is to ask the identical question again. Nothing here
   * could tell that retry from a fresh ask - a new UUID per call, no dedup key on the
   * table - so the abandoned row stayed pending BESIDE its own retry and the operator was
   * shown the same prompt twice, with no way to tell which of the two still had an agent
   * listening behind it. The live database records the pattern plainly: the duplicate
   * pairs cluster 293-325 seconds apart with a byte-identical body, which is a client
   * timeout and not a human-meaningful interval.
   *
   * So an identical ask from the same session, while the first is still unanswered, is
   * treated as what it is - the same question - and returns the existing row untouched.
   * The retry then long-polls the ORIGINAL review, and `wait` keeps a SET of waiters per
   * id, so answering the one card the operator sees unblocks every call still holding on.
   *
   * Scoped to PENDING deliberately, which is what makes this safe rather than sticky. A
   * question the human already settled is not a match, so an agent that legitimately asks
   * the same thing again later gets a fresh card; the collapse only ever covers the window
   * where a second card would have been unanswerable noise anyway. And the two asks it
   * refuses to collapse are the two it must: a different session's, and one whose offered
   * options differ, since the options are what the human is actually choosing between.
   *
   * This is one floor, not the fix for the timeout itself. The MCP side reports progress to
   * clients that ask for it and persists detachment when a client's maximum still expires.
   * A retry remains harmless, while a later answer no longer depends on a retry occurring.
   *
   * A retry that is NOT byte-identical is the second floor (`retriesReplacedBy`).
   */
  create(
    sessionId: string,
    kind: ReviewKind,
    title: string,
    body: string,
    incomingDecisions: PlanDecision[] | null = null,
    options: {
      snoozable?: boolean;
      now?: number;
      /**
       * `"message"`: the agent's call returns at once and the answer reaches it as a message.
       * Decided by the route (`decideWaitMode`), applied only to `request_input`'s own asks
       * (`async-input`) and to plan forms (`filed-plan-decisions`); absent is today's call-mode
       * wait.
       */
      waitMode?: "message";
      /** The agent's one line on what it does while a message-mode question is open. */
      meanwhile?: string | null;
      /**
       * The asker will long-poll for the answer whatever it is told: an MCP child from an older
       * build, which never says `asyncCapable` and cannot read a receipt.
       */
      callerPolls?: boolean;
      /**
       * The review id of the filed plan form this one revises (`request_plan_decisions`). Checked
       * by `revisionFor`, which refuses with `RevisionRefusal` and writes nothing; an open target
       * is withdrawn in the same transaction as this form is inserted.
       */
      revises?: string;
    } = {},
  ): ReviewItem {
    // An MCP process may still be running a previous build. Compare retries using the form
    // the operator will see, regardless of which version produced the request.
    const decisions = restoreRequestInputText(kind, incomingDecisions);
    // A SNOOZED twin is the same question too. Its agent was told not to ask again, and one that
    // does anyway is handed the parked row back, whose wait returns at once with the same
    // "carry on" it already got, rather than putting a second card in front of the operator.
    // With `revises`, only the revision this same request already filed is that ask: a retry of it
    // is handed back, and any other identical open form is not, so a new revision is always
    // validated, linked and numbered, and its open target withdrawn.
    const existing = this.registry
      .outstandingReviews(sessionId)
      .find((r) => r.kind === kind && r.title === title && r.body === body && sameDecisions(r.decisions, decisions)
        && (options.revises === undefined || r.revision?.previousId === options.revises));
    if (existing) {
      // An older child re-asked a filed question (`async-input`) and is about to long-poll it.
      // Attach the row now, before this response leaves, so an answer given before its first
      // poll arrives is that poll's result and is never also queued as a message.
      return existing.waitMode === "message" && options.callerPolls === true ? this.attachCall(existing) : existing;
    }

    // Validated after the re-attach, so a retried revision is handed the revision it already filed
    // rather than refused because its target is now revised.
    const revision = options.revises === undefined ? null : this.revisionFor(sessionId, kind, options.revises);
    const review: ReviewItem = {
      id: randomUUID(),
      sessionId,
      kind,
      title,
      body,
      status: "pending",
      response: null,
      decisions,
      selections: null,
      resolvedBy: null,
      ...(options.snoozable === true && kind === "input" ? { snoozable: true } : {}),
      ...(options.waitMode === "message" && ((options.snoozable === true && kind === "input") || kind === "plan-decisions")
        ? { waitMode: "message" as const } : {}),
      // Only a filed question keeps it: a question its agent waits on inside the call must not
      // tell the operator the agent is carrying on.
      ...(options.meanwhile && options.waitMode === "message" && options.snoozable === true && kind === "input"
        ? { meanwhile: options.meanwhile } : {}),
      ...(revision ? { revision: revision.link } : {}),
      createdAt: options.now ?? Date.now(),
      resolvedAt: null,
    };
    // Decided before anything is written, then committed with the new card in one transaction:
    // a failure part way leaves neither the new card nor a withdrawal, rather than both cards
    // pending with the withdrawal lost. Only after the commit is anything published or woken.
    const replaced = this.retriesReplacedBy(review);
    const resolvedAt = Date.now();
    inTransaction(() => {
      if (isRequestInputQuestion(review) && (review.waitMode === "message" || featureEnabled(ASYNC_INPUT_FLAG))) {
        // Count parked and call-mode questions too. A recognized retry replaces its older
        // card in this transaction, so only questions that will remain consume a slot.
        const open = this.openQuestions(sessionId).filter((r) => !replaced.some((older) => older.id === r.id));
        if (open.length >= MAX_OPEN_QUESTIONS) {
          throw new OpenQuestionLimitError(
            `Not asked: this session already has ${open.length} open questions (limit ${MAX_OPEN_QUESTIONS}):\n` +
            open.map((r) => `- ${r.title} (${r.id})`).join("\n") +
            "\nWork on what you can or end your turn. Use withdraw_question for a message-mode question you no longer need.",
          );
        }
      }
      insertReview(review);
      for (const older of replaced) updateReviewStatus(older.id, "superseded", null, resolvedAt, null, null);
      // An open form this one revises is withdrawn by the one agent-withdrawal writer, inside
      // this transaction, so the operator never sees both cards and a failure leaves neither. It
      // is never also in `replaced`: a revision is a plan form, and only a `request_input`
      // question supersedes, and only a call-mode question.
      revision?.withdrawal?.persist();
    });
    // The replaced form's withdrawal is published before the revision, so no subscriber ever
    // holds both open cards between the two events.
    revision?.withdrawal?.publish();
    this.registry.upsertReview(review);
    for (const older of replaced) {
      this.publishSettled({ ...older, status: "superseded", response: null, resolvedAt, resolvedBy: null, selections: null });
    }
    return review;
  }

  /**
   * Refuse a `revises` before a caller writes anything of its own (`RevisionRefusal`), for a route
   * that binds other state to a review id before the review itself is written.
   */
  assertRevisable(sessionId: string, kind: ReviewKind, revises: string): void {
    this.revisionFor(sessionId, kind, revises);
  }

  /**
   * Check a `revises` and say what it links to. The target must be a filed plan form of this
   * session, by the wait mode stored on its row now, that is either still open or was withdrawn by
   * its own agent (`withdrawnByItsAgent`), and that no form has revised yet. Anything else is a
   * `RevisionRefusal` with the reason, before anything is written.
   *
   * The row is read from the database rather than the registry, because a withdrawn form leaves the
   * registry at the next restart (`loadPendingReviews` restores only open rows).
   */
  private revisionFor(sessionId: string, kind: ReviewKind, revises: string): Revision {
    const refuse = (why: string): never => {
      throw new RevisionRefusal(`Not filed: revises names ${revises}, which ${why} Nothing was filed.`);
    };
    if (kind !== "plan-decisions") refuse("cannot be revised by this kind of ask; only request_plan_decisions revises a form.");
    const target = loadReview(revises);
    if (!target) return refuse("is not a review Mission Control knows.");
    if (target.sessionId !== sessionId) refuse("belongs to another session. Revise only a plan form your own session filed.");
    if (target.kind !== "plan-decisions") refuse("is not a plan form. Only a form filed with request_plan_decisions can be revised; file this plan without revises.");
    if (!isFiledGate(target)) {
      refuse("waits for its answer inside a tool call, so it cannot be revised. Its call returns the operator's answer; wait for that instead.");
    }
    const revisedBy = reviewRevisedBy(target.id);
    if (revisedBy) refuse(`was already revised by ${revisedBy}. Revise the latest form instead: revises ${revisedBy}.`);
    const number = (target.revision?.number ?? 1) + 1;
    let withdrawal: AgentWithdrawal | null = null;
    if (target.status === "pending") {
      let admitted: ReviewItem;
      try {
        admitted = this.admitAgentWithdrawal(sessionId, target.id);
      } catch (error) {
        // Mid runtime transfer, for one: the open form cannot be withdrawn now, so nothing is filed.
        if (error instanceof ReviewResolutionError) return refuse(`cannot be withdrawn right now (${error.message}) Try again shortly.`);
        throw error;
      }
      withdrawal = this.agentWithdrawal(admitted, `Revised: replaced by revision ${number} of this plan.`);
    } else if (!withdrawnByItsAgent(target)) {
      refuse(revisionRefusalFor(target));
    }
    return { link: { number, previousId: target.id }, withdrawal };
  }

  /**
   * The `request_input` questions the ten-question limit counts: both wait modes, including
   * questions parked by the operator. Never a plan form, filed or not.
   */
  openQuestions(sessionId: string): ReviewItem[] {
    return this.registry.outstandingReviews(sessionId).filter(isRequestInputQuestion);
  }

  /**
   * What an agent may list and withdraw as its own (`isAgentAsk`): its `request_input` questions
   * and its filed plan forms. Not the limit's count, which stays `openQuestions`.
   */
  openAsks(sessionId: string): ReviewItem[] {
    return this.registry.outstandingReviews(sessionId).filter(isAgentAsk);
  }

  /**
   * `withdraw_question`: the asking agent taking back its own filed ask, a question or a plan form.
   * One of the two entries to the agent withdrawal (`agentWithdrawal`), the one place that writes
   * the status `withdrawn`. It admits only the calling session's own ask and refuses a call-mode
   * one, so a `withdrawn` review was always withdrawn by its own agent.
   */
  withdrawQuestion(sessionId: string, id: string, reason: string): ReviewItem {
    const withdrawal = this.agentWithdrawal(this.admitAgentWithdrawal(sessionId, id), reason);
    inTransaction(withdrawal.persist);
    return withdrawal.publish();
  }

  /**
   * Who may enter the agent withdrawal, for both of its entries: the calling session's own open
   * ask (`openAsks`), filed rather than waited on in a call, outside a runtime transfer.
   */
  private admitAgentWithdrawal(sessionId: string, id: string): ReviewItem {
    const review = this.openAsks(sessionId).find((r) => r.id === id);
    if (!review) throw new ReviewResolutionError("No open question with this id belongs to this session.");
    if (review.waitMode !== "message") throw new ReviewResolutionError("A call-mode question cannot be withdrawn; its call is still waiting.");
    if (transferForSource(sessionId)) throw new ReviewResolutionError("This session is mid runtime transfer.");
    return review;
  }

  /**
   * The one place that writes the status `withdrawn`, in two halves (`AgentWithdrawal`). Its two
   * entries are `withdrawQuestion` and a `revises` that names an open form (`revisionFor`), each
   * admitted by `admitAgentWithdrawal`, so the status is only ever the asking agent's own act and
   * records no actor. `reason` is stored in `response`.
   */
  private agentWithdrawal(review: ReviewItem, reason: string): AgentWithdrawal {
    let noteKey: string | null = null;
    let withdrawn: ReviewItem | null = null;
    return {
      persist: () => {
        const resolvedAt = Date.now();
        updateReviewStatus(review.id, "withdrawn", reason, resolvedAt, null, null);
        // Withdraw the question and its still-unclaimed instruction together. Claimed deliveries
        // may already have reached the agent, so keep their records for delivery reconciliation.
        noteKey = cancelUnclaimedSnoozeInstruction(review.id);
        withdrawn = { ...review, status: "withdrawn", response: reason, resolvedAt, resolvedBy: null, selections: null };
      },
      publish: () => {
        if (!withdrawn) throw new Error(`withdrawal of ${review.id} was published before it was persisted`);
        const published = this.publishSettled(withdrawn);
        if (noteKey !== null) this.registry.refreshPendingTurns(noteKey);
        return published;
      },
    };
  }

  /**
   * An older MCP child is waiting in a call on a question filed without one: turn it into the
   * call-mode question it now is (`markReviewWaitAttached`), and republish it so the session
   * counts it as a pending review rather than an open question until it settles. Without this
   * a session blocked in that call would read as still working past its question.
   */
  private attachCall(review: ReviewItem): ReviewItem {
    if (review.filedByVoiceAt != null) throw new VoiceFiledCallRefusal(review.id);
    if (!markReviewWaitAttached(review.id)) return review;
    const { waitMode: _filed, meanwhile: _carryingOn, ...call } = review;
    this.registry.upsertReview(call);
    return call;
  }

  /**
   * The questions a new `request_input` ask replaces, which `create` withdraws with it.
   *
   * The exact-match re-attach in `create` covers a retry sent byte for byte. Agents rarely
   * retry that way. When an MCP client gives up on a blocking call, the model reads a timeout
   * error and reissues the decision in new words: "The previous prompt timed out. May I
   * proceed...". Codex does exactly this, and its client sends no cancellation, so the daemon
   * never records the first wait as detached. Both cards stayed in the queue, and the operator
   * answered the same decision twice.
   *
   * So when a session's new `request_input` ask is a reworded retry of an older one from the
   * same session that is still pending (`isRewordedRetry`: the same decision, by its wording and
   * by any phase, PR or other number it names), the older card is settled and the newer one
   * stays. Any
   * other older question stays exactly where it is, because a later, different ask is no
   * evidence that the operator no longer needs to answer it. Parallel calls are never retries:
   * a call-mode `request_input` blocks, so an agent still waiting on one question can only ask another in
   * the same batch, and those arrive less than `PARALLEL_ASK_WINDOW_MS` apart.
   *
   * Only `request_input`'s own asks (`snoozable`), on both sides: plan approvals, diff reviews,
   * and the confirmations other tools raise are not retried this way and are never withdrawn
   * by it. A question the operator snoozed is excluded even after it comes back to `pending`,
   * because they chose to park it and its agent was told to carry on, so a later, different
   * question from that agent is expected rather than a retry.
   *
   * An older message-mode question (`async-input`) is never withdrawn. The withdrawal rests on
   * the older call being blocking: only a timed-out call leaves a question its agent re-asks. A
   * message-mode ask never times out, so a later, similar question is a new question. A newer
   * message-mode ask CAN withdraw an older call-mode one: a call that timed out before the flag
   * was turned on, re-asked in new words, is the same retry, and leaving both would let the
   * operator answer a stale copy after the agent already heard the other.
   */
  private retriesReplacedBy(newer: ReviewItem): ReviewItem[] {
    if (newer.snoozable !== true) return [];
    const cutoff = newer.createdAt - PARALLEL_ASK_WINDOW_MS;
    return this.registry.outstandingReviews(newer.sessionId).filter((older) =>
      older.id !== newer.id && older.status === "pending" && older.snoozable === true &&
      older.waitMode !== "message" &&
      !older.snooze && older.createdAt <= cutoff && isRewordedRetry(older, newer));
  }

  /**
   * "Remind me later": park a pending `request_input` question and release the agent.
   *
   * Persist, publish, then wake the waiters, the order `settle` keeps and for the same reasons.
   * Waking them is the point: the MCP call long-polling this review returns with the snoozed
   * row, and `reviewToolResult` turns that into the instruction to carry on. A wait that had
   * already detached has no waiter to wake, so on the first snooze the same instruction is
   * queued through the continuation outbox as a message (`deliverSnoozeInstruction`); the later
   * answer then follows by the ordinary continuation, under its own marker.
   *
   * "Nobody is listening" is read at this instant. An MCP child between two long polls of a
   * wait that is recorded as detached (every pending wait is, after a daemon restart) can be
   * told twice - once as the result of its next poll, once as a message. That duplicate is the
   * accepted cost: the alternative failure is an agent never told at all.
   *
   * `meanwhile` is checked against the question even on a later snooze, where it is not stored,
   * so a request naming an option the question never offered is refused rather than ignored.
   */
  snooze(
    id: string,
    delayMs: number,
    meanwhile: ReviewSnoozeMeanwhile = { mode: "judgment" },
    now = Date.now(),
    by: ReviewActor = "human",
  ): ReviewItem | null {
    const cur = this.registry.getReview(id);
    if (!cur) return null;
    if (by !== "human") throw new SnoozeActorRefusal("Only the operator can choose Remind me later");
    if (cur.snoozable !== true) {
      throw new ReviewResolutionError("Only a question asked through request_input can be snoozed");
    }
    if (cur.status !== "pending") {
      throw new ReviewResolutionError(
        cur.status === "snoozed" ? "This question is already snoozed" : "This question is already settled",
      );
    }
    const problem = snoozeMeanwhileProblem(cur, meanwhile);
    if (problem) throw new ReviewResolutionError(`Cannot snooze: ${problem}`);
    const snoozed = snoozeReviewRow(id, {
      at: now,
      until: now + delayMs,
      mode: meanwhile.mode,
      optionId: meanwhile.mode === "option" ? meanwhile.optionId : null,
      listening: (this.waiters.get(id)?.size ?? 0) > 0,
    });
    if (!snoozed) throw new ReviewResolutionError("This question is no longer open");
    const updated = snoozed.review;
    this.registry.upsertReview(updated);
    this.releaseWaiters(updated);
    // Nobody was listening and the wait had ended: the instruction goes as a message instead.
    if (snoozed.instructionOwed) this.deliverSnoozeInstruction(updated);
    return updated;
  }

  /**
   * Bring a snoozed question back to the operator now: its time came, or they chose Answer now.
   * Null when it is not snoozed (already back, answered, or unknown), which a sweep that raced
   * an answer reads as nothing to do.
   */
  wake(id: string, now = Date.now()): ReviewItem | null {
    const cur = this.registry.getReview(id);
    if (!cur || cur.status !== "snoozed") return null;
    const updated = wakeReviewRow(id, now);
    if (!updated) return null;
    this.registry.upsertReview(updated);
    return updated;
  }

  /** Wake every snoozed question that is due. Returns the ones it brought back. */
  sweepSnoozed(now = Date.now()): ReviewItem[] {
    const woken: ReviewItem[] = [];
    for (const review of this.registry.snoozedReviews()) {
      if ((review.snooze?.until ?? 0) > now) continue;
      try {
        const updated = this.wake(review.id, now);
        if (updated) woken.push(updated);
      } catch (error) {
        console.error(`Failed to bring back snoozed review ${review.id}:`, error);
      }
    }
    return woken;
  }

  /**
   * Start bringing snoozed questions back on time. Sweeps once at once, so a reminder that fell
   * due while the daemon was down is not held for another interval, then every `intervalMs`.
   * Returns the stop.
   */
  startSnoozeClock(intervalMs = SNOOZE_SWEEP_MS): () => void {
    this.sweepSnoozed();
    const timer = unref(setInterval(() => this.sweepSnoozed(), intervalMs));
    return () => clearInterval(timer);
  }

  /**
   * Write a question that was ALREADY answered elsewhere - born settled, never pending.
   *
   * The second writer of this table, and the reason it is a separate method rather than a
   * `create` followed by a `resolve`. A session on the SDK runtime keeps Claude's native
   * `AskUserQuestion` and is answered by resolving the callback it is blocked on
   * (`/submit-options`), so by the time there is anything to record the decision is made
   * and the agent has moved on. Routing that through the pending path would publish a
   * `review_upsert` with `status: "pending"` for an instant - long enough for the dashboard
   * to bump its badge, pop the review modal over whatever the operator was reading, and
   * offer them a form for a question that is already gone.
   *
   * So this is the whole of it: one durable write, one upsert to publish it. No waiters are
   * woken because nothing is waiting - a driver request has no MCP long poll behind it - and
   * `refreshPendingCount` is a no-op on a row that was never pending.
   *
   * "Born settled" has to hold of the DATABASE and not only of the event, which is what
   * `inTransaction` is for. Two writers land this row - `insertReview` lays down every
   * column it shares with a `create`, `updateReviewStatus` stamps the settle columns - and
   * a failure between them commits the first without the second.
   *
   * Be precise about what that leaves, because it is NOT a pending review: `insertReview`
   * writes the status off the item, and the item is already `answered`, so the half-written
   * row reads `answered` with a null `resolved_by` and null `selections`. Nothing restores
   * it as a question (`loadPendingReviews` filters on `pending`) and nothing shows it as an
   * answer (`loadHumanResolvedReviews` requires a human or standing-approval actor), so it is inert -
   * today. It is still worth not writing. It is indistinguishable from a row that predates
   * the actor column, it accumulates where nothing will ever collect it, and its harmlessness
   * is a property of two queries in another module rather than of this write: the first
   * reader that asks for `status = 'answered'` without also asking who answered surfaces a
   * review with no author and no selections. The transaction makes the pair all-or-nothing,
   * so the failure mode is "no record of an answer" - which the conversation shows as the
   * silence this feature replaced - and never a row that half exists.
   *
   * Two writers inside a transaction rather than one wide INSERT, deliberately. The settle
   * columns then have exactly one place they are written from, so a column added to
   * `updateReviewStatus` reaches this path for free; a terminal-state INSERT here would be a
   * second column list to keep in step, and the one that silently drifts is the one no
   * pending-review path exercises.
   *
   * The upsert RETAINS as well as publishes, and that is not incidental. The dashboard
   * re-seeds its live review map wholesale from the reconnect snapshot
   * (`useEventStream`), so a record that was only emitted would vanish from an open
   * conversation the first time the SSE stream dropped - and the fetched half beside it was
   * taken at mount, before this row existed, so nothing would put it back until the panel
   * remounted. Publishing without keeping is the cheaper-looking version of this that does
   * not work.
   *
   * `resolvedBy` is required, not defaulted. It is the field the conversation reads to
   * decide whose voice an answer speaks in (`isHumanResolvedReview`), and Foreman answers
   * driver questions through the very same route the dashboard does.
   *
   * REFUSED when the session has no row in the registry, which is the dangling case and the
   * one place it can arise: this method is reached only after `answerDriverRequest` has
   * AWAITED the driver taking the answer, and an eviction timer can fire inside that await.
   * What would be written is a conversation entry for a conversation that no longer exists -
   * nothing can render it, because the card is gone - and it would be durably
   * indistinguishable from an ordinary answer for ever after. That is not a cosmetic
   * difference: retro worthiness is reconstructed from these rows when a session is
   * introduced (`Registry.seedRetroFromReviews`), so a row written behind a departed session
   * would light the offer for the very path the design excludes, on this daemon or on any
   * later one. Refusing at the write is what makes that exclusion structural rather than a
   * piece of memory a restart discards.
   *
   * A throw rather than a silent no-op, and it costs nothing: the caller already treats a
   * failed record as a thing to log beside the delivery that did happen, and must not turn it
   * into a 409 - the operator would answer a question the agent is no longer blocked on.
   */
  record(o: {
    /** Supplied when the caller must bind other state to the id before the row is published. */
    id?: string;
    sessionId: string;
    kind: ReviewKind;
    title: string;
    body: string;
    decisions: PlanDecision[];
    selections: PlanDecisionAnswer[];
    response: string;
    resolvedBy: ReviewActor;
    /**
     * When the human spoke - NOT when this ran.
     *
     * The conversation places an answer by `resolvedAt`, and the caller only reaches this
     * after the answer has been handed to the driver, which is after the agent has been
     * unblocked and may already have written its next turn. Stamping here would file a
     * decision below the reply it caused. The route takes the reading before it delivers.
     */
    at: number;
    /**
     * The filed plan form this record revises: a managed bundle revision that a standing approval
     * approved outright, so no card is filed to carry the link. Checked and applied as `create`
     * does, the open target withdrawn in this record's transaction.
     */
    revises?: string;
  }): ReviewItem {
    if (!this.registry.getSession(o.sessionId)) {
      throw new ReviewResolutionError(
        `session ${o.sessionId} is no longer registered, so its answer has no conversation to join`,
      );
    }
    const now = o.at;
    const revision = o.revises === undefined ? null : this.revisionFor(o.sessionId, o.kind, o.revises);
    const review: ReviewItem = {
      id: o.id ?? randomUUID(),
      sessionId: o.sessionId,
      kind: o.kind,
      title: o.title,
      body: o.body,
      status: "answered",
      response: o.response,
      decisions: o.decisions,
      selections: o.selections,
      resolvedBy: o.resolvedBy,
      ...(revision ? { revision: revision.link } : {}),
      createdAt: now,
      resolvedAt: now,
    };
    inTransaction(() => {
      insertReview(review);
      updateReviewStatus(review.id, "answered", o.response, now, o.selections, o.resolvedBy);
      revision?.withdrawal?.persist();
    });
    // Published only after the commit, so nothing can put a review on screen that a rollback
    // then took off disk. The throw from a failed transaction reaches the caller, which
    // logs it and still reports the delivery that did happen. A replaced form's withdrawal goes
    // first, as in `create`.
    revision?.withdrawal?.publish();
    this.registry.upsertReview(review);
    this.markSteered(review);
    return review;
  }

  /**
   * A settled review the human authored is the same retro evidence as a typed correction.
   *
   * ONE test for both writers of a terminal status, and it is `isHumanResolvedReview` rather
   * than a status check spelled again here: Foreman resolves reviews through the very route
   * the dashboard does, and the daemon's own orphan settle carries no actor at all. Neither
   * is a person steering the work, and both are already excluded from the conversation by
   * this same predicate - so the offer and the log agree by construction.
   *
   * Called AFTER the durable write and the publish, never before. A rolled-back transaction
   * throws out of `record` before it reaches here, and a delivery that failed never reached
   * `record` at all (the driver route returns 409 first) - so nothing lights the offer on an
   * answer the agent never received. The Registry drops it on the floor when the session row
   * has already gone; see `recordRetroHumanReview`.
   */
  private markSteered(review: ReviewItem): void {
    if (!isHumanResolvedReview(review)) return;
    this.registry.recordRetroHumanReview(review.sessionId);
  }

  /** Voice converts a call only with every current waiter's consent. From then on all filed-ask rules apply. */
  convertToFiled(reviewId: string): boolean {
    const waiters = this.waiters.get(reviewId);
    if (!waiters?.size || [...waiters].some(waiter => !waiter.convertible)) return false;
    const filed = fileReviewByVoice(reviewId, Date.now());
    if (!filed) return false;
    // Remove the calls before publishing: synchronous registry listeners may settle the filed ask.
    this.releaseWaiters(convertedResponse(filed));
    this.registry.upsertReview(filed);
    return true;
  }

  /**
   * Resolve immediately if already decided; otherwise wait up to `timeoutMs`.
   * On timeout returns the still-pending item so the caller can long-poll again.
   * Returns null if the id is unknown. `signal` ends the wait early the same way a timeout does,
   * which is how the daemon's shutdown answers a long-poll instead of cutting it.
   */
  wait(id: string, timeoutMs: number, signal?: AbortSignal, convertible = false): Promise<ReviewWaitResponse | null> {
    const current = this.registry.getReview(id);
    if (!convertible && current?.filedByVoiceAt != null) return Promise.reject(new VoiceFiledCallRefusal(id));
    if (convertible) {
      // A settled ask can be absent from the registry after restart. Its answer already
      // belongs to the outbox, so the retry still returns the original filing receipt.
      const review = current ?? loadReview(id);
      if (review?.waitMode === "message" && review.filedByVoiceAt != null) {
        return Promise.resolve(convertedResponse(review));
      }
    }
    if (!current) return Promise.resolve(null);
    if (current.status !== "pending") return Promise.resolve(current);
    return new Promise<ReviewWaitResponse | null>((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));

      const finish = (r: ReviewWaitResponse | null): void => {
        clearTimeout(timer);
        set!.delete(waiter);
        if (!set!.size) this.waiters.delete(id);
        signal?.removeEventListener("abort", early);
        resolve(r);
      };
      const waiter: Waiter = { finish, convertible };
      const early = (): void => finish(this.registry.getReview(id) ?? null);
      const timer = unref(setTimeout(early, timeoutMs));

      set.add(waiter);
      if (signal?.aborted) return early();
      signal?.addEventListener("abort", early, { once: true });
      if (!convertible) blockReviewVoiceConversion(id);
      // A call is waiting on a question filed without one (`async-input`): an MCP child from an
      // older build re-asked it word for word, was handed the open row, and long-polls it because
      // it cannot read a receipt. From here the row is delivered the way a call-mode question is:
      // its answer is this call's result, and only a later detach (a cancelled or restarted call)
      // hands it to the outbox. Without this the agent would hear the answer twice. Attached only
      // after this waiter is registered: attaching publishes a `session_upsert`, and a merge
      // closure that event triggers must be able to release this very call.
      if (current.waitMode === "message") {
        this.attachCall(current);
      } else if (convertible && featureEnabled("voice")) {
        const session = this.registry.getSession(current.sessionId);
        if (session && hasQueuedSpeechForReview(id, noteKeyFor(session))) this.convertToFiled(id);
      }
    });
  }

  /**
   * A decision arriving from outside: the dashboard's, or the Foreman worker's.
   *
   * `by` is carried rather than assumed because both arrive on the same route, and only the
   * human's answers belong in the session's conversation (`isHumanResolvedReview`).
   * `selections` is the structured form behind an `answer`, kept so that conversation can
   * replay the question - the `response` string beside it names only what was chosen.
   */
  resolve(
    id: string,
    action: ReviewAction,
    response: string | null,
    by: ReviewActor = "human",
    selections: PlanDecisionAnswer[] | null = null,
    /**
     * Durable state that must commit with this resolution or not at all - the standing plan
     * bundle grant. Runs in the same transaction as the status write, before anything is
     * published or any waiter is woken, so a failure leaves the review pending to retry.
     */
    persistWith?: () => void,
  ): ReviewItem | null {
    const cur = this.registry.getReview(id);
    if (!cur) return null;
    // A snoozed question is still unanswered, and answering it before it comes back is allowed:
    // the answer leaves through the continuation outbox, since the agent's wait already ended.
    if (cur.status !== "pending" && cur.status !== "snoozed") return cur;

    const status: ReviewStatus =
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : action === "dismiss"
            ? "dismissed"
            : "answered";
    const storedResponse = action === "dismiss" ? null : response;
    // Selections describe a form that was filled in, so only an `answer` can carry them.
    // The schema already clears them on a dismiss; this covers the approve/reject actions
    // it does not, and holds whether or not the request came through that schema.
    const storedSelections = action === "answer" ? selections : null;
    return this.settle(cur, status, storedResponse, by, storedSelections, persistWith);
  }

  /**
   * The session that asked has gone. Settle everything it was blocked on.
   *
   * `orphaned` rather than `dismissed`: the operator declining to choose and the agent no
   * longer being there to hear a choice are different facts, and only the first is
   * evidence of intent. The row keeps its question and its body - this is a settle, not a
   * delete, so the record of what was asked survives for anything reading history.
   */
  private orphanReviewsFor(sessionId: string): void {
    if (transferForSource(sessionId)) return;
    for (const r of this.registry.outstandingReviews(sessionId)) this.settle(r, "orphaned", null);
  }

  /**
   * A merge completed this session's task: close every outstanding `request_input` question and
   * filed plan form as `orphaned`, with the close reason `merged`, at that moment rather than at a
   * later eviction.
   *
   * The scope is the completion rules' (`questionHoldsCompletion`): pending or snoozed, a
   * message-mode ask always and a call-mode question while the flag is on. With the flag
   * off a call-mode question is left exactly as before, to be orphaned without a reason when its
   * session goes. Merging is the operator's own conclusion, so nothing here holds the
   * completion; it only makes sure no question outlives it unexplained.
   */
  closeQuestionsForMerge(sessionId: string, flagOn: boolean): ReviewItem[] {
    const closure = this.mergeClosure(sessionId, flagOn);
    inTransaction(closure.persist);
    return closure.publish();
  }

  /**
   * The merge closure in two halves, so a caller can commit it inside its own transaction.
   * `persist` writes every outstanding question's `orphaned`/`merged` settle and cancels its
   * unclaimed snooze instruction. It must run inside a transaction, and throws
   * `MergeClosureDeferred` mid runtime transfer.
   * `publish` broadcasts what `persist` wrote and releases waiting calls; run it only after
   * the commit. Merge-driven completion persists this with the task's own status write
   * (`TaskManager` `joinCompletion`), so the two land together or not at all.
   */
  mergeClosure(sessionId: string, flagOn: boolean): { persist: () => void; publish: () => ReviewItem[] } {
    let closing: ReviewItem[] = [];
    let resolvedAt = 0;
    const noteKeys = new Set<string>();
    return {
      persist: () => {
        noteKeys.clear();
        closing = this.registry.outstandingReviews(sessionId).filter((review) => questionHoldsCompletion(review, flagOn));
        if (closing.length === 0) return;
        // Mid runtime transfer the questions are moving to the successor session, so they cannot
        // be closed here. A skipped close is not a success: throw, and the merge settle keeps the
        // task running until the transfer resolves and the next observation can close them.
        if (transferForSource(sessionId)) {
          closing = [];
          throw new MergeClosureDeferred(`session ${sessionId} is mid runtime transfer`);
        }
        resolvedAt = Date.now();
        for (const review of closing) {
          updateReviewStatus(review.id, "orphaned", null, resolvedAt, null, null, "merged");
          const noteKey = cancelUnclaimedSnoozeInstruction(review.id);
          if (noteKey !== null) noteKeys.add(noteKey);
        }
      },
      publish: () => {
        for (const noteKey of noteKeys) this.registry.refreshPendingTurns(noteKey);
        return closing.map((review) => this.publishSettled({
          ...review, status: "orphaned", response: null, resolvedAt, resolvedBy: null, selections: null, closedReason: "merged",
        }));
      },
    };
  }

  /**
   * The agent is waiting inside a `request_input` call right now: a pending question of its own
   * with a live long-poll attached, or whose call has not yet detached. Such an agent cannot go idle until the question
   * settles, which is why a merge has to close it rather than wait for idleness.
   */
  blockedInRequestInputCall(sessionId: string, flagOn: boolean): boolean {
    // Pending in either count: a filed question an older child re-asked is waited on in a call too.
    // A live long-poll proves the call; so does a row whose call has not detached, which covers the
    // moment between the ask and its first `/wait`, when no poll is attached yet. The in-memory
    // filter runs first, so the row is read only for a question that could hold the merge.
    return this.registry.outstandingReviews(sessionId).some((review) =>
      review.status === "pending" && questionHoldsCompletion(review, flagOn)
      && ((this.waiters.get(review.id)?.size ?? 0) > 0 || reviewWaitAttached(review.id)));
  }

  persistRuntimeTransfer(sourceId: string, successorId: string): ReviewItem[] {
    return transferPendingReviews(sourceId, successorId);
  }

  publishRuntimeTransfer(reviews: readonly ReviewItem[]): void {
    for (const review of reviews) this.registry.upsertReview(review);
  }

  settleRuntimeTransfer(sourceId: string): void { this.orphanReviewsFor(sourceId); }

  /** The restart half: pending reviews bound to a session the first sweep never found. */
  private orphanReviewsWithNoLiveSession(): void {
    for (const r of this.registry.outstandingReviews()) {
      if (this.registry.getSession(r.sessionId) || transferForSource(r.sessionId)) continue;
      this.settle(r, "orphaned", null);
    }
  }

  /**
   * The one writer of a terminal status, human-driven or not.
   *
   * Persist, publish, then release the waiters - in that order, and never one without the
   * others. The write is what survives a restart (`loadPendingReviews` is a SQL filter on
   * status, so an in-memory-only settle comes straight back at the next boot), the upsert
   * is what reaches the dashboards (the live channel is SSE only; nothing polls this), and
   * waking the waiters is what unblocks an agent long-polling on an answer instead of
   * leaving it to discover the timeout.
   */
  private settle(
    cur: ReviewItem,
    status: ReviewStatus,
    response: string | null,
    /**
     * Null for the two orphan paths below, which are the daemon tidying up after a session
     * that went away, and for `retriesReplacedBy` - not a decision anyone made, and so
     * not a voice in the conversation.
     */
    resolvedBy: ReviewActor | null = null,
    selections: PlanDecisionAnswer[] | null = null,
    persistWith?: () => void,
  ): ReviewItem {
    const resolvedAt = Date.now();
    const write = () => updateReviewStatus(cur.id, status, response, resolvedAt, selections, resolvedBy);
    if (persistWith) inTransaction(() => { write(); persistWith(); });
    else write();
    return this.publishSettled({ ...cur, status, response, resolvedAt, resolvedBy, selections });
  }

  /**
   * Everything a settle does after its status is durably written: publish it, credit or retire
   * what the actor's decision affects, and release the waiters. Split from `settle` so `create`
   * can commit a withdrawal in the same transaction as the card that replaced it.
   */
  private publishSettled(updated: ReviewItem): ReviewItem {
    const { resolvedBy } = updated;
    this.registry.upsertReview(updated);

    // You decided this yourself, so Foreman's pinned note about the same review is spent.
    //
    // Gated on the HUMAN, and the two excluded actors are excluded for different reasons.
    // `foreman` is Foreman delivering its own approved answer, whose `applyVerdict` writes
    // the note itself - retiring it here would race that write and file the decision as one
    // nobody delivered. A null actor is the daemon orphaning reviews for a session that went
    // away: no decision was made, so there is no answer of yours to credit, and the note
    // rightly stays until the session's own teardown clears it.
    if (resolvedBy === "human") {
      this.registry.retireNoteAnsweredByYou(updated.sessionId, `review:${updated.id}`);
    }
    this.markSteered(updated);
    // One actor policy (`CONTINUATION_ACTOR_POLICY`): the operator, a controlling session, a home
    // session or mctl always, and Foreman or a standing approval for a message-mode question, which
    // has no call to return it through. The conversation and timeline still read
    // `isConversationResolvedReview`.
    if (deliversContinuation(updated)) {
      const candidate = loadReviewContinuationCandidates(updated.id)[0];
      if (candidate) this.deliverContinuation(candidate);
    }

    this.releaseWaiters(updated);
    return updated;
  }

  private releaseWaiters(review: ReviewWaitResponse): void {
    const set = this.waiters.get(review.id);
    if (set) {
      for (const w of Array.from(set)) w.finish(review);
      this.waiters.delete(review.id);
    }
  }
}
