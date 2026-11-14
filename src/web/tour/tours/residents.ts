import { BUILTIN_RESIDENT_PROFILE_ID_PREFIX } from "@shared/residents.ts";
import {
  assertTourDefinition,
  refresh,
  restage,
  type TourDefinition,
  type TourStep,
  type TourStepContext,
} from "../contracts.ts";
import { assertTourContentStages, tourStageContent } from "../content.ts";

/** The built-in this tour advertises. Append-only, like every built-in id. */
export const AGENT_SHEPHERD_PROFILE_ID = `${BUILTIN_RESIDENT_PROFILE_ID_PREFIX}agent-shepherd`;

export interface ResidentsTourRuntime {
  /**
   * The profile the authoring stops stand on: Agent Shepherd, the built-in this tour promises.
   * Null until that profile is in the collection; no other profile stands in for it.
   */
  profileId: string | null;
  /** Whether the Residents drawer is on screen right now. */
  drawerShown: boolean;
}

/**
 * Every move this tour makes, as transitions the dashboard already performs.
 *
 * Nothing here saves, duplicates, launches or pins: the tour opens the Residents page on a
 * read-only built-in, then the drawer, and points at the controls that do those things.
 */
export interface ResidentsTourNavigation {
  /** Open the Residents page on a profile, or on its rail alone when null. */
  showProfile: (profileId: string | null) => boolean;
  /** Leave for the fleet, where the top bar's Residents button opens the drawer. */
  showFleet: () => boolean;
  /**
   * Open the drawer beside the fleet without taking the keyboard - the tour's popover owns it -
   * and without writing the stored pin. Under the Board and Console placement the drawer is
   * borrowed for the length of the tour, the way See the work borrows a switched-off Line.
   */
  showDrawer: () => boolean;
  /** Put away a drawer this tour opened. One that was already open, or pinned, stays. */
  hideDrawer: () => void;
  /**
   * The operator reached the last stop. Not a move: App reads it as the tour ends, and a run
   * left before this stop is announced again in the next window's startup picker, so dismissing
   * the tour midway brings it back rather than spending its one announcement.
   */
  reachedEnd: () => void;
}

/**
 * The profile the tour reads: Agent Shepherd, or null until it is in the collection. Never
 * another built-in, which the tour's copy would then be presenting as Agent Shepherd.
 */
export function selectResidentsTourProfile(profiles: readonly { id: string }[]): string | null {
  return profiles.find((profile) => profile.id === AGENT_SHEPHERD_PROFILE_ID)?.id ?? null;
}

type Context = TourStepContext<ResidentsTourRuntime, ResidentsTourNavigation>;
type Step = TourStep<ResidentsTourRuntime, ResidentsTourNavigation>;

const profileLoadingCopy =
  "The built-in resident profiles are still arriving. Once they do, this stop reads Agent "
  + "Shepherd on the Residents page. Back, Next, and Exit remain available.";

/** A live element inside the registered editor, or null when no profile is open in it. */
const editorPart = (context: Context, selector: string): HTMLElement | null => {
  if (!context.runtime.profileId) return null;
  const part = context.registry.get("residents:editor")?.querySelector(selector);
  return part instanceof HTMLElement ? part : null;
};

/**
 * A stop standing on the built-in's profile. `prepare` opens it every time, so Back from the
 * fleet half of the tour lands on the page this stop describes rather than wherever it was.
 */
const profileStop = (step: Step): Step => ({
  ready: (context) => context.runtime.profileId !== null && context.element !== null,
  attainable: (context) => context.runtime.profileId !== null,
  fallback: (context) => (context.runtime.profileId
    ? "The profile is opening. Back, Next, and Exit remain available."
    : profileLoadingCopy),
  // Restage rather than refresh: the profile collection can land after this stop opens, and
  // only a re-run of `prepare` moves the page onto the built-in it names.
  reconcile: restage,
  ...step,
  prepare: (context) => context.navigation.showProfile(context.runtime.profileId),
});

/** A stop standing on the open drawer. */
const drawerStop = (step: Step): Step => ({
  ready: (context) => context.runtime.drawerShown && context.element !== null,
  fallback: () => "The Residents sidebar is opening. Back and Exit remain available.",
  reconcile: (context) => (context.runtime.drawerShown ? refresh() : restage()),
  ...step,
  prepare: (context) => context.navigation.showDrawer(),
});

const STEPS: readonly Step[] = [
  {
    id: "residents",
    ...tourStageContent("residents", "residents"),
    targets: [],
    centered: true,
    // Behind the opening card, the page the next six stops read.
    prepare: (context) => context.navigation.showProfile(context.runtime.profileId),
    reconcile: restage,
  },
  profileStop({
    id: "agent-shepherd",
    ...tourStageContent("residents", "agent-shepherd"),
    // The built-in's own row, which the rail marks current while its profile is open.
    targets: [{
      target: "residents:rail",
      side: "right",
      resolve: (context) => {
        if (!context.runtime.profileId) return null;
        const row = context.registry.get("residents:rail")
          ?.querySelector('.resident-list-item[aria-current="true"]');
        return row instanceof HTMLElement ? row : null;
      },
    }],
  }),
  profileStop({
    id: "profile",
    ...tourStageContent("residents", "profile"),
    // The read-only note and the editor's head: what this profile is and why it is locked.
    // The whole editor is taller than any window, and a spotlight past the fold says nothing.
    targets: [{
      target: "residents:editor",
      side: "bottom",
      resolve: (context) => editorPart(context, ".resident-editor-head"),
    }],
  }),
  profileStop({
    id: "duplicate",
    ...tourStageContent("residents", "duplicate"),
    targets: [{
      target: "residents:duplicate",
      side: "bottom",
      resolve: (context) =>
        context.runtime.profileId ? context.registry.get("residents:duplicate") : null,
    }],
  }),
  profileStop({
    id: "new",
    ...tourStageContent("residents", "new"),
    targets: [{ target: "residents:new", side: "right" }],
    // The rail's New button is on the page whether or not a built-in has arrived.
    ready: (context) => context.element !== null,
    attainable: () => true,
    fallback: () => "The Residents rail is opening. Back, Next, and Exit remain available.",
  }),
  profileStop({
    id: "loop",
    ...tourStageContent("residents", "loop"),
    targets: [{
      target: "residents:editor",
      side: "top",
      resolve: (context) =>
        editorPart(context, 'section[aria-labelledby="resident-section-loop"]'),
    }],
  }),
  profileStop({
    id: "launch",
    ...tourStageContent("residents", "launch"),
    targets: [{
      target: "residents:launch",
      side: "bottom",
      resolve: (context) =>
        context.runtime.profileId ? context.registry.get("residents:launch") : null,
    }],
  }),
  {
    id: "open-sidebar",
    ...tourStageContent("residents", "open-sidebar"),
    targets: [{ target: "residents:topbar-button", side: "bottom" }],
    prepare: (context) => context.navigation.showFleet(),
    ready: (context) => context.element !== null,
    fallback: () =>
      "The top bar's Residents button is hidden under Settings > Display > Top bar. Shift+H, "
      + "the ⌘K palette and the edge tab on the window's right edge still open the sidebar. "
      + "Next opens it.",
    nextLabel: () => "Open the sidebar",
    reconcile: refresh,
  },
  drawerStop({
    id: "sidebar",
    ...tourStageContent("residents", "sidebar"),
    targets: [{ target: "residents:drawer", side: "left" }],
    onBack: (context) => context.navigation.hideDrawer(),
  }),
  {
    ...drawerStop({
      id: "pin",
      ...tourStageContent("residents", "pin"),
      targets: [{ target: "residents:drawer-pin", side: "left" }],
      nextLabel: () => "Finish tour",
    }),
    // Reaching this stop is seeing the tour through, whether Finish or Exit then ends it.
    prepare: (context) => {
      context.navigation.reachedEnd();
      return context.navigation.showDrawer();
    },
  },
];

const CONTENT = assertTourContentStages("residents", STEPS);

export const RESIDENTS_TOUR: TourDefinition<ResidentsTourRuntime, ResidentsTourNavigation> =
  assertTourDefinition({
    id: "residents",
    title: CONTENT.title,
    steps: STEPS,
    documentFlags: [],
    stopping: {
      title: "Closing the tour…",
      description: "Leaving you on the fleet.",
    },
    runtimeKey: (runtime) => [runtime.profileId, runtime.drawerShown].join(" "),
  });
