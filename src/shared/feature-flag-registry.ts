import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
