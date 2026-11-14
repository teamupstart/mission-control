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
 * Deliberately not a second source of truth for the preference: it can only ADD an owed
 * announcement on top of the daemon's record, never hide one, and an unreadable entry reads as
 * owing nothing.
 */

const STORAGE_KEY = "mission.tourAnnouncementsOwed";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A sandboxed frame throws on the property read itself.
    return null;
  }
}

/** The tour ids owed here, or none when nothing is stored or what is stored is unreadable. */
export function readOwedAnnouncements(store: Storage | null = storage()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === "string" && id !== ""))]
      : [];
  } catch {
    return [];
  }
}

function write(ids: readonly string[], store: Storage | null): void {
  try {
    if (ids.length === 0) store?.removeItem(STORAGE_KEY);
    else store?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Full or forbidden storage: the debt is simply lost, which is the old behavior.
  }
}

/** Remember that this browser owes `id` its announcement. Returns the owed list now stored. */
export function oweAnnouncement(id: string, store: Storage | null = storage()): string[] {
  const owed = [...new Set([...readOwedAnnouncements(store), id])];
  write(owed, store);
  return owed;
}

/** Settle `ids`: they were announced, or seen through. Returns the owed list now stored. */
export function settleOwedAnnouncements(
  ids: readonly string[],
  store: Storage | null = storage(),
): string[] {
  const owed = readOwedAnnouncements(store).filter((id) => !ids.includes(id));
  write(owed, store);
  return owed;
}
