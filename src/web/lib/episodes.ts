import type { ForemanEpisode, PendingTurn, ReviewItem } from "@shared/types.ts";
import { isConversationResolvedReview } from "@shared/review-item.ts";
import { isReviewMessageTurn, parseReviewEnvelope, type ReviewEnvelopeKind } from "@shared/review-message-envelope.ts";
import type { ReportItem } from "@shared/reports.ts";
import type { TranscriptRow } from "./tools.ts";

/**
 * The turn that carried a review message to the agent (`async-input`), when the card is drawn
 * there. Only a turn the daemon bound to its own recorded delivery carries the presentation
 * this is read from, so a pasted marker never becomes one.
 */
export interface ReviewRowDelivery {
  envelope: ReviewEnvelopeKind;
  /** The delivery turn's native id and time. */
  turnId: string;
  at: number;
  /** Exactly what the agent received, for "What the agent received" and find. */
  text: string;
  /**
   * The last card drawn for this turn. A message that carried several answers draws one card
   * each, and the text they shared is disclosed once, on the card the agent's reply follows.
   */
  last: boolean;
}

/**
 * A transcript row, or one of the things that happened ALONGSIDE the transcript and belong in
 * the same reading: a decision Foreman made about the session, an answer the human gave it, and
 * a question its agent filed and kept working past.
 *
 * - `asked`: a message-mode question (`async-input`), where it was filed. The agent's turn does
 *   not stop there, so without this the log would show the agent carrying on past a question it
 *   never appears to have asked. The entry also says how the question ended.
 * - `closed`: a question its agent waited on inside the call that a merge closed while it was
 *   snoozed or still pending. Drawn in place of its Snoozed entry, so the closure the operator's
 *   merge caused is said in the conversation whichever way the question waited.
 */
export type ConversationRow =
  | TranscriptRow
  | { kind: "episode"; ts: number; episode: ForemanEpisode }
  | {
      kind: "review";
      ts: number;
      review: ReviewItem;
      /** Drawn at the turn that delivered it, rather than where the operator answered. */
      delivery?: ReviewRowDelivery;
      /** Answered, and its message is still in the outbox: "On its way to the agent". */
      queued?: true;
    }
  | { kind: "asked"; ts: number; review: ReviewItem }
  | { kind: "closed"; ts: number; review: ReviewItem }
  /**
   * An agent report (`inbox` flag), where it was posted. Every version is an entry: a report
   * replaced later keeps its place here, saying it was replaced.
   */
  | { kind: "report"; ts: number; report: ReportItem }
  | {
      /**
       * A delivered review message naming a review this conversation cannot draw (one a database
       * restore predates, say). Still an answer card, never the raw text: the turn is the daemon's
       * own recorded delivery, and what the agent received stays one click away.
       */
      kind: "delivered";
      ts: number;
      reviewId: string;
      delivery: ReviewRowDelivery;
      /** The conversation's review history has not come back yet: the question may yet be found. */
      loading: boolean;
      /**
       * The history settled without being read in full (refused, or its retries ran out): the
       * question may still exist, so the card says it could not be loaded rather than that it is
       * no longer available.
       */
      unreadable: boolean;
    };

type ReviewEntry = Extract<ConversationRow, { kind: "review" | "asked" | "closed" }>;

/**
 * Where one review appears in the conversation: none, one or two entries.
 *
 * - A message-mode question gets its Asked entry at the moment it was filed, always.
 * - A human answer is the gold entry at `resolvedAt`, the moment the human spoke, never where
 *   the agent asked: a review left open across a long stretch of work would otherwise file the
 *   reply above everything the agent did while waiting for it.
 * - A snoozed question sits where the operator chose "Remind me later", the moment its agent
 *   was told to carry on (or, for a message-mode question, kept on carrying on).
 * - A call-mode question a merge closed is a closure entry where it was snoozed, or where the
 *   merge closed it if it never was. A message-mode one says so on its Asked entry instead.
 *
 * A stamp of zero cannot be placed and is returned with `ts: 0`, which the merge files last.
 */
export function reviewEntries(review: ReviewItem): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  if (review.waitMode === "message") entries.push({ kind: "asked", ts: review.createdAt, review });
  if (review.status === "snoozed") {
    entries.push({ kind: "review", ts: review.snooze?.at ?? 0, review });
  } else if (isConversationResolvedReview(review)) {
    entries.push({ kind: "review", ts: review.resolvedAt ?? 0, review });
  } else if (review.waitMode !== "message" && review.status === "orphaned" && review.closedReason === "merged") {
    entries.push({ kind: "closed", ts: review.snooze?.at ?? review.resolvedAt ?? 0, review });
  }
  return entries;
}

function precedesTranscript(row: ConversationRow, transcriptTs: number): boolean {
  if (row.ts !== transcriptTs) return row.ts < transcriptTs;
  return (
    row.ts > 0 && row.kind === "review" && row.review.createdAt === row.review.resolvedAt
  );
}

/**
 * Draw each delivered review message at its turn, once.
 *
 * A turn the daemon bound to its delivery (`presentation.kind === "review-message"`) becomes
 * one card per review it carried, in delivery order, keeping the turn's time and native id. A
 * review this conversation cannot draw still gets a card at that turn, so a delivered answer is
 * never shown as raw daemon text. What that card says follows the review history (`history`):
 * loading while it is in flight, unreadable once its reads were refused or failed through every
 * retry, and "no longer available" only once a read answered without the review. `delivered` collects
 * what was drawn here so the merge can drop those reviews' entries elsewhere. Returns the rows
 * unchanged, by reference, when no turn is a review message.
 */
function drawDeliveries(
  rows: TranscriptRow[],
  reviews: readonly ReviewItem[],
  delivered: { answer: Set<string>; "remind-later": Set<string> },
  history: ReviewHistory,
): TranscriptRow[] | ConversationRow[] {
  if (!rows.some((row) => row.kind === "turn" && row.message.presentation?.kind === "review-message")) return rows;
  // A question a runtime-transfer predecessor asked can be answered here; its own entries stay
  // in its conversation, so it is looked up for the card and nothing else.
  const byId = new Map([...(history.lineage ?? []), ...reviews].map((review) => [review.id, review]));
  const out: ConversationRow[] = [];
  for (const row of rows) {
    const presentation = row.kind === "turn" ? row.message.presentation : undefined;
    if (row.kind !== "turn" || presentation?.kind !== "review-message") {
      out.push(row);
      continue;
    }
    presentation.reviewIds.forEach((id, i) => {
      const delivery: ReviewRowDelivery = {
        envelope: presentation.envelope,
        turnId: row.message.id,
        at: row.message.ts,
        text: row.message.text,
        last: i === presentation.reviewIds.length - 1,
      };
      const review = byId.get(id);
      if (!review) {
        const loading = history.loaded === false;
        out.push({ kind: "delivered", ts: row.ts, reviewId: id, delivery, loading, unreadable: !loading && history.failed === true });
        return;
      }
      delivered[presentation.envelope].add(review.id);
      out.push({ kind: "review", ts: row.ts, review, delivery });
    });
  }
  return out;
}

/**
 * What is known of the conversation's review history beyond the entries themselves. `loaded`
 * false means the durable read is still in flight, so a delivered answer whose review is not in
 * hand is drawn as loading rather than as gone. `failed` means it settled without a full read (a
 * source refused, or its retries ran out), so such an answer is drawn as unreadable: "no longer
 * available" is reserved for a read that answered. `lineage` adds reviews a runtime-transfer predecessor asked, for drawing
 * a delivered answer only.
 */
export interface ReviewHistory {
  loaded?: boolean;
  failed?: boolean;
  lineage?: readonly ReviewItem[];
}

/**
 * The reviews whose answer is still queued in this session's outbox, from the marker of each row
 * the daemon wrote about a review. An operator's queued message is never read, whatever it says.
 */
export function queuedAnswerIds(pendingTurns: readonly PendingTurn[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of pendingTurns) {
    if (!isReviewMessageTurn(turn)) continue;
    const envelope = parseReviewEnvelope(turn.text);
    if (envelope?.kind === "answer") for (const id of envelope.reviewIds) ids.add(id);
  }
  return ids;
}

/**
 * Interleave the out-of-band entries into the transcript by time.
 *
 * Both kinds speak about a session from outside it, and neither is in the JSONL. Foreman's
 * decisions never will be, because the thing it most often answers - a blocked permission
 * prompt - is precisely what has NOT yet been written to the transcript. The human's review
 * answers never will be either: they reach the agent as an MCP tool result, and a user turn
 * that is purely a tool result is dropped by every harness parser as machine noise (see
 * `harness/claude/transcript.ts`). So all three streams are merged at render time rather
 * than joined at the source.
 *
 * Stable by construction: the extras are placed relative to turns by timestamp, and ties
 * normally keep the transcript turn first. A tie is not hypothetical - Foreman answers
 * within seconds of the turn that provoked it, and second-resolution timestamps collide -
 * and putting the extra first there would show a reply above the message it replies to.
 * The exception is a review born settled (`createdAt === resolvedAt`). Those are native SDK
 * question answers stamped immediately before the driver resumes, so a same-millisecond
 * assistant turn is the reply they released and belongs below them.
 *
 * An entry with no usable timestamp sorts to the END rather than the beginning. Zero is what
 * a missing time reads as, so the naive ordering would file the one entry we know least
 * about at the very top of the conversation, above turns that definitely preceded it.
 */
export function mergeConversation(
  transcript: TranscriptRow[],
  episodes: ForemanEpisode[],
  reviews: ReviewItem[] = [],
  pendingTurns: readonly PendingTurn[] = [],
  history: ReviewHistory = {},
  reports: readonly ReportItem[] = [],
): ConversationRow[] {
  // A delivered review message is drawn at the turn the agent received it, and only there: an
  // answer's entry at `resolvedAt` and a snooze's at `snooze.at` give way to it. An answer
  // still in the outbox stays at `resolvedAt`, saying it is on its way. A call-mode answer its
  // call returned has neither, and is placed exactly as before. Drawn before the early return,
  // so a delivered turn is a card even in a conversation with no reviews to show.
  const delivered = { answer: new Set<string>(), "remind-later": new Set<string>() };
  const rows: ConversationRow[] = drawDeliveries(transcript, reviews, delivered, history);
  if (episodes.length === 0 && reviews.length === 0 && reports.length === 0) return rows;
  const queued = queuedAnswerIds(pendingTurns);

  const dated: ConversationRow[] = [];
  const undated: ConversationRow[] = [];
  for (const e of episodes) {
    (e.createdAt > 0 ? dated : undated).push({ kind: "episode", ts: e.createdAt, episode: e });
  }
  for (const r of reviews) {
    // See `reviewEntries` for where each entry is placed and why.
    for (const entry of reviewEntries(r)) {
      if (entry.kind === "review") {
        const snoozedEntry = r.status === "snoozed";
        if (delivered[snoozedEntry ? "remind-later" : "answer"].has(r.id)) continue;
        if (!snoozedEntry && queued.has(r.id)) {
          (entry.ts > 0 ? dated : undated).push({ ...entry, queued: true });
          continue;
        }
      }
      (entry.ts > 0 ? dated : undated).push(entry);
    }
  }
  for (const report of reports) {
    (report.createdAt > 0 ? dated : undated).push({ kind: "report", ts: report.createdAt, report });
  }
  // The episodes API hands its rows back newest-first (the drawer's order) and the reviews
  // API oldest-first, and the two are now interleaved with each other as well as with the
  // transcript - so the combined list is sorted here rather than relying on either
  // endpoint's order. Sorted once, since the drawer and this read the same fetch.
  dated.sort((a, b) => a.ts - b.ts);

  // Merged rather than concat-and-sorted so the transcript's own order is preserved exactly
  // as it arrived. Turns can share a timestamp (or carry none at all, which reads as 0), and
  // a comparison sort would be free to reorder those against each other - reshuffling the
  // conversation around the entries being added to it.
  const out: ConversationRow[] = [];
  let i = 0;
  for (const row of rows) {
    // Entries sharing a turn's timestamp normally follow it. A driver-question answer is
    // recorded born settled after delivery succeeds, but its timestamp is deliberately
    // taken before delivery. If the released assistant turn is written in that same
    // millisecond, keep the answer above the reply it caused.
    while (i < dated.length && precedesTranscript(dated[i]!, row.ts)) {
      out.push(dated[i++]!);
    }
    out.push(row);
  }
  while (i < dated.length) out.push(dated[i++]!);
  return [...out, ...undated];
}
