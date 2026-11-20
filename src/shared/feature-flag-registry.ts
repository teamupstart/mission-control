import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [{
  id: "automatic-pr-branch-update", label: "Automatic PR branch updates",
  description: "Update otherwise ready PR branches when GitHub requires them to catch up. Never authorizes a merge.",
  stage: "preview", keywords: ["github", "pull request", "branch", "checks"],
}] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
