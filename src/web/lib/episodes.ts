import type { ForemanEpisode, ReviewItem } from "@shared/types.ts";
import type { TranscriptRow } from "./tools.ts";

/**
 * A transcript row, or one of the two things that happened ALONGSIDE the transcript and
 * belong in the same reading: a decision Foreman made about the session, and an answer the
 * human gave it.
 */
export type ConversationRow =
  | TranscriptRow
  | { kind: "episode"; ts: number; episode: ForemanEpisode }
  | { kind: "review"; ts: number; review: ReviewItem };

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
 * keep the transcript turn first. A tie is not hypothetical - Foreman answers within
 * seconds of the turn that provoked it, and second-resolution timestamps collide - and
 * putting the extra first there would show a reply above the message it replies to.
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
    // `resolvedAt` and not `createdAt`: the entry is the ANSWER, so it belongs where the
    // human spoke, not where the agent asked. A review left open across a long stretch of
    // work would otherwise file your reply above everything the agent did while waiting
    // for it. A resolved review without a stamp cannot be placed at all and goes to the end.
    const ts = r.resolvedAt ?? 0;
    (ts > 0 ? dated : undated).push({ kind: "review", ts, review: r });
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
    // Strictly less-than, so an entry sharing a turn's timestamp follows it.
    while (i < dated.length && dated[i]!.ts < row.ts) out.push(dated[i++]!);
    out.push(row);
  }
  while (i < dated.length) out.push(dated[i++]!);
  return [...out, ...undated];
}
