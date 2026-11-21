import type { TranscriptMessage, TurnOriginSession } from "@shared/types.ts";
import { pruneDelegatedTurns as pruneRows, type DelegatedTurnRow } from "./db.ts";
import { forgetDeliveryBindingState, type DeliveryConversation } from "./delivery-binding.ts";
import { delegatedLedger as ledger } from "./delivery-ledgers.ts";

export {
  noteOtherSend,
  rememberedOtherSendKeys,
  withdrawOtherSend,
  type OtherSendHandle,
} from "./delivery-ledgers.ts";

/**
 * Which controlling session sent a delegated message, durably and per delivery.
 *
 * `injections.ts` answers "who typed this text" from memory, keyed by the text, which is
 * right for its Goal-suppression reader and wrong for this label on two counts: a restart
 * forgets it, so an older delegated message reads as the operator's, and identical words
 * from two controllers collapse into one entry, so both turns name whichever sent last.
 *
 * So each delivery is its own row in `session_delegated_turns`, bound to its turn by the
 * shared rule in `delivery-binding.ts`: reserved before the send with the target transcript's
 * size, bound once to the first matching turn after it, and contested while another send of
 * the same words - the operator's, Foreman's, or another controller's - is in flight.
 */

/** A target conversation, and the transcript its deliveries are bound against. */
export type DelegatedConversation = DeliveryConversation;

function sourceOf(row: DelegatedTurnRow): TurnOriginSession {
  return { id: row.controllerId, name: row.controllerName };
}


/**
 * Record a delegated delivery BEFORE it is attempted; returns its id for `releaseDelegatedTurn`.
 * The target transcript's size now is where its turn can first appear.
 */
export function reserveDelegatedTurn(
  conversation: DelegatedConversation,
  text: string,
  source: TurnOriginSession,
  now = Date.now(),
): string {
  return ledger.reserve(conversation, text, (base) => ({
    ...base,
    controllerId: source.id,
    controllerName: source.name,
  }), now).id;
}

/** Give back a delivery with positive evidence that nothing landed. */
export function releaseDelegatedTurn(noteKey: string, id: string): void {
  ledger.release(noteKey, id);
}

/**
 * The sender of each delegated turn in `messages`, by message id (see `DeliveryLedger.bound`).
 *
 * A text this conversation has delegated rows for, on a turn none of them claims, is the
 * operator's: `contested` names those turns so the caller can tell them from "never
 * delegated", where only the in-memory label is left to ask.
 */
export function delegatedTurnSources(
  conversation: DelegatedConversation | null | undefined,
  messages: readonly TranscriptMessage[],
  now = Date.now(),
): { sources: Map<string, TurnOriginSession>; contested: Set<string>; ambiguous: Set<string> } {
  const bound = ledger.bound(conversation, messages, now);
  const sources = new Map<string, TurnOriginSession>();
  for (const [id, row] of bound.rows) sources.set(id, sourceOf(row));
  return { sources, contested: bound.matched, ambiguous: bound.ambiguous };
}

/**
 * Drop rows of conversations no live session holds, on the goal table's prune tick. Null live
 * keys mean liveness is unknown and prune nothing; an empty list means no session is live.
 */
export function pruneDelegatedTurns(liveKeys: Iterable<string> | null, olderThan: number): number {
  const removed = pruneRows(liveKeys, olderThan);
  // Only the row caches: live conversations' in-flight sends must survive another's prune.
  if (removed) ledger.forgetCaches();
  return removed;
}

/** For tests: a full reset, as a daemon restart would leave it, so the next read comes from the table. */
export function forgetDelegatedTurnCache(): void {
  forgetDeliveryBindingState();
}
