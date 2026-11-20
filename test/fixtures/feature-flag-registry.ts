import type { FeatureFlagDefinition } from "../../src/shared/feature-flags.ts";

// Replaces only the registry module in reader tests.
export const FEATURE_FLAGS = [{
  id: "fixture-preview", label: "Fixture preview", description: "Reader test fixture",
  stage: "preview", keywords: [],
}] as const satisfies readonly FeatureFlagDefinition[];
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
