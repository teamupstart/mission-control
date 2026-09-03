import type { SetupFamilyId } from "@shared/setup-catalog.ts";
import {
  assertTourDefinition,
  refresh,
  type TourDefinition,
  type TourStep,
} from "../contracts.ts";
import { assertTourContentStages, tourStageContent } from "../content.ts";

export interface SetupTourNavigation {
  showSetup: () => boolean;
  /**
   * Open Setup with one family selected.
   *
   * The panel shows a single family at a time, so a step whose copy is about statuses and
   * remedies has to say which family it means - otherwise it spotlights whichever one the
   * rail happened to open on, which on a fully-configured machine has no remedy to point at.
   */
  showSetupFamily: (family: SetupFamilyId) => boolean;
}

type Step = TourStep<null, SetupTourNavigation>;

const STEPS: readonly Step[] = [
  {
    id: "overview",
    ...tourStageContent("setup", "overview"),
    targets: [{ target: "setup:panel", side: "left" }],
    prepare: (context) => context.navigation.showSetup(),
    reconcile: refresh,
  },
  {
    // "Read by family" is now literally the rail, so it is the rail this points at rather
    // than one family's rows.
    id: "families",
    ...tourStageContent("setup", "families"),
    targets: [{ target: "setup:rail", side: "left" }],
    prepare: (context) => context.navigation.showSetup(),
    reconcile: refresh,
  },
  {
    // GitHub, deliberately: both of its rows are `required`, so this step and the next have
    // a status ramp and a real remedy to point at on any machine.
    id: "statuses",
    ...tourStageContent("setup", "statuses"),
    targets: [{ target: "setup:pane", side: "left" }],
    prepare: (context) => context.navigation.showSetupFamily("github"),
    reconcile: refresh,
  },
  {
    id: "remedies",
    ...tourStageContent("setup", "remedies"),
    targets: [{ target: "setup:pane", side: "left" }],
    prepare: (context) => context.navigation.showSetupFamily("github"),
    reconcile: refresh,
  },
  {
    id: "recheck",
    ...tourStageContent("setup", "recheck"),
    targets: [{ target: "setup:recheck", side: "bottom" }],
    prepare: (context) => context.navigation.showSetup(),
    reconcile: refresh,
  },
  {
    id: "close",
    ...tourStageContent("setup", "close"),
    targets: [],
    centered: true,
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
    description: "Returning to the page and control where you started.",
  },
  runtimeKey: () => "setup",
});
