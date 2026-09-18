import type { TourId } from "./contracts.ts";
import { RECOMMENDED_TOUR, TOUR_ENTRIES, type TourEntry } from "./entries.ts";
import { TOUR_DEFINITIONS } from "./definitions.ts";

export interface TourCatalogEntry extends TourEntry {
  stopCount: number;
  recommended: boolean;
}

/** Runtime definitions join discovery metadata only at the picker boundary. */
export function tourCatalog(
  entries: readonly TourEntry[] = TOUR_ENTRIES,
  recommended: TourId = RECOMMENDED_TOUR,
): TourCatalogEntry[] {
  const ordered = [
    ...entries.filter((entry) => entry.id === recommended),
    ...entries.filter((entry) => entry.id !== recommended),
  ];
  return ordered.map((entry) => ({
    ...entry,
    stopCount: TOUR_DEFINITIONS[entry.id].steps.length,
    recommended: entry.id === recommended,
  }));
}
