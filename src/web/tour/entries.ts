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
  preview: {
    summary: string;
    outcomes: readonly [string, string, string];
    illustration?: "work" | "library" | "setup";
  };
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
   * startup picker may have no invoker, and a keyboard operator would otherwise
   * be left at the document root on a page they did not ask for.
   */
  exit?: { route: MissionRoute; focus: TourTargetId };
}

const SEE_WORK_TITLE = tourContent("see-work").title;
const LIBRARY_TITLE = tourContent("library").title;
const WORKFLOWS_TITLE = tourContent("workflows").title;
const SETUP_TITLE = tourContent("setup").title;

const SEE_WORK_ENTRY: TourEntry = {
  id: "see-work",
  title: SEE_WORK_TITLE,
  preview: {
    summary: "Follow work from the fleet overview to one session's desk, then through review and completion.",
    outcomes: [
      "Read the Line and compare sessions on the Board",
      "Explore a session's conversation and work desk",
      "See how dispatch, review, and completion fit together",
    ],
    illustration: "work",
  },
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
  preview: {
    summary: "Explore the reusable instructions and checks that shape your agents' work.",
    outcomes: [
      "Find Personas, Actions, and Commands in the Library",
      "Inspect the workflow that reviews finished work",
      "Connect reusable definitions to their runs",
    ],
    illustration: "library",
  },
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

const WORKFLOWS_ENTRY: TourEntry = {
  id: "workflows",
  title: WORKFLOWS_TITLE,
  preview: {
    summary: "Follow one No-Mistakes Review run from frozen evidence to a shipped pull request.",
    outcomes: [
      "Know what each stage of a review is doing",
      "Bind or trigger a review yourself",
      "Read evidence, rounds, and the GitHub Inspector gate",
    ],
    illustration: "work",
  },
  settings: {
    tooltip: "Tour one No-Mistakes Review run: stages, evidence, rounds, and its final gates",
    ariaLabel: `Start ${WORKFLOWS_TITLE} tour`,
    heading: WORKFLOWS_TITLE,
    hint: "Walk one real review run",
  },
  palette: {
    rowId: "command:workflows-tour",
    title: `Start ${WORKFLOWS_TITLE} tour`,
    detail: "Follow one No-Mistakes Review run - stages, evidence, rounds, and its final gates.",
    keywords: [
      "tour",
      "product tour",
      "onboarding",
      "workflow",
      "review",
      "run",
      "evidence",
      "readiness",
      "inspector",
      "no-mistakes",
      "binding",
    ],
    hint: "Start the guided workflow run tour.",
  },
  // The Runs page, which is the tour's whole subject: its first stop is a centered card over
  // the surface every later stop returns to.
  entryRoute: { page: "runs" },
  // The tour's last stop hands the Runs page over - "Finish leaves you here" is its own
  // copy - so the exit declares it rather than replaying the snapshot's route. The landing
  // control is the All filter chip, the first control of the rail the close stop spotlights.
  exit: { route: { page: "runs" }, focus: "workflows:run-filter-all" },
};

const SETUP_ENTRY: TourEntry = {
  id: "setup",
  title: SETUP_TITLE,
  preview: {
    summary: "Find the tools this machine needs and choose which repositories your agents may use.",
    outcomes: [
      "Find Setup from Settings",
      "Check dependencies and re-check installed tools",
      "Understand repository grants in Trust",
    ],
    illustration: "setup",
  },
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
  const entries = [SEE_WORK_ENTRY, LIBRARY_ENTRY, WORKFLOWS_ENTRY, SETUP_ENTRY];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`duplicate tour entry ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
})();

/** Recommended first preview, without changing the discovery order in Settings or search. */
export const RECOMMENDED_TOUR: TourId = "setup";

export function tourEntry(id: TourId): TourEntry {
  const entry = TOUR_ENTRIES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no such tour ${id}`);
  return entry;
}
