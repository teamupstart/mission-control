import {
  bindDelegatedTurn,
  bindReviewDelivery,
  contestDelegatedTurn,
  contestReviewDelivery,
  deleteDelegatedTurn,
  deleteReviewDelivery,
  insertDelegatedTurn,
  insertReviewDelivery,
  loadDelegatedTurns,
  loadReviewDeliveries,
  type DelegatedTurnRow,
  type ReviewDeliveryRow,
} from "./db.ts";
import { DeliveryLedger, registerDeliveryLedgers } from "./delivery-binding.ts";

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
 * claim space depending on which delivery module some caller happened to import.
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

registerDeliveryLedgers([delegatedLedger, reviewLedger]);
