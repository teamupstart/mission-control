import { transferForNote, transferHold } from "./session-transfers/store.ts";
import { randomUUID } from "node:crypto";
import type { MessageSendDisposition, PendingTurn, ServerEvent, Session, SdkSendDisposition, TurnOrigin } from "@shared/types.ts";
import {
  AFTER_WORK_SKILLS_TURN_PREFIX, MESSAGE_INTERRUPT_WATCHDOG_MS, canSteerMessage, deliverySchedule, deliveryStage, idleOnlyTurn,
  assignSteerReceipts, supportsDeliveryAction, type MessageDeliveryAction,
} from "@shared/message-delivery.ts";
import { canMessage } from "@shared/pane.ts";
import { activePaneDialog, settledIdle } from "@shared/session.ts";
import { injectPrompt, interruptPaneSession, type InjectResult } from "./actions.ts";
import { followSpokenConversationKey, reserveSpokenHandoff, spokenLedger } from "./delivery-ledgers.ts";
import { VOICE_TURN_PREFIX, openQuestionsNote, spokenMessageText } from "@shared/voice-delivery.ts";
import { isAgentAsk } from "@shared/async-input.ts";
import type { ReviewContinuationKind } from "./reviews.ts";
import {
  claimNextPendingTurn,
  createPendingTurn,
  expeditePendingTurn,
  recordPendingTurnInterrupt,
  createReviewContinuationPendingTurn,
  createSnoozeInstructionPendingTurn,
  SNOOZE_INSTRUCTION_TURN_PREFIX,
  MESSAGE_ANSWER_TURN_PREFIX,
  afterWorkTurnOwed,
  deleteClaimedPendingTurn,
  retireDeliveredPendingTurn,
  dropQueuedAfterWorkTurn,
  dropQueuedPendingTurns,
  markPendingTurnUncertain,
  recallPendingTurn,
  recoverSendingPendingTurns,
  rekeyPendingTurns,
  releasePendingTurn,
  resolveUncertainPendingTurn,
  retryPendingTurn,
} from "./db.ts";
import { noteKeyFor, type Registry } from "./registry.ts";
import type { SdkTurn } from "./harness/types.ts";
import { sdkFor, sessionMessages, type SessionMessages } from "./harness/index.ts";
import { journalScoutPrompt } from "./scouts/prompt-journal.ts";
import { noteOtherSend, withdrawOtherSend, type OtherSendHandle } from "./delegated-turns.ts";
import {
  confirmReviewDelivery,
  followNativeConversationKey,
  releaseReviewDelivery,
  reserveReviewDelivery,
  stampReviewDeliveryHandoff,
} from "./review-deliveries.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { INBOX_MESSAGES, INBOX_MESSAGE_TURN_PREFIX, type InboxMessageKind } from "@shared/inbox.ts";
import { ASYNC_INPUT_FLAG } from "@shared/async-input.ts";
import { isReviewMessageTurn } from "@shared/review-message-envelope.ts";
import {
  confirmHumanEcho,
  expectHumanEcho,
  markHumanEchoCaptured,
  notePersonDelivery,
  recordInjection,
  releaseHumanEcho,
  releaseInjection,
  reserveInjection,
  AutomatedAttributionError,
  PersonAttributionError,
  withdrawPersonDelivery,
  type HumanEchoTicket,
  type PersonDelivery,
} from "./injections.ts";
import { unref } from "./util/timers.ts";

const DEFAULT_IDLE_SETTLE_MS = 1_500;
/** Why a queued after-work prompt was not delivered: task shaping was off when its turn came. */
export const AFTER_WORK_FLAG_OFF = "Task shaping was turned off before the prompt was delivered.";
/** Why an after-work turn was refused: a later launch of its task replaced the launch it was for. */
export const AFTER_WORK_SUPERSEDED = "A later launch of the task replaced the launch this after-work prompt was for.";
/**
 * Why an after-work turn was held back, not refused: whether its launch still owns it could not be
 * read. It stays queued, undelivered and unsettled, and is checked again (`afterWorkRecheckMs`).
 */
export const AFTER_WORK_UNVERIFIED = "Mission Control could not check that this after-work prompt's launch still owns it.";
const DEFAULT_PICKUP_TIMEOUT_MS = 15_000;

export interface IdleSdkSender {
  sendWhenIdle(
    id: string,
    turn: SdkTurn,
    beforeSend?: () => string | null,
  ): Promise<"started" | null>;
  send(id: string, turn: SdkTurn, beforeSend?: () => string | null): Promise<SdkSendDisposition>;
  interruptForDelivery(id: string, beforeInterrupt: () => string | null): Promise<void>;
  /**
   * Whether this session's driver must not be handed a turn yet: a hibernated task's woken
   * driver before Resume binds the task to it (`SdkSupervisor.wakeBound`). Rows stay queued,
   * and the `session_upsert` the binding emits re-arms their delivery. Optional, because only
   * the supervisor has woken drivers.
   */
  holdsDelivery?(id: string): boolean;
}

export interface PendingTurnSubmitResult {
  ok: boolean;
  /**
   * A refusal that can clear without anyone acting: the outbox was still starting, or a live
   * session could not take messages at that moment. Absent on a refusal that cannot, such as a
   * session that is gone or has exited.
   */
  retryable?: boolean;
  pasted: false;
  submitVerified: false;
  delivery?: MessageSendDisposition;
  pendingTurn?: PendingTurn;
  error?: string;
}

interface PendingTurnDeps {
  unseenReports: (session: Session) => string | null;
  now: () => number;
  id: () => string;
  inject: typeof injectPrompt;
  idleSettleMs: number;
  pickupTimeoutMs: number;
  interruptTimeoutMs: number;
  interruptPane: typeof interruptPaneSession;
  /** Where a session's transcript is read, for noticing that a steer has been read. */
  messagesFor: (session: Session) => SessionMessages | null;
  steerReceiptPollMs: number;
  /**
   * Whether task shaping is on, read when an after-work turn is about to be delivered. A turn
   * queued while it was on is dropped rather than sent once it is off, including after a restart.
   */
  afterWorkEnabled: () => boolean;
  /** Whether an after-work turn's launch still owns it (`afterWorkTurnOwed`). */
  afterWorkTurnOwed: (turnId: string) => boolean;
  /** How long an after-work turn whose ownership could not be read waits before it is checked again. */
  afterWorkRecheckMs: number;
  /** Retire a delivered turn with its after-work prompt row (`retireDeliveredPendingTurn`). */
  retireDelivered: typeof retireDeliveredPendingTurn;
}

/**
 * How often a conversation with an unread steer re-reads its transcript tail. Close to the
 * dashboard's own transcript stream, so the steered row and the turn that replaces it
 * change hands within about a second of each other. Idle whenever nothing is waiting.
 */
const DEFAULT_STEER_RECEIPT_POLL_MS = 500;
const DEFAULT_AFTER_WORK_RECHECK_MS = 1_000;
/** The first and the longest wait before a delivered turn's failed retire is tried again. */
const RETIRE_RETRY_BASE_MS = 1_000;
const RETIRE_RETRY_MAX_MS = 5 * 60_000;

/** How far one conversation's receipt scan has read its transcript. */
interface SteerReceiptScan {
  /** Null until the transcript can be located; the scan then reads it from the start. */
  path: string | null;
  pos: number;
  /**
   * Transcript turns already paired with a steer. A later steer can rewind `pos` over turns
   * this scan has read before, and one of those must never answer a second steer.
   */
  claimed: Set<string>;
}

interface PickupCandidate {
  sessionId: string;
  turn: PendingTurn;
  boundaryAt: number;
  generation: number;
  spokenReservationId: string | null;
  injectionSucceeded: boolean;
  pickupObserved: boolean;
  pickupObservedAt: number | null;
  ownershipUncertain: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TerminalDrainBoundary {
  sessionId: string;
  writeBoundaryAt: number;
  activityObservedAt: number | null;
}

interface SdkHandoff {
  sessionId: string;
  turn: PendingTurn;
  acceptanceBoundaryCrossed: boolean;
  ownershipUncertain: boolean;
}

interface ArmedDrain {
  timer: ReturnType<typeof setTimeout>;
  /** The next idle-settle boundary or message escalation instant. */
  drainAt: number;
}

/**
 * Durable human-turn outbox shared by embedded and terminal conversations.
 *
 * Delivery follows registry evidence and the one message-delivery policy. SDK drivers
 * re-check the appropriate busy or idle boundary while accepting, and terminal
 * rows remain claimed until a hook or passive reader observes work beginning. That keeps an
 * editable row on Mission Control's side of the line and makes every ambiguous terminal
 * outcome an explicit human decision instead of an automatic duplicate.
 */
/**
 * Who WROTE a queued row, when it was not the operator. Every row is the operator's words
 * except three the daemon composes: a snoozed question's "carry on" instruction, the answer
 * to a message-mode question (`async-input`), whoever gave it, and a Stuck row's fixed
 * Nudge, Continue or push message (`inbox`). Those are reserved and recorded
 * as `harness` authorship like any other daemon-typed text, so the agent's prompt hook does not
 * take them for the human's Goal and the scout trail does not archive them as something the
 * operator said. Authorship changes nothing about escalation: `nextDelivery` steers and
 * interrupts these rows on the same clock as an operator message.
 */
function daemonAuthorOf(turn: PendingTurn): TurnOrigin | null {
  return turn.id.startsWith(SNOOZE_INSTRUCTION_TURN_PREFIX)
    || turn.id.startsWith(MESSAGE_ANSWER_TURN_PREFIX)
    || turn.id.startsWith(AFTER_WORK_SKILLS_TURN_PREFIX)
    || turn.id.startsWith(INBOX_MESSAGE_TURN_PREFIX)
    ? "harness"
    : null;
}

/**
 * How one outbox send was recorded before it was attempted, so a refusal can give it back.
 *
 * A row carrying a review marker (`async-input`) reserves a delivery of its own
 * (`review-deliveries.ts`), which is what lets the conversation draw its turn as answer cards
 * and what keeps its prompt-hook echo out of the Goal, across a restart too. It is deliberately
 * NOT also noted as another send: that record would contest the very delivery it describes.
 * Every other row is noted as a send that contests a recorded delivery of the same words.
 */
type OutboxSend =
  | { kind: "review"; noteKey: string; id: string }
  | { kind: "spoken"; words: string; reservationId: string | null }
  | { kind: "other"; handle: OtherSendHandle };

function recordOutboxSend(session: Session, turn: PendingTurn): OutboxSend {
  if (turn.spokenWords !== undefined) {
    return { kind: "spoken", words: turn.spokenWords, reservationId: null };
  }
  const conversation = { key: noteKeyFor(session), transcript: sessionMessages(session) };
  // Only a row the daemon queued about a review: an operator's message that happens to begin
  // with the marker line is the operator's, and is noted like any other send.
  const id = isReviewMessageTurn(turn) ? reserveReviewDelivery(conversation, turn.text, session.workCycle) : null;
  return id ? { kind: "review", noteKey: conversation.key, id } : { kind: "other", handle: noteOtherSend(conversation, turn.text) };
}

/** Both transports run this guard immediately before the write. Only a current, stamped
 * attempt may reserve a transcript occurrence. A crash before the guard leaves no reservation. */
function handoffSpokenTurn(send: OutboxSend, session: Session, turn: PendingTurn, generation: number, now: number, sdkInput?: SdkTurn): boolean {
  if (send.kind !== "spoken" || send.reservationId !== null) return true;
  const conversation = { key: turn.noteKey, transcript: sessionMessages(session) };
  const row = reserveSpokenHandoff(conversation, turn, send.words,
    sdkInput !== undefined && sdkFor(session.agent)?.clientMessageIds === true, generation, now);
  if (!row) return false;
  send.reservationId = row.id;
  if (sdkInput && row.messageId) sdkInput.clientMessageId = row.messageId;
  return true;
}

/** Positive evidence that nothing landed: give the record back. */
function withdrawOutboxSend(send: OutboxSend, turn: PendingTurn): void {
  if (send.kind === "review") releaseReviewDelivery(send.noteKey, send.id);
  else if (send.kind === "other") withdrawOtherSend(send.handle);
  else if (send.reservationId !== null) spokenLedger.release(turn.noteKey, send.reservationId);
}

/**
 * Record that a review delivery was accepted. The acceptance itself is already a fact the runtime
 * reported: a failed bookkeeping write must not turn it into a transport failure, which would make
 * an accepted answer retryable (SDK) or strand a pasted one without its pickup timeout (terminal).
 * The row stays reserved but unconfirmed, which binding already treats as a delivery that may
 * have landed.
 */
function confirmReviewSend(noteKey: string, id: string, options: Parameters<typeof confirmReviewDelivery>[2]): void {
  try {
    confirmReviewDelivery(noteKey, id, options);
  } catch (err) {
    console.error(`[pending-turns] could not record review delivery ${id} as confirmed:`, errorMessage(err));
  }
}

export class PendingTurnManager {
  private readonly deps: PendingTurnDeps;
  private readonly draining = new Set<string>();
  /** After-work turns a delivery guard held back because their launch could not be checked. */
  private readonly unverifiedAfterWork = new Set<string>();
  /** Retires of delivered turns that failed and are tried again, by turn id. */
  private readonly retireRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTimers = new Map<string, ArmedDrain>();
  private readonly pickup = new Map<string, PickupCandidate>();
  private readonly terminalDrainBoundaries = new Map<string, TerminalDrainBoundary>();
  private readonly sdkHandoffs = new Map<string, SdkHandoff>();
  private readonly interruptions = new Map<string, { turn: PendingTurn; cancel: () => void }>();
  private readonly interruptHolds = new Map<string, number>();
  private readonly activeDeliveries = new Map<string, Promise<void>>();
  private readonly resetPreserve = new Map<string, Set<string>>();
  private readonly knownKeys = new Map<string, string>();
  private readonly steerScans = new Map<string, SteerReceiptScan>();
  private steerTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly registry: Registry,
    private readonly sdk: IdleSdkSender,
    deps: Partial<PendingTurnDeps> = {},
  ) {
    this.deps = {
      unseenReports: deps.unseenReports ?? (() => null),
      now: deps.now ?? Date.now,
      id: deps.id ?? randomUUID,
      inject: deps.inject ?? injectPrompt,
      idleSettleMs: deps.idleSettleMs ?? DEFAULT_IDLE_SETTLE_MS,
      pickupTimeoutMs: deps.pickupTimeoutMs ?? DEFAULT_PICKUP_TIMEOUT_MS,
      interruptTimeoutMs: deps.interruptTimeoutMs ?? MESSAGE_INTERRUPT_WATCHDOG_MS,
      interruptPane: deps.interruptPane ?? interruptPaneSession,
      messagesFor: deps.messagesFor ?? sessionMessages,
      steerReceiptPollMs: deps.steerReceiptPollMs ?? DEFAULT_STEER_RECEIPT_POLL_MS,
      afterWorkEnabled: deps.afterWorkEnabled ?? (() => featureEnabled("task-shaping")),
      afterWorkTurnOwed: deps.afterWorkTurnOwed ?? afterWorkTurnOwed,
      afterWorkRecheckMs: deps.afterWorkRecheckMs ?? DEFAULT_AFTER_WORK_RECHECK_MS,
      retireDelivered: deps.retireDelivered ?? retireDeliveredPendingTurn,
    };
  }

  /** Begin recovery and delivery only after the daemon has won its loopback port. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    recoverSendingPendingTurns(this.deps.now());
    this.unsubscribe = this.registry.subscribe((event) => this.observe(event));
    for (const session of this.registry.snapshot().sessions) {
      followSpokenConversationKey(session.id, session.id, noteKeyFor(session));
      this.knownKeys.set(session.id, noteKeyFor(session));
      this.registry.refreshPendingTurns(noteKeyFor(session));
      this.observeSession(this.registry.getSession(session.id) ?? session);
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const armed of this.idleTimers.values()) clearTimeout(armed.timer);
    for (const candidate of this.pickup.values()) {
      if (candidate.timer) clearTimeout(candidate.timer);
    }
    this.idleTimers.clear();
    this.pickup.clear();
    for (const timer of this.retireRetries.values()) clearTimeout(timer);
    this.retireRetries.clear();
    this.terminalDrainBoundaries.clear();
    this.sdkHandoffs.clear();
    if (this.steerTimer) clearTimeout(this.steerTimer);
    this.steerTimer = null;
    this.steerScans.clear();
  }

  /**
   * Establish reset as a delivery boundary before reset policy clears durable rows.
   *
   * A queued row is safe for reset to discard. A row whose SDK handoff or terminal paste
   * may already have crossed is not: settle the active delivery and return its id so reset
   * retains the resulting `uncertain` row for explicit operator resolution.
   */
  async invalidateForReset(sessionId: string): Promise<readonly string[]> {
    const session = this.registry.getSession(sessionId);
    if (!session) return [];
    const key = noteKeyFor(session);
    const preserve = this.resetPreserve.get(sessionId) ?? new Set<string>();
    for (const turn of session.pendingTurns) {
      if (turn.state === "uncertain") preserve.add(turn.id);
    }
    this.resetPreserve.set(sessionId, preserve);
    this.cancelIdleTimer(key);
    this.terminalDrainBoundaries.delete(key);

    const active = this.activeDeliveries.get(sessionId);
    if (active) {
      try {
        await active;
      } catch {
        // Delivery owns its durable transition. Reset still performs the defensive pickup
        // check below in case an unexpected failure left a terminal candidate behind.
      }
    }

    const current = this.registry.getSession(sessionId);
    // An accepted turn may have installed this boundary just before the reset marker became
    // visible. Reset owns all later work, so an old turn must not hold its new outbox closed.
    this.terminalDrainBoundaries.delete(key);
    for (const turn of current?.pendingTurns ?? []) {
      if (turn.state === "uncertain") preserve.add(turn.id);
    }

    const candidate = this.pickup.get(key);
    if (candidate) {
      if (candidate.sessionId === sessionId) {
        this.markResetUncertain(
          sessionId,
          candidate.turn,
          "Session reset began after terminal delivery may have crossed its write boundary.",
        );
      } else {
        candidate.ownershipUncertain = true;
        preserve.add(candidate.turn.id);
      }
    }
    const sdkHandoff = this.sdkHandoffs.get(key);
    if (sdkHandoff) {
      if (sdkHandoff.sessionId === sessionId) {
        this.markResetUncertain(
          sessionId,
          sdkHandoff.turn,
          "Session reset began while the SDK was accepting this message.",
        );
      } else {
        sdkHandoff.ownershipUncertain = true;
        preserve.add(sdkHandoff.turn.id);
      }
    }
    return [...preserve];
  }

  /** Resume a safely refused queued row only after reset's registry marker is gone. */
  finishReset(sessionId: string): void {
    if (this.registry.sessionResetInProgress(sessionId)) return;
    this.resetPreserve.delete(sessionId);
    const session = this.registry.getSession(sessionId);
    if (session) this.scheduleDrain(noteKeyFor(session));
  }

  /** Queue one message in the operator's words. */
  submit(sessionId: string, text: string): PendingTurnSubmitResult {
    return this.queueMessage(sessionId, text, "");
  }

  submitSpoken(sessionId: string, words: string, utteranceId: string): PendingTurnSubmitResult {
    return this.queueMessage(sessionId, words, VOICE_TURN_PREFIX, utteranceId);
  }

  /**
   * Queue a Stuck row's fixed Nudge, Continue or push message (`inbox`). The manager chooses
   * both the words and the turn id, so the row is always recorded as daemon-written
   * (`daemonAuthorOf`): a caller asks for a kind and cannot send other words under that
   * authorship, or these words as the operator's.
   */
  submitInboxMessage(sessionId: string, kind: InboxMessageKind): PendingTurnSubmitResult {
    return this.queueMessage(sessionId, INBOX_MESSAGES[kind], INBOX_MESSAGE_TURN_PREFIX);
  }

  /** The one queueing path both kinds of message share; `idPrefix` is the authorship mark. */
  private queueMessage(sessionId: string, text: string, idPrefix: string, utteranceId?: string): PendingTurnSubmitResult {
    if (!this.started) {
      return {
        ok: false,
        pasted: false,
        submitVerified: false,
        error: "pending turns are still starting",
      };
    }
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, pasted: false, submitVerified: false, error: "no such session" };
    }
    if (!canMessage(session) || session.state === "exited") {
      return {
        ok: false,
        pasted: false,
        submitVerified: false,
        error: "this session cannot receive messages",
      };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, pasted: false, submitVerified: false, error: "message is empty" };
    }
    const pendingTurn = createPendingTurn({
      id: `${idPrefix}${utteranceId ?? this.deps.id()}`,
      ...(utteranceId !== undefined && { spokenWords: text }),
      noteKey: noteKeyFor(session),
      text,
      now: this.deps.now(),
    });
    this.registry.refreshPendingTurns(pendingTurn.noteKey);
    this.scheduleDrain(pendingTurn.noteKey);
    return {
      ok: true,
      pasted: false,
      submitVerified: false,
      delivery: "pending",
      pendingTurn,
    };
  }

  /**
   * Queue the answer to a review whose blocking MCP result channel was canceled.
   *
   * Unlike an ordinary composer submit, the idempotency key is the review itself. The DB
   * inserts the pending turn and stamps the review in one transaction, so startup recovery
   * can call this again without duplicating the human's answer.
   *
   * `snooze-instruction` is the other review message this outbox carries: the "carry on"
   * instruction of a question snoozed after its wait had already ended. It has its own turn id
   * and its own stamp on the review, so it can never take the answer's place.
   */
  submitReviewContinuation(
    reviewId: string,
    sessionId: string,
    text: string,
    kind: ReviewContinuationKind = "answer",
  ): PendingTurnSubmitResult {
    if (!this.started) {
      return {
        ok: false,
        pasted: false,
        submitVerified: false,
        error: "pending turns are still starting",
      };
    }
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, pasted: false, submitVerified: false, error: "no such session" };
    }
    if (!canMessage(session) || session.state === "exited") {
      return {
        ok: false,
        pasted: false,
        submitVerified: false,
        error: "this session cannot receive messages",
      };
    }
    const queue = kind === "snooze-instruction"
      ? createSnoozeInstructionPendingTurn
      : createReviewContinuationPendingTurn;
    const pendingTurn = queue({
      reviewId,
      noteKey: noteKeyFor(session),
      text,
      now: this.deps.now(),
      // A call-mode late answer or snooze instruction carries the review marker only while
      // `async-input` is on; a message-mode question's always does (`queueReviewPendingTurn`).
      markCallMode: featureEnabled(ASYNC_INPUT_FLAG),
    });
    if (!pendingTurn) {
      return { ok: true, pasted: false, submitVerified: false, delivery: "pending" };
    }
    this.registry.refreshPendingTurns(pendingTurn.noteKey);
    this.scheduleDrain(pendingTurn.noteKey);
    return {
      ok: true,
      pasted: false,
      submitVerified: false,
      delivery: "pending",
      pendingTurn,
    };
  }

  /**
   * Queue a turn the daemon wrote. `create` inserts it, together with whatever records that it
   * is owed, in one transaction, and answers null when it is no longer owed; nothing is queued
   * then. Delivered like any other row, through the one drain.
   */
  submitDaemonTurn(
    sessionId: string,
    create: (noteKey: string, now: number) => PendingTurn | null,
  ): PendingTurnSubmitResult {
    if (!this.started) {
      return { ok: false, retryable: true, pasted: false, submitVerified: false, error: "pending turns are still starting" };
    }
    const session = this.registry.getSession(sessionId);
    if (!session) return { ok: false, pasted: false, submitVerified: false, error: "no such session" };
    if (session.state === "exited") {
      return { ok: false, pasted: false, submitVerified: false, error: "this session cannot receive messages" };
    }
    if (!canMessage(session)) {
      return { ok: false, retryable: true, pasted: false, submitVerified: false, error: "this session cannot receive messages" };
    }
    const pendingTurn = create(noteKeyFor(session), this.deps.now());
    if (!pendingTurn) return { ok: true, pasted: false, submitVerified: false, delivery: "pending" };
    this.registry.refreshPendingTurns(pendingTurn.noteKey);
    this.scheduleDrain(pendingTurn.noteKey);
    return { ok: true, pasted: false, submitVerified: false, delivery: "pending", pendingTurn };
  }

  recall(sessionId: string, id: string, revision: number): PendingTurn | null {
    if (!this.started) return null;
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    const key = noteKeyFor(session);
    const recalled = recallPendingTurn(key, id, revision);
    if (recalled) {
      if (recalled.spokenWords !== undefined) this.registry.voiceRouter?.settleSpoken(recalled.id, "cancelled");
      this.registry.refreshPendingTurns(key);
    }
    return recalled;
  }

  expedite(sessionId: string, id: string, revision: number, action: "steer" | "interrupt"): boolean {
    const session = this.registry.getSession(sessionId);
    if (!this.started || this.stopped || !session || !this.canDeliver(session)) return false;
    if (!supportsDeliveryAction(session, action)) return false;
    // An unresolved handoff must be reconciled before another instruction can pass it.
    if (session.pendingTurns.some((turn) => turn.state !== "queued")) return false;
    const updated = expeditePendingTurn(noteKeyFor(session), id, revision, action, this.deps.now());
    if (!updated) return false;
    this.registry.refreshPendingTurns(updated.noteKey);
    this.scheduleDrain(updated.noteKey);
    return true;
  }

  /** Keep normal Stop ahead of deadline delivery until its outcome is known. */
  pauseForInterrupt(sessionId: string): () => void {
    this.interruptHolds.set(sessionId, (this.interruptHolds.get(sessionId) ?? 0) + 1);
    const session = this.registry.getSession(sessionId);
    if (session) this.cancelIdleTimer(noteKeyFor(session));
    return () => {
      const remaining = (this.interruptHolds.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.interruptHolds.set(sessionId, remaining);
      else this.interruptHolds.delete(sessionId);
      const current = this.registry.getSession(sessionId);
      if (current) this.scheduleDrain(noteKeyFor(current));
    };
  }

  /**
   * Drop everything still waiting to be delivered to this session, and say how much went.
   *
   * `recall`'s bulk sibling, and the queue half of the interrupt gesture: stopping the turn
   * while leaving the outbox armed would restart, seconds later, exactly the work the
   * operator just stopped - so the two are one act. It is runtime-independent, which is why
   * it lives on the manager rather than in either arm of the interrupt's runtime fan-out.
   *
   * Only `queued` rows go; `sending` and `uncertain` are left alone for the reasons
   * `dropQueuedPendingTurns` states. This is not a recall: the text is discarded rather
   * than handed back to a composer, because the operator is about to type a replacement
   * and a queue that reappeared in the box would be in the way of it.
   */
  dropQueued(sessionId: string): number {
    if (!this.started) return 0;
    const session = this.registry.getSession(sessionId);
    if (!session) return 0;
    const key = noteKeyFor(session);
    // This claim has only requested interruption; its text has not entered the runtime.
    // An ordinary Stop still owns that unsent replacement and must prevent it restarting
    // work as soon as the interrupted turn reports idle.
    const interruption = this.interruptions.get(sessionId);
    let dropped = 0;
    if (interruption) {
      interruption.cancel();
      if (deleteClaimedPendingTurn(interruption.turn.id, interruption.turn.revision)) dropped++;
    }
    dropped += dropQueuedPendingTurns(key);
    if (dropped > 0) {
      const spoken = session.pendingTurns.filter(turn => turn.spokenWords !== undefined);
      this.registry.refreshPendingTurns(key);
      const remaining = this.registry.getSession(sessionId)?.pendingTurns;
      for (const turn of spoken) {
        if (!remaining?.some(row => row.id === turn.id)) this.registry.voiceRouter?.settleSpoken(turn.id, "cancelled");
      }
    }
    return dropped;
  }

  retry(sessionId: string, id: string, revision: number): PendingTurn | null {
    if (!this.started) return null;
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    const key = noteKeyFor(session);
    const row = session.pendingTurns.find((turn) => turn.id === id);
    if (!row || row.noteKey !== key) return null;
    const retried = retryPendingTurn(id, revision, this.deps.now());
    if (retried) {
      this.registry.refreshPendingTurns(key);
      this.scheduleDrain(key);
    }
    return retried;
  }

  resolve(sessionId: string, id: string, revision: number): boolean {
    if (!this.started) return false;
    const session = this.registry.getSession(sessionId);
    if (!session) return false;
    const key = noteKeyFor(session);
    const row = session.pendingTurns.find((turn) => turn.id === id);
    if (!row || row.noteKey !== key) return false;
    const resolved = resolveUncertainPendingTurn(id, revision, this.deps.now());
    if (resolved) {
      if (row.spokenWords !== undefined) this.registry.voiceRouter?.settleSpoken(row.id, "sent");
      this.registry.refreshPendingTurns(key);
      this.scheduleDrain(key);
    }
    return resolved;
  }

  private observe(event: ServerEvent): void {
    if (event.type === "session_remove") {
      const key = this.knownKeys.get(event.id);
      this.knownKeys.delete(event.id);
      if (key) {
        if (this.terminalDrainBoundaries.get(key)?.sessionId === event.id) {
          this.terminalDrainBoundaries.delete(key);
        }
        const owner = this.registry.sessionForNoteKey(key);
        if (owner) this.observeSession(owner);
        else if (!transferForNote(key)) this.registry.forgetSteers(key);
      }
      return;
    }
    if (event.type === "session_upsert") this.observeSession(event.session);
    if (event.type === "feature_flags") {
      for (const session of this.registry.liveSessions()) {
        if (session.pendingTurns.some(row => row.spokenWords !== undefined)) this.scheduleDrain(noteKeyFor(session));
      }
    }
  }

  private observeSession(session: Session): void {
    const key = noteKeyFor(session);
    const previousKey = this.knownKeys.get(session.id);
    this.knownKeys.set(session.id, key);
    if (previousKey !== key) followSpokenConversationKey(session.id, previousKey ?? session.id, key);
    if (previousKey && previousKey !== key) {
      this.registry.moveSteeredTurns(previousKey, key);
      // Review deliveries follow a session id becoming its native key, never a `/clear`.
      followNativeConversationKey(session.id, previousKey, key);
      const scan = this.steerScans.get(previousKey);
      if (scan) {
        this.steerScans.delete(previousKey);
        this.steerScans.set(key, scan);
      }
      this.moveConversationKey(session.id, previousKey, key);
    }
    if (steerReadWindowClosed(session) && this.registry.hasSteeredTurns(key)) {
      // Read once more first: an agent that wrote the steer and finished its turn inside one
      // poll interval has a receipt waiting, and clearing without it would drop its label.
      this.scanSteerReceiptsFor(key);
      this.registry.clearSteeredTurns(key);
      this.steerScans.delete(key);
    }
    const sdkHandoff = this.sdkHandoffs.get(key);
    if (sdkHandoff && sdkHandoff.sessionId !== session.id && session.state !== "exited") {
      sdkHandoff.ownershipUncertain = true;
    }
    const drainBoundary = this.terminalDrainBoundaries.get(key);
    if (drainBoundary) {
      if (drainBoundary.sessionId !== session.id || session.state === "exited") {
        this.terminalDrainBoundaries.delete(key);
      } else {
        const observedAt = this.pickupActivityAt(session, drainBoundary.writeBoundaryAt);
        if (observedAt !== null) {
          drainBoundary.activityObservedAt = Math.max(
            drainBoundary.activityObservedAt ?? drainBoundary.writeBoundaryAt, observedAt,
          );
        }
        // One passive read can contain both the start and completion of a fast turn.
        if (
          drainBoundary.activityObservedAt !== null && session.stateConfirmed &&
          session.state === "idle" &&
          (session.lastActivity ?? 0) >= drainBoundary.activityObservedAt
        ) {
          this.terminalDrainBoundaries.delete(key);
        } else {
          this.cancelIdleTimer(key);
          return;
        }
      }
    }
    const candidate = this.pickup.get(key);
    if (candidate && candidate.sessionId !== session.id && session.state !== "exited") {
      candidate.ownershipUncertain = true;
      return;
    }
    const observedAt = candidate ? this.pickupActivityAt(session, candidate.boundaryAt) : null;
    if (candidate && candidate.sessionId === session.id && observedAt !== null) {
      candidate.pickupObserved = true;
      candidate.pickupObservedAt = Math.max(
        candidate.pickupObservedAt ?? candidate.boundaryAt,
        observedAt,
      );
      // A reset owns the session now. Evidence that arrives while injection is settling is
      // provisional until deliverTerminal records the reset-safe uncertain transition.
      if (
        candidate.injectionSucceeded &&
        !this.registry.sessionResetInProgress(session.id)
      ) {
        this.completePickup(session.id, candidate.turn);
      }
      return;
    }
    this.scheduleDrain(key);
  }

  private pickupActivityAt(session: Session, boundaryAt: number): number | null {
    if (!session.stateConfirmed) return null;
    const startedAt = this.registry.passiveTurnStartedAt(session);
    if (startedAt !== null && startedAt >= boundaryAt) return startedAt;
    return session.state === "working" && (session.lastActivity ?? 0) >= boundaryAt
      ? session.lastActivity
      : null;
  }

  private moveConversationKey(sessionId: string, fromKey: string, toKey: string): void {
    this.cancelIdleTimer(fromKey);
    const candidate = this.pickup.get(fromKey);
    const sdkHandoff = this.sdkHandoffs.get(fromKey);
    const drainBoundary = this.terminalDrainBoundaries.get(fromKey);
    if (
      (candidate && candidate.sessionId !== sessionId) ||
      (sdkHandoff && sdkHandoff.sessionId !== sessionId)
    ) {
      if (candidate) candidate.ownershipUncertain = true;
      if (sdkHandoff) sdkHandoff.ownershipUncertain = true;
      return;
    }
    if (!rekeyPendingTurns(fromKey, toKey, this.deps.now())) {
      if (drainBoundary?.sessionId === sessionId) {
        this.terminalDrainBoundaries.delete(fromKey);
      }
      return;
    }
    if (candidate) {
      this.pickup.delete(fromKey);
      candidate.turn.noteKey = toKey;
      this.pickup.set(toKey, candidate);
    }
    if (sdkHandoff) {
      this.sdkHandoffs.delete(fromKey);
      sdkHandoff.turn.noteKey = toKey;
      this.sdkHandoffs.set(toKey, sdkHandoff);
    }
    if (drainBoundary?.sessionId === sessionId) {
      this.terminalDrainBoundaries.delete(fromKey);
      this.terminalDrainBoundaries.set(toKey, drainBoundary);
    }
    this.registry.refreshPendingTurns(fromKey);
    this.registry.refreshPendingTurns(toKey);
  }

  /**
   * Every delivery precondition except the wait.
   *
   * Deliberately split from `readyToDrain`: the two ask different questions. This one asks
   * whether a drain is still COMING, and it stays true throughout the settle window that
   * `readyToDrain` is false during. That distinction is the whole reason the timer exists,
   * because an idle transition always arrives carrying `lastActivity === now` - so a session
   * is never settled at the instant it reports being idle. Arming on `readyToDrain` would
   * refuse the timer at exactly the moment it is needed, and an embedded session, whose
   * driver events are the only thing that ever pokes its card, would never ask again.
   */
  private canDrain(session: Session): boolean {
    const drainBoundary = this.terminalDrainBoundaries.get(noteKeyFor(session));
    return (
      drainBoundary?.sessionId !== session.id &&
      session.stateConfirmed &&
      session.state === "idle" &&
      // `activePaneDialog`, not the raw field, because that helper is where this codebase
      // keeps the one notion of "a menu is covering this session" - the reply box, the
      // attention buckets, Foreman's responder and the skills reload all ask it, and its
      // own contract says readers ask here rather than reading the field. This gate was
      // the last caller reading it directly, which left the DISPLAY of a held row and the
      // rule that holds it derived from two different expressions.
      //
      // The swap cannot loosen delivery. The two differ only for `exited` and `stopping`,
      // and the `state === "idle"` conjunct above already refuses both - so wherever this
      // clause can decide anything, the field and the helper return the same value.
      // `test/pending-turn-manager.test.ts` pins that over the whole `SessionState` union
      // rather than leaving it as an argument someone has to re-derive.
      activePaneDialog(session) === null &&
      !this.registry.sessionResetInProgress(session.id) &&
      !this.interruptHolds.has(session.id) &&
      // Paused: hold every row where it is. Lifting the pause emits a `session_upsert`, and
      // that is what re-arms the drain - so a message typed while paused is delivered on resume.
      !session.pause &&
      // Woken and not yet bound to its task: held the same way, and re-armed by the binding.
      !this.sdk.holdsDelivery?.(session.id) &&
      canMessage(session)
    );
  }

  /**
   * A row as its escalation clock should read it. Steer and interrupt deadlines count from
   * `createdAt`, so a message queued during a long pause would otherwise be overdue the moment
   * the pause lifts and interrupt the turn it resumed. Rows older than the last resume count
   * from the resume instead, which gives them the same quiet minute any new message gets.
   */
  private rebased(session: Session, row: PendingTurn): PendingTurn {
    // Read from the registry, where `PauseManager` keeps it - and restores it on start - so a
    // daemon restart just after a resume does not make every held message overdue at once.
    const resumedAt = this.registry.sessionResumedAt(session.id);
    return resumedAt !== null && row.createdAt < resumedAt ? { ...row, createdAt: resumedAt } : row;
  }

  /** Shared safety gates; only steering is allowed to relax the idle requirement. */
  private canDeliver(session: Session): boolean {
    return !this.stopped && !this.interruptHolds.has(session.id) && session.stateConfirmed &&
      !session.pause && !this.sdk.holdsDelivery?.(session.id) &&
      (session.state === "idle" || session.state === "working") &&
      activePaneDialog(session) === null &&
      !this.registry.sessionResetInProgress(session.id) && canMessage(session) &&
      this.registry.sessionForNoteKey(noteKeyFor(session))?.id === session.id;
  }

  /**
   * The stage each queued row would act on now, in enqueue order.
   *
   * A refused steer has not crossed acceptance and may resume - including by escalating -
   * when its blocker clears. An attempted interruption is different: the attempt is recorded
   * before the request leaves, so a message stops one turn at most however that attempt ends,
   * and a repeat is an explicit operator action.
   */
  private stages(session: Session): { turn: PendingTurn; at: number; action: MessageDeliveryAction }[] {
    return session.pendingTurns.flatMap((row) => {
      if (this.spokenBlocked(session, row) || row.interruptAttemptedAt != null) return [];
      const stage = deliveryStage(session, this.rebased(session, row), this.deps.now());
      return stage ? [{ turn: row, ...stage }] : [];
    });
  }

  private spokenBlocked(session: Session, turn: PendingTurn): boolean {
    return turn.spokenWords !== undefined && (!featureEnabled("voice") || session.pendingReviews > 0);
  }

  private nextDelivery(session: Session): { turn: PendingTurn; at: number; action: "idle" | MessageDeliveryAction } | null {
    if (!this.canDeliver(session) || session.pendingTurns.some((turn) => turn.state !== "queued")) return null;
    const first = session.pendingTurns.find(turn => !this.spokenBlocked(session, turn));
    if (!first) return null;
    const stages = this.stages(session);
    const due = stages.find(stage => stage.at <= this.deps.now());
    if (this.canDrain(session)) {
      return { turn: due?.turn ?? first, at: (session.lastActivity ?? session.firstSeen) + this.deps.idleSettleMs, action: "idle" };
    }
    // A terminal can still show old idle evidence while a previous paste awaits pickup.
    // That is not proof of a running turn that may be interrupted.
    if (session.state !== "working") return null;
    // A row still inside its quiet first minute may not pass one whose minute is up. Among
    // due rows keep enqueue order, even after restart.
    return due ?? stages.reduce<{ turn: PendingTurn; at: number; action: MessageDeliveryAction } | null>(
      (best, stage) => !best || stage.at < best.at ? stage : best, null);
  }

  /**
   * The earliest escalation still ahead of us, which is what a refused or not-yet-due
   * message needs a timer for. A turn that has gone silent emits no event that would
   * re-arm one, and that is exactly the turn the three-minute interruption exists for.
   */
  private nextEscalationAt(session: Session): number | null {
    if (!this.canDeliver(session) || session.pendingTurns.some((turn) => turn.state !== "queued")) return null;
    const ahead = session.pendingTurns
      .filter((row) => row.interruptAttemptedAt == null)
      .flatMap((row) => deliverySchedule(session, this.rebased(session, row)).map((stage) => stage.at))
      .filter((at) => at > this.deps.now());
    return ahead.length ? Math.min(...ahead) : null;
  }

  private readyToDrain(session: Session): boolean {
    return (
      this.canDrain(session) &&
      settledIdle(session, this.deps.now(), this.deps.idleSettleMs)
    );
  }

  private scheduleDrain(key: string): void {
    if (this.stopped || this.draining.has(key) || this.pickup.has(key) || transferForNote(key)) return;
    const session = this.registry.sessionForNoteKey(key);
    const next = session ? this.nextDelivery(session) : null;
    if (!next) { this.cancelIdleTimer(key); return; }
    this.armDrain(key, next.at);
  }

  /**
   * Recompute after every relevant event. Output may move an idle boundary, but must never
   * extend a message's escalation instant or delay an explicit Steer now request.
   */
  private armDrain(key: string, drainAt: number): void {
    const armed = this.idleTimers.get(key);
    if (armed) {
      if (armed.drainAt === drainAt) return;
      clearTimeout(armed.timer);
    }
    const timer = unref(
      setTimeout(() => {
        this.idleTimers.delete(key);
        void this.drain(key);
      }, Math.max(0, drainAt - this.deps.now())),
    );
    this.idleTimers.set(key, { timer, drainAt });
  }

  private cancelIdleTimer(key: string): void {
    const armed = this.idleTimers.get(key);
    if (!armed) return;
    clearTimeout(armed.timer);
    this.idleTimers.delete(key);
  }

  private drain(key: string): Promise<void> {
    const session = this.registry.sessionForNoteKey(key);
    if (!session) return Promise.resolve();
    const existing = this.activeDeliveries.get(session.id);
    if (existing) return existing;
    const active = this.drainOne(key);
    this.activeDeliveries.set(session.id, active);
    void active.then(
      () => {
        if (this.activeDeliveries.get(session.id) === active) {
          this.activeDeliveries.delete(session.id);
        }
      },
      () => {
        if (this.activeDeliveries.get(session.id) === active) {
          this.activeDeliveries.delete(session.id);
        }
      },
    );
    return active;
  }

  private async drainOne(key: string): Promise<void> {
    if (this.stopped || this.draining.has(key) || this.pickup.has(key) || transferForNote(key)) return;
    const session = this.registry.sessionForNoteKey(key);
    if (!session) return;
    const next = this.nextDelivery(session);
    if (!next || next.at > this.deps.now()) {
      // Woke inside a settle window that moved after this timer was armed. Re-arm instead
      // of returning: nothing re-polls an embedded session on the outbox's behalf, so a
      // dropped claim here is a queued row that never leaves.
      this.scheduleDrain(key);
      return;
    }
    // An after-work prompt is task shaping's, and follows its flag at delivery as well as when it
    // was written: queued while the flag was on, it is dropped, never sent, once it is off. One a
    // later launch's shaping commit superseded is dropped the same way. Either may have happened
    // while a delivery held it, which the delivery guards refused and released. One whose launch
    // could not be checked is neither claimed nor dropped: it is checked again shortly.
    const afterWorkRefusal = this.afterWorkRefusal(next.turn);
    if (afterWorkRefusal === AFTER_WORK_UNVERIFIED) {
      this.armDrain(key, this.deps.now() + this.deps.afterWorkRecheckMs);
      return;
    }
    if (afterWorkRefusal) {
      if (dropQueuedAfterWorkTurn(next.turn.id, afterWorkRefusal)) {
        this.registry.refreshPendingTurns(key);
        this.scheduleDrain(key);
      }
      return;
    }
    this.draining.add(key);
    let turn: PendingTurn | null = null;
    try {
      turn = claimNextPendingTurn(key, this.deps.now(), next.turn, words => spokenMessageText(words, {
        openQuestions: openQuestionsNote(this.registry.outstandingReviews(session.id).filter(isAgentAsk)),
        unseenReports: this.deps.unseenReports(session),
      }));
      if (!turn) return;
      this.registry.refreshPendingTurns(key);
      if (next.action === "interrupt") {
        try {
          await this.interruptAndWait(session, turn);
        } catch (err) {
          releasePendingTurn(turn.id, turn.revision, errorMessage(err), this.deps.now());
          this.registry.refreshPendingTurns(key);
          return;
        }
      }
      if (session.runtime === "sdk") await this.deliverSdk(session, turn, next.action === "steer");
      else await this.deliverTerminal(session, turn);
    } finally {
      this.draining.delete(key);
      // Steering may leave state unchanged, and a fast terminal turn may finish before
      // injection returns. Wake eligible input after retirement without another event;
      // a refused or uncertain delivery must never become a retry loop.
      const current = this.registry.sessionForNoteKey(key);
      const following = current ? this.nextDelivery(current) : null;
      const retiredId = turn?.id;
      const retired = !!retiredId && !!current && !current.pendingTurns.some((row) => row.id === retiredId);
      // A guard's held-back mark is consumed by every delivery that ends, so none outlives its turn.
      const recheckAfterWork = !!retiredId && this.unverifiedAfterWork.delete(retiredId);
      if (retired && following && (session.runtime === "terminal" || next.action === "steer" || following.action !== "idle")) {
        this.scheduleDrain(key);
      } else if (!retired && current) {
        // The row is still queued: a refusal, or a stage that did not finish the message.
        // Arm the escalation that is still ahead of it rather than waiting for an event a
        // silent turn will never produce. Nothing here re-tries a due stage, so a refusal
        // that keeps refusing cannot become a loop. The one exception is an after-work turn
        // held back because its launch could not be checked: nothing else would ever wake it,
        // so it is checked again on the recheck interval until the read answers.
        if (recheckAfterWork) {
          this.armDrain(key, this.deps.now() + this.deps.afterWorkRecheckMs);
        } else {
          const escalation = this.nextEscalationAt(current);
          if (escalation != null) this.armDrain(key, escalation);
        }
      }
    }
  }

  private transcriptEnd(session: Session): SteerReceiptScan | null {
    try {
      const located = this.deps.messagesFor(session);
      const size = located ? located.read.size(located.path) : null;
      return located && size !== null ? { path: located.path, pos: size, claimed: new Set() } : null;
    } catch {
      return null;
    }
  }

  /** Start, or keep, reading this conversation's transcript for the steers it holds. */
  private watchSteerReceipt(key: string, from: SteerReceiptScan | null): void {
    const scan = this.steerScans.get(key);
    if (!scan || (from && scan.path !== from.path)) {
      this.steerScans.set(key, from ?? { path: null, pos: 0, claimed: new Set() });
    } else if (from && from.pos < scan.pos) {
      // The scan kept reading for an earlier steer while this one's `send` was in flight,
      // and the agent may already have written this steer's line behind the cursor. Rewind
      // to where the transcript ended before this send; `claimed` keeps the turns it passes
      // again from answering a steer twice.
      scan.pos = from.pos;
    }
    if (!this.steerTimer && !this.stopped) {
      this.steerTimer = unref(setTimeout(() => this.scanSteerReceipts(), this.deps.steerReceiptPollMs));
    }
  }

  /**
   * Retire every steer the agent has now read.
   *
   * The transcript is the receipt: the agent writes a user message there when it takes it,
   * so a steer leaves the moment that line exists, during the turn that read it. Reads only
   * what was appended since the last pass, and runs only while something is waiting; a
   * steer whose line never appears still leaves when its turn ends (`observeSession`).
   */
  private scanSteerReceipts(): void {
    this.steerTimer = null;
    if (this.stopped) return;
    for (const key of Array.from(this.steerScans.keys())) this.scanSteerReceiptsFor(key);
    if (this.steerScans.size > 0) {
      this.steerTimer = unref(setTimeout(() => this.scanSteerReceipts(), this.deps.steerReceiptPollMs));
    }
  }

  /** One pass over one conversation's transcript: retire every steer it now shows. */
  private scanSteerReceiptsFor(key: string): void {
    const scan = this.steerScans.get(key);
    if (!scan) return;
    const waiting = this.registry.steeredTurns(key);
    if (waiting.length === 0) {
      this.steerScans.delete(key);
      return;
    }
    const session = this.registry.sessionForNoteKey(key);
    let messages;
    try {
      const located = session ? this.deps.messagesFor(session) : null;
      if (!located) return;
      if (scan.path !== located.path) {
        scan.path = located.path;
        scan.pos = 0;
      }
      const size = located.read.size(located.path);
      if (size === null || size === scan.pos) return;
      // Rewritten under us: the offset names a byte that no longer exists.
      if (size < scan.pos) scan.pos = 0;
      const read = located.read.appended(located.path, scan.pos);
      scan.pos = read.pos;
      messages = read.messages;
    } catch {
      return; // unreadable this pass; the next one, or the turn's end, settles it
    }
    const paired = assignSteerReceipts(waiting, messages, scan.claimed);
    for (const messageId of paired.values()) scan.claimed.add(messageId);
    if (paired.size > 0) this.registry.retireSteeredTurns(key, paired, this.deps.now());
    if (this.registry.steeredTurns(key).length === 0) this.steerScans.delete(key);
  }

  /**
   * Say whose words a row carries before anything else of its send: a daemon-written row is
   * reserved as such (`reserveInjection`), and the operator's own words are announced as a
   * person's (`notePersonDelivery`), which is always the session's wake. Either one refused
   * because its attribution could not be stored (`AutomatedAttributionError`,
   * `PersonAttributionError`) wrote nothing: the row goes back to the queue as undelivered, as a
   * busy agent's does, and the send stops here (null).
   */
  private announceTurn(
    session: Session,
    turn: PendingTurn,
    author: TurnOrigin | null,
  ): { personSend: PersonDelivery | null } | null {
    try {
      if (author) {
        reserveInjection(session.id, turn.text, author);
        return { personSend: null };
      }
      return { personSend: notePersonDelivery(session.id, turn.text) };
    } catch (error) {
      if (!(error instanceof AutomatedAttributionError) && !(error instanceof PersonAttributionError)) throw error;
      releasePendingTurn(turn.id, turn.revision, error.message, this.deps.now());
      this.registry.refreshPendingTurns(turn.noteKey);
      return null;
    }
  }

  private async deliverSdk(session: Session, turn: PendingTurn, steer = false): Promise<void> {
    // Whose words these are, said BEFORE the send, because the prompt hook can report them back
    // while the send is still in flight (see `reserveInjection`). First of all, so one refused
    // for its attribution leaves nothing else to undo. The operator's own words are always the
    // session's wake, even when they repeat an automated delivery still on its way (see
    // `notePersonDelivery`); that announcement is withdrawn wherever this row is released as
    // positively undelivered, beside `withdrawOutboxSend`.
    const author = daemonAuthorOf(turn);
    const announced = this.announceTurn(session, turn, author);
    if (!announced) return;
    const personSend = announced.personSend;
    // The operator's queued words may race a delegated send of the same ones. Every path below
    // that releases the row is positive evidence nothing landed, so it withdraws this record.
    const outboxSend = recordOutboxSend(session, turn);
    // A recorded review message is the daemon's text whoever's answer it carries: no door
    // captures it as a Goal revision, and its echo is owed on the delivery row instead.
    const reviewMessage = outboxSend.kind === "review";
    // Where the transcript ends BEFORE the driver can take the steer, so the line the agent
    // writes when it reads it is always after this point, however soon that is.
    const receiptFrom = steer ? this.transcriptEnd(session) : null;
    const handoff: SdkHandoff = {
      sessionId: session.id,
      turn,
      acceptanceBoundaryCrossed: false,
      ownershipUncertain: false,
    };
    this.sdkHandoffs.set(turn.noteKey, handoff);
    // This row's entry in the expected-echo ledger: the agent's prompt hook reports the same
    // text back and must not open a second Goal revision for it (see `ExpectedHumanEcho`).
    let humanEcho: HumanEchoTicket | null = null;
    let generation = session.workCycle?.generation ?? 0;
    try {
      const send = steer ? this.sdk.send.bind(this.sdk) : this.sdk.sendWhenIdle.bind(this.sdk);
      const input: SdkTurn = { text: turn.text };
      const accepted = await send(session.id, input, () => {
        const blocker = this.acceptanceBlocker(handoff, steer);
        if (!blocker) {
          const current = this.registry.getSession(session.id)!;
          generation = current.workCycle?.generation ?? 0;
          if (!handoffSpokenTurn(outboxSend, current, turn, generation, this.deps.now(), input)) {
            return "The spoken turn is no longer claimed for delivery.";
          }
          handoff.acceptanceBoundaryCrossed = true;
          // Registered at the acceptance guard, which runs inside the supervisor's serialized
          // boundary immediately before the driver is handed the turn. Earlier, the row could
          // wait behind another operation long enough for its turn stamp to be stale, and a
          // guard that refuses leaves nothing to release.
          // A review message's echo turn is decided here too, from the cycle as it is now: the
          // row may have waited long enough for the one read at reservation to be stale.
          if (outboxSend.kind === "review") {
            stampReviewDeliveryHandoff(outboxSend.noteKey, outboxSend.id, this.registry.getSession(session.id)?.workCycle);
          }
          if (!author && !reviewMessage) humanEcho ??= expectHumanEcho(session.id, turn.text, {
            noteKey: turn.noteKey,
            cycle: this.registry.getSession(session.id)?.workCycle,
            spokenWords: turn.spokenWords,
            now: this.deps.now(),
          });
        }
        return blocker;
      });
      if (
        handoff.ownershipUncertain ||
        this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id
      ) {
        this.markBoundaryUncertain(
          session.id,
          turn,
          "SDK conversation ownership changed during delivery.",
          handoff.acceptanceBoundaryCrossed,
        );
        // The row stays uncertain either way, but a guard that refused before the acceptance
        // boundary handed the driver nothing: the person's words did not land, so they no longer
        // contest a delivery of the same words. Past the boundary they may have, and stand.
        if (!handoff.acceptanceBoundaryCrossed) withdrawPersonDelivery(personSend);
      } else if (accepted === null) {
        if (humanEcho) releaseHumanEcho(humanEcho, this.deps.now());
        if (author) releaseInjection(session.id, turn.text);
        withdrawOutboxSend(outboxSend, turn);
        withdrawPersonDelivery(personSend);
        releasePendingTurn(
          turn.id,
          turn.revision,
          "The agent became busy before delivery.",
          this.deps.now(),
        );
        this.dropIfRefused(turn);
      } else if (this.registry.sessionResetInProgress(session.id)) {
        this.markResetUncertain(
          session.id,
          turn,
          "Session reset began while the SDK was accepting this message.",
        );
      } else {
        // The driver accepted a human-authored row and the same native conversation still
        // owns it. Goal capture belongs after both facts, never when the row is merely queued
        // in Mission Control or when delivery became uncertain.
        //
        // The prompt hook may have been the first door. Capture only when it was not, and
        // mark the entry only once this capture returned a goal: a refused prompt or a failed
        // write leaves it confirmed, so the echo still records the turn.
        const echo = humanEcho
          ? confirmHumanEcho(humanEcho, { queued: accepted === "steered", now: this.deps.now() })
          : { captured: false };
        try {
          // A daemon-written row is nobody's ask, so it never becomes a Goal revision.
          if (!author && !reviewMessage && !echo.captured
            && this.registry.captureAcceptedPrompt(session.id, turn.spokenWords ?? turn.text, turn.noteKey)
            && humanEcho) {
            markHumanEchoCaptured(humanEcho, { now: this.deps.now() });
          }
        } catch (err) {
          // The turn already crossed the driver's acknowledgement boundary. A Goal write
          // failure must not make it retryable and deliver the same human message twice.
          console.error(
            `[pending-turns] could not capture accepted Goal prompt for ${session.id}:`,
            errorMessage(err),
          );
        }
        if (outboxSend.kind === "review") {
          confirmReviewSend(outboxSend.noteKey, outboxSend.id, {
            queued: accepted === "steered",
            completedGeneration: this.registry.getSession(session.id)?.workCycle?.generation,
          });
        }
        const reservationId = outboxSend.kind === "spoken" ? outboxSend.reservationId : null;
        const publish = () => this.journalDelivered(session.id, turn, generation);
        const retirement = this.retireDelivered(turn, reservationId, turn.spokenWords !== undefined ? publish : undefined);
        if (retirement === "stale" && reservationId !== null) return;
        // Accepted into the running turn is not read: the agent takes it at its next step
        // and only then writes it to the transcript the log is drawn from. Keep it on
        // screen until then, unless the turn has already ended and cannot hold it.
        const current = this.registry.getSession(session.id);
        if (accepted === "steered" && current && !steerReadWindowClosed(current)) {
          this.registry.recordSteeredTurn(turn.noteKey, {
            id: turn.id,
            text: turn.text,
            acceptedAt: this.deps.now(),
          });
          this.watchSteerReceipt(turn.noteKey, receiptFrom);
        }
        if (turn.spokenWords === undefined) publish();
      }
    } catch (err) {
      if (
        handoff.ownershipUncertain ||
        this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id
      ) {
        this.markBoundaryUncertain(
          session.id,
          turn,
          `SDK conversation ownership changed during delivery: ${errorMessage(err)}`,
          handoff.acceptanceBoundaryCrossed,
        );
        // Withdrawn only when the refusal came before the acceptance boundary (see above).
        if (!handoff.acceptanceBoundaryCrossed) withdrawPersonDelivery(personSend);
      } else if (handoff.acceptanceBoundaryCrossed) {
        // Once the supervisor crossed its serialized acceptance guard, a thrown
        // transport response is not proof of refusal: Codex may already have written
        // `turn/start`. Keep fail-closed uncertainty instead of automatically replaying
        // the same text on the next idle transition. markBoundaryUncertain also carries
        // the row through a concurrent reset.
        this.markBoundaryUncertain(
          session.id,
          turn,
          `SDK delivery may have crossed its acceptance boundary before failing: ${errorMessage(err)}`,
          true,
        );
      } else {
        if (humanEcho) releaseHumanEcho(humanEcho, this.deps.now());
        if (author) releaseInjection(session.id, turn.text);
        withdrawOutboxSend(outboxSend, turn);
        withdrawPersonDelivery(personSend);
        releasePendingTurn(turn.id, turn.revision, errorMessage(err), this.deps.now());
      }
    } finally {
      if (this.sdkHandoffs.get(turn.noteKey) === handoff) {
        this.sdkHandoffs.delete(turn.noteKey);
      }
    }
    this.registry.refreshPendingTurns(turn.noteKey);
    const current = this.registry.getSession(session.id);
    if (current && noteKeyFor(current) !== turn.noteKey) {
      this.registry.refreshPendingTurns(noteKeyFor(current));
    }
  }

  private async deliverTerminal(session: Session, turn: PendingTurn): Promise<void> {
    // Whose words these are, said first and withdrawn as `deliverSdk` does.
    const author = daemonAuthorOf(turn);
    const announced = this.announceTurn(session, turn, author);
    if (!announced) return;
    const personSend = announced.personSend;
    const outboxSend = recordOutboxSend(session, turn);
    let boundaryCrossed = false;
    let spokenEcho: HumanEchoTicket | null = null;
    const beforeWrite = (): string | null => {
      const current = this.registry.getSession(session.id);
      if (
        !current ||
        current.runtime !== "terminal" ||
        noteKeyFor(current) !== turn.noteKey ||
        this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id ||
        this.spokenBlocked(current, turn) || !this.readyToDrain(current)
      ) {
        return "The agent became busy or opened a dialog before delivery.";
      }
      // Immediately before the paste: an after-work turn task shaping was turned off for, or a
      // later launch superseded, while this delivery held it never reaches the agent.
      const afterWorkRefusal = this.guardAfterWork(turn);
      if (afterWorkRefusal) return afterWorkRefusal;
      const resourceBlocker = this.registry.promptResourceBlockerForSession(session.id);
      if (resourceBlocker) return resourceBlocker;
      if (!boundaryCrossed) {
        const generation = current.workCycle?.generation ?? 0;
        if (!handoffSpokenTurn(outboxSend, current, turn, generation, this.deps.now())) {
          return "The spoken turn is no longer claimed for delivery.";
        }
        boundaryCrossed = true;
        // The write is next: a review message's echo belongs to the cycle as it stands now.
        if (outboxSend.kind === "review") stampReviewDeliveryHandoff(outboxSend.noteKey, outboxSend.id, current.workCycle);
        if (turn.spokenWords !== undefined) {
          spokenEcho = expectHumanEcho(session.id, turn.text, {
            noteKey: turn.noteKey, cycle: current.workCycle, spokenWords: turn.spokenWords, now: this.deps.now(),
          });
        }
        this.pickup.set(turn.noteKey, {
          sessionId: session.id,
          turn,
          boundaryAt: this.deps.now(),
          generation,
          spokenReservationId: outboxSend.kind === "spoken" ? outboxSend.reservationId : null,
          injectionSucceeded: false,
          pickupObserved: false,
          pickupObservedAt: null,
          ownershipUncertain: false,
          timer: null,
        });
      }
      return null;
    };

    let result: InjectResult;
    try {
      result = await this.deps.inject(session, turn.text, undefined, beforeWrite);
    } catch (err) {
      result = {
        ok: false,
        error: errorMessage(err),
        pasted: true,
        submitVerified: false,
      };
    }

    if (spokenEcho) {
      if (result.ok || result.pasted) confirmHumanEcho(spokenEcho, { now: this.deps.now() });
      else releaseHumanEcho(spokenEcho, this.deps.now());
    }

    const candidate = this.pickup.get(turn.noteKey);
    if (
      !candidate ||
      candidate.turn.id !== turn.id ||
      candidate.sessionId !== session.id
    ) {
      if (boundaryCrossed || result.pasted || result.ok) {
        this.markBoundaryUncertain(
          session.id,
          turn,
          result.error ?? "The terminal delivery owner or outcome is unknown.",
          boundaryCrossed || result.pasted || result.ok,
        );
      } else {
        if (author) releaseInjection(session.id, turn.text);
        withdrawOutboxSend(outboxSend, turn);
        withdrawPersonDelivery(personSend);
        releasePendingTurn(
          turn.id,
          turn.revision,
          result.error ?? "The terminal refused the message.",
          this.deps.now(),
        );
        this.dropIfRefused(turn);
      }
      this.registry.refreshPendingTurns(turn.noteKey);
      return;
    }
    if (
      candidate.ownershipUncertain ||
      this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id
    ) {
      this.markBoundaryUncertain(
        session.id,
        turn,
        "Terminal conversation ownership changed during delivery.",
        true,
      );
      return;
    }
    if (result.ok) {
      if (this.registry.sessionResetInProgress(session.id)) {
        this.markResetUncertain(
          session.id,
          turn,
          "Session reset began after terminal delivery may have crossed its write boundary.",
        );
        return;
      }
      candidate.injectionSucceeded = true;
      if (outboxSend.kind === "review") {
        confirmReviewSend(outboxSend.noteKey, outboxSend.id, {
          completedGeneration: this.registry.getSession(session.id)?.workCycle?.generation,
        });
      }
      // A collapsed-paste placeholder observed before Enter and gone afterwards is direct
      // prompt-pickup evidence. Do not wait for a second hook/passive state signal that may
      // never exist on an otherwise readable terminal session.
      if (result.submitVerified || candidate.pickupObserved) {
        this.completePickup(session.id, turn);
        return;
      }
      const latest = this.registry.getSession(session.id);
      if (latest) this.observeSession(latest);
      this.armPickupTimeout(session.id, turn);
      return;
    }

    if (candidate.timer) clearTimeout(candidate.timer);
    this.pickup.delete(turn.noteKey);
    if (result.pasted) {
      if (this.registry.sessionResetInProgress(session.id)) {
        this.markResetUncertain(
          session.id,
          turn,
          result.error ??
            "Session reset began after terminal delivery may have crossed its write boundary.",
        );
      } else {
        markPendingTurnUncertain(
          turn.id,
          turn.revision,
          result.error ?? "The terminal delivery outcome is unknown.",
          this.deps.now(),
        );
      }
    } else {
      if (author) releaseInjection(session.id, turn.text);
      withdrawOutboxSend(outboxSend, turn);
      withdrawPersonDelivery(personSend);
      releasePendingTurn(
        turn.id,
        turn.revision,
        result.error ?? "The terminal refused the message.",
        this.deps.now(),
      );
    }
    this.registry.refreshPendingTurns(turn.noteKey);
  }

  private acceptanceBlocker(handoff: SdkHandoff, steer = false): string | null {
    const current = this.registry.getSession(handoff.sessionId);
    if (current && transferHold(current)) return transferHold(current);
    if (
      handoff.ownershipUncertain ||
      !current ||
      noteKeyFor(current) !== handoff.turn.noteKey ||
      this.registry.sessionForNoteKey(handoff.turn.noteKey)?.id !== handoff.sessionId
    ) {
      handoff.ownershipUncertain = true;
      return "The SDK conversation owner changed before delivery.";
    }
    if (this.spokenBlocked(current, handoff.turn)) return "Voice is off or the agent is waiting on a review.";
    if (steer ? (!this.canDeliver(current) || !canSteerMessage(current)) : !this.readyToDrain(current)) {
      return "The session reset, became busy, or opened a dialog before delivery.";
    }
    // At the instant the driver would take it: an after-work turn task shaping was turned off
    // for, or a later launch superseded, while this delivery held it never reaches the agent.
    return this.guardAfterWork(handoff.turn) ?? this.registry.promptResourceBlockerForSession(current.id);
  }

  /**
   * Why an after-work turn must not be delivered now, or null: task shaping is off, a later
   * launch of its task replaced the launch it was for, or whether one did could not be read
   * (`AFTER_WORK_UNVERIFIED`, which holds the turn back rather than refusing it). Null for every
   * other turn.
   */
  private afterWorkRefusal(turn: PendingTurn): string | null {
    if (!idleOnlyTurn(turn)) return null;
    if (!this.deps.afterWorkEnabled()) return AFTER_WORK_FLAG_OFF;
    const owed = this.afterWorkTurnOwed(turn);
    if (owed === null) return AFTER_WORK_UNVERIFIED;
    return owed ? null : AFTER_WORK_SUPERSEDED;
  }

  /**
   * `afterWorkRefusal` at a delivery guard. A turn the guard holds back because its launch could
   * not be checked is marked here, from the guard's own answer, so the drain rechecks it however
   * any later read turns out: nothing else would wake a quiet session's queued turn.
   */
  private guardAfterWork(turn: PendingTurn): string | null {
    const refusal = this.afterWorkRefusal(turn);
    if (refusal === AFTER_WORK_UNVERIFIED) this.unverifiedAfterWork.add(turn.id);
    return refusal;
  }

  /**
   * A released after-work turn that must not be delivered leaves the outbox at once, settled with
   * why. One whose launch still cannot be checked stays queued, marked for the drain to check
   * again; one that is owed after all stays queued with the guard's mark, and the recheck
   * delivers it.
   */
  private dropIfRefused(turn: PendingTurn): void {
    const refusal = this.afterWorkRefusal(turn);
    if (refusal === AFTER_WORK_UNVERIFIED) this.unverifiedAfterWork.add(turn.id);
    else if (refusal && dropQueuedAfterWorkTurn(turn.id, refusal)) this.unverifiedAfterWork.delete(turn.id);
  }

  /**
   * Whether an after-work turn's launch still owns it, or null when that cannot be read. Fails
   * closed: an unread answer is never taken as owed, because a later launch's turn would be the
   * one to receive the earlier launch's prompt.
   */
  private afterWorkTurnOwed(turn: PendingTurn): boolean | null {
    try {
      return this.deps.afterWorkTurnOwed(turn.id);
    } catch (error) {
      console.warn("[pending-turns] could not check an after-work turn's launch:", error);
      return null;
    }
  }

  private async interruptAndWait(session: Session, turn: PendingTurn): Promise<void> {
    let active = true;
    const guard = (): string | null => {
      if (!active) return "This interruption attempt has expired.";
      const current = this.registry.getSession(session.id);
      if (!current || noteKeyFor(current) !== turn.noteKey || !this.canDeliver(current)) {
        return "The session changed, reset, or opened a dialog before interruption.";
      }
      return this.registry.promptResourceBlockerForSession(current.id);
    };
    const blocked = guard();
    if (blocked) throw new Error(blocked);
    if (!recordPendingTurnInterrupt(turn.id, turn.revision, this.deps.now())) {
      throw new Error("This message already attempted interruption.");
    }
    const boundary = this.deps.now();
    await new Promise<void>((resolve, reject) => {
      let acknowledged = false;
      let finished = false;
      let settle: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        active = false;
        clearTimeout(timer);
        clearTimeout(settle);
        unsubscribe();
        this.interruptions.delete(session.id);
        if (error) reject(error); else resolve();
      };
      const check = (): void => {
        if (finished) return;
        const blockedNow = guard();
        if (blockedNow) { finish(new Error(blockedNow)); return; }
        const current = this.registry.getSession(session.id)!;
        if (acknowledged && current.state === "idle" &&
            (current.runtime === "sdk" || (current.lastActivity ?? 0) >= boundary)) {
          // Use the normal settled-idle acceptance guard after confirmed interruption.
          if (this.readyToDrain(current)) finish();
          else {
            clearTimeout(settle);
            settle = setTimeout(check, Math.max(1,
              (current.lastActivity ?? current.firstSeen) + this.deps.idleSettleMs - this.deps.now()));
          }
        }
      };
      const unsubscribe = this.registry.subscribe(() => check());
      const timer = setTimeout(() => finish(new Error(
        "Interruption was not confirmed in time. The message was not sent; automatic interruption will not repeat.",
      )), this.deps.interruptTimeoutMs);
      this.interruptions.set(session.id, {
        turn,
        cancel: () => finish(new Error("The operator stopped this queued replacement.")),
      });
      const interrupt = async (): Promise<void> => {
        try {
          const beforeInterrupt = (): string | null => {
            const blocker = guard();
            if (blocker) return blocker;
            const current = this.registry.getSession(session.id)!;
            if (current.workCycle?.generation !== session.workCycle?.generation) {
              return "The active turn changed before interruption. This message remains queued.";
            }
            return null;
          };
          if (session.runtime === "sdk") {
            await this.sdk.interruptForDelivery(session.id, beforeInterrupt);
          } else {
            const blocker = beforeInterrupt();
            if (blocker) throw new Error(blocker);
            const result = await this.deps.interruptPane(session);
            if (!result.ok) throw new Error(result.error ?? "The terminal refused interruption.");
          }
          acknowledged = true;
          check();
        } catch (err) { finish(new Error(errorMessage(err))); }
      };
      void interrupt();
    });
  }

  private markResetUncertain(sessionId: string, turn: PendingTurn, error: string): void {
    const uncertain = this.markDeliveryUncertain(sessionId, turn, error);
    if (uncertain) this.resetPreserve.get(sessionId)?.add(turn.id);
  }

  private markBoundaryUncertain(
    sessionId: string,
    turn: PendingTurn,
    error: string,
    boundaryCrossed: boolean,
  ): void {
    if (boundaryCrossed && this.registry.sessionResetInProgress(sessionId)) {
      this.markResetUncertain(sessionId, turn, error);
    } else {
      this.markDeliveryUncertain(sessionId, turn, error);
    }
  }

  private markDeliveryUncertain(sessionId: string, turn: PendingTurn, error: string): PendingTurn | null {
    const candidate = this.pickup.get(turn.noteKey);
    if (candidate?.turn.id === turn.id && candidate.sessionId === sessionId) {
      if (candidate.timer) clearTimeout(candidate.timer);
      this.pickup.delete(turn.noteKey);
    }
    const uncertain = markPendingTurnUncertain(
      turn.id,
      turn.revision,
      error,
      this.deps.now(),
    );
    this.registry.refreshPendingTurns(turn.noteKey);
    return uncertain;
  }

  private completePickup(sessionId: string, turn: PendingTurn): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (
      !candidate ||
      candidate.turn.id !== turn.id ||
      candidate.sessionId !== sessionId ||
      candidate.ownershipUncertain
    ) return;
    if (candidate.timer) clearTimeout(candidate.timer);
    // A verified paste proves this row crossed the terminal boundary, but the registry may
    // still contain the idle observation from BEFORE Enter. Keep the FIFO closed until work
    // is observed and a later idle transition proves that work finished. When a hook or
    // passive read already supplied pickup evidence, carry that evidence into the boundary
    // so only the corresponding idle transition remains.
    this.terminalDrainBoundaries.set(turn.noteKey, {
      sessionId,
      writeBoundaryAt: candidate.boundaryAt,
      activityObservedAt: candidate.pickupObservedAt,
    });
    this.pickup.delete(turn.noteKey);
    const publish = () => this.journalDelivered(sessionId, turn, candidate.generation);
    this.retireDelivered(turn, candidate.spokenReservationId, turn.spokenWords !== undefined ? publish : undefined);
    if (turn.spokenWords === undefined) publish();
    this.registry.refreshPendingTurns(turn.noteKey);
  }

  /**
   * Retire a turn the agent took, with its after-work prompt row if it has one, in one
   * transaction. The delivery has already happened, so a retire that throws is not the
   * delivery's failure: it is tried again, backing off from 1 second to 5 minutes, until it
   * commits or the row is gone. Meanwhile the row stays `sending`, which holds the
   * conversation's next delivery behind it, and a restart turns it `uncertain` for the
   * operator, never resending it. Marking that sent settles the prompt row too
   * (`resolveUncertainPendingTurn`).
   */
  private retireDelivered(turn: PendingTurn, reservationId: string | null, onCommit?: () => void,
    failures = 0): "committed" | "retrying" | "stale" {
    const retryKey = reservationId ?? turn.id;
    this.retireRetries.delete(retryKey);
    let retired: boolean;
    try {
      retired = this.deps.retireDelivered(turn.id, turn.revision, this.deps.now(), reservationId);
    } catch (error) {
      console.warn(`[pending-turns] could not retire delivered turn ${turn.id}; trying again:`, error);
      if (this.stopped) return "stale";
      const delay = Math.min(RETIRE_RETRY_MAX_MS, RETIRE_RETRY_BASE_MS * 2 ** failures);
      this.retireRetries.set(retryKey, unref(setTimeout(() => {
        this.retireDelivered(turn, reservationId, onCommit, failures + 1);
        this.registry.refreshPendingTurns(turn.noteKey);
      }, delay)));
      return "retrying";
    }
    if (!retired) return "stale";
    onCommit?.();
    return "committed";
  }

  /**
   * Announce that this row positively reached the agent.
   *
   * Called from the two places that RETIRE a claimed row - an accepted SDK turn and a
   * proven terminal pickup - and from nowhere else, which is the whole contract. A queued
   * row is still editable, a recalled one was never delivered, a released one went back to
   * the outbox, and an uncertain one is a question for the operator; telling any of them to
   * a subscriber would put words in the agent's ears it never heard.
   *
   * `PendingTurn.id` is the delivery id, so a row that went out, could not be confirmed and
   * was retried is one delivery rather than two.
   *
   * **Two subscribers now, and the second was added rather than the fact re-derived.** The
   * scout prompt journal was the first; the line-comment walkthrough is the second, and it
   * needs exactly this fact - "the bytes were taken" - to stamp a comment delivered. It
   * hears it through `Registry.onTurnDelivered` rather than through a hook on this class,
   * because that is the shape every other durable subscriber in this daemon already has and
   * because the walkthrough is constructed long after this manager is.
   *
   * Both calls are synchronous and neither may throw: `journalScoutPrompt` cannot, for the
   * reason stated once on `prompt-journal.ts`, and the emit runs listeners that the
   * Registry's own contract already forbids from throwing.
   */
  private journalDelivered(sessionId: string, turn: PendingTurn, generation: number): void {
    const now = this.deps.now();
    // No try/catch: `journalScoutPrompt` cannot throw, and the reason is stated once on
    // `prompt-journal.ts` rather than re-argued at each of its callers. A local guard here
    // would read as though this site were special, and the two sites that turned out to
    // need one had not copied it.
    // A daemon-written row settles its reservation instead, which journals it under its own
    // origin through the injection observer; only the operator's words are journaled as human.
    const author = daemonAuthorOf(turn);
    if (author) recordInjection(sessionId, turn.text, author);
    else journalScoutPrompt(this.registry, sessionId, turn.spokenWords ?? turn.text, "human", turn.id, now);
    this.registry.turnDelivered({
      sessionId, turnId: turn.id, deliveredAt: now,
      ...(turn.spokenWords !== undefined && { spoken: { generation } }),
    });
  }

  private armPickupTimeout(sessionId: string, turn: PendingTurn): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (
      !candidate ||
      candidate.turn.id !== turn.id ||
      candidate.sessionId !== sessionId ||
      candidate.timer
    ) return;
    candidate.timer = unref(
      setTimeout(() => {
        const current = this.pickup.get(turn.noteKey);
        if (
          !current ||
          current.turn.id !== turn.id ||
          current.sessionId !== sessionId
        ) return;
        this.pickup.delete(turn.noteKey);
        markPendingTurnUncertain(
          turn.id,
          turn.revision,
          "Mission Control could not confirm that the terminal accepted this message.",
          this.deps.now(),
        );
        this.registry.refreshPendingTurns(turn.noteKey);
      }, this.deps.pickupTimeoutMs),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a steer accepted into this session's turn can still be waiting to be read.
 *
 * Once the turn is over the agent has either read the message or begun a new turn with it,
 * and either way the transcript is about to show it. `awaiting_review` is not an end: a
 * permission question pauses the turn that will read the steer when it resumes.
 */
function steerReadWindowClosed(session: Session): boolean {
  return session.state === "idle" || session.state === "awaiting_input" ||
    session.state === "starting" || session.state === "stopping" || session.state === "exited";
}
