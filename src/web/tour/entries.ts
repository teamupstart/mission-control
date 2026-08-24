import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";
import { tourContent } from "./content.ts";
import type { TourId } from "./contracts.ts";

/**
 * What a tour looks like before it starts.
 *
 * Deliberately separate from the tour's `TourDefinition`: the Settings rail, the command
 * palette, and the palette's own hint text all need this metadata in modules that must stay
 * DOM-free and Driver-free, while a definition reaches for the registry, the runtime, and
 * driver.js. One entry per tour, read by every discovery surface, so adding a tour never
 * means adding a second list of rows somewhere.
 */
export interface TourEntry {
  id: TourId;
  /** The tour's name, as the kicker, the progress label, and both entry points say it. */
  title: string;
  /** The Settings rail's Help & tours row. */
  settings: {
    tooltip: string;
    ariaLabel: string;
    heading: string;
    hint: string;
  };
  /** The command palette's Do row. */
  palette: {
    rowId: string;
    title: string;
    detail: string;
    keywords: readonly string[];
    /** The preview line shown for the highlighted row. */
    hint: string;
  };
  /**
   * The route the tour opens on.
   *
   * App transitions here BEFORE it marks a tour active, so a dirty draft raises the existing
   * leave dialog while no tour is running and the ordinary route flow owns the answer.
   */
  entryRoute: MissionRoute;
}

const SEE_WORK_TITLE = tourContent("see-work").title;
const LIBRARY_TITLE = tourContent("library").title;

const SEE_WORK_ENTRY: TourEntry = {
  id: "see-work",
  title: SEE_WORK_TITLE,
  settings: {
    tooltip: "Tour the fleet, Board, and one session's work desk",
    ariaLabel: `Start ${SEE_WORK_TITLE} tour`,
    heading: SEE_WORK_TITLE,
    hint: "Start the guided tour",
  },
  palette: {
    rowId: "command:see-work-tour",
    title: `Start ${SEE_WORK_TITLE} tour`,
    detail: "Preview how the Fleet, Board, and one session desk fit together.",
    keywords: ["tour", "product tour", "onboarding", "fleet", "board", "session detail"],
    hint: "Start the temporary guided See the work comparison tour.",
  },
  entryRoute: { page: "fleet" },
};

const LIBRARY_ENTRY: TourEntry = {
  id: "library",
  title: LIBRARY_TITLE,
  settings: {
    tooltip: "Tour the Library: Personas, Actions, Commands, and the workflow that reviews",
    ariaLabel: `Start ${LIBRARY_TITLE} tour`,
    heading: LIBRARY_TITLE,
    hint: "Start the Library guided tour",
  },
  palette: {
    rowId: "command:library-tour",
    title: `Start ${LIBRARY_TITLE} tour`,
    detail: "Walk the Library - Personas, Actions, Commands - and the review that follows work.",
    keywords: [
      "tour",
      "product tour",
      "onboarding",
      "library",
      "persona",
      "action",
      "command",
      "workflow",
      "review",
      "no-mistakes",
    ],
    hint: "Start the guided Library authoring tour.",
  },
  // The shelves index, not a shelf: the tour's first stop is the page that names all six.
  entryRoute: { page: "library" },
};

/** Every tour Mission Control offers, in the order its entry points list them. */
export const TOUR_ENTRIES: readonly TourEntry[] = (() => {
  const entries = [SEE_WORK_ENTRY, LIBRARY_ENTRY];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`duplicate tour entry ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
})();

export function tourEntry(id: TourId): TourEntry {
  const entry = TOUR_ENTRIES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no such tour ${id}`);
  return entry;
}
