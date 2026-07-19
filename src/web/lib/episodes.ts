import type { ForemanEpisode } from "@shared/types.ts";
import type { TranscriptRow } from "./tools.ts";

/** A transcript row, or one of Foreman's decisions placed among them. */
export type ConversationRow = TranscriptRow | { kind: "episode"; ts: number; episode: ForemanEpisode };

/**
 * Interleave Foreman's episodes into the transcript by time.
 *
 * Foreman speaks about a session from outside it: its decisions are not turns in the
 * JSONL and never will be, because the thing it most often answers - a blocked
 * permission prompt - is precisely what has NOT yet been written to the transcript.
 * So the two streams are merged at render time rather than joined at the source.
 *
 * Stable by construction: episodes are placed relative to turns by timestamp, and
 * ties keep the transcript turn first. A tie is not hypothetical - Foreman answers
 * within seconds of the turn that provoked it, and second-resolution timestamps
 * collide - and putting the episode first there would show Foreman replying to a
 * message that appears below its reply.
 *
 * An episode with no usable timestamp sorts to the END rather than the beginning.
 * Zero is what a missing time reads as, so the naive ordering would file the one
 * episode we know least about at the very top of the conversation, above turns that
 * definitely preceded it.
 */
export function mergeEpisodes(
  rows: TranscriptRow[],
  episodes: ForemanEpisode[],
): ConversationRow[] {
  if (episodes.length === 0) return rows;

  const dated: ConversationRow[] = [];
  const undated: ConversationRow[] = [];
  for (const e of episodes) {
    (e.createdAt > 0 ? dated : undated).push({ kind: "episode", ts: e.createdAt, episode: e });
  }
  // The API hands these back newest-first (the drawer's order); the walk below needs
  // oldest-first. Sorted here rather than asked for twice, since the drawer and this
  // read the same fetch.
  dated.sort((a, b) => a.ts - b.ts);

  // Merged rather than concat-and-sorted so the transcript's own order is preserved
  // exactly as it arrived. Turns can share a timestamp (or carry none at all, which
  // reads as 0), and a comparison sort would be free to reorder those against each
  // other - reshuffling the conversation around the episodes being added to it.
  const out: ConversationRow[] = [];
  let i = 0;
  for (const row of rows) {
    // Strictly less-than, so an episode sharing a turn's timestamp follows it.
    while (i < dated.length && dated[i]!.ts < row.ts) out.push(dated[i++]!);
    out.push(row);
  }
  while (i < dated.length) out.push(dated[i++]!);
  return [...out, ...undated];
}
