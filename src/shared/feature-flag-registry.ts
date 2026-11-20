import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [
  {
    id: "task-shaping",
    label: "Task shaping",
    description: "Call configured shapers before dispatch and add their context to a worker's first prompt.",
    stage: "preview",
    keywords: ["shaping", "shaper", "context", "guidance", "prompt"],
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
