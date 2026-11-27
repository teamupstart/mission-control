import type { FeatureFlagDefinition } from "./feature-flags.ts";
import { INBOX_FLAG } from "./inbox.ts";
import { VOICE_FIRST_PREVIEW_HOLD_FLAG, VOICE_FLAG } from "./voice.ts";

/** The one owner of the headless-mode flag id: the gates and the shared contracts import it from here. */
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
/** The one owner of the session-awaiting flag id: the daemon gates and the dashboard import it. */
export const SESSION_AWAITING_FLAG_ID = "session-awaiting" as const;

export const PINNED_PLAN_CHANGE_FLAG_ID = "pinned-plan-change" as const;
/**
 * The one owner of the work unit preview's id. The server reads it in one place,
 * `launchWorkUnitId` in `src/server/work-unit.ts`, once per launch. Nothing else reads it: the
 * dashboard row shows the launch record. See `docs/work-units.md`.
 */
export const WORK_UNIT_ID_FLAG_ID = "work-unit-id" as const;

export const MCP_SCHEDULES_FLAG_ID = "mcp-schedules" as const;
export const IDLE_RAIL_SECTION_COUNTS_FLAG_ID = "idle-rail-section-counts" as const;

/**
 * The one owner of the Stalled section's id: idle stalls move from the inbox's Stuck section into
 * Idle's Stalled section on the Board and the Console rail. See `docs/attention-and-alerts.md`.
 */
export const IDLE_STALLED_FLAG_ID = "idle-stalled" as const;

export const MACOS_TERMINAL_FLAG_ID = "macos-terminal" as const;

export const BACKGROUND_REASONING_EFFORT_FLAG_ID = "background-reasoning-effort" as const;

/** The one owner of the Markdown question body preview's id; the dashboard's question surfaces read it. */
export const MARKDOWN_QUESTIONS_FLAG_ID = "markdown-questions" as const;

/** The one owner of the unified split inbox's id; the attention inbox reads it. */
export const INBOX_SPLIT_FLAG_ID = "inbox-split" as const;

export const PERSONA_REPOSITORY_ACCESS_FLAG_ID = "persona-repository-access" as const;

export const BUG_FIX_INSPECTOR_FLAG_ID = "bug-fix-inspector" as const;

export const SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID = "seven-day-worktree-cleanup" as const;

/**
 * Lets automatic worktree retention also return disposable task checkouts Git no longer
 * recognizes, and finish tasks whose terminal home is positively proved absent. Its own flag
 * rather than part of `seven-day-worktree-cleanup`: that flag only chooses the window, and
 * turning it off still enforces cleanup, so it cannot be the off switch for a new class of
 * unattended deletion. See `docs/worktrees-and-checks.md#orphaned-task-checkouts`.
 */
export const ORPHANED_WORKTREE_RECLAIM_FLAG_ID = "orphaned-worktree-reclaim" as const;

export const LOCAL_INSPECTOR_FLAG_ID = "local-inspector" as const;
export const SESSION_SETTINGS_FLAG_ID = "session-settings-mcp" as const;

/**
 * The one owner of the shaper sign-in preview's id. A remote shaper whose server carries the
 * `auth` marker is called only while it is on and signed in. See `docs/task-shaping.md`.
 */
export const SHAPER_SIGN_IN_FLAG_ID = "shaper-sign-in" as const;

export const RESIDENT_CARD_NAMES_FLAG_ID = "resident-card-names" as const;

export const FEATURE_FLAGS = [
  {
    id: SESSION_SETTINGS_FLAG_ID,
    label: "Session settings through MCP",
    description: "Let registered sessions read and change supported Mission Control settings on your request.",
    stage: "preview",
    sessionSetting: "Desktop Trust consent and the rollout switch govern access to this tool.",
    keywords: ["settings", "access", "mcp", "mission_settings"],
  },
  {
    id: LOCAL_INSPECTOR_FLAG_ID,
    label: "Local Inspector",
    description: "Review the submitted checkout in a workflow before opening a pull request.",
    stage: "preview",
    sessionSetting: "Controls whether the workflow can review the submitted checkout before publication.",
    keywords: ["workflow", "inspector", "review", "repository"],
  },
  {
    id: BUG_FIX_INSPECTOR_FLAG_ID,
    label: "Bug Fix Inspector",
    description: "Offer an optional resident that investigates Mission Control bugs and prepares GitHub issues for approval.",
    stage: "preview",
    sessionSetting: "Offers a resident with log access and a GitHub issue workflow.",
    keywords: ["resident", "bugs", "inspector", "logs", "github"],
  },
  {
    id: PERSONA_REPOSITORY_ACCESS_FLAG_ID,
    label: "Persona repository access",
    description: "Give selected workflow reviewers read-only access to the submitted checkout.",
    stage: "preview",
    sessionSetting: "Grants workflow reviewers access to a repository.",
    keywords: ["workflows", "review", "repository", "persona"],
  },
  {
    id: PINNED_PLAN_CHANGE_FLAG_ID,
    label: "Change pinned plan revision",
    description: "Preview and update a backlog task’s exact plan input and originating dependency together.",
    stage: "preview",
    sessionSetting: "Allows revisions and dependencies of reviewed plans to be changed.",
    keywords: ["backlog", "plan", "revision", "dependency"],
  },
  {
    id: "resident-active-hours",
    label: "Resident active hours",
    description: "Choose the days and hours a resident's loop may wake it. Outside them the resident keeps running but sleeps: no loop prompt and no tokens until the next window opens.",
    stage: "preview",
    sessionSetting: "Changes when residents run automatically.",
    keywords: ["residents", "schedule", "sleep", "working hours", "weekdays"],
  },
  {
    id: RESIDENT_CARD_NAMES_FLAG_ID,
    label: "Resident names on cards",
    description: "Offer a Display setting that shows a resident's profile name on its board card beside the call sign it answers to.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["residents", "reference name", "call sign", "board card", "display"],
  },
  {
    id: "automatic-pr-branch-update",
    label: "Automatic PR branch updates",
    description: "Update otherwise ready PR branches when GitHub requires them to catch up. Never authorizes a merge.",
    stage: "preview",
    sessionSetting: "Authorizes automated writes to GitHub branches.",
    keywords: ["github", "pull request", "branch", "checks"],
  },
  {
    id: HEADLESS_MODE_FLAG_ID,
    label: "Headless mode",
    description: "Dispatch work to Mission Control from a Claude Code terminal session.",
    stage: "preview",
    sessionSetting: "Enables terminal dispatch authority.",
    keywords: ["headless", "terminal", "cli", "dispatch"],
  },
  {
    id: "task-hibernation",
    label: "Hibernate tasks",
    description:
      "Adds Hibernate to a task session's pause menu: the agent stops and frees its memory, and the task waits in the Backlog until you resume its conversation.",
    stage: "preview",
    sessionSetting: "Changes session lifecycle controls.",
    keywords: ["hibernate", "resume", "memory", "pause", "sleep", "backlog"],
  },
  {
    id: "task-shaping",
    label: "Task shaping",
    description: "Call registered shapers at dispatch and add the context they return to a worker's first prompt. Register and dry-run them in Settings > Task shaping.",
    stage: "preview",
    sessionSetting: "Allows configured executables and remote shapers to run at dispatch.",
    keywords: ["shaping", "shaper", "context", "guidance", "prompt"],
  },
  {
    id: SHAPER_SIGN_IN_FLAG_ID,
    label: "Shaper sign-in",
    description: "Sign a remote shaper in to an OAuth-protected server from Settings > Task shaping.",
    stage: "preview",
    sessionSetting: "Enables credential enrollment for remote shapers.",
    keywords: ["shaping", "shaper", "oauth", "sign-in", "login", "token"],
  },
  {
    id: "resident-profiles-fold",
    label: "Fold the drawer's Profiles",
    description: "Adds a chevron to the Residents drawer's Profiles heading that folds the launch list away, so the live residents above get the room.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["residents", "drawer", "profiles", "launch", "collapse"],
  },
  {
    id: "session-control-requests",
    label: "Session control requests",
    description: "Let a session ask, through Mission Control's MCP tools, for permission to control other sessions. "
      + "The request appears in the attention inbox, and only your own click on Accept in the desktop app grants it.",
    stage: "preview",
    sessionSetting: "Controls the surface for requesting cross-session authority.",
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
    sessionSetting: "A prerequisite of workstation microphone capture.",
    keywords: ["request_input", "question", "inbox", "asynchronous", "non-blocking", "ask"],
  },
  {
    id: "filed-plan-decisions",
    label: "File plan decisions",
    description:
      "request_plan_decisions files the plan form in the attention inbox instead of holding a tool call open. " +
      "The agent still stops and waits on it, and your answer reaches it later as a message. Takes effect only " +
      "while Ask without stopping is on.",
    stage: "preview",
    sessionSetting: "A prerequisite of workstation microphone capture.",
    keywords: ["request_plan_decisions", "plan", "decisions", "inbox", "asynchronous", "approval"],
  },
  {
    id: WORK_UNIT_ID_FLAG_ID,
    // The label and description name no work unit: the id is tracked, never shown, and this
    // switch is the one place the dashboard refers to it. Search still finds it by `keywords`.
    label: "MCP call attribution",
    description:
      "Tag each agent started for a task with one id that its MCP calls and traces carry, so a task's " +
      "calls can be found together in your own tools. The id is tracked, never shown here. A switch " +
      "takes effect at each agent's next start.",
    stage: "preview",
    sessionSetting: "Adds attribution to downstream MCP requests.",
    keywords: ["work unit", "WORK_UNIT_ID", "x-work-unit-id", "mcp", "trace", "telemetry"],
  },
  {
    id: SESSION_AWAITING_FLAG_ID,
    label: "Awaiting background work",
    description: "Let a session declare, with report_awaiting, that it is idle on purpose while a background process "
      + "such as CI checks finishes. Its card shows what it waits for and when it is due, and idle automation leaves it "
      + "alone until that deadline.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["awaiting", "report_awaiting", "background", "ci", "idle", "deadline", "overdue"],
  },
  {
    id: INBOX_FLAG,
    label: "Reports and inbox upgrades",
    description:
      "Agents can post reports for you to read: a Reports section in the attention inbox and a to read " +
      "figure in the top bar. Stalled sessions get a Stuck section in the inbox with the fix on each row. " +
      "One rule names an agent in alert titles, the attention inbox, the review modal and question cards: " +
      "its resident name in its board colour, else its task title, else its session name. The alerts " +
      "popover gains What notifies you switches, and a report notifies you when its agent is back or " +
      "still working. Settings > Reports edits when agents post reports and lists muted agents, and the " +
      "Reports section has Mark all read.",
    stage: "preview",
    sessionSetting: "A prerequisite of workstation microphone capture.",
    keywords: ["inbox", "names", "display name", "attention", "alerts", "resident", "reports", "post_report", "to read", "stuck", "stall", "notifications", "what notifies you", "mute", "report guidance", "mark all read"],
  },
  {
    id: INBOX_SPLIT_FLAG_ID,
    label: "Unified split inbox",
    description:
      "Show the attention inbox as one list with a detail pane: every question, permission, halt, stuck " +
      "session and report is a row, the selected one opens beside the list with its usual controls, and " +
      "the next one opens when it is settled. Tabs filter to what is owed, what is to read and what is snoozed.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["inbox", "attention", "split", "reader", "list", "detail", "questions", "reports", "next"],
  },
  {
    id: IDLE_RAIL_SECTION_COUNTS_FLAG_ID,
    label: "Counts on Idle rail sections",
    description: "Show a session total in the conversation’s Idle rail and put status counts on expandable section headings.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["idle", "rail", "conversation", "sections", "counts"],
  },
  {
    id: IDLE_STALLED_FLAG_ID,
    label: "Stalled section in Idle",
    description:
      "Sessions that went quiet with work still open move out of the inbox into a Stalled section of " +
      "the Idle column. Each card says what is open, what it last did and the step that moves it, " +
      "with the fix in place.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["stalled", "stuck", "stall", "idle", "inbox", "unfinished", "parked", "board"],
  },
  {
    id: MCP_SCHEDULES_FLAG_ID,
    label: "Recurring missions through MCP",
    description: "Let sessions preview and create recurring missions through MCP, and read the saved mission catalog.",
    stage: "preview",
    sessionSetting: "Grants sessions the ability to create recurring missions.",
    keywords: ["schedule", "recurring", "mission", "mcp", "create_schedule"],
  },
  {
    id: VOICE_FLAG,
    label: "Voice addressing",
    description:
      "Talk to agents by name, with speech recognized on this machine. Needs Ask without stopping, " +
      "Reports and inbox upgrades and File plan decisions: the Voice family in Settings > Setup turns " +
      "them on. Settings > Voice shows whether voice is listening and why not, and who can be addressed: " +
      "residents by name or reference name, and sessions given a call sign under Dispatch > Advanced.",
    stage: "preview",
    sessionSetting: "Controls availability of workstation microphone capture.",
    keywords: ["voice", "speech", "microphone", "listen", "hands-free", "dictation", "call sign", "reference name", "mute"],
  },
  {
    id: VOICE_FIRST_PREVIEW_HOLD_FLAG,
    label: "Voice first-preview hold",
    description:
      "In Always-on listening, wait until a phrase holds 300 ms of voiced audio before showing its first live words, " +
      "so room noise and typing stop flashing words like \"Okay\" or \"Mm-hmm\". What is sent, and to whom, is unchanged. " +
      "Applies to the macOS listener.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["voice", "transcript", "preview", "live words", "phantom", "filler", "noise", "always-on"],
  },
  {
    id: MACOS_TERMINAL_FLAG_ID,
    label: "macOS Terminal",
    description: "Open shells and show multiplexer sessions in the Terminal app built into macOS.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["terminal", "apple", "macos", "dispatch"],
  },
  {
    id: BACKGROUND_REASONING_EFFORT_FLAG_ID,
    label: "Background reasoning effort",
    description: "Choose the reasoning effort for each background model call in Settings > Models.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["background jobs", "models", "thinking", "reasoning", "foreman", "inspector"],
  },
  {
    id: MARKDOWN_QUESTIONS_FLAG_ID,
    label: "Markdown questions",
    description:
      "Render the context an agent sends with request_input as Markdown, so its lists, headings and code " +
      "read as they were written: on the question card, in the attention inbox and in the conversation.",
    stage: "preview",
    sessionSetting: "read-write",
    keywords: ["request_input", "question", "context", "markdown", "bullets", "inbox"],
  },
  {
    id: SEVEN_DAY_WORKTREE_CLEANUP_FLAG_ID,
    label: "Seven-day worktree cleanup",
    description: "Use seven days for automatic task worktree cleanup when the checkout is safe to return. Turning this off uses the configured retention window.",
    stage: "preview",
    sessionSetting: "Controls when unattended worktree deletion can occur.",
    keywords: ["worktrees", "cleanup", "retention", "disk space"],
  },
  {
    id: ORPHANED_WORKTREE_RECLAIM_FLAG_ID,
    label: "Reclaim orphaned task worktrees",
    description: "Let automatic cleanup return task checkouts Git no longer recognizes after archiving their local-only files, and finish tasks whose terminal home is proved gone.",
    stage: "preview",
    sessionSetting: "Controls whether unattended deletion can remove checkouts that Git no longer recognizes.",
    keywords: ["worktrees", "cleanup", "orphaned", "retention", "disk space", "terminal home"],
  },
] as const satisfies readonly (FeatureFlagDefinition & { sessionSetting: string })[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = ["codex-resident-native-mcp"] as const;
