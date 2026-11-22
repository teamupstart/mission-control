import type { FeatureFlagDefinition } from "./feature-flags.ts";

/** The one owner of the headless-mode flag id: the gates and the shared contracts import it from here. */
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
/** The one owner of the session-awaiting flag id: the daemon gates and the dashboard import it. */
export const SESSION_AWAITING_FLAG_ID = "session-awaiting" as const;

export const WORKFLOW_HOLD_DETAILS_FLAG_ID = "workflow-hold-details" as const;
export const PINNED_PLAN_CHANGE_FLAG_ID = "pinned-plan-change" as const;

export const FEATURE_FLAGS = [
  {
    id: WORKFLOW_HOLD_DETAILS_FLAG_ID,
    label: "Workflow hold details",
    description: "Show why each workflow holds a Fleet session, who acts next, and a link to its run.",
    stage: "preview",
    keywords: ["fleet", "workflow", "held", "waiting"],
  },
  {
    id: PINNED_PLAN_CHANGE_FLAG_ID,
    label: "Change pinned plan revision",
    description: "Preview and update a backlog task’s exact plan input and originating dependency together.",
    stage: "preview",
    keywords: ["backlog", "plan", "revision", "dependency"],
  },
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
    id: HEADLESS_MODE_FLAG_ID,
    label: "Headless mode",
    description: "Dispatch work to Mission Control from a Claude Code terminal session.",
    stage: "preview",
    keywords: ["headless", "terminal", "cli", "dispatch"],
  },
  {
    id: "task-hibernation",
    label: "Hibernate tasks",
    description:
      "Adds Hibernate to a task session's pause menu: the agent stops and frees its memory, and the task waits in the Backlog until you resume its conversation.",
    stage: "preview",
    keywords: ["hibernate", "resume", "memory", "pause", "sleep", "backlog"],
  },
  {
    id: "task-shaping",
    label: "Task shaping",
    description: "Register shapers in Settings > Task shaping and dry-run them to see the context they would add to a worker's first prompt. Dispatch does not call them yet.",
    stage: "preview",
    keywords: ["shaping", "shaper", "context", "guidance", "prompt"],
  },
  {
    id: "resident-profiles-fold",
    label: "Fold the drawer's Profiles",
    description: "Adds a chevron to the Residents drawer's Profiles heading that folds the launch list away, so the live residents above get the room.",
    stage: "preview",
    keywords: ["residents", "drawer", "profiles", "launch", "collapse"],
  },
  {
    id: "session-control-requests",
    label: "Session control requests",
    description: "Let a session ask, through Mission Control's MCP tools, for permission to control other sessions. "
      + "The request appears as a card on that session, and only your own click on Accept in the desktop app grants it.",
    stage: "preview",
    keywords: ["control other sessions", "permission", "request_session_control", "delegation"],
  },
  {
    id: "async-input",
    label: "Ask without stopping",
    description:
      "request_input files the question in the attention inbox and returns at once, so the agent keeps " +
      "working; your answer reaches it later as a message. A session that stops with a question open shows " +
      "as waiting on your answer.",
    stage: "preview",
    keywords: ["request_input", "question", "inbox", "asynchronous", "non-blocking", "ask"],
  },
  {
    id: SESSION_AWAITING_FLAG_ID,
    label: "Awaiting background work",
    description: "Let a session declare, with report_awaiting, that it is idle on purpose while a background process "
      + "such as CI checks finishes. Its card shows what it waits for and when it is due, and idle automation leaves it "
      + "alone until that deadline.",
    stage: "preview",
    keywords: ["awaiting", "report_awaiting", "background", "ci", "idle", "deadline", "overdue"],
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
