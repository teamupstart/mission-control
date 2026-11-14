/**
 * Tour announcements this browser still owes, when the daemon could not be told.
 *
 * Dismissing Meet your residents midway gives its announcement back by removing it from the
 * daemon's `announcedTours`. When that write is refused, the daemon's record still reads the
 * tour as seen, and nothing in it can bring the tour back - so the debt is kept here, beside the
 * UI cache, and the next window on this dashboard features the tour anyway. It is settled the
 * moment a picker opening's own record write lands, or the tour is seen through.
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
