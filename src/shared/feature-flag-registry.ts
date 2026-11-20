import type { FeatureFlagDefinition } from "./feature-flags.ts";

/** The one owner of the headless-mode flag id: the gates and the shared contracts import it from here. */
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;

export const FEATURE_FLAGS = [
  {
    id: HEADLESS_MODE_FLAG_ID,
    label: "Headless mode",
    description: "Dispatch work to Mission Control from a Claude Code terminal session.",
    stage: "preview",
    keywords: ["headless", "terminal", "cli", "dispatch"],
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
