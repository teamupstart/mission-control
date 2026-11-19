import { createContext, useContext } from "react";
import { FEATURE_FLAGS_DEFAULTS, resolveFeatureFlag, type FeatureFlagId } from "@shared/feature-flags.ts";

/** The event stream is the sole owner; the provider only passes its current value. */
export const FeatureFlagsContext = createContext(FEATURE_FLAGS_DEFAULTS);
export function useFeatureFlag(id: FeatureFlagId): boolean {
  return resolveFeatureFlag(id, useContext(FeatureFlagsContext));
}
