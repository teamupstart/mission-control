import type { TranscriptMessage } from "@shared/types.ts";

/**
 * Conversation history that has been scrolled back to, parked outside the React tree and
 * keyed by session.
 *
 * The panel's stream opens on a bounded tail - the most recent turns and no more - and
 * for a long session that is a small slice of a file that still holds everything. Paging
 * back (`?before=`) is what makes the rest reachable; this is what stops the reader
 * paying for it twice.
 *
 * It is a module-level map for the reason `drafts.ts` is one: the thing it protects has
 * to outlive mounts that end under it, and every one of those endings is routine. The
 * conversation panel unmounts when you switch to the Diff tab, when a card collapses,
 * and when you select another session - and its `EventSource` re-opens (replacing the
 * view with a fresh tail) on every transient drop and every daemon restart. Three
 * hundred turns of scroll-back, gone to a tab click.
 *
 * Nothing renders FROM this map; the panel hydrates from it on mount and writes through.
 * Its scope is honestly the tab, the same deal drafts make: a reload starts over.
 *
 * **Ranges are bytes, and they abut exactly.** A page records the byte range it was read
 * from so the next read back can be anchored to its `start`, leaving no gap (a turn
 * silently missing from the middle) and no overlap. Overlap is the sharper failure: a
 * harness whose records carry no id synthesizes one per parse batch, so two overlapping
 * reads de-dupe against nothing and the same turn renders twice. Nothing here merges by
 * id across pages for that reason - adjacency is what keeps the seam clean.
 */

/** A contiguous run of turns and the byte range it came from. */
export interface HistoryPage {
  /** Byte offset of the first turn - the anchor for the next page back. */
  start: number;
  /** Byte offset just past the last turn. */
  end: number;
  messages: TranscriptMessage[];
}

/**
 * One session's accumulated conversation.
 *
 * Split into `older` and `tail` because the two are learned differently and only one of
 * them is stable. `tail` is whatever the live stream last opened on plus everything it
 * has appended since, so it is re-stated in full on every reconnect. `older` is what the
 * reader explicitly scrolled back to, and nothing but another page-back changes it.
 */
export interface SessionHistory {
  /** Pages older than `tailStart`, ascending and contiguous; `older[i].end === older[i+1].start`. */
  older: HistoryPage[];
  /** Byte offset the live tail window began at - the anchor the next page back uses. */
  tailStart: number;
  /** The live window: the stream's opening turns plus everything appended since. */
  tail: TranscriptMessage[];
  /**
   * Byte offset the live window has been read up to.
   *
   * What a reconnect hands back as `?from=`, so the stream continues this history instead
   * of re-anchoring a fresh window at the current end of the file. Without it a reconnect
   * had to re-seed, and re-seeding drops the scrollback whenever the agent wrote anything
   * meanwhile - which, on a session that is working, is always.
   */
  tailEnd: number;
  /** True when the oldest page held is as far back as the file goes. */
  atStart: boolean;
}

/**
 * How many sessions' histories to keep.
 *
 * A full scroll-back runs to a few hundred kilobytes, so this is a memory bound rather
 * than a correctness one - evicting is only ever a re-fetch. Small because the reader is
 * one person: the sessions whose history they still care about are the handful they have
 * been clicking between.
 */
const MAX_SESSIONS = 8;

/** Insertion-ordered, so the oldest key is the least recently seeded. */
const histories = new Map<string, SessionHistory>();

/** What this session has accumulated, or null when nothing has been read yet. */
export function readHistory(sessionId: string): SessionHistory | null {
  return histories.get(sessionId) ?? null;
}

function store(sessionId: string, h: SessionHistory): SessionHistory {
  // Re-insert so the key moves to the end and eviction stays least-recently-used.
  histories.delete(sessionId);
  histories.set(sessionId, h);
  while (histories.size > MAX_SESSIONS) {
    const oldest = histories.keys().next();
    if (oldest.done) break;
    histories.delete(oldest.value);
  }
  return h;
}

/** Every turn held, oldest first - what the panel renders. */
export function flattenHistory(h: SessionHistory | null): TranscriptMessage[] {
  if (!h) return [];
  const out: TranscriptMessage[] = [];
  for (const p of h.older) out.push(...p.messages);
  out.push(...h.tail);
  return out;
}

/** The offset the next page back is read from, or null when there is nothing older. */
export function backAnchor(h: SessionHistory | null): number | null {
  if (!h || h.atStart) return null;
  const oldest = h.older.length > 0 ? h.older[0]!.start : h.tailStart;
  return oldest > 0 ? oldest : null;
}

/**
 * Take a fresh `init` window from the stream, keeping scroll-back that still fits above
 * it.
 *
 * This is the START-OVER path, not the reconnect path. A reconnect hands the stream
 * `?from=` and gets a `resume`, which leaves the anchor and every held page exactly where
 * they were - see `resumeTail`. Re-seeding through here happens on a first connect, after
 * a reset, and when the server REFUSES to resume: the file was cleared or rotated, or
 * more was written than a reconnect can honestly claim to have missed.
 *
 * That refusal is what makes the strict test below the right one. A held page survives
 * only when it still abuts the new window exactly; the tail anchor only ever moves
 * FORWARD (the file is append-only, so the "last N turns" boundary advances), so held
 * pages are never too new - they are either flush against the new window or separated
 * from it by turns written while we were away. That gap is the one thing this cannot
 * paper over: rendering across it would put two non-adjacent turns side by side and show
 * nothing to say so. Dropping is recoverable and silently lying is not, and scrolling up
 * re-reads the dropped span anyway.
 *
 * Before `resume` existed this ran on every reconnect, and the strictness was a bug
 * rather than a safeguard: a single turn written during a blip slid `init.start` forward
 * and cost the reader every page they had scrolled back to, with no gap that could not
 * have been bridged.
 */
export function seedTail(
  sessionId: string,
  init: { messages: TranscriptMessage[]; start: number; atStart: boolean; pos: number },
): SessionHistory {
  const prev = histories.get(sessionId);
  const newest = prev?.older[prev.older.length - 1];
  const abuts = prev
    ? newest
      ? newest.end === init.start
      : prev.tailStart === init.start
    : false;
  if (prev && abuts) {
    return store(sessionId, {
      older: prev.older,
      tailStart: init.start,
      tail: init.messages,
      tailEnd: init.pos,
      // `atStart` describes the OLDEST page held, which this window is not when pages
      // survived above it - taking the stream's answer here would claim the file starts
      // at a turn the reader has already scrolled past.
      atStart: prev.older.length > 0 ? prev.atStart : init.atStart,
    });
  }
  return store(sessionId, {
    older: [],
    tailStart: init.start,
    tail: init.messages,
    tailEnd: init.pos,
    atStart: init.atStart,
  });
}

/**
 * The offset a reconnect should ask the stream to continue from, or null when there is
 * nothing to continue.
 */
export function resumeAnchor(sessionId: string): number | null {
  const held = histories.get(sessionId);
  return held ? held.tailEnd : null;
}

/**
 * Extend the live window with the turns a reconnect reported as missed.
 *
 * The counterpart to `seedTail`, and the reason a dropped connection is now free: the
 * reader keeps every page it had, the anchor does not move, and only genuinely new turns
 * arrive. Returns null when nothing is held for this session, which is the caller's cue
 * that the stream should have been asked for a fresh window instead.
 */
export function resumeTail(
  sessionId: string,
  resumed: { messages: TranscriptMessage[]; pos: number },
): SessionHistory | null {
  const prev = histories.get(sessionId);
  if (!prev) return null;
  const seen = new Set(prev.tail.map((m) => m.id));
  const add = resumed.messages.filter((m) => !seen.has(m.id));
  return store(sessionId, {
    ...prev,
    tail: add.length ? [...prev.tail, ...add] : prev.tail,
    // Advance even when nothing new parsed: the bytes were still consumed, and leaving
    // the anchor behind would make the next reconnect re-request a range already read.
    tailEnd: Math.max(prev.tailEnd, resumed.pos),
  });
}

/**
 * Add a page of older turns fetched by scrolling up.
 *
 * Refuses a page that does not end exactly where the held history begins. That can only
 * happen if the file was rewritten under a request already in flight, and the two
 * plausible alternatives are both worse than dropping it: splicing it in regardless
 * invents an adjacency, and re-anchoring to it discards everything below.
 */
export function prependPage(sessionId: string, page: HistoryPage & { atStart: boolean }): SessionHistory | null {
  const prev = histories.get(sessionId);
  if (!prev) return null;
  const anchor = prev.older.length > 0 ? prev.older[0]!.start : prev.tailStart;
  if (page.end !== anchor) return null;
  // A page can legitimately render nothing - a long stretch of pure tool output holds no
  // turn - and it still moved the anchor, so it is kept as an empty range rather than
  // dropped. Dropping it would leave the anchor where it was and the next scroll would
  // ask the same question forever.
  return store(sessionId, {
    ...prev,
    older: [{ start: page.start, end: page.end, messages: page.messages }, ...prev.older],
    atStart: page.atStart,
  });
}

/** Extend the live window with turns the stream just appended. */
export function appendLive(
  sessionId: string,
  messages: TranscriptMessage[],
  pos?: number,
): SessionHistory | null {
  const prev = histories.get(sessionId);
  if (!prev) return null;
  const seen = new Set(prev.tail.map((m) => m.id));
  const add = messages.filter((m) => !seen.has(m.id));
  const tailEnd = pos === undefined ? prev.tailEnd : Math.max(prev.tailEnd, pos);
  if (add.length === 0 && tailEnd === prev.tailEnd) return prev;
  return store(sessionId, {
    ...prev,
    tail: add.length ? [...prev.tail, ...add] : prev.tail,
    tailEnd,
  });
}

/**
 * Forget one session's history, because that session is gone for good.
 *
 * Driven by `session_remove` for the reason `dropSessionDrafts` documents at length: it
 * is the only positive "this one is gone" signal, and inferring departure from absence
 * wipes live state every time the fleet rebuilds after a daemon restart.
 */
export function dropHistory(sessionId: string): void {
  histories.delete(sessionId);
}

/** Test seam: forget everything. Never called by the app. */
export function resetHistories(): void {
  histories.clear();
}
