import {
  assertTourDefinition,
  refresh,
  type TourDefinition,
  type TourStep,
} from "../contracts.ts";
import { assertTourContentStages, tourStageContent } from "../content.ts";

export interface SetupTourNavigation {
  showSetup: () => boolean;
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
    id: "families",
    ...tourStageContent("setup", "families"),
    targets: [{ target: "setup:family-agents", side: "left" }],
    prepare: (context) => context.navigation.showSetup(),
    reconcile: refresh,
  },
  {
    id: "statuses",
    ...tourStageContent("setup", "statuses"),
    targets: [{ target: "setup:family-github", side: "left" }],
    prepare: (context) => context.navigation.showSetup(),
    reconcile: refresh,
  },
  {
    id: "remedies",
    ...tourStageContent("setup", "remedies"),
    targets: [{ target: "setup:family-github", side: "left" }],
    prepare: (context) => context.navigation.showSetup(),
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
