import type { FeatureFlagDefinition } from "../../src/shared/feature-flags.ts";

// The shipped registry also exports this id; a build that substitutes the registry keeps the export.
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;

// Replaces only the registry module in reader tests. The shipped registry stays empty.
export const FEATURE_FLAGS = [{
  id: "fixture-preview", label: "Fixture preview", description: "Reader test fixture",
  stage: "preview", keywords: [],
}] as const satisfies readonly FeatureFlagDefinition[];
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
