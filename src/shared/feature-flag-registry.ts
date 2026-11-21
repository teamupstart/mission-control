import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [
  {
    id: "session-control-requests",
    label: "Session control requests",
    description: "Let a session ask, through Mission Control's MCP tools, for permission to control other sessions. "
      + "The request appears as a card on that session, and only your own click on Accept in the desktop app grants it.",
    stage: "preview",
    keywords: ["control other sessions", "permission", "request_session_control", "delegation"],
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
