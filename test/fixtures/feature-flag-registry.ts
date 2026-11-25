export const LOCAL_INSPECTOR_FLAG_ID = "local-inspector" as const;
export const BACKGROUND_REASONING_EFFORT_FLAG_ID = "background-reasoning-effort" as const;
export const BUG_FIX_INSPECTOR_FLAG_ID = "bug-fix-inspector" as const;
export const MACOS_TERMINAL_FLAG_ID = "macos-terminal" as const;
export const PERSONA_REPOSITORY_ACCESS_FLAG_ID = "persona-repository-access" as const;
import type { FeatureFlagDefinition } from "../../src/shared/feature-flags.ts";

// The shipped registry also exports these ids; a build that substitutes the registry keeps the export.
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
export const PINNED_PLAN_CHANGE_FLAG_ID = "pinned-plan-change" as const;
export const WORK_UNIT_ID_FLAG_ID = "work-unit-id" as const;
export const SESSION_SETTINGS_FLAG_ID = "session-settings-mcp" as const;
export const SESSION_AWAITING_FLAG_ID = "session-awaiting" as const;
export const SHAPER_SIGN_IN_FLAG_ID = "shaper-sign-in" as const;

export const MCP_SCHEDULES_FLAG_ID = "mcp-schedules" as const;
export const IDLE_RAIL_SECTION_COUNTS_FLAG_ID = "idle-rail-section-counts" as const;
export const IDLE_STALLED_FLAG_ID = "idle-stalled" as const;
export const MARKDOWN_QUESTIONS_FLAG_ID = "markdown-questions" as const;

// Replaces only the registry module in reader tests. The composed daemon requires the session settings entry.
export const FEATURE_FLAGS = [
  { id: "fixture-preview", label: "Fixture preview", description: "Reader test fixture", stage: "preview", keywords: [] },
  { id: SESSION_SETTINGS_FLAG_ID, label: "Session settings through MCP", description: "Session settings route fixture", stage: "preview", keywords: [] },
] as const satisfies readonly FeatureFlagDefinition[];
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
