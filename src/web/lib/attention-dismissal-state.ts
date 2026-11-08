import type {
  AttentionDismissal,
  AttentionDismissalKey,
  AttentionDismissalWrite,
} from "@shared/protocol.ts";

/**
 * The dashboard's copy of the attention-inbox dismissals, and the one rule that keeps a
 * dismissal from coming back while requests overlap.
 *
 * THE RULE: only a READ may replace the stored set, and reads apply in the order they were
 * started. A write's own answer never replaces it. An earlier cut did exactly that - each
 * dismissal's response carried the whole stored set and became the new copy - so two quick
 * dismissals A then B whose answers arrived B then A ended with A's older snapshot, which
 * predates B, and B came back although the daemon had stored it. Nothing could repair that: the
 * change events that would have prompted a fresh read had already been answered.
 *
 * So this window's own dismissals live in `pending` beside the stored copy, and each stays
 * there until a read that STARTED after the daemon acknowledged it has been applied. Such a
 * read was answered by a daemon that already held the write, so the stored copy now carries it
 * and the overlay entry can go. A read that started earlier - in flight across the write, or
 * answered out of order - can replace the stored copy without it, and the overlay still hides
 * the row. A refused write leaves the overlay at once, which is what brings its row back.
 *
 * And the daemon keeps whichever write of a row it stores LAST, so writes of one row must reach
 * it in the order they were made: `createDismissalWriteQueue` holds a row's dismissal until that
 * row's earlier one has been answered. Without that, dismissing a row, watching it come back
 * because it now reports something new, and dismissing it again could let the first, delayed
 * write land last and overwrite the second - after which the next read showed the newer problem
 * again, though the operator had dismissed it.
 *
 * That queue cannot see another WINDOW's writes, so the daemon also refuses a stale write: each
 * one carries a basis, and a write behind the stored revision was made without seeing a newer
 * dismissal. Its row comes back in this window with the reason, as any refusal does, and the
 * newer dismissal stands. The basis is what this window had seen WHEN THE OPERATOR CLICKED,
 * raised only by this window's own earlier writes (`createDismissalSender`) - never by what it
 * learned from other windows while the write waited in the queue, which would let an older
 * click pass for a newer one.
 *
 * Pure and separate from the hook so the orderings can be driven one event at a time in a test.
 */

/** One of this window's dismissals that the stored copy may not show yet. */
interface PendingDismissal {
  occurrence: string;
  /** Which write sent it; a later write of the same row supersedes it. */
  write: number;
  /**
   * How many reads had been STARTED when the daemon acknowledged the write, or null while it is
   * unanswered. A read numbered above this began after the write was stored.
   */
  readsStartedAtAck: number | null;
}

export interface AttentionDismissalState {
  /** The stored set as of the newest read applied: item id to occurrence. */
  stored: ReadonlyMap<string, string>;
  /** This window's dismissals not yet confirmed by a later read. */
  pending: ReadonlyMap<string, PendingDismissal>;
  /** The number of the newest read applied, 0 before any. Reads number from 1 as they start. */
  appliedRead: number;
}

export const INITIAL_DISMISSAL_STATE: AttentionDismissalState = {
  stored: new Map(),
  pending: new Map(),
  appliedRead: 0,
};

/** The row is hidden from the moment the operator clicks. */
export function beginDismissalWrite(
  state: AttentionDismissalState,
  keys: readonly AttentionDismissalKey[],
  write: number,
): AttentionDismissalState {
  const pending = new Map(state.pending);
  for (const key of keys) pending.set(key.itemId, { occurrence: key.occurrence, write, readsStartedAtAck: null });
  return { ...state, pending };
}

/**
 * The daemon answered `write`. Refused: its rows come back now. Stored: they stay hidden until a
 * read numbered above `readsStarted` - the count of reads started when this answer arrived - is
 * applied. Entries a later write of the same row has replaced are left to that write.
 */
export function settleDismissalWrite(
  state: AttentionDismissalState,
  keys: readonly AttentionDismissalKey[],
  write: number,
  stored: boolean,
  readsStarted: number,
): AttentionDismissalState {
  const pending = new Map(state.pending);
  for (const key of keys) {
    const entry = pending.get(key.itemId);
    if (!entry || entry.write !== write) continue;
    if (stored) pending.set(key.itemId, { ...entry, readsStartedAtAck: readsStarted });
    else pending.delete(key.itemId);
  }
  return { ...state, pending };
}

/**
 * Read number `read` answered with `dismissals`. Ignored when a newer read has already been
 * applied - an older answer describes the set as it was before. Otherwise it becomes the stored
 * copy, and every pending dismissal it is guaranteed to include leaves the overlay.
 */
export function applyDismissalRead(
  state: AttentionDismissalState,
  read: number,
  dismissals: readonly AttentionDismissal[],
): AttentionDismissalState {
  if (read <= state.appliedRead) return state;
  const pending = new Map(state.pending);
  for (const [itemId, entry] of pending) {
    if (entry.readsStartedAtAck !== null && entry.readsStartedAtAck < read) pending.delete(itemId);
  }
  return {
    stored: new Map(dismissals.map((entry) => [entry.itemId, entry.occurrence])),
    pending,
    appliedRead: read,
  };
}

/** What the fold filters on: the stored copy, with this window's own dismissals on top. */
export function effectiveDismissals(state: AttentionDismissalState): ReadonlyMap<string, string> {
  if (state.pending.size === 0) return state.stored;
  const merged = new Map(state.stored);
  for (const [itemId, entry] of state.pending) merged.set(itemId, entry.occurrence);
  return merged;
}

/**
 * Send dismissals so that every row's writes reach the daemon in the order they were made.
 *
 * Each write waits until every earlier write naming any of the same rows has been answered -
 * stored, refused or failed alike, since the later click is the operator's newer decision either
 * way - and is sent at once when none is outstanding. Writes of different rows never wait for
 * each other. Returns `send`'s own answer.
 */
export function createDismissalWriteQueue<Key extends { itemId: string }, Answer>(
  send: (keys: readonly Key[]) => Promise<Answer>,
): (keys: readonly Key[]) => Promise<Answer> {
  /** The newest write of each row that has not been answered yet. */
  const outstanding = new Map<string, Promise<unknown>>();
  return (keys) => {
    const earlier = new Set<Promise<unknown>>();
    for (const key of keys) {
      const write = outstanding.get(key.itemId);
      if (write) earlier.add(write);
    }
    const sent = Promise.allSettled(earlier).then(() => send(keys));
    for (const key of keys) outstanding.set(key.itemId, sent);
    const forget = (): void => {
      for (const key of keys) if (outstanding.get(key.itemId) === sent) outstanding.delete(key.itemId);
    };
    sent.then(forget, forget);
    return sent;
  };
}

/**
 * The newest daemon revision of each row this window has seen - in a read, or in the answer to
 * one of its own writes - which is the `basis` every write of that row is sent with.
 *
 * Only ever raised, never lowered: revisions are the daemon's AUTOINCREMENT, so a larger one is
 * always the later write, and a read that started before this window's own write was stored
 * (and so carries an older revision, or none) must not make its next write look stale.
 */
export interface RevisionLedger {
  learn(rows: readonly { itemId: string; revision: number }[]): void;
  /** The basis to send with a write of this row: 0 when this window has seen none. */
  basisFor(itemId: string): number;
}

export function createRevisionLedger(): RevisionLedger {
  const newest = new Map<string, number>();
  return {
    learn(rows) {
      for (const row of rows) newest.set(row.itemId, Math.max(newest.get(row.itemId) ?? 0, row.revision));
    },
    basisFor: (itemId) => newest.get(itemId) ?? 0,
  };
}

/** What a dismissal write's answer must carry for the sender to learn from it. */
interface DismissalWriteAnswer {
  ok: boolean;
  accepted?: readonly { itemId: string; revision: number }[];
}

/**
 * Send this window's dismissals, each with the basis that makes the daemon's ordering honest.
 *
 * A write's basis is fixed from two facts and nothing else:
 *
 *  - the newest revision of its row this window had seen AT THE CLICK (`seen`, read when the
 *    returned function is called); and
 *  - the revision this window's own earlier write of that row was stored at, if one was - read
 *    when the write is sent, because the queue holds it until that earlier write is answered.
 *
 * The larger of the two. Revisions `seen` learns from OTHER windows while a write waits in the
 * queue are deliberately left out: the operator clicked before those dismissals existed, so the
 * click is the older decision, and a basis raised to cover them would let the daemon accept it
 * over a newer one. The window's own preceding write is the one later revision it may claim -
 * leaving it out would refuse a window's second dismissal of a row because of its first.
 *
 * Writes go through `createDismissalWriteQueue`, so a row's writes reach the daemon in click
 * order. Accepted revisions are taught to both the window's own ledger and to `seen`.
 */
export function createDismissalSender<Answer extends DismissalWriteAnswer>(
  post: (writes: readonly AttentionDismissalWrite[]) => Promise<Answer>,
  seen: RevisionLedger,
): (keys: readonly AttentionDismissalKey[]) => Promise<Answer> {
  /** Revisions this window's own writes were stored at, and nothing else. */
  const own = createRevisionLedger();
  type Stamped = AttentionDismissalKey & { seenAtClick: number };
  const enqueue = createDismissalWriteQueue<Stamped, Answer>(async (stamped) => {
    const answer = await post(
      stamped.map(({ itemId, occurrence, seenAtClick }) => ({
        itemId,
        occurrence,
        basis: Math.max(seenAtClick, own.basisFor(itemId)),
      })),
    );
    if (answer.ok && answer.accepted) {
      own.learn(answer.accepted);
      seen.learn(answer.accepted);
    }
    return answer;
  });
  return (keys) => enqueue(keys.map((key) => ({ ...key, seenAtClick: seen.basisFor(key.itemId) })));
}

/**
 * How long to wait before retrying the first read of the dismissals after `failures` failed
 * ones: half a second, doubling, never more than fifteen. Until that read succeeds the inbox
 * is held empty, so it is retried rather than left for some later event to ask again - and
 * never hammered, because a local daemon that answers at all answers in milliseconds.
 */
export function firstReadRetryDelay(failures: number): number {
  return Math.min(500 * 2 ** failures, 15_000);
}
