// The first line of every outbox message Mission Control writes about a review (`async-input`).
//
// Browser-safe: no `node:` import may reach this module. It is the only writer and the only
// parser of the line. The daemon composes it where a review's outbox row is written, the
// delivery ledger reads the review ids back out of a row it is about to send, the dashboard
// reads the ids of answers still queued, and the tests pin the grammar through these same
// functions. No other module matches the string.
//
// The line is a label, never a proof. Anyone who can type into a session can paste it, so a
// turn is drawn as an answer card only when a delivery the daemon recorded is bound to it
// (`server/review-deliveries.ts`). The marker is how the daemon knows which rows to record,
// and it tells the agent what the message is.

/**
 * The turn-id prefix of every outbox row the daemon writes about a review (a call-mode late
 * answer is `review-continuation:<id>`, a message-mode answer `review-continuation:answer:<id>`,
 * a snooze instruction `review-continuation:snooze:<id>`). The ids are the daemon's own: an
 * operator's queued message gets a random one. A marker counts only on a row with this prefix,
 * so an operator who types the line into the composer is never read as a review message.
 */
export const REVIEW_MESSAGE_TURN_PREFIX = "review-continuation:";

/** Whether a queued row is one the daemon wrote about a review, and so may carry a marker. */
export function isReviewMessageTurn(turn: { id: string }): boolean {
  return turn.id.startsWith(REVIEW_MESSAGE_TURN_PREFIX);
}

/** What a marked message carries: answers to questions, or a snoozed question's "carry on". */
export type ReviewEnvelopeKind = "answer" | "remind-later";

export const REVIEW_ENVELOPE_KINDS: readonly ReviewEnvelopeKind[] = ["answer", "remind-later"];

/** A parsed marker: its kind, the review ids in delivery order, and the text below it. */
export interface ReviewEnvelope {
  kind: ReviewEnvelopeKind;
  reviewIds: string[];
  /** Exactly the text the agent would have received without the marker. */
  rest: string;
}

/** Review ids are `randomUUID()` output: lowercase, hyphenated, ASCII. */
const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The whole first line. One id is `review=`, two or more are `reviews=`, comma-separated with
 * no spaces. Anything else - other spacing, a trailing character, a lone `reviews=` - is no
 * marker at all, so a near miss reads as the plain text it is.
 */
const MARKER = /^\[mission-control:(answer|remind-later) (review|reviews)=([0-9a-f,-]+)\]$/;

function validIds(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => REVIEW_ID.test(id)) && new Set(ids).size === ids.length;
}

/**
 * The marker line for these review ids, in delivery order, or null when any id is not a
 * review id (a hand-built fixture, say). Null leaves the message unmarked rather than writing
 * a line the parser would refuse.
 */
export function formatReviewEnvelope(kind: ReviewEnvelopeKind, reviewIds: readonly string[]): string | null {
  if (!REVIEW_ENVELOPE_KINDS.includes(kind) || !validIds(reviewIds)) return null;
  return reviewIds.length === 1
    ? `[mission-control:${kind} review=${reviewIds[0]}]`
    : `[mission-control:${kind} reviews=${reviewIds.join(",")}]`;
}

/**
 * The marker, a blank line, then the text. Returns the text unchanged when no marker can be
 * written for these ids.
 */
export function wrapReviewEnvelope(kind: ReviewEnvelopeKind, reviewIds: readonly string[], text: string): string {
  const line = formatReviewEnvelope(kind, reviewIds);
  return line === null ? text : `${line}\n\n${text}`;
}

/**
 * Read the marker off a message, or null when it has none.
 *
 * Valid only as the literal first line, followed by one blank line: a leading blank line or
 * leading whitespace means there is no marker. Only the exact grammar and review-shaped ids
 * are accepted, which also refuses any non-ASCII character on the line.
 */
export function parseReviewEnvelope(text: string): ReviewEnvelope | null {
  const end = text.indexOf("\n");
  if (end < 0 || text[end + 1] !== "\n") return null;
  const match = MARKER.exec(text.slice(0, end));
  if (!match) return null;
  const ids = match[3]!.split(",");
  // `review=` names exactly one, `reviews=` at least two.
  if ((match[2] === "review") !== (ids.length === 1) || !validIds(ids)) return null;
  return { kind: match[1] as ReviewEnvelopeKind, reviewIds: ids, rest: text.slice(end + 2) };
}
