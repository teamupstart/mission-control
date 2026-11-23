/**
 * Tour announcements this browser still owes after a midway dismissal.
 *
 * Dismissing Meet your residents before its last stop makes the next window's startup picker
 * feature it again. The debt is kept here, beside the UI cache, rather than by taking the tour
 * back off the daemon's `announcedTours`: that list is written whole, so a re-arm landing late
 * could undo another window's announcement and owe the tour twice. Nothing here is ever sent
 * anywhere. It is settled the moment a picker opening's own record write is saved, in any
 * window of this browser, or the tour is seen through.
 *
 * Every debt carries the sequence number it was owed at, and the store keeps the highest one it
 * has handed out. A picker opening captures that mark as its record write begins and settles
 * only debts owed at or before it, so a write still in flight when the operator starts the tour
 * and leaves it midway cannot clear that newer dismissal when it lands.
 *
 * Deliberately not a second source of truth for the preference: it can only ADD an owed
 * announcement on top of the daemon's record, never hide one, and an unreadable entry reads as
 * owing nothing.
 */

const STORAGE_KEY = "mission.tourAnnouncementsOwed";

interface OwedState {
  /** The highest sequence number handed out. Never reset, so an older mark stays older. */
  seq: number;
  /** Each owed tour id, with the sequence number it was owed at. */
  owed: Record<string, number>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A sandboxed frame throws on the property read itself.
    return null;
  }
}

const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readState(store: Storage | null): OwedState {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { seq: 0, owed: {} };
    }
    const { seq, owed } = parsed as { seq?: unknown; owed?: unknown };
    const entries = typeof owed === "object" && owed !== null && !Array.isArray(owed)
      ? Object.entries(owed).filter((entry): entry is [string, number] => entry[0] !== "" && isSeq(entry[1]))
      : [];
    const high = Math.max(isSeq(seq) ? seq : 0, ...entries.map(([, at]) => at));
    return { seq: high, owed: Object.fromEntries(entries) };
  } catch {
    return { seq: 0, owed: {} };
  }
}

function writeState(state: OwedState, store: Storage | null): void {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Full or forbidden storage: the debt is simply lost, which is the old behavior.
  }
}

/** The tour ids owed here, or none when nothing is stored or what is stored is unreadable. */
export function readOwedAnnouncements(store: Storage | null = storage()): string[] {
  return Object.keys(readState(store).owed);
}

/** The newest debt's sequence number: what a record write captures as it begins. */
export function owedAnnouncementsMark(store: Storage | null = storage()): number {
  return readState(store).seq;
}

/** Remember that this browser owes `id` its announcement. Returns the owed list now stored. */
export function oweAnnouncement(id: string, store: Storage | null = storage()): string[] {
  const state = readState(store);
  const seq = state.seq + 1;
  const next = { seq, owed: { ...state.owed, [id]: seq } };
  writeState(next, store);
  return Object.keys(next.owed);
}

/**
 * Settle `ids` that were owed at or before `upTo`: they were announced, or seen through. A debt
 * owed after `upTo` stays owed. Returns the owed list now stored.
 */
export function settleOwedAnnouncements(
  ids: readonly string[],
  store: Storage | null = storage(),
  upTo = Number.POSITIVE_INFINITY,
): string[] {
  const state = readState(store);
  const owed = Object.fromEntries(
    Object.entries(state.owed).filter(([id, at]) => !ids.includes(id) || at > upTo),
  );
  writeState({ seq: state.seq, owed }, store);
  return Object.keys(owed);
}
