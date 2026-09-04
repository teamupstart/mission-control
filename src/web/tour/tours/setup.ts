import {
  assertTourDefinition,
  refresh,
  type TourDefinition,
  type TourStep,
} from "../contracts.ts";
import { assertTourContentStages, tourStageContent } from "../content.ts";

/**
 * The three route moves this tour makes, in the order it makes them.
 *
 * All three are transitions the dashboard already performs for a link. The tour clicks no
 * control, selects no family, and runs no remedy: it shows an operator who has never opened
 * Setup how to reach it, then leaves them on it.
 */
export interface SetupTourNavigation {
  /**
   * Leave Settings for the fleet.
   *
   * The first stop points at the gear, and the gear only READS "Settings" from somewhere
   * else: on the Settings page the same control is "Return to Fleet", which is the opposite
   * of what that stop is teaching.
   */
  showFleet: () => boolean;
  /** Open Settings on its ordinary landing category, with Setup still unselected. */
  showSettings: () => boolean;
  /** Open Settings, Setup selected - the page this tour hands over when it ends. */
  showSetup: () => boolean;
}

type Step = TourStep<null, SetupTourNavigation>;

const STEPS: readonly Step[] = [
  {
    id: "settings",
    ...tourStageContent("setup", "settings"),
    targets: [{ target: "setup:settings-gear", side: "bottom" }],
    prepare: (context) => context.navigation.showFleet(),
    nextLabel: () => "Open Settings",
    reconcile: refresh,
  },
  {
    // Settings deliberately opens on its ordinary landing category here rather than straight
    // onto Setup: this stop teaches where Setup is in the rail, and a row that was already
    // selected before Next was pressed says nothing about how it got there.
    id: "setup",
    ...tourStageContent("setup", "setup"),
    targets: [{ target: "setup:settings-tab", side: "right" }],
    prepare: (context) => context.navigation.showSettings(),
    nextLabel: () => "Open Setup",
    reconcile: refresh,
  },
  {
    // The rail and the rows together, not one family: which tools this machine is missing
    // decides which family is worth reading, and that is the operator's call rather than
    // the tour's.
    id: "dependencies",
    ...tourStageContent("setup", "dependencies"),
    targets: [{ target: "setup:dependencies", side: "left" }],
    prepare: (context) => context.navigation.showSetup(),
    reconcile: refresh,
  },
  {
    id: "recheck",
    ...tourStageContent("setup", "recheck"),
    targets: [{ target: "setup:recheck", side: "bottom" }],
    prepare: (context) => context.navigation.showSetup(),
    nextLabel: () => "Finish tour",
    reconcile: refresh,
  },
];

const CONTENT = assertTourContentStages("setup", STEPS);

export const SETUP_TOUR: TourDefinition<null, SetupTourNavigation> = assertTourDefinition({
  id: "setup",
  title: CONTENT.title,
  steps: STEPS,
  documentFlags: [],
  stopping: {
    title: "Closing the tour...",
    // This tour ends on the page it just opened rather than putting one back; see the
    // `exit` route on its entry.
    description: "Leaving you on Setup.",
  },
  runtimeKey: () => "setup",
});
