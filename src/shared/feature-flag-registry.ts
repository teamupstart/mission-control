import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [
  {
    id: "codex-resident-native-mcp",
    label: "Codex resident native MCP",
    description: "Let Codex residents use their native MCP configuration and saved logins.",
    stage: "preview",
    keywords: ["residents", "oauth", "global servers"],
  },
  {
    id: "resident-active-hours",
    label: "Resident active hours",
    description: "Choose the days and hours a resident's loop may wake it. Outside them the resident keeps running but sleeps: no loop prompt and no tokens until the next window opens.",
    stage: "preview",
    keywords: ["residents", "schedule", "sleep", "working hours", "weekdays"],
  },
  {
    id: "automatic-pr-branch-update",
    label: "Automatic PR branch updates",
    description: "Update otherwise ready PR branches when GitHub requires them to catch up. Never authorizes a merge.",
    stage: "preview",
    keywords: ["github", "pull request", "branch", "checks"],
  },
  {
    id: "task-shaping",
    label: "Task shaping",
    description: "Register shapers in Settings > Task shaping and dry-run them to see the context they would add to a worker's first prompt. Dispatch does not call them yet.",
    stage: "preview",
    keywords: ["shaping", "shaper", "context", "guidance", "prompt"],
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
