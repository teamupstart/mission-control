import type { ForemanEpisode, ReviewItem } from "@shared/types.ts";
import { isConversationResolvedReview } from "@shared/review-item.ts";
import type { TranscriptRow } from "./tools.ts";

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
  | { kind: "review"; ts: number; review: ReviewItem }
  | { kind: "asked"; ts: number; review: ReviewItem }
  | { kind: "closed"; ts: number; review: ReviewItem };

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
  rows: TranscriptRow[],
  episodes: ForemanEpisode[],
  reviews: ReviewItem[] = [],
): ConversationRow[] {
  if (episodes.length === 0 && reviews.length === 0) return rows;

  const dated: ConversationRow[] = [];
  const undated: ConversationRow[] = [];
  for (const e of episodes) {
    (e.createdAt > 0 ? dated : undated).push({ kind: "episode", ts: e.createdAt, episode: e });
  }
  for (const r of reviews) {
    // See `reviewEntries` for where each entry is placed and why.
    for (const entry of reviewEntries(r)) (entry.ts > 0 ? dated : undated).push(entry);
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
