import type { TourDefinition, TourId } from "./contracts.ts";
import { LIBRARY_TOUR } from "./tours/library.ts";
import { SEE_WORK_TOUR } from "./tours/see-work.ts";

/**
 * Every runnable tour, by id.
 *
 * `Record<TourId, ...>` is the point: a new member of `TourId` fails to compile until it has
 * a definition here, so the engine can resolve any tour App decides to run without a branch
 * on a concrete one. The runtime and navigation types differ per tour, which is why this is
 * typed loosely at the boundary and precisely at each use site.
 */
export const TOUR_DEFINITIONS = {
  "see-work": SEE_WORK_TOUR,
  "library": LIBRARY_TOUR,
} as const satisfies Record<TourId, TourDefinition<never, never>>;

export type TourDefinitions = typeof TOUR_DEFINITIONS;
