export const BACKGROUND_REASONING_EFFORT_FLAG_ID = "background-reasoning-effort" as const;
export const MACOS_TERMINAL_FLAG_ID = "macos-terminal" as const;
import type { FeatureFlagDefinition } from "../../src/shared/feature-flags.ts";

// The shipped registry also exports these ids; a build that substitutes the registry keeps the export.
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
export const PINNED_PLAN_CHANGE_FLAG_ID = "pinned-plan-change" as const;
export const WORK_UNIT_ID_FLAG_ID = "work-unit-id" as const;
export const SESSION_AWAITING_FLAG_ID = "session-awaiting" as const;

export const MCP_SCHEDULES_FLAG_ID = "mcp-schedules" as const;
export const IDLE_STALLED_FLAG_ID = "idle-stalled" as const;
export const MARKDOWN_QUESTIONS_FLAG_ID = "markdown-questions" as const;

// Replaces only the registry module in reader tests.
export const FEATURE_FLAGS = [{
  id: "fixture-preview", label: "Fixture preview", description: "Reader test fixture",
  stage: "preview", keywords: [],
}] as const satisfies readonly FeatureFlagDefinition[];
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
