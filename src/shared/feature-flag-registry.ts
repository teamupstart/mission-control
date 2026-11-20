import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [{
  id: "codex-resident-native-mcp",
  label: "Codex resident native MCP",
  description: "Let Codex residents use their native MCP configuration and saved logins.",
  stage: "preview",
  keywords: ["residents", "oauth", "global servers"],
}] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
