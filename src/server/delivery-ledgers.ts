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
  deleteReviewDelivery,
  deleteSpokenTurn,
  insertDelegatedTurn,
  insertReviewDelivery,
  insertSpokenTurn,
  loadDelegatedTurns,
  loadReviewDeliveries,
  loadSpokenTurns,
  moveSpokenTurns,
  type DelegatedTurnRow,
  type ReviewDeliveryRow,
  type SpokenTurnRow,
} from "./db.ts";
import { DeliveryLedger, onSend, registerDeliveryLedgers, type DeliveryConversation } from "./delivery-binding.ts";
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
  newTranscriptAfter(transcript, deliveredAt) {
    try {
      const created = statSync(transcript.path).birthtimeMs;
      return created > 0 && created >= deliveredAt;
    } catch {
      return false;
    }
  },
  load: loadSpokenTurns,
  insert: insertSpokenTurn,
  remove: deleteSpokenTurn,
  contest: contestSpokenTurn,
  bind: bindSpokenTurn,
  sender: row => row.spokenWords,
});

/** On runtimes that accept a native user-message id, reserve that identity before the write. */
export function reserveSpokenTurn(conversation: DeliveryConversation, spokenWords: string, received: string,
  clientMessageIds: boolean, attempt: Pick<PendingTurn, "id" | "revision">) {
  return spokenLedger.reserve(conversation, received, base => ({
    ...base, spokenWords, received, outboxTurnId: attempt.id, outboxRevision: attempt.revision,
    messageId: clientMessageIds ? base.id : null,
  }));
}

export function followSpokenConversationKey(sessionId: string, fromKey: string, toKey: string): void {
  if (fromKey === sessionId && fromKey !== toKey && moveSpokenTurns(fromKey, toKey)) spokenLedger.forgetCaches();
}

registerDeliveryLedgers([delegatedLedger, reviewLedger, spokenLedger]);
