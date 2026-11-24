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
  type SpokenTurnRow,
} from "./db.ts";
import { DELIVERY_LAG_MS, DeliveryLedger, forgetDeliveryBindingState, onSend, registerDeliveryLedgers, transcriptSize, type DeliveryConversation } from "./delivery-binding.ts";
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
  bind: bindDelegatedTurn,
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
  bind: bindReviewDelivery,
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
  takeInvalidatedKeys: takeDiscardedSpokenKeys,
  newTranscriptAfter(transcript, deliveredAt) {
    try {
      const created = statSync(transcript.path).birthtimeMs;
      return created > 0 && Math.floor(created) > deliveredAt;
    } catch {
      return false;
    }
  },
  load: loadSpokenTurns,
  insert: insertSpokenTurn,
  remove: deleteSpokenTurn,
  contest: contestSpokenTurn,
  bind: bindSpokenTurn,
  observeClientReceipt: observeSpokenClientReceipt,
  sender: row => row.spokenWords,
});

/** On runtimes that accept a native user-message id, reserve that identity before the write. */
export function reserveSpokenTurn(conversation: DeliveryConversation, spokenWords: string, received: string,
  clientMessageIds: boolean, attempt: Pick<PendingTurn, "id" | "revision"> & { reservationId: string }, now = Date.now()) {
  return spokenLedger.reserve(conversation, received, base => ({
    ...base, spokenWords, received, outboxTurnId: attempt.id, outboxRevision: attempt.revision,
    messageId: clientMessageIds ? base.id : null,
  }), now, attempt.reservationId);
}

export function followSpokenConversationKey(sessionId: string, fromKey: string, toKey: string): void {
  if (fromKey === sessionId && fromKey !== toKey && moveSpokenTurns(fromKey, toKey)) spokenLedger.forgetCaches();
}

/** At the transport guard, the receiving cycle and its corresponding ledger reservation commit together. */
export function reserveSpokenHandoff(conversation: DeliveryConversation, turn: PendingTurn, words: string,
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

/** Give each abandoned SDK attempt one final transcript walk, including conversations nobody has opened. */
export function pruneAbandonedSpokenTurns(now: number, transcriptFor: (key: string) => DeliveryConversation["transcript"]): number {
  const cutoff = now - DELIVERY_LAG_MS;
  const candidates = expiredSpokenReservations(cutoff);
  let removed = 0;
  for (const { noteKey, offset, lastOffset } of candidates) {
    const transcript = transcriptFor(noteKey);
    if (!transcript) continue;
    const size = transcriptSize(transcript);
    if (size === null || size < lastOffset) continue;
    let from = offset;
    for (;;) {
      let page;
      try {
        page = transcript.read.after(transcript.path, from, 50, true);
      } catch (error) {
        console.warn("[voice] Could not reconcile abandoned spoken receipts:", error instanceof Error ? error.message : String(error));
        break;
      }
      spokenLedger.bound({ key: noteKey, transcript }, page.messages, now);
      if (page.start !== from) break;
      if (page.atEnd) {
        // A reader can also return an empty terminal page on I/O failure or an incomplete line.
        if (page.end === size && transcriptSize(transcript) === size) {
          removed += deleteExpiredSpokenReservations(noteKey, cutoff);
        }
        break;
      }
      if (page.end <= from || page.end >= size) break;
      from = page.end;
    }
  }
  return removed;
}

registerDeliveryLedgers([delegatedLedger, reviewLedger, spokenLedger]);
