import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";
import { tourContent } from "./content.ts";
import type { TourId } from "./contracts.ts";
import type { TourTargetId } from "./target-registry.ts";

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
  /**
   * Where the tour LEAVES the operator, when handing a page over is the point of it.
   *
   * Omitted by a tour that only demonstrates, and therefore owes back the page, asset, and
   * control it borrowed. Declared by one whose last stop is somewhere to start working: Set
   * up this machine ends on Trust because granting the repositories you work in is the next
   * thing to do once the tools are installed, and replaying the snapshot would take that
   * page away again.
   *
   * Everything else in the snapshot - layout, selection, Board drill-in, filter, the open
   * Line drawer - is still restored either way. This replaces the route alone.
   *
   * `focus` is the control to land on when the invoking one did not survive the move. The
   * automatic first-run tour has no invoker at all, and a keyboard operator would otherwise
   * be left at the document root on a page they did not ask for.
   */
  exit?: { route: MissionRoute; focus: TourTargetId };
}

const SEE_WORK_TITLE = tourContent("see-work").title;
const LIBRARY_TITLE = tourContent("library").title;
const SETUP_TITLE = tourContent("setup").title;

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

const SETUP_ENTRY: TourEntry = {
  id: "setup",
  title: SETUP_TITLE,
  settings: {
    tooltip: "Find Setup from the gear, install what you will use, then grant repos in Trust",
    ariaLabel: `Start ${SETUP_TITLE} tour`,
    heading: SETUP_TITLE,
    // Short enough not to ellipsize in the rail row that draws it.
    hint: "Setup, then Trust",
  },
  palette: {
    rowId: "command:setup-tour",
    title: `Start ${SETUP_TITLE} tour`,
    detail:
      "Seven stops: the gear, Setup in the rail, what to install, Re-check, then Trust and "
      + "the repositories it grants.",
    keywords: [
      "tour",
      "onboarding",
      "setup",
      "machine",
      "dependencies",
      "install",
      "github",
      "terminal",
      // The second half of the tour, so the words an operator would search for to reach the
      // grant matrix start this tour as well as opening that category.
      "trust",
      "grant",
      "allowlist",
      "repository",
    ],
    hint: "Start the guided machine Setup and Trust tour.",
  },
  // The fleet, not the page this tour is about: its first stop points at the gear, which
  // reads "Settings" from everywhere except the Settings page itself.
  entryRoute: { page: "fleet" },
  // Trust, not Setup: the last stop is the grant matrix, and the landing control is the rail
  // row that says which category you were left on. The add-repo field is what an operator
  // reaches for next, but it is a combobox whose own focus handler opens a dropdown, and a
  // tour that ends by opening a menu nobody asked for is worse than one that ends quietly.
  exit: { route: { page: "settings", category: "trust" }, focus: "setup:trust-tab" },
};

/** Every tour Mission Control offers, in the order its entry points list them. */
export const TOUR_ENTRIES: readonly TourEntry[] = (() => {
  const entries = [SEE_WORK_ENTRY, LIBRARY_ENTRY, SETUP_ENTRY];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`duplicate tour entry ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
})();

/**
 * The one tour a fresh profile receives automatically, before it has asked for anything.
 *
 * Setup, because nothing else in the product works until this machine has the tools the work
 * needs and the repositories that work may touch, and an operator who has never seen either
 * panel cannot be expected to find them. Named here rather than written into the effect that
 * starts it, so the automatic tour and the manual ones are drawn from the same registry.
 */
export const FIRST_RUN_TOUR: TourId = "setup";

export function tourEntry(id: TourId): TourEntry {
  const entry = TOUR_ENTRIES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no such tour ${id}`);
  return entry;
}
