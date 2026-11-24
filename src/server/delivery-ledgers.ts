import { statSync } from "node:fs";
import type { PendingTurn } from "@shared/types.ts";
import {
  bindDelegatedTurn,
  bindReviewDelivery,
  bindSpokenTurn,
  contestDelegatedTurn,
  contestReviewDelivery,
  contestSpokenTurn,
  deleteDelegatedTurn,
  deleteExpiredSpokenReservations,
  deleteReviewDelivery,
  deleteSpokenTurn,
  expiredSpokenReservations,
  inTransaction,
  insertDelegatedTurn,
  insertReviewDelivery,
  insertSpokenTurn,
  loadDelegatedTurns,
  loadReviewDeliveries,
  loadSpokenTurns,
  moveSpokenTurns,
  observeSpokenClientReceipt,
  recordSpokenHandoff,
  takeDiscardedSpokenKeys,
  type DelegatedTurnRow,
  type ReviewDeliveryRow,
  type SpokenTranscriptLocator,
  type SpokenTurnRow,
} from "./db.ts";
import type { TranscriptSession } from "./harness/types.ts";
import { DELIVERY_LAG_MS, DeliveryLedger, forgetDeliveryBindingState, onSend, registerDeliveryLedgers, type DeliveryConversation } from "./delivery-binding.ts";
import { settleSteerEchoesBeforeSend } from "./review-steer-echo.ts";

export {
  noteOtherSend,
  rememberedOtherSendKeys,
  withdrawOtherSend,
  type OtherSendHandle,
} from "./delivery-binding.ts";

/**
 * The composition point for every recorded-delivery table, constructed and registered together.
 *
 * The binding rule treats the ledgers as one claim space: a turn is bound by at most one row of
 * any of them, and rows of the same words in different ledgers contest each other. That only holds
 * if every ledger is registered before any binding, reservation or other send runs. Constructing
 * them here, in one module that both `delegated-turns.ts` and `review-deliveries.ts` import, means
 * whichever is loaded first brings the other's rows into the claim space with it, rather than the
 * claim space depending on which delivery module some caller happened to import. The same holds for
 * what a ledger must do before any send into that space: the review ledger's steered-echo listener
 * is installed here, with the ledger, so a delegated send settles a review delivery's echo even in
 * a process that never imported `review-deliveries.ts`.
 */

/** A controlling session's delegated messages (`delegated-turns.ts`). */
export const delegatedLedger = new DeliveryLedger<DelegatedTurnRow>({
  label: "a delegated turn",
  load: loadDelegatedTurns,
  insert: insertDelegatedTurn,
  remove: deleteDelegatedTurn,
  contest: contestDelegatedTurn,
  bind: (row, id, ts) => bindDelegatedTurn(row.id, id, ts),
  // The label a row would show: two rows with the same one cannot be credited to the wrong sender.
  sender: (row) => `${row.controllerId}\0${row.controllerName}`,
});

const reviewForgetHooks: Array<() => void> = [];

/** Mission Control's own messages about a review (`review-deliveries.ts`). */
export const reviewLedger = new DeliveryLedger<ReviewDeliveryRow>({
  label: "a review message",
  load: loadReviewDeliveries,
  insert: insertReviewDelivery,
  remove: deleteReviewDelivery,
  contest: contestReviewDelivery,
  bind: (row, id, ts) => bindReviewDelivery(row.id, id, ts),
  // Every review message is Mission Control's, so two of the same words never contest each other.
  sender: () => "mission-control",
}, () => {
  for (const hook of reviewForgetHooks) hook();
});

/** Drop what `review-deliveries.ts` derived from the review rows whenever their caches drop. */
export function onReviewLedgerForget(hook: () => void): void {
  reviewForgetHooks.push(hook);
}

// Before any send into the claim space, a bound review delivery's steered echo is settled from
// what the file already holds (`review-steer-echo.ts`), so the new send's turn can never take it.
onSend(settleSteerEchoesBeforeSend(reviewLedger));

export const spokenLedger = new DeliveryLedger<SpokenTurnRow>({
  label: "a spoken message",
  // Reads include archived sessions and hourly cleanup, which can outlive Registry eviction.
  maxCachedConversations: 32,
  requireExactFingerprint: true,
  takeInvalidatedKeys: takeDiscardedSpokenKeys,
  textBoundary(row, transcript) {
    if (row.transcriptOffset === null) {
      // bindPending checked the file's creation time. Pin its identity on the first binding.
      if (row.messageId !== null || row.transcriptBoundary !== "missing") return false;
      return transcript.read.boundary?.(transcript.path, 0) ?? null;
    }
    if (row.transcriptBoundary === null) return false;
    const boundary = transcript.read.boundary?.(transcript.path, row.transcriptOffset);
    if (!boundary) return null;
    return boundary.proof === row.transcriptBoundary ? boundary : false;
  },
  newTranscriptAfter(transcript, deliveredAt) {
    try {
      const created = statSync(transcript.path).birthtimeMs;
      return created > 0 && Math.floor(created) > deliveredAt;
    } catch {
      return null;
    }
  },
  load: loadSpokenTurns,
  insert: insertSpokenTurn,
  remove: deleteSpokenTurn,
  contest: contestSpokenTurn,
  bind(row, id, ts, boundary) {
    if (!boundary || !bindSpokenTurn(row.id, id, ts, boundary)) return false;
    row.transcriptOffset = boundary.offset;
    row.transcriptBoundary = boundary.proof;
    return true;
  },
  observeClientReceipt: observeSpokenClientReceipt,
  sender: row => row.spokenWords,
});

type SpokenConversation = DeliveryConversation & { session?: Pick<TranscriptSession, "agent" | "cwd" | "transcriptPath"> };

/** On runtimes that accept a native user-message id, reserve that identity before the write. */
export function reserveSpokenTurn(conversation: SpokenConversation, spokenWords: string, received: string,
  clientMessageIds: boolean, attempt: Pick<PendingTurn, "id" | "revision"> & { reservationId: string }, now = Date.now()) {
  return spokenLedger.reserve(conversation, received, base => {
    const transcript = conversation.transcript;
    const boundary = !clientMessageIds && transcript ? transcript.read.boundary?.(transcript.path) : null;
    return {
      ...base, spokenWords, received, outboxTurnId: attempt.id, outboxRevision: attempt.revision,
      messageId: clientMessageIds ? base.id : null,
      transcriptOffset: boundary?.offset ?? base.transcriptOffset,
      transcriptBoundary: boundary?.proof ?? (!clientMessageIds && !transcript ? "missing" : null),
      transcriptAgent: conversation.session?.agent ?? null,
      transcriptCwd: conversation.session?.cwd ?? null,
      transcriptPath: transcript?.path ?? conversation.session?.transcriptPath ?? null,
    };
  }, now, attempt.reservationId);
}

export function followSpokenConversationKey(sessionId: string, fromKey: string, toKey: string): void {
  if (fromKey === sessionId && fromKey !== toKey && moveSpokenTurns(fromKey, toKey)) spokenLedger.forgetCaches();
}

/** At the transport guard, the receiving cycle and its corresponding ledger reservation commit together. */
export function reserveSpokenHandoff(conversation: SpokenConversation, turn: PendingTurn, words: string,
  clientMessageIds: boolean, generation: number, now: number): SpokenTurnRow | null {
  // Process invalidations from prior outbox transactions before the ledger is read inside this one.
  spokenLedger.rows(conversation.key);
  try {
    return inTransaction(() => {
      const reservationId = recordSpokenHandoff(turn.id, turn.revision, generation, now);
      if (!reservationId) return null;
      return reserveSpokenTurn(conversation, words, turn.text, clientMessageIds, { ...turn, reservationId }, now);
    });
  } catch (error) {
    // Binding can also have updated the other ledgers' contests before the insert or commit failed.
    forgetDeliveryBindingState();
    throw error;
  }
}

function reconcileSpokenTurns(noteKey: string, transcript: NonNullable<DeliveryConversation["transcript"]>,
  now: number): "complete" | "unavailable" | "retry" {
  const snapshot = transcript.read.snapshot?.(transcript.path);
  if (!snapshot) return "unavailable";
  try {
    spokenLedger.reconcileBeforePrune(noteKey, transcript, now);
    // A rewritten native transcript can put a client UUID before the offset recorded at handoff.
    let from = 0;
    for (;;) {
      const page = transcript.read.after(transcript.path, from, 50, true);
      spokenLedger.bound({ key: noteKey, transcript }, page.messages, now);
      if (!spokenLedger.flushClientObservations(noteKey)) return "retry";
      if (page.start !== from) return "retry";
      if (page.atEnd) {
        // Only a complete walk of the same file revision establishes absence.
        return page.end === snapshot.size && transcript.read.snapshot?.(transcript.path)?.version === snapshot.version ? "complete" : "retry";
      }
      if (page.end <= from || page.end >= snapshot.size) return "retry";
      from = page.end;
    }
  } catch (error) {
    console.warn("[voice] Could not reconcile spoken receipts:", error instanceof Error ? error.message : String(error));
    return error instanceof Error && "path" in error && error.path === transcript.path ? "unavailable" : "retry";
  }
}

/** Final transcript pass for abandoned attempts and confirmed deliveries still awaiting a native match. */
export function pruneExpiredSpokenTurns(now: number, transcriptsFor: (key: string, locator: SpokenTranscriptLocator) => DeliveryConversation["transcript"][],
  unavailableBefore?: number): number {
  const cutoff = now - DELIVERY_LAG_MS;
  let removed = 0;
  spokenLedger.flushClientObservations();
  for (const group of expiredSpokenReservations(cutoff)) {
    if (!spokenLedger.flushClientObservations(group.noteKey)) continue;
    const scans = transcriptsFor(group.noteKey, group).map(transcript =>
      transcript ? reconcileSpokenTurns(group.noteKey, transcript, now) : "unavailable");
    if (scans.length && scans.every(scan => scan === "complete")) removed += deleteExpiredSpokenReservations(group, cutoff, cutoff);
    else if (!scans.includes("retry") && unavailableBefore !== undefined) {
      // Only confirmed, unbound text expires without a readable file. Exact SDK receipts can still arrive.
      removed += deleteExpiredSpokenReservations(group, null, Math.min(cutoff, unavailableBefore));
    }
  }
  return removed;
}

registerDeliveryLedgers([delegatedLedger, reviewLedger, spokenLedger]);
