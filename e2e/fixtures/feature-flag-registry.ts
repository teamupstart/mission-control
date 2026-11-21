import type { FeatureFlagDefinition } from "../../src/shared/feature-flags.ts";

// The shipped registry also exports these ids; the private builds that substitute it keep the export.
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
export const WORK_UNIT_ID_FLAG_ID = "work-unit-id" as const;

export const FEATURE_FLAGS = [
  { id: "preview-navigation", label: "Preview navigation", description: "Try a new way to move between sessions while keeping your existing workspace, preferences and running tasks exactly where you left them.", stage: "preview", keywords: ["wayfinding"] },
  { id: "preview-timeline", label: "Preview timeline", description: "See a chronological overview of session activity.", stage: "preview", keywords: ["chronology"] },
  { id: "compact-history", label: "Compact history", description: "Group older activity into a compact history view.", stage: "default-on", keywords: ["archive"] },
  { id: "quick-replies", label: "Quick replies", description: "Keep common replies close to the composer.", stage: "default-on", keywords: ["shortcuts"] },
] as const satisfies readonly FeatureFlagDefinition[];
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
