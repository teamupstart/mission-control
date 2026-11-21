import { parseReviewEnvelope } from "@shared/review-message-envelope.ts";
import type { TranscriptMessage, TranscriptPresentation, WorkCycleSummary } from "@shared/types.ts";
import {
  bindReviewDelivery,
  confirmReviewDelivery as persistConfirmation,
  contestReviewDelivery,
  deleteReviewDelivery,
  insertReviewDelivery,
  loadReviewDeliveries,
  pruneUnboundReviewDeliveries,
  settleReviewDeliverySteerEcho,
  updateReviewDeliveryEcho,
  type ReviewDeliveryRow,
} from "./db.ts";
import { DELIVERY_LAG_MS, DeliveryLedger, onSend, type DeliveryConversation } from "./delivery-binding.ts";
import { HUMAN_ECHO_TTL_MS, injectionFingerprint } from "./injections.ts";

/**
 * Which transcript turn carried a review message to the agent (`async-input`), durably.
 *
 * The daemon marks every outbox message it writes about a review with one first line
 * (`@shared/review-message-envelope.ts`). The line is a label for the agent and a filter for
 * the daemon, never a proof: an operator can paste it. So a marked row reserves one delivery
 * here before it is sent, and the turn it writes is found by the binding rule delegated turns
 * already use (`delivery-binding.ts`). Only a turn a delivery is bound to is drawn as an
 * answer card, and the review ids come from the row, not from the turn's text.
 *
 * Every delivery is Mission Control's, so two deliveries of the same words never contest each
 * other; they bind in reservation order. Any other send of the same words in their window - the
 * operator's composer, a queued turn, Foreman - contests them (`noteOtherSend`), and then
 * neither turn becomes a card.
 *
 * Each delivery also owes the Goal reader exactly one prompt-hook echo, persisted on the row so
 * a restart cannot let the daemon's text through as the operator's Goal. The debt follows the
 * lifetime an operator follow-up's expected echo has (`expireHumanEchoes`): it ends when the
 * echo arrives, when the work cycle the delivery belongs to completes, or `HUMAN_ECHO_TTL_MS`
 * after that cycle became the next one, so a harness that drops or alters the echo cannot
 * leave a debt that swallows a later operator copy.
 */

const MISSION_CONTROL = "mission-control";

const ledger = new DeliveryLedger<ReviewDeliveryRow>({
  label: "a review message",
  load: loadReviewDeliveries,
  insert: insertReviewDelivery,
  remove: deleteReviewDelivery,
  contest: contestReviewDelivery,
  bind: bindReviewDelivery,
  sender: () => MISSION_CONTROL,
});

// Another send of a delivery's words - the operator's, Foreman's, a controller's delegated
// delivery, or a second delivery of Mission Control's own - about to be written: from here a
// plain record of those words could be that send rather than the steered delivery's echo.
// Settle every bound delivery's echo now, from what the file already holds, so a later copy can
// never take it.
onSend((conversation, fingerprint) => {
  // A delivery whose turn has landed but that no reader has bound yet is bound first, so its
  // echo is decided too.
  if (conversation.transcript) ledger.bindLanded(conversation.key, conversation.transcript, Date.now());
  for (const row of ledger.rows(conversation.key)) {
    if (row.messageId === null || row.fingerprint !== fingerprint || row.steerEcho !== null) continue;
    const echo = conversation.transcript ? steerEchoOf(row, conversation.transcript) : undefined;
    if (echo === undefined) settleSteerEcho(row, null);
  }
});

/**
 * The work-cycle generation each reservation was made at, until it is confirmed. A restart in
 * between ends the delivery as uncertain and it is never confirmed, so memory is enough.
 */
const reservedAt = new Map<string, number>();

/**
 * Arrivals that spent the echo of a delivery not yet accepted, keyed by delivery. If that delivery
 * is then refused, nothing it sent can have been echoed, so the arrival was someone else's words
 * - the operator's - and is captured after all. In memory: a restart leaves an unaccepted delivery
 * uncertain, never refused.
 */
const unacceptedClaims = new Map<string, () => void>();

/**
 * Reserve a delivery for an outbox row about to be sent, BEFORE the send. Returns its id, or
 * null when the text carries no marker and so is not a review message this ledger records.
 *
 * `cycle` is the session's work cycle as the registry projects it now, which decides the turn
 * the delivery's echo belongs to, exactly as `expectHumanEcho` decides it for a follow-up.
 */
export function reserveReviewDelivery(
  conversation: DeliveryConversation,
  text: string,
  cycle: WorkCycleSummary | undefined,
  now = Date.now(),
): string | null {
  const envelope = parseReviewEnvelope(text);
  if (!envelope) return null;
  const base = cycle?.generation ?? 0;
  const queued = cycle?.active === true;
  const row = ledger.reserve(conversation, text, (shared) => ({
    ...shared,
    envelope: envelope.kind,
    reviewIds: envelope.reviewIds,
    confirmedAt: null,
    echoOwed: true,
    echoTurnGeneration: base + (queued ? 2 : 1),
    echoEligibleAt: queued ? null : now,
    steerEcho: null,
  }), now);
  reservedAt.set(row.id, base);
  return row.id;
}

/**
 * The runtime accepted the delivery. `queued` is its own answer that the message waits behind a
 * running turn, which moves the echo to the turn after it; `completedGeneration` is the
 * conversation's completed generation now, so a turn ahead that already ended is not waited on.
 */
export function confirmReviewDelivery(
  noteKey: string,
  id: string,
  options: { queued?: boolean; completedGeneration?: number; now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const row = ledger.rows(noteKey).find((r) => r.id === id);
  const base = reservedAt.get(id);
  reservedAt.delete(id);
  unacceptedClaims.delete(id);
  persistConfirmation(id, now);
  if (!row) return;
  row.confirmedAt = now;
  if (!row.echoOwed || !options.queued || base === undefined || row.echoTurnGeneration >= base + 2) return;
  row.echoTurnGeneration = base + 2;
  row.echoEligibleAt = row.echoTurnGeneration <= (options.completedGeneration ?? base) + 1 ? now : null;
  persistEcho(row);
}

/** Give back a delivery with positive evidence that nothing landed. */
export function releaseReviewDelivery(noteKey: string, id: string): void {
  reservedAt.delete(id);
  ledger.release(noteKey, id);
  const restore = unacceptedClaims.get(id);
  unacceptedClaims.delete(id);
  try {
    restore?.();
  } catch (err) {
    console.error("[review-deliveries] could not restore an operator prompt:", err instanceof Error ? err.message : String(err));
  }
}

function persistEcho(row: ReviewDeliveryRow): void {
  updateReviewDeliveryEcho(row.id, { owed: row.echoOwed, turnGeneration: row.echoTurnGeneration, eligibleAt: row.echoEligibleAt });
}

/** Whether this delivery's owed echo has aged past its wait. */
function echoLapsed(row: ReviewDeliveryRow, now: number): boolean {
  return row.echoEligibleAt !== null && now - row.echoEligibleAt > HUMAN_ECHO_TTL_MS;
}

/**
 * A prompt-hook arrival with these words: spend one owed delivery echo for it, oldest first.
 * True when one was owed, and then the arrival is the daemon's own text, never a Goal revision.
 *
 * Counted, never paired. An operator copy of the same words and the delivery's echo cannot be
 * told apart on arrival, so whichever comes first spends the debt and the other is captured: N
 * deliveries and M operator sends of the same text always yield exactly M revisions.
 */
export function claimReviewDeliveryEcho(
  noteKey: string,
  texts: readonly string[],
  now = Date.now(),
  /** Capture this arrival after all, if the delivery whose echo it spent is then refused. */
  ifRefused?: () => void,
): boolean {
  const fingerprints = new Set(texts.map(injectionFingerprint));
  for (const row of ledger.rows(noteKey)) {
    if (!row.echoOwed || !fingerprints.has(row.fingerprint)) continue;
    row.echoOwed = false;
    persistEcho(row);
    // A lapsed debt is cleared all the same, and the search goes on: it owes nothing now.
    if (echoLapsed(row, now)) continue;
    // Spent before the runtime accepted the delivery, whose echo may yet be this arrival or may
    // never exist. The count is settled now; a refusal later hands the arrival back.
    if (row.confirmedAt === null && reservedAt.has(row.id) && ifRefused) unacceptedClaims.set(row.id, ifRefused);
    return true;
  }
  return false;
}

/**
 * A turn of this conversation completed, leaving it at `completedGeneration`. Clears the debt
 * of every delivery that belonged to that turn or an earlier one, and starts the next turn's
 * deliveries aging. Idempotent.
 */
export function expireReviewDeliveryEchoes(noteKey: string, completedGeneration: number, now = Date.now()): void {
  for (const row of ledger.rows(noteKey)) {
    if (!row.echoOwed) continue;
    if (row.echoTurnGeneration <= completedGeneration || echoLapsed(row, now)) {
      row.echoOwed = false;
      persistEcho(row);
    } else if (row.echoEligibleAt === null && row.echoTurnGeneration <= completedGeneration + 1) {
      row.echoEligibleAt = now;
      persistEcho(row);
    }
  }
}

/**
 * A turn a delivery is bound to: always Mission Control's, always presented as the review message
 * it is. Whether each review it names can still be drawn is the dashboard's to say.
 */
export interface BoundReviewTurn {
  presentation: Extract<TranscriptPresentation, { kind: "review-message" }>;
}

/** What recognition decided about the turns on one page. */
export interface ReviewMessageTurns {
  bound: Map<string, BoundReviewTurn>;
  /** Turns with a delivery's words that no delivery claims: someone else's copy. */
  matched: Set<string>;
  /** Turns that could be a contested or boundary-less delivery: nobody's label applies. */
  ambiguous: Set<string>;
}

/**
 * Recognize the review messages on one page of turns. Reads only the delivery table and the
 * transcript, both durable, so it survives a restart and works on all history, and it never reads
 * the flag: a conversation with marked turns keeps its cards when the flag is off.
 */
export function reviewMessageTurns(
  conversation: DeliveryConversation | null | undefined,
  messages: readonly TranscriptMessage[],
  now = Date.now(),
): ReviewMessageTurns {
  const found = ledger.bound(conversation, messages, now);
  const bound: ReviewMessageTurns["bound"] = new Map();
  if (!conversation) return { bound, matched: found.matched, ambiguous: found.ambiguous };
  const rowsByTurn = new Map(found.rows);
  // A steered delivery can be recorded twice: as the message the agent took mid-turn, which is
  // the turn the delivery binds, and again as a plain record of the same words before the agent
  // says anything. That echo is the same delivery, so it is answered the same way, which lets the
  // dashboard draw the pair once (`collapseSteerEchoes`) instead of the echo as a raw turn. Found
  // in the file, never on the page, so a page that starts at the echo still knows it.
  const transcript = conversation.transcript;
  if (transcript) {
    const boundRows = ledger.rows(conversation.key).filter((row) => row.messageId !== null);
    for (const m of messages) {
      if (!found.matched.has(m.id) || rowsByTurn.has(m.id) || found.ambiguous.has(m.id)) continue;
      const fingerprint = injectionFingerprint(m.text);
      const row = boundRows.find((r) => r.fingerprint === fingerprint && steerEchoOf(r, transcript) === m.id);
      if (row) rowsByTurn.set(m.id, row);
    }
  }
  // Always presented, whatever has become of the reviews it names: the row is the daemon's own
  // record of its own message, so the turn is a delivered answer even when a question can no
  // longer be found, and the dashboard draws it as one rather than as raw daemon text.
  for (const [messageId, row] of rowsByTurn) {
    bound.set(messageId, { presentation: { kind: "review-message", envelope: row.envelope, reviewIds: [...row.reviewIds] } });
  }
  return { bound, matched: found.matched, ambiguous: found.ambiguous };
}


/** Record a delivery's echo decision durably, once; null is "none". */
function settleSteerEcho(row: ReviewDeliveryRow, echo: string | null): string | null {
  if (row.steerEcho !== null) return row.steerEcho || null;
  row.steerEcho = echo ?? "";
  settleReviewDeliverySteerEcho(row.id, row.steerEcho);
  return echo;
}

/**
 * The turn that echoes a bound delivery's mid-turn record: the next turn in the file, when it is
 * a plain user record of the same words, with no agent turn or other message between them (the
 * rule `collapseSteerEchoes` draws by). Walked forward from the delivery's own offset, so it does
 * not depend on the page being read. Undefined while the file ends right after the record, as the
 * echo may still be written; settled and remembered once anything follows it.
 */
function steerEchoOf(row: ReviewDeliveryRow, transcript: NonNullable<DeliveryConversation["transcript"]>): string | null | undefined {
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
    return undefined;
  }
  // The bound turn was not found under its id (a parser that re-synthesizes ids): no echo is
  // credited on a guess. Found and last in the file: its echo may not be written yet.
  return seen ? undefined : settle(null);
}

/**
 * Drop unbound deliveries past the delivery window: they can no longer bind anything. Bound rows
 * are kept, so an old conversation reopened later still draws its cards.
 */
export function pruneReviewDeliveries(now = Date.now()): number {
  const removed = pruneUnboundReviewDeliveries(now - DELIVERY_LAG_MS);
  if (removed) ledger.forgetCaches();
  return removed;
}
