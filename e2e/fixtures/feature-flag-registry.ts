export const BACKGROUND_REASONING_EFFORT_FLAG_ID = "background-reasoning-effort" as const;
export const MACOS_TERMINAL_FLAG_ID = "macos-terminal" as const;
export const PERSONA_REPOSITORY_ACCESS_FLAG_ID = "persona-repository-access" as const;
import type { FeatureFlagDefinition } from "../../src/shared/feature-flags.ts";

// The shipped registry also exports these ids; the private builds that substitute it keep the export.
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
export const PINNED_PLAN_CHANGE_FLAG_ID = "pinned-plan-change" as const;
export const WORK_UNIT_ID_FLAG_ID = "work-unit-id" as const;
export const SESSION_AWAITING_FLAG_ID = "session-awaiting" as const;

export const MCP_SCHEDULES_FLAG_ID = "mcp-schedules" as const;
export const IDLE_RAIL_SECTION_COUNTS_FLAG_ID = "idle-rail-section-counts" as const;
export const IDLE_STALLED_FLAG_ID = "idle-stalled" as const;
export const MARKDOWN_QUESTIONS_FLAG_ID = "markdown-questions" as const;

export const FEATURE_FLAGS = [
  { id: "preview-navigation", label: "Preview navigation", description: "Try a new way to move between sessions while keeping your existing workspace, preferences and running tasks exactly where you left them.", stage: "preview", keywords: ["wayfinding"] },
  { id: "preview-timeline", label: "Preview timeline", description: "See a chronological overview of session activity.", stage: "preview", keywords: ["chronology"] },
  { id: "compact-history", label: "Compact history", description: "Group older activity into a compact history view.", stage: "default-on", keywords: ["archive"] },
  { id: "quick-replies", label: "Quick replies", description: "Keep common replies close to the composer.", stage: "default-on", keywords: ["shortcuts"] },
] as const satisfies readonly FeatureFlagDefinition[];
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
