import { settleReviewDeliverySteerEcho, type ReviewDeliveryRow } from "./db.ts";
import type { DeliveryConversation, DeliveryLedger } from "./delivery-binding.ts";
import { injectionFingerprint } from "./injections.ts";

/**
 * The echo a steered review delivery leaves behind, decided once from the transcript file and
 * persisted on its row (`steer_echo`).
 *
 * A steered delivery can be recorded twice: as the message the agent took mid-turn, which is the
 * turn the delivery binds, and again as a plain record of the same words. That echo is the same
 * delivery, so it is drawn with it rather than as a raw turn (`reviewMessageTurns`).
 *
 * This module imports no ledger, so the composition point (`delivery-ledgers.ts`) can install the
 * review ledger's send listener as it constructs that ledger: the echo is settled before every
 * send into the shared claim space, whichever delivery module a caller imported.
 */

/** The file was read and ends right after the mid-turn record: the echo may yet be written. */
export const STEER_ECHO_PENDING = Symbol("steer-echo-pending");
/** The file could not be read: nothing about the echo is known. */
export const STEER_ECHO_UNREADABLE = Symbol("steer-echo-unreadable");

/** Record a delivery's echo decision durably, once; null is "none". */
export function settleSteerEcho(row: ReviewDeliveryRow, echo: string | null): string | null {
  if (row.steerEcho !== null) return row.steerEcho || null;
  row.steerEcho = echo ?? "";
  settleReviewDeliverySteerEcho(row.id, row.steerEcho);
  return echo;
}

/**
 * The turn that echoes a bound delivery's mid-turn record: the next turn in the file, when it is
 * a plain user record of the same words, with no agent turn or other message between them (the
 * rule `collapseSteerEchoes` draws by). Walked forward from the delivery's own offset, so it does
 * not depend on the page being read. `STEER_ECHO_PENDING` while the file was read and ends right
 * after the record, as the echo may still be written; `STEER_ECHO_UNREADABLE` when the read failed,
 * which decides nothing; settled and remembered once anything follows the record.
 */
export function steerEchoOf(
  row: ReviewDeliveryRow,
  transcript: NonNullable<DeliveryConversation["transcript"]>,
): string | null | typeof STEER_ECHO_PENDING | typeof STEER_ECHO_UNREADABLE {
  if (row.steerEcho !== null) return row.steerEcho || null;
  const settle = (echo: string | null): string | null => settleSteerEcho(row, echo);
  let from = row.transcriptOffset ?? 0;
  let seen = false;
  try {
    for (;;) {
      const page = transcript.read.after(transcript.path, from, 50);
      for (const m of page.messages) {
        if (!seen) {
          if (m.id !== row.messageId) continue;
          if (!m.takenMidTurn) return settle(null);
          seen = true;
          continue;
        }
        if (m.role !== "user" || m.takenMidTurn || !m.text) return settle(null);
        return settle(injectionFingerprint(m.text) === row.fingerprint ? m.id : null);
      }
      if (page.atEnd || page.end <= from) break;
      from = page.end;
    }
  } catch {
    return STEER_ECHO_UNREADABLE;
  }
  // The bound turn was not found under its id (a parser that re-synthesizes ids): no echo is
  // credited on a guess. Found and last in the file: its echo may not be written yet.
  return seen ? STEER_ECHO_PENDING : settle(null);
}

/**
 * The review ledger's send listener. Another send of a delivery's words - the operator's,
 * Foreman's, a controller's delegated delivery, or a second delivery of Mission Control's own -
 * is about to be written: from here a plain record of those words could be that send rather than
 * the steered delivery's echo. So every bound delivery's echo is settled now, from what the file
 * already holds, and a later copy can never take it.
 */
export function settleSteerEchoesBeforeSend(
  ledger: DeliveryLedger<ReviewDeliveryRow>,
): (conversation: DeliveryConversation, fingerprint: string) => void {
  return (conversation, fingerprint) => {
    // Settled as "none" only when the file was read and ends at the mid-turn record. With no
    // transcript, or a read that failed, an echo may already be written, so nothing is ruled out.
    if (!conversation.transcript) return;
    // A delivery whose turn has landed but that no reader has bound yet is bound first, so its
    // echo is decided too.
    ledger.bindLanded(conversation.key, conversation.transcript, Date.now());
    for (const row of ledger.rows(conversation.key)) {
      if (row.messageId === null || row.fingerprint !== fingerprint || row.steerEcho !== null) continue;
      if (steerEchoOf(row, conversation.transcript) === STEER_ECHO_PENDING) settleSteerEcho(row, null);
    }
  };
}
