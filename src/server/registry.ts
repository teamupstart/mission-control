import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PERMISSION_MODES } from "@shared/types.ts";
import type {
  AgentType,
  ForemanEpisode,
  ForemanInvite,
  MetaSource,
  FleetCost,
  OrphanedQueueHint,
  PaneDialog,
  PendingTurn,
  PermissionMode,
  RateLimits,
  RateLimitWindow,
  RateLimitSource,
  PrChecks,
  PrState,
  ReviewItem,
  ServerEvent,
  Session,
  SessionCost,
  SessionMeta,
  SessionGoal,
  SessionIntentGuard,
  SessionGoalSummary,
  SessionNote,
  SessionNoteSummary,
  SessionQueue,
  SessionQueueSummary,
  SessionState,
  Task,
  TaskSummary,
  ThinkingLevel,
  WorkItem,
  InspectorInspection,
  InspectorSummary,
  RepoPrFeedback,
  InspectionUpdated,
  KeepAwakeStatus,
  RetroSummary,
  SettingsStatus,
} from "@shared/types.ts";
import type { EnsembleSummary, TaskEnsembleLink } from "@shared/ensemble.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import {
  pipelineRunKey,
  pipelineRunKeyOf,
  type PipelineProviderId,
  type PipelineRun,
  type SessionPipelineLink,
} from "@shared/pipeline.ts";
import type {
  HookIngest,
  OtlpMetrics,
  RecordEpisode,
  ResolveEpisode,
  SetGoal,
  SetNote,
  StatusLineIngest,
} from "@shared/protocol.ts";
import { inFlightItem as inFlightItemOf, isTerminalState } from "@shared/queue.ts";
import { noteAwaitsYou } from "@shared/foreman.ts";
import { reportBucket } from "@shared/session.ts";
import { goalLine, resolvedSessionIntent, sessionIntentMatches } from "@shared/goal.ts";
import { fullTaskTitle } from "@shared/title.ts";
import { taskRepoPrSummaries, taskRepoRefs } from "@shared/task-repos.ts";
import { capabilitiesFor, workQueueBlockedReason } from "@shared/harness-capabilities.ts";
import { canWriteTo, muxHandle, paneToken, terminalHomeNames, terminalResourceId, terminalResourceIds, tmuxPaneToken, weztermPaneToken } from "@shared/pane.ts";
import type { EmulatorHandle, MuxHandle, TerminalHandle } from "@shared/terminal.ts";
import type {
  PersonaView,
  SessionAction,
  WorkflowBindingSummary,
  WorkflowCommandView,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@shared/workflow.ts";
import {
  effectiveContextWindow,
  isLongContext,
  modelLabel,
  parseContextWindowSize,
} from "@shared/model.ts";
import type { DiscoveredSession } from "./discovery/correlate.ts";
import type {
  RuntimeMetaRead,
  SdkEvent,
  SdkUsage,
  SessionActivityRead,
  WorkCycleSignal,
} from "./harness/types.ts";
// The one projection of a driver request into the dialog shape every surface already
// renders. Pure and its own module - see `sdk/dialog.ts`.
import { driverDialog } from "./sdk/dialog.ts";
import { settingsStatus } from "./settings-status.ts";
import { hooksFor } from "./harness/index.ts";
import type { HookSpec } from "./harness/types.ts";
// The live catalog is seeded from the Phase 1 store at boot; it is a read of durable state,
// the same shape as `loadActiveTasks` above. The store never imports the registry, so this
// direct import is cycle-free - unlike ensembles, whose projection is a registered callback
// because it runs per session per sweep.
import { listSchedules as loadActiveSchedules } from "./schedules/store.ts";
// The Line's fold. Pure and input-driven (see `line-summary.ts`), so this import brings no
// store with it: everything it reads is gathered by `lineSummaryNow` below.
import type { LineSummary } from "@shared/line.ts";
import { SEVEN_DAY_MS } from "@shared/cost.ts";
import { foldLineSummary, lineSummaryEqual } from "./line-summary.ts";
import { getBacklogPlan } from "./backlog.ts";
import { getTaskSourcesConfig } from "./task-sources/config.ts";
import { taskSourceStatuses } from "./task-sources/sweeper.ts";
import { clampPrompt } from "./util/prompt-text.ts";
// The repository's one segment-safe "is this path at or under that one" predicate. Reached
// for rather than re-spelled as a `startsWith`, which would read `.worktrees/add-widgets` as
// living inside `.worktrees/add`.
import { withinRoot } from "./util/repo-doc.ts";
import { gitInfo } from "./util/git.ts";
import {
  clearPendingTurns as clearPendingTurnsDb,
  clearQueue as clearQueueDb,
  deleteQueueItem,
  deleteTask as dbDeleteTask,
  getQueueItem,
  getQueueRow,
  getSessionGoal,
  getSessionNote,
  listQueueItems,
  listQueueRows,
  listPendingTurns,
  loadActiveTasks,
  loadResourceHoldingTerminalTasks,
  loadPrPendingTerminalTasks,
  loadPendingReviews,
  loadRecentTerminalTasks,
  loadSessionGoals,
  pruneSessionGoals,
  loadSessionNotes,
  loadForemanInvites,
  upsertForemanInvite,
  deleteForemanInvite,
  moveForemanInvite as moveForemanInviteDb,
  pruneForemanInvites as pruneForemanInvitesDb,
  hooksEverSeen,
  lastAgentBinding,
  logEvent,
  markWorkCycleActive,
  completeWorkCycle,
  bootstrapPromptedConsumedGeneration,
  consumePromptedGeneration as dbConsumePromptedGeneration,
  recordAgentBinding,
  rekeyQueue,
  listQueueRowsForCwd,
  countOpenQueueItems,
  pruneDeadQueues,
  pruneEpisodes,
  recordEpisode as dbRecordEpisode,
  resolveEpisode as dbResolveEpisode,
  episodesFor,
  automationEstimatedCostSince,
  automationSpendSince,
  automationTokensSince,
  fleetEstimatedCostSince,
  fleetTokensSince,
  firstWorkEpisodePromptAfter,
  prsOpenedSince,
  pruneUsageLedger,
  pruneUsageSources,
  noteOtelExportSeen,
  recordDriverSessionUsage,
  reorderQueueItems,
  sdkOwnedNoteKey,
  sessionCostFor,
  taskIdForSession as dbTaskIdForSession,
  bindTaskWorkEpisode as dbBindTaskWorkEpisode,
  deleteHistoricalTaskWorkEpisodeBinding,
  deleteSessionWorkEpisode,
  deleteSessionWorkEpisodeWithOwnership,
  deleteWorkEpisodePrompts,
  historicalTaskWorkEpisodeBindings,
  rebindPendingSessionWorkEpisodeWithDependencies,
  replaceSessionWorkEpisode,
  replaceSessionWorkEpisodeWithDependencies,
  sessionWorkEpisodeFor,
  taskWorkEpisodeForSession,
  taskWorkEpisodeForTask,
  taskHasPrCarryingBinding,
  updateWorkEpisodePr,
  primaryRepoPrForTask,
  recordWorkEpisodeRepoPr,
  retargetInspectorPrCheckout,
  taskReposFor,
  workEpisodeRepoPr,
  workEpisodeRepoPrsForTask,
  workCycleFor as dbWorkCycleFor,
  upsertQueue,
  upsertQueueItem,
  upsertSessionGoal,
  upsertSessionNote,
  upsertTask as dbUpsertTask,
  upsertUsageCell,
  loadInspectorInspections,
  markWorkEpisodeMerged,
  type TaskDependencyRewrite,
  recordWorkEpisodePrompt,
  workEpisodePromptIdentities,
} from "./db.ts";
import type { ForemanInviteRow, SessionWorkEpisode, TaskWorkEpisodeBinding, UsageCol } from "./db.ts";
import { refreshScoutPromptTitle } from "./scouts/prompt-journal.ts";
import { unref } from "./util/timers.ts";
import { getInspectorConfig } from "./inspector/config.ts";
import { parsePrUrl } from "./inspector/github.ts";
import { retroSummary } from "./retro-worthiness.ts";

/**
 * A pull request a session's agent was PROVEN to have just opened, carried to whoever
 * is keeping the adoption ledger. Everything but `url` is context for that row: which
 * session, and which checkout to run `gh` from later.
 */
export interface PrOpened {
  url: string;
  sessionId: string;
  cwd: string | null;
  repoRoot: string | null;
}

/**
 * The id space of driver-run sessions.
 *
 * Disjoint from discovery's `proc:<tty>:<pid>:<startMs>` so the two writers into one map
 * cannot collide, and that is ALL it is for: it is validated once, at registration, and
 * nothing else in the codebase may branch on it. `Session.runtime` is the axis - an id
 * prefix is a spelling, and a spelling is exactly what stops being reliable the moment
 * someone needs a second one.
 */
export const SDK_SESSION_ID_PREFIX = "sdk:";

/**
 * What the supervisor has to say to put a driver-run session on the dashboard.
 *
 * The required four are the identity and the checkout; everything else is optional because
 * it is either not known yet (the subprocess pid, which may arrive only when the driver
 * binds) or a fact about the checkout the caller resolves once (the git triple, which
 * discovery computes for a pane-backed session and the supervisor computes for this one).
 * An omitted field is the same "not known" a freshly discovered session carries, never a
 * guess.
 */
export interface SdkSessionRegistration {
  /** `sdk:<uuid>`, minted by the supervisor and durable across a daemon restart. */
  id: string;
  agent: AgentType;
  name: string;
  cwd: string;
  /**
   * The durable harness-native identity when restoring a known conversation.
   *
   * Fresh launches omit it until the driver's `bound` event. Restores already know it from
   * SQLite and must publish it on the first session frame: briefly falling back to the
   * synthetic SDK id makes workflow bindings believe the conversation changed.
   */
  agentSessionId?: string | null;
  /**
   * The lifecycle projection the card carries until the driver reports a state.
   *
   * Omitted for a fresh launch or an interrupted restore, both of which are genuinely
   * starting work. The supervisor passes `idle` only when it is restoring a durable row
   * that owes no turn; the driver's `bound` event then confirms that projection without
   * requiring a harness to manufacture an idle frame.
   */
  initialState?: "starting" | "idle";
  pid?: number;
  permissionMode?: PermissionMode | null;
  gitBranch?: string | null;
  gitRoot?: string | null;
  repoRoot?: string | null;
  /** Injectable clock, for the same reason every other seam in here has one: tests. */
  now?: number;
}

/** A task whose work landed: the PR of the episode it was bound to merged. */
export interface TaskPrMerged {
  taskId: string;
  sessionId: string;
  /** The episode that merged. Compared later against the session's current one. */
  episodeId: string;
  url: string;
  mergedAt: number;
}

/** An open-or-merged PR the poller matched to a session's current branch. */
export type PrMatch = {
  url: string;
  number: number | null;
  state: PrState;
  /** Rolled-up CI status for the PR, or null when it carries no checks. */
  checks: PrChecks | null;
  branch: string;
  agentSessionId: string | null;
  episodeId: string | null;
  createdAt: number | null;
  mergedAt: number | null;
  headSha: string | null;
  worktreeHeadSha: string | null;
};

export type PrObservation = {
  url: string;
  branch: string | null;
  agentSessionId: string | null;
  episodeId: string;
  headSha: string | null;
};

/**
 * One SECONDARY repository of a live multi-repo task, as the branch poller has to ask about
 * it: which worktree to run `gh` in, and which branch to ask for.
 *
 * Keyed by `(session, repo)` rather than by session alone, which is the whole reason this is
 * a separate harvest from `prPollTargets`: one session can be waiting on a pull request in
 * each of several repositories at once, and a session-keyed map has room for one.
 */
export interface RepoPrPollTarget {
  /** `${sessionId}\0${repoRoot}` - what the poller keys its results by. */
  key: string;
  sessionId: string;
  taskId: string;
  repoRoot: string;
  /** The attached repo's provisioned worktree - where `gh` resolves this repo from. */
  cwd: string;
  branch: string;
  agentSessionId: string | null;
  episodeId: string | null;
}

/** The `(session, repo)` key a repo poll result is carried under. */
export function repoPrTargetKey(sessionId: string, repoRoot: string): string {
  return `${sessionId}\0${repoRoot}`;
}

/** One repository's open pull request as the last poll saw it. See `Registry.livePrs`. */
interface LivePrObservation {
  url: string;
  number: number;
  checks: PrChecks | null;
}

/** How many finished tasks to rehydrate on start, so "recent outcomes" survives a restart. */
const RECENT_TERMINAL_TASKS = 50;
const DEFAULT_WORK_BRANCHES = new Set(["main", "master"]);

/** How long an exited session lingers on the dashboard before removal (ms). */
const EXIT_LINGER_MS = 8000;
/**
 * How long a FINISHED, session-less queue is kept before it's pruned.
 *
 * Generous on purpose. Nothing can act on such a queue any more - the only thing
 * that reads it is the re-attach hint, which skips it because it has no open items -
 * so this is a floor on how long its record stays legible to a human going back
 * through what a batch did, not a bound on anything the system needs. A queue with
 * open work is never pruned at any age; see `pruneDeadQueues`.
 */
const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a Foreman episode is kept.
 *
 * Shorter than a gate byline and longer than a queue, because it is read for a
 * different span than either: the drawer answers "what has Foreman been deciding on
 * this session", which is a question about recent judgment, not about a branch that
 * may sit open for months. The rows are also the fattest of the three - each can
 * carry a whole pane capture - so generosity costs more here than it does there.
 */
const EPISODE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a usage-ledger row is kept.
 *
 * The most generous of the four, because it is the only one whose value is CUMULATIVE:
 * every other record answers a question about one session, while these rows are summed
 * to answer "what was the fleet's API-equivalent estimate last quarter". Deleting one does
 * not make a record less legible, it makes a total wrong. Two quarters is enough to compare
 * one against the last; the rows are a handful of numbers each, on a table that grows with
 * export windows rather than with events, so generosity is nearly free here.
 */
const USAGE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/** How often the retention sweep runs. It rides the discovery sweep, which is ~1.5s. */
const QUEUE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Floor on how often the fleet estimate figures are recomputed off the back of a sweep.
 *
 * The sweep is ~1.5s and this is two SUM queries on the synchronous handle that also
 * serves hook ingest and SSE, so it is not free. Nothing here is urgent either: an
 * ingest recomputes immediately (that is when the number actually changed), and this
 * exists only so a QUIET fleet still rolls "today" over at midnight and lets the recent
 * rate decay instead of freezing at the last export's value.
 */
const FLEET_COST_IDLE_INTERVAL_MS = 30 * 1000;
/**
 * Floor on how often the Line refolds off the back of a sweep.
 *
 * The event-driven path (`LINE_INPUT_EVENTS`) covers everything that arrives as an SSE
 * event, which is most of it. This covers the rest, and it is a real remainder rather than
 * belt-and-braces: a task-source sweep that succeeds moves `lastSweepAt` without emitting
 * anything, Foreman's plan write moves "next up" through a route that emits nothing, and
 * the strip's own relative times ("swept 4m ago", "next mission in 3h") go stale on a fleet
 * where literally nothing happened. Thirty seconds is under the minute those strings are
 * quantised to, so they never skip a value; the change-gate means a genuinely still fleet
 * still emits nothing.
 */
const LINE_IDLE_INTERVAL_MS = 30 * 1000;
/**
 * The events whose payload is an input to the Line's fold.
 *
 * Reviews are deliberately absent even though a pending review is exactly what makes a
 * session "need you": the fold reads `Session.pendingReviews`, which is denormalized onto
 * the session and emitted as `session_upsert`, so the review's own frame would buy a second
 * identical fold. Personas, workflow definitions and session actions are absent because
 * they are authoring state - the Line is about execution. `line_summary` is absent for the
 * obvious reason.
 *
 * A new event type is NOT automatically a member. Adding one means asking whether it names
 * a store the strip reads; if it does, it belongs here and in `LineFoldInput`.
 */
const LINE_INPUT_EVENTS = new Set<ServerEvent["type"]>([
  "session_upsert",
  "session_remove",
  "task_upsert",
  "task_remove",
  "workflow_run_upsert",
  "workflow_run_remove",
  "ensemble_upsert",
  "ensemble_remove",
  "schedule_upsert",
  "schedule_remove",
  // Moves the Shipped stage's per-PR figure.
  "cost_fleet",
  // Moves the Intake stage's tone: `taskSources.failing` and this tuple are the same read.
  "settings_status",
  // Changes which model/effort/runtime the NEXT dispatch uses, so the pickers naming those
  // defaults have to re-read rather than wait out a poll.
  "harnesses_config_changed",
  // Deliberately absent: worktree inventory and policy do not feed the Line's execution
  // fold. Its content-free event only tells an open Settings panel to re-observe.
  // `pipeline_upsert` / `pipeline_remove` are DELIBERATELY absent, and the question was
  // asked rather than skipped. The Line folds Mission Control's own execution - its
  // sessions, tasks, runs and ensembles - and a pipeline run is a second engine's, which
  // the fold has no input for and could not count without double-counting the session the
  // engine spawned (which the strip already sees, as a session). What a halted pipeline
  // owes an operator is attention, not a stage figure, and that is phase 3's
  // `pipeline_halt` item - which reaches the strip through the attention fold this set
  // does not feed.
]);
/** Hook overlays older than this are ignored/pruned (a session went quiet). */
const OVERLAY_TTL_MS = 30 * 60 * 1000;
/**
 * How long a Claude statusLine reading stays authoritative. While fresh, the
 * passive transcript poller won't overwrite it (statusLine is exact + carries
 * thinking level). Once a session goes quiet past this, the transcript read is
 * allowed to take over so an idle card doesn't freeze on a stale exact figure.
 */
const STATUSLINE_TTL_MS = 3 * 60 * 1000;

/**
 * Passive effort revisions are source-specific. Codex supplies ISO timestamps, which
 * we can order; Claude supplies record UUIDs, which we cannot. A different opaque
 * revision is therefore not evidence that the read happened after a verified change.
 */
function isLaterEffortRevision(previous: string | null, next: string | null): boolean {
  if (previous === null || next === null) return false;
  const previousTime = Date.parse(previous);
  const nextTime = Date.parse(next);
  return Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime > previousTime;
}

/** Hook-derived state for a session, applied over passive discovery. */
interface HookOverlay {
  /**
   * The harness whose bridge produced this. Overlays are keyed by PANE, and a pane
   * outlives the agent in it: quit Claude, start Codex in the same tmux pane, and
   * without this the Codex card inherits Claude's last state, activity, permission mode
   * and transcript path - reported as `instrumented`, from an agent that pushes nothing.
   * A hookless harness is supposed to fall through to the passive path, and this is what
   * keeps it there.
   */
  agent: AgentType;
  agentSessionId: string | null;
  transcriptPath: string | null;
  state: SessionState;
  activity: string | null;
  /** Last-known harness permission mode; sticky across events that omit it. */
  permissionMode: PermissionMode | null;
  lastActivity: number;
  updatedAt: number;
}

/**
 * Transcript-derived state for a session, applied in `mergeDiscovered` ONLY when no
 * fresh hook overlay exists. The hook-free fallback that keeps a quiet session's
 * queue moving: unlike a `HookOverlay` it needs no live event to refresh it - the
 * passive poller re-derives it from the on-disk transcript every tick - so it
 * survives both a daemon restart and a session going silent past the overlay TTL.
 */
interface PassiveState {
  /** Synthetic process identity. A pane can outlive the process that produced this read. */
  sessionId: string;
  /** Conversation identity at the time of the read; catches /clear on the same process. */
  agentSessionId: string | null;
  /** Exact passive source where discovery could name it. */
  transcriptPath: string | null;
  state: SessionState;
  /** Epoch ms of the newest transcript record (drives `settledIdle`'s settle gap). */
  lastActivity: number;
  /** When the poller last refreshed this read; bounds staleness if the poller stalls. */
  updatedAt: number;
}

/**
 * In-memory source of truth for live sessions and pending reviews. Emits a
 * `ServerEvent` on every change; the SSE layer forwards those to browsers.
 *
 * Terminal sessions are keyed by their synthetic discovery id (tty+pid+start). Hook
 * events cannot see that id, so they bind through a terminal-pane overlay that survives
 * the next discovery sweep. SDK sessions use the supervisor's durable `sdk:<uuid>` and
 * report directly through the handle that owns that entry.
 */
export class Registry extends EventEmitter {
  private sessions = new Map<string, Session>();
  private prObservations = new Map<string, PrObservation>();
  /**
   * Pull requests each session has already been announced as the author of.
   *
   * See `announcePrOpened`. In memory and per session, because the durable half of this
   * fact is the adoption row the announcement produces.
   */
  private announcedPrs = new Map<string, Set<string>>();
  /**
   * Last observed head of each multi-repo worktree the completion quorum asks about, by
   * path. A `null` value is "we looked and could not answer"; a MISSING key is "nothing has
   * looked yet", and the quorum holds on that rather than concluding. See
   * `recordWorktreeHeads`.
   */
  private worktreeHeads = new Map<string, string | null>();
  /** Re-entrancy state for `emitEvent`: a change announced from inside another's delivery. */
  private emitting = false;
  private emitQueue: ServerEvent[] = [];
  private reviews = new Map<string, ReviewItem>();
  private tasks = new Map<string, Task>();
  /** Reusable workflow Personas, including archived rows for durable history links. */
  private personas = new Map<string, PersonaView>();
  /**
   * Reusable SessionActions, including archived rows for durable history links.
   *
   * The FULL record rides the snapshot, prompt Markdown included, exactly as a Persona's
   * guidance does. Measured against that precedent rather than assumed: the four shipped
   * Personas already carry roughly 60 KB of guidance in every snapshot, and one shipped
   * action's prompt is under 2 KB. A detail-only fetch is the right answer if this catalog
   * ever grows large, and `session-action-sse.test.ts` pins the current size so making that
   * switch has to be a decision rather than an accident.
   */
  private sessionActions = new Map<string, SessionAction>();
  /**
   * The Global Command catalog, one entry per built-in slot and never more.
   *
   * Bounded by construction rather than by policy: the map's key space is the append-only
   * slot list, so this collection cannot grow with operator data the way a Persona catalog
   * can. Its bytes scale only with the overrides an operator wrote, each of them a path and
   * a short argv.
   */
  private workflowCommands = new Map<string, WorkflowCommandView>();
  /** Bounded catalog projections only; full drafts and guidance stay on HTTP. */
  private workflowSummaries = new Map<string, WorkflowSummary>();
  /** Compact execution projections only. Graphs, evidence, and timelines stay on HTTP. */
  private workflowRuns = new Map<string, WorkflowRunSummary>();
  /**
   * What each conversation is ARMED with, as distinct from what is running on it.
   *
   * Separate from `workflowRuns` because the two answer different questions and a binding
   * outlives every run it starts - under the `foreman_complete` trigger it precedes the first
   * run by the whole length of the session's work. Archived bindings never enter.
   */
  private workflowBindings = new Map<string, WorkflowBindingSummary>();
  /** Compact ensemble projections only. Members, artifacts and evaluations stay on HTTP. */
  private ensembles = new Map<string, EnsembleSummary>();
  /**
   * The live Recurring Missions catalog: non-archived schedules only.
   *
   * A cache and a notifier, never a second persistence authority - the schedule service is
   * the only writer, and it calls `upsertSchedule`/`removeSchedule` here AFTER its durable
   * write returns. Occurrence history stays out of this map on purpose: it is page-oriented
   * and fetched on demand, not live catalog state.
   */
  private schedules = new Map<string, MissionSchedule>();
  /**
   * The pipeline projection, keyed `provider repoRoot slug` (see `pipelineRunKey`).
   *
   * A cache and a notifier, exactly like `schedules`: the pipelines watcher is the only
   * writer of `pipeline_runs`, and it calls `upsertPipelineRun` / `removePipelineRun`
   * here AFTER its durable write returns.
   *
   * Bounded by operator consent rather than by history. It holds one entry per feature
   * currently in an enabled repository's provider worktrees; a feature whose worktree is
   * gone leaves through `pipeline_remove`, and a repository whose consent is withdrawn
   * takes all of its entries with it. On the shipped configuration - no provider enabled
   * anywhere - it is empty and stays empty.
   */
  private pipelineRuns = new Map<string, PipelineRun>();
  /**
   * How a task finds out it is an ensemble member.
   *
   * Registered by the daemon rather than imported, so nothing in here has to know what an
   * ensemble store is - the same seam `registerWorkflowReset` uses. Null until the manager
   * is constructed, which is also every build and test that has no ensembles at all.
   */
  private ensembleProjection: ((taskId: string) => TaskEnsembleLink | null) | null = null;
  private workflowReset: ((noteKey: string) => void) | null = null;
  /** A terminal side effect must not cross the asynchronous reset boundary. */
  private resettingSessionCounts = new Map<string, number>();
  /** Foreman notes keyed by note key (agentSessionId ?? synthetic id). */
  private notes = new Map<string, SessionNote>();
  /** Session goals, keyed by the SAME note key - a sibling record, not part of the note. */
  private goals = new Map<string, SessionGoal>();
  /**
   * Foreman invites, keyed by the SAME note key. In memory like notes/goals because
   * `foremanInviteFor` runs per session per ~1.5s sweep, and a per-sweep SELECT is the
   * exact cost the note cache exists to avoid. Holds every row, the `'withdrawn'`
   * tombstones included - resolution, not storage, is where the tombstone becomes null.
   */
  private invites = new Map<string, ForemanInviteRow>();
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private driverDialogs = new Map<string, PaneDialog[]>();
  /** overlay keyed by pane token ("tmux:%12" | "wezterm:12") - see `@shared/pane.ts`. */
  private overlays = new Map<string, HookOverlay>();
  /** Transcript-derived state keyed by pane token and attributed inside the value to
   *  the process + conversation that produced it. Consulted only when a session has
   *  no fresh hook overlay. See `PassiveState` and `applyPassiveActivity`. */
  private passiveStates = new Map<string, PassiveState>();
  private observedEfforts = new Map<string, {
    agentSessionId: string | null;
    transcriptPath: string | null;
    modelId: string | null;
    previous: ThinkingLevel;
    effort: ThinkingLevel;
    effortRevision: string | null;
    statusLineTimestamp: number | null;
    verifiedAt: number;
  }>();
  private runtimeEffortRevisions = new Map<string, string | null>();
  private statusLineTimestamps = new Map<string, number>();
  private effortFreshnessGuards = new Map<string, {
    agentSessionId: string | null;
    transcriptPath: string | null;
    model: string | null;
    modelId: string | null;
    effortRevision: string | null;
    statusLineTimestamp: number | null;
    verifiedAt: number;
  }>();
  /**
   * A menu selection is visible immediately, but Codex does not append its new
   * `turn_context` until the next turn. Hold that verified selection over passive
   * rollout reads until their own timestamp proves they happened afterwards.
   */
  private permissionModeFreshnessGuards = new Map<string, {
    agentSessionId: string | null;
    transcriptPath: string | null;
    verifiedAt: number;
  }>();
  /**
   * What DISCOVERY said this session's conversation is, keyed by synthetic id - the
   * subset of `Session.agentSessionId` / `transcriptPath` that was read off the live
   * process itself (the rollout an exact pid holds open, via `annotateCodexRollouts`).
   *
   * Kept apart from the session because the field on the session is not the same claim.
   * There it is the last binding we LEARNED, from a hook or from `lastAgentBinding` after
   * a restart, and a `/clear` is supposed to replace it. Here it is evidence from the
   * process table, which a hook cannot contradict - so this, and only this, is what
   * `applyHook` refuses a mismatching event against. Reading the session's own field
   * instead makes the guard reject the rebinding it exists to protect.
   */
  private discoveredIdentity = new Map<string, { agentSessionId: string | null; transcriptPath: string | null }>();
  /** Whether a discovery sweep has ever completed - see `sessionsObserved`. */
  private sweptSessions = false;
  /** The Inspector's ledger, by PR key. Rebuilt from the DB; see `refreshInspections`. */
  private inspections = new Map<string, InspectorInspection>();
  /**
   * The last poll's answer for each `(session, repo)` of a multi-repo task, while it was OPEN.
   *
   * The per-repository twin of the `prUrl`/`prNumber`/`prChecks` scalars `reconcilePrs` writes
   * onto a session, and it exists because those scalars answer for the session's own checkout
   * only: a secondary repository's pull request is polled (`extraRepoPrPollTargets` gives it
   * its own `gh` call) and its checks were then thrown away, so nothing downstream could tell
   * a red sibling from a green one.
   *
   * In memory and RETRACTED, unlike the durable per-repo association in `work_episode_prs`.
   * That association is never taken back once made - a card and the completion quorum need it
   * to survive the worktree - but "is there an open pull request here right now" is an
   * observation, and Foreman types instructions off it. A poll that reports no open pull
   * request for a repository deletes its entry; a poll that ERRORED (`skip`) changes nothing,
   * because `gh` failing says nothing about the pull request.
   */
  private livePrs = new Map<string, LivePrObservation>();
  /**
   * Session ids whose transcript has shown a human turn beyond the opening brief.
   *
   * Written only by `recordRetroCorrections` and held until the session ROW is removed, not
   * until the session exits: an exited card still offers a retro (the route files a task for
   * it), so forgetting the reason the moment the agent stopped would withdraw the offer at
   * precisely the moment it is most likely to be taken.
   *
   * In memory rather than persisted, like the injection attribution it depends on. A daemon
   * restart therefore loses it and the poller rebuilds what it can from the transcript still
   * on disk - which is the honest behaviour, since `originOf` cannot re-derive who typed a
   * turn it never saw delivered.
   */
  private retroCorrections = new Set<string>();
  private lastQueuePrune = 0;
  /**
   * The last rate-limit reading either Claude live transport reported.
   *
   * ONE value for the whole registry, not one per session, because that is what the fact
   * is: a five-hour window is a property of the ACCOUNT, and every session on the machine
   * reports the same one. Held in memory and never persisted - it is a live gauge with a
   * server-supplied reset time, and a stored percentage would be read as current long
   * after it stopped being true.
   */
  private latestRateLimits: RateLimits | null = null;
  private latestRateLimitSources = new Map<AgentType, RateLimitSource>();
  /** Last fleet figures emitted, so an unchanged recompute doesn't wake every browser. */
  private lastFleetCost: FleetCost | null = null;
  private lastFleetCostAt = 0;
  /** Last settings tuple emitted, so an unchanged config write wakes no browser either. */
  private lastSettingsStatus: SettingsStatus | null = null;
  /**
   * The current Keep Awake observation, held for the snapshot and emitted on change.
   *
   * Held rather than computed: the manager owns the child process and pushes every
   * transition through `setKeepAwakeStatus`, so this cache IS the daemon's answer. The
   * default is a truthful placeholder for a registry no manager has seeded yet (the
   * ~20 hand-built route-test registries): unsupported and off, which a browser renders
   * as unavailable rather than as a claim about host power state. `src/server/index.ts`
   * seeds the real status before the server accepts traffic. Deliberately TRANSIENT -
   * a new daemon always snapshots `off`, which is the approved restart-reset behavior.
   */
  private keepAwake: KeepAwakeStatus = {
    supported: false,
    unavailableReason: "this daemon did not initialize a keep-awake provider",
    state: "off",
    provider: null,
    since: null,
    error: null,
  };
  /** Last Line fold emitted, for the same reason as the two above. */
  private lastLineSummary: LineSummary | null = null;
  private lastLineSummaryAt = 0;
  /**
   * The pending coalesced fold, or null when none is scheduled.
   *
   * The Line's inputs are five stores plus two config blobs, and they move CONSTANTLY: one
   * discovery sweep emits a session upsert per session, and a busy workflow emits a run
   * upsert per node. Recomputing per mutation - which is what `cost_fleet` does, because its
   * ingest points are few and each one genuinely changed a figure - would run the fold, its
   * two zod parses and its `COUNT` a dozen times to produce one identical answer.
   *
   * `setImmediate`, not a millisecond debounce: it fires at the end of the current event-loop
   * turn, which is exactly the boundary a sweep or an HTTP handler completes on, so a burst
   * collapses to one fold with no added latency and nothing to tune. Unreffed, so a pending
   * fold never holds the process open at shutdown.
   */
  private lineRecomputeHandle: ReturnType<typeof setImmediate> | null = null;

  constructor() {
    super();
    for (const r of loadPendingReviews()) this.reviews.set(r.id, r);
    for (const n of loadSessionNotes()) this.notes.set(n.noteKey, n);
    for (const g of loadSessionGoals()) this.goals.set(g.noteKey, g);
    for (const i of loadForemanInvites()) this.invites.set(i.noteKey, i);
    for (const t of loadActiveTasks()) this.tasks.set(t.id, t);
    for (const t of loadRecentTerminalTasks(RECENT_TERMINAL_TASKS)) this.tasks.set(t.id, t);
    // Always load terminal tasks that still hold resources so they get reconciled, even if newer
    // terminal tasks would push them past the recent cap.
    for (const t of loadResourceHoldingTerminalTasks()) this.tasks.set(t.id, t);
    // And the same for terminal tasks whose OUTCOME is still open - a failed or cancelled row
    // whose pull request has yet to be seen merged. Past the cap it would not be loaded, so
    // nothing would poll that pull request and the merge would never be observed.
    for (const t of loadPrPendingTerminalTasks()) this.tasks.set(t.id, t);
    for (const row of loadInspectorInspections()) this.inspections.set(row.key, row);
    // Seed the live catalog so a reconnect snapshot is truthful before the scheduler's first
    // tick. Empty on every machine that has never saved a schedule.
    for (const s of loadActiveSchedules()) this.schedules.set(s.id, s);
    this.hydrateTaskDependencyProvenance();
    this.cleanupDependencyProvenance();
  }

  snapshot(): {
    sessions: Session[];
    reviews: ReviewItem[];
    tasks: Task[];
    personas: PersonaView[];
    sessionActions: SessionAction[];
    workflowCommands: WorkflowCommandView[];
    workflowSummaries: WorkflowSummary[];
    workflowRunSummaries: WorkflowRunSummary[];
    workflowBindingSummaries: WorkflowBindingSummary[];
    ensembleSummaries: EnsembleSummary[];
    schedules: MissionSchedule[];
    pipelineRuns: PipelineRun[];
    fleetCost: FleetCost | null;
    lineSummary: LineSummary;
    settingsStatus: SettingsStatus;
    keepAwake: KeepAwakeStatus;
  } {
    return {
      sessions: [...this.sessions.values()],
      reviews: [...this.reviews.values()],
      tasks: [...this.tasks.values()],
      personas: [...this.personas.values()],
      sessionActions: [...this.sessionActions.values()],
      workflowCommands: [...this.workflowCommands.values()],
      workflowSummaries: [...this.workflowSummaries.values()],
      workflowRunSummaries: [...this.workflowRuns.values()],
      workflowBindingSummaries: [...this.workflowBindings.values()],
      ensembleSummaries: [...this.ensembles.values()],
      schedules: [...this.schedules.values()],
      // Seeded from the projection at boot, so a dashboard connecting before the watcher's
      // first pass is already right rather than blank for one tick. Empty on every fleet
      // that has enabled no pipeline repository.
      pipelineRuns: [...this.pipelineRuns.values()],
      // Computed on demand rather than served from `lastFleetCost`, which is null until
      // the first ingest: a dashboard opened before any export would otherwise show a
      // blank strip over a ledger that already holds a week of estimated usage.
      fleetCost: this.fleetCostNow(),
      // Folded fresh rather than served from `lastLineSummary`, which is null until the
      // first mutation: the strip is permanent chrome, so a dashboard opened onto a quiet
      // fleet must read "nothing waiting · no sessions open" rather than six blanks.
      lineSummary: this.lineSummaryNow(),
      // Composed fresh for the same reason: the rail dots and gear must be right on the
      // first render, not blank until the next config write happens to change something.
      settingsStatus: settingsStatus(),
      // The held observation, not a recompute: the manager pushes every transition here,
      // and a daemon that just started holds the seeded `off` - which is exactly the
      // restart-reset a reconnecting dashboard must converge on.
      keepAwake: this.keepAwake,
    };
  }

  /**
   * Adopt the manager's Keep Awake observation, dropping a frame that restates the last
   * one. The suppression mirrors `emitSettingsStatus`: the manager publishes on every
   * transition attempt, and an idempotent re-request (double-enable from two windows)
   * must not wake every browser with a status none of them can see move.
   */
  setKeepAwakeStatus(status: KeepAwakeStatus): void {
    const prev = this.keepAwake;
    const same =
      prev.supported === status.supported &&
      prev.unavailableReason === status.unavailableReason &&
      prev.state === status.state &&
      prev.provider === status.provider &&
      prev.since === status.since &&
      prev.error === status.error;
    this.keepAwake = status;
    if (same) return;
    this.emitEvent({ type: "keep_awake_status", status });
  }

  /**
   * Emit the settings status tuple, dropping a frame that restates the last one.
   *
   * The suppression mirrors `recomputeFleetCost`: `publishSettingsStatus` recomposes on
   * every config write and after every sweep, so without this an operator toggling one
   * source's interval would push an identical tuple to every open dashboard. The compare
   * is a shallow field walk - the shape is a handful of small scalars, so `byJson` would be
   * the same answer at more cost.
   *
   * **Every field of the tuple has to appear below.** A field left out is not merely
   * compared loosely: it is a field whose CHANGE is silently dropped, because a tuple that
   * moved only there compares equal and no frame is sent. The `pipelines` pair was missing
   * when it arrived, which meant the promise that installing the engine makes the Conductor
   * row appear "while you are still looking for it" was answered by a frame this method
   * threw away - and the row waited for whatever unrelated setting moved next.
   */
  emitSettingsStatus(status: SettingsStatus): void {
    const prev = this.lastSettingsStatus;
    const same =
      prev != null &&
      prev.inspector.enabled === status.inspector.enabled &&
      prev.inspector.mode === status.inspector.mode &&
      prev.shipping.autoMerge === status.shipping.autoMerge &&
      prev.taskSources.failing === status.taskSources.failing &&
      prev.pipelines.present === status.pipelines.present &&
      prev.pipelines.observing === status.pipelines.observing;
    this.lastSettingsStatus = status;
    if (same) return;
    this.emitEvent({ type: "settings_status", status });
  }

  /**
   * Announce that the per-harness dispatch defaults were rewritten.
   *
   * No no-change suppression, unlike `emitSettingsStatus`: this frame carries no body to
   * compare (see the event's declaration), and it is emitted only from the one route that
   * writes the config, so there is no recompute-driven caller to debounce. A write that
   * happens to store an identical config costs one re-read in each open dashboard.
   */
  emitHarnessesConfigChanged(): void {
    this.emitEvent({ type: "harnesses_config_changed" });
  }

  /** Announce that the bounded Worktrees route should be re-observed. */
  emitWorktreesChanged(): void {
    this.emitEvent({ type: "worktrees_changed" });
  }

  /**
   * Announce that the local archive library moved.
   *
   * Raised once per reconciliation BATCH by the archive manager, never per bundle: the
   * reconciler already coalesces a pass into one decision about whether derived state
   * changed, and this is the frame that carries it. Content-free for the reason the event's
   * declaration gives - archive history is bounded, filtered, paginated HTTP state, and it
   * stays out of both this frame and the reconnect snapshot.
   */
  emitArchiveChanged(): void {
    this.emitEvent({ type: "archive_changed" });
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Surface an accepted SDK stop while its driver drains.
   *
   * This is deliberately NOT eviction. The card remains registered, no durable subscriber
   * runs, and only the driver's later `exited` event may enter `beginEviction`. The previous
   * presentation fields are returned so the supervisor can put the card back if requesting
   * the stop itself fails while the handle is still live.
   */
  markSessionStopping(id: string): Pick<Session, "state" | "stateConfirmed" | "activity" | "lastActivity"> | null {
    const session = this.sessions.get(id);
    if (!session || session.state === "exited") return null;
    const previous = {
      state: session.state,
      stateConfirmed: session.stateConfirmed,
      activity: session.activity,
      lastActivity: session.lastActivity,
    };
    if (session.state === "stopping") return previous;
    const now = Date.now();
    const stopping: Session = {
      ...session,
      state: "stopping",
      stateConfirmed: true,
      activity: null,
      lastActivity: now,
    };
    this.sessions.set(id, stopping);
    this.emitSession(stopping);
    return previous;
  }

  /** Undo only the transient presentation written by `markSessionStopping`. */
  restoreSessionAfterStopFailure(
    id: string,
    previous: Pick<Session, "state" | "stateConfirmed" | "activity" | "lastActivity">,
  ): void {
    const session = this.sessions.get(id);
    if (!session || session.state !== "stopping") return;
    const restored: Session = { ...session, ...previous };
    this.sessions.set(id, restored);
    this.emitSession(restored);
  }

  /** Resolve a durable conversation key back to its current live session. */
  sessionForNoteKey(noteKey: string): Session | undefined {
    let owner: Session | undefined;
    for (const session of this.sessions.values()) {
      if (session.state === "exited" || noteKeyFor(session) !== noteKey) continue;
      if (owner) return undefined;
      owner = session;
    }
    return owner;
  }

  beginSessionReset(id: string): void {
    this.resettingSessionCounts.set(id, (this.resettingSessionCounts.get(id) ?? 0) + 1);
  }

  endSessionReset(id: string): void {
    const count = this.resettingSessionCounts.get(id);
    if (!count || count === 1) {
      this.resettingSessionCounts.delete(id);
      return;
    }
    this.resettingSessionCounts.set(id, count - 1);
  }

  sessionResetInProgress(id: string): boolean {
    return this.resettingSessionCounts.has(id);
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }

  onSessionsObserved(fn: () => void): () => void {
    if (this.sweptSessions) {
      fn();
      return () => {};
    }
    this.once("sessions_observed", fn);
    return () => this.off("sessions_observed", fn);
  }

  /**
   * Fired when a hook PROVED a session's agent just ran `gh pr create`.
   *
   * Separate from `subscribe` because this is not a state change anyone renders - it
   * is a one-shot fact about consent, and the only listener is the Inspector's
   * adoption ledger. Pushed rather than polled precisely because nothing persists it:
   * `Session.prUrl` is rebuilt from the OS every sweep and says nothing about who
   * opened the PR, so if this event isn't caught as it happens the proof is gone and
   * the PR is indistinguishable from a stranger's forever after.
   *
   * Listeners must not throw; `applyHook` is on the hook-ingest path.
   */
  onPrOpened(fn: (e: PrOpened) => void): () => void {
    this.on("pr_opened", fn);
    return () => this.off("pr_opened", fn);
  }

  /** A projected pipeline moved, including the boot-time projection restore. */
  onPipelineRun(fn: (run: PipelineRun) => void): () => void {
    this.on("pipeline_run", fn);
    return () => this.off("pipeline_run", fn);
  }

  /**
   * Fired ONCE as a session starts being evicted, while its row and its transcript still
   * exist.
   *
   * The window this exists for is small and shuts hard: `beginEviction` gives a session
   * `EXIT_LINGER_MS` before `remove` deletes it, and that is SHORTER than some pollers'
   * intervals - so "catch it on the next tick" is not a strategy, it is a race that the
   * poller usually loses. A subscriber gets the transition itself instead.
   *
   * Deliberately not `session_remove`: by then the row is gone, and a listener that wanted
   * to record something ABOUT the session would have nowhere to put it.
   */
  onSessionExit(fn: (s: Session) => void): () => void {
    this.on("session_exit", fn);
    return () => this.off("session_exit", fn);
  }

  /**
   * Fired when the pull request a TASK's work episode produced was observed merged.
   *
   * Emitted from `reconcileWorkEpisodeMerge`, which is the one place both merge
   * observers converge: the per-session branch queries and the shared by-URL queries. That
   * matters more than it looks. Hanging this off YOLO mode's `maybeMerge` instead would
   * cover only the merges Mission Control performs, leaving a PR the OPERATOR merged to
   * strand its task exactly as before - and YOLO is off by default, so the fix would
   * ship dark. Hanging it off `Session.prState` would not work at all: this function
   * clears the match on merge, so the session never durably reads `merged`.
   *
   * NOT "the task is over". For a live task on the current binding, the merge is one half
   * of that answer and the agent having finished its episode is the other, which only
   * `TaskManager` can weigh - see `settleMergedTask`. What is announced here is the merge
   * of a current task binding, once.
   *
   * Listeners must not throw; this runs inside the PR poller's reconciliation.
   */
  onTaskPrMerged(fn: (e: TaskPrMerged) => void): () => void {
    this.on("task_pr_merged", fn);
    return () => this.off("task_pr_merged", fn);
  }

  /**
   * Fired once per by-URL reconciliation pass that recorded at least one merge.
   *
   * The periodic backstop behind session-independent completion, and deliberately not a
   * second timer: the PR poller's own tick is the clock. `task_pr_merged` above cannot
   * serve this - it announces only a current task binding, and its consumer handles only
   * live `running`/`dispatching` tasks. Historical bindings and already-terminal rows are
   * exactly what this signal must also wake. This says only "the durable record moved",
   * leaving `TaskManager.reconcileMergedTasks` to decide what that completes: the Registry
   * stores, the TaskManager decides, the same split `session_remove` makes.
   *
   * Listeners must not throw; this runs inside the PR poller's reconciliation.
   */
  onPrMergesRecorded(fn: () => void): () => void {
    this.on("pr_merges_recorded", fn);
    return () => this.off("pr_merges_recorded", fn);
  }

  /** Internal Inspector-to-workflow wakeup. This is deliberately not browser SSE. */
  onInspectionUpdated(fn: (e: InspectionUpdated) => void): () => void {
    this.on("inspection_updated", fn);
    return () => this.off("inspection_updated", fn);
  }

  /**
   * Refresh one adopted ledger row and report the GitHub observation that caused it.
   * Finding bodies stay in SQLite; the signal carries only the compact inspection row.
   */
  inspectionUpdated(
    prKey: string,
    observedHeadSha: string | null,
    observedState: InspectionUpdated["observedState"],
    observedAt = Date.now(),
  ): void {
    const ledger = loadInspectorInspections().find((row) => row.key === prKey);
    if (!ledger) return;
    this.inspections.set(prKey, ledger);
    this.emit("inspection_updated", {
      prKey,
      observedHeadSha,
      observedState,
      observedAt,
      ledger,
    } satisfies InspectionUpdated);
  }

  /** Wake adopted gates after settings change without pretending GitHub was observed. */
  inspectorConfigChanged(now = Date.now()): void {
    for (const row of loadInspectorInspections()) {
      this.inspections.set(row.key, row);
      this.emit("inspection_updated", {
        prKey: row.key,
        observedHeadSha: null,
        observedState: null,
        observedAt: now,
        ledger: row,
      } satisfies InspectionUpdated);
    }
  }

  /**
   * Broadcast one change, and keep a change CAUSED BY that broadcast behind it.
   *
   * The queue is the whole of this. Listeners run synchronously, and one of them - the task
   * manager - concludes work from what it just heard: a `session_upsert` carrying a merged
   * pull request makes it complete the task, which writes a new session entry and emits
   * again, from inside the first emit. Delivered depth-first, the browser then receives the
   * CONSEQUENCE before the event that caused it, and last-write-wins leaves it holding the
   * stale one - a finished task drawn as still running, for as long as nothing else happens
   * to that session. Which, for a task that has just finished, is a long time.
   *
   * So a nested emit is queued and delivered after the outer one drains, and the wire order
   * matches the order the store actually moved in. Still fully synchronous by the time this
   * returns, which every caller and every test that asserts straight after an `applyHook` or
   * a `reconcilePrs` depends on - this is a reordering, not a deferral.
   */
  private emitEvent(e: ServerEvent): void {
    if (this.emitting) {
      this.emitQueue.push(e);
      return;
    }
    this.emitting = true;
    try {
      this.deliverEvent(e);
      // `shift` rather than a for-of: a delivery can queue more, and those belong at the
      // back of this same drain rather than in a second one.
      while (this.emitQueue.length > 0) this.deliverEvent(this.emitQueue.shift()!);
    } finally {
      this.emitting = false;
      // A listener that threw abandons the drain; clearing keeps the next emit from
      // replaying a burst whose ordering no longer means anything.
      this.emitQueue.length = 0;
    }
  }

  private deliverEvent(e: ServerEvent): void {
    this.emit("event", e);
    // The Line's one hook into the stores it folds over.
    //
    // Here rather than in each of the ten `upsert*`/`remove*` methods, and that is the whole
    // reason it is correct: every path that changes a store MUST emit, or no dashboard would
    // see the change either - so a mutation path added later cannot forget to refresh the
    // strip the way it could forget a call at its own end. The recompute is coalesced and
    // change-gated, so a burst costs one fold and a fold that moved nothing costs no frame.
    if (LINE_INPUT_EVENTS.has(e.type)) this.scheduleLineRecompute();
  }
  private emitSession(s: Session): void {
    this.emitEvent({ type: "session_upsert", session: s });
  }

  // ---- workflow Persona catalog ----

  /** Boot-time catalog install. It precedes serving SSE, so no incremental emit is needed. */
  initializePersonas(personas: PersonaView[]): void {
    this.personas = new Map(personas.map((persona) => [persona.id, persona]));
  }

  upsertPersona(persona: PersonaView): void {
    this.personas.set(persona.id, persona);
    this.emitEvent({ type: "persona_upsert", persona });
  }

  removePersona(id: string): void {
    if (this.personas.delete(id)) this.emitEvent({ type: "persona_remove", id });
  }

  // ---- Global Command catalog ----

  /** Boot-time catalog install. It precedes serving SSE, so no incremental emit is needed. */
  initializeWorkflowCommands(views: WorkflowCommandView[]): void {
    this.workflowCommands = new Map(views.map((view) => [view.slot, view]));
  }

  /**
   * The ONLY incremental Command event, and it carries a whole slot.
   *
   * There is no remove twin: a built-in slot is never deleted, only emptied, and an emptied
   * slot is still four cards' worth of live state ("Not configured") rather than an absence.
   */
  upsertWorkflowCommand(view: WorkflowCommandView): void {
    this.workflowCommands.set(view.slot, view);
    this.emitEvent({ type: "workflow_command_upsert", command: view });
  }

  // ---- workflow SessionAction catalog ----

  /** Boot-time catalog install. It precedes serving SSE, so no incremental emit is needed. */
  initializeSessionActions(actions: SessionAction[]): void {
    this.sessionActions = new Map(actions.map((action) => [action.id, action]));
  }

  /**
   * Archive comes through HERE and not through `removeSessionAction`. An archived action is
   * still addressable - drafts and published versions name its id, and history reports it -
   * so dropping it from the browser's map would make an existing node's source unnameable.
   */
  upsertSessionAction(action: SessionAction): void {
    this.sessionActions.set(action.id, action);
    this.emitEvent({ type: "session_action_upsert", action });
  }

  removeSessionAction(id: string): void {
    if (this.sessionActions.delete(id)) this.emitEvent({ type: "session_action_remove", id });
  }

  // ---- workflow definition catalog ----

  initializeWorkflows(workflows: WorkflowSummary[]): void {
    this.workflowSummaries = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  }

  upsertWorkflow(workflow: WorkflowSummary): void {
    this.workflowSummaries.set(workflow.id, workflow);
    this.emitEvent({ type: "workflow_upsert", workflow });
  }

  removeWorkflow(id: string): void {
    if (this.workflowSummaries.delete(id)) this.emitEvent({ type: "workflow_remove", id });
  }

  initializeWorkflowRuns(runs: WorkflowRunSummary[]): void {
    this.workflowRuns = new Map(runs.map((run) => [run.id, run]));
  }

  upsertWorkflowRun(run: WorkflowRunSummary): void {
    this.workflowRuns.set(run.id, run);
    this.emitEvent({ type: "workflow_run_upsert", run });
  }

  removeWorkflowRun(id: string): void {
    if (this.workflowRuns.delete(id)) this.emitEvent({ type: "workflow_run_remove", id });
  }

  initializeWorkflowBindings(bindings: WorkflowBindingSummary[]): void {
    this.workflowBindings = new Map(bindings.map((binding) => [binding.id, binding]));
  }

  upsertWorkflowBinding(binding: WorkflowBindingSummary): void {
    this.workflowBindings.set(binding.id, binding);
    this.emitEvent({ type: "workflow_binding_upsert", binding });
  }

  removeWorkflowBinding(id: string): void {
    if (this.workflowBindings.delete(id)) this.emitEvent({ type: "workflow_binding_remove", id });
  }

  // ---- ensemble catalog ----

  /** Boot-time catalog install. It precedes serving SSE, so no incremental emit is needed. */
  initializeEnsembles(summaries: EnsembleSummary[]): void {
    this.ensembles = new Map(summaries.map((summary) => [summary.id, summary]));
  }

  upsertEnsemble(summary: EnsembleSummary): void {
    this.ensembles.set(summary.id, summary);
    this.emitEvent({ type: "ensemble_upsert", ensemble: summary });
  }

  removeEnsemble(id: string): void {
    if (this.ensembles.delete(id)) this.emitEvent({ type: "ensemble_remove", id });
  }

  /**
   * Teach the registry how to say which ensemble member a task is.
   *
   * A registered lookup rather than an import, so this file keeps no dependency on the
   * ensemble store and the projection stays one in-memory map read - `taskSummaryFor` runs
   * for every session on every discovery sweep, and a SQLite query there would be a query
   * per session per 1.5 seconds for a feature most operators are not using.
   */
  registerEnsembleProjection(lookup: (taskId: string) => TaskEnsembleLink | null): void {
    this.ensembleProjection = lookup;
    for (const id of this.sessions.keys()) this.resyncSessionTask(id);
  }

  // ---- schedule catalog (Recurring Missions live state) ----
  //
  // The schedule service is the only writer of the schedule tables; these methods are the
  // live-state adapter it notifies, and each emits AFTER the durable write it reflects (an
  // SSE emission cannot be rolled back). `upsertSchedule` / `removeSchedule` are the two
  // halves of the `ScheduleNotifier` the manager was built against in Phase 2.

  getSchedule(id: string): MissionSchedule | undefined {
    return this.schedules.get(id);
  }

  listSchedules(): MissionSchedule[] {
    return [...this.schedules.values()];
  }

  upsertSchedule(schedule: MissionSchedule): void {
    this.schedules.set(schedule.id, schedule);
    this.emitEvent({ type: "schedule_upsert", schedule });
  }

  removeSchedule(id: string): void {
    if (this.schedules.delete(id)) this.emitEvent({ type: "schedule_remove", id });
  }

  // ---- pipeline projection (external SDLC engines) ----
  //
  // The same shape as the schedule catalog above and for the same reason: the pipelines
  // watcher is the only writer of `pipeline_runs`, and these are the live-state adapter it
  // notifies after each durable write. Nothing here reads a provider's files, spawns a
  // provider's CLI, or decides what a run's group is - all three are the watcher's, so this
  // class stays free of any knowledge that a pipeline provider exists beyond its shape.

  listPipelineRuns(): PipelineRun[] {
    return [...this.pipelineRuns.values()];
  }

  /**
   * Boot-time install of the projection read back from SQLite. It precedes serving SSE, so
   * it emits no browser frame, the same contract `initializeWorkflowCommands` holds. The
   * internal event lets server-owned consumers such as Inspector rebuild their projections.
   */
  initializePipelineRuns(runs: readonly PipelineRun[]): void {
    this.pipelineRuns = new Map(runs.map((run) => [pipelineRunKeyOf(run), run]));
    for (const run of runs) this.emit("pipeline_run", run);
  }

  /**
   * Adopt a run and tell every browser, unless nothing a human could see moved.
   *
   * The suppression is not an optimization the way `emitSettingsStatus`' is - it is what
   * makes a polling watcher tolerable at all. The loop re-reads each enabled repository's
   * state files on a cadence and re-derives a whole `PipelineRun` every time; without this
   * check a quiet fleet would push one frame per run per tick, for ever.
   *
   * `updatedAt` is excluded from the comparison deliberately: it is the projection's own
   * clock, not a fact about the run, so including it would defeat the check entirely.
   */
  upsertPipelineRun(run: PipelineRun): void {
    const key = pipelineRunKeyOf(run);
    const prev = this.pipelineRuns.get(key);
    this.pipelineRuns.set(key, run);
    if (prev && pipelineRunDisplayEqual(prev, run)) return;
    this.emit("pipeline_run", run);
    this.emitEvent({ type: "pipeline_upsert", run });
    // After the frame, and after the map already holds the new run: the sessions this moves
    // are re-derived FROM the projection, so it has to be current before they are asked.
    this.syncSessionsForPipelineRun(run.provider, run.repoRoot, run.slug, run.worktree);
  }

  removePipelineRun(provider: PipelineProviderId, repoRoot: string, slug: string): void {
    const gone = this.pipelineRuns.get(pipelineRunKey(provider, repoRoot, slug));
    if (this.pipelineRuns.delete(pipelineRunKey(provider, repoRoot, slug))) {
      this.emitEvent({ type: "pipeline_remove", provider, repoRoot, slug });
      // A retired run - the engine tore its worktree down, or consent was withdrawn - has to
      // give its sessions back. They are ordinary sessions again, composer included, which
      // is the fail-open posture stated on `Session.pipeline`.
      this.syncSessionsForPipelineRun(provider, repoRoot, slug, gone?.worktree ?? null);
    }
  }

  registerWorkflowReset(cleanup: (noteKey: string) => void): void {
    this.workflowReset = cleanup;
  }

  clearWorkflowState(noteKey: string): void {
    this.workflowReset?.(noteKey);
  }

  // ---- passive discovery ----

  applyDiscovery(discovered: DiscoveredSession[]): void {
    const now = Date.now();
    const seen = new Set<string>();
    // Only a COMPLETED sweep reaches here - the poller logs and skips on failure -
    // so this is the moment the session map starts meaning anything. See `sessionsObserved`.
    const firstSweep = !this.sweptSessions;
    this.sweptSessions = true;

    for (const d of discovered) {
      seen.add(d.syntheticId);
      const timer = this.exitTimers.get(d.syntheticId);
      if (timer) {
        clearTimeout(timer);
        this.exitTimers.delete(d.syntheticId);
      }
      const prev = this.sessions.get(d.syntheticId);
      const next = this.mergeDiscovered(prev, d, now);
      this.sessions.set(d.syntheticId, next);
      if (!prev || !sessionEqual(prev, next)) this.emitSession(next);
    }

    // Anything a COMPLETED sweep didn't see is gone, and gets an eviction timer -
    // whether or not it already reads as exited.
    //
    // Skipping on `state === "exited"` instead left a permanent zombie: `applyHook`
    // writes that state straight into the map on SessionEnd with no timer, and this
    // loop then skipped it forever, so `remove` (which only this timer calls) never
    // ran. Its key counted as live to `orphanedQueueFor`, so a queue the human could
    // still resume was never offered on any card - stranded, with nothing to heal it.
    // Keying the skip on the TIMER instead says what was meant ("already on its way
    // out"), and makes the two ways a session can be marked exited converge here.
    //
    // SCOPED TO PANE-BACKED SESSIONS, and that scope is load-bearing rather than tidy.
    // "Unseen" here means terminal discovery produced no matching process. An SDK session
    // has no terminal-discovery identity by construction, and `groupAgentsByTty` excludes
    // its daemon-owned subprocesses, so this loop would have evicted every one of them on
    // the very first sweep after registration. Their lifecycle has an authority that cannot
    // be wrong about it: the supervisor holds the handle, and its `exited` event goes through
    // `beginEviction` below - the same sequence, so `session_remove` reaches WorkflowManager
    // and TaskManager identically.
    for (const [id, s] of this.sessions) {
      if (s.runtime !== "terminal") continue;
      if (seen.has(id) || this.exitTimers.has(id)) continue;
      this.beginEviction(s);
    }

    // Hints LAST, once the map is whole. `mergeDiscovered` resolved each session's
    // hint as it merged, i.e. against a map still being filled one session at a time:
    // on the first sweep after a restart the first session merged saw only its own
    // key as live, so every OTHER live session's queue looked orphaned to it. That
    // hint is actionable, and `reattachQueue` trusts it - it checks only that the
    // target is queue-eligible and holds no open items, never that the source is really
    // orphaned - so a click inside that window re-keys a healthy session's live queue
    // onto another card and drops the original row. The hint's correctness is the
    // only guard on that write, so it must never be computed from a partial map.
    this.syncAllOrphanHints();
    this.pruneQueues(now);
    // Throttled hard: an ingest already recomputes when estimated usage changes, so this is
    // only here to keep a QUIET fleet honest - "today" has to roll over at midnight, and the
    // recent rate has to fall back to zero when the exports stop.
    if (now - this.lastFleetCostAt >= FLEET_COST_IDLE_INTERVAL_MS) this.recomputeFleetCost(now);
    // The Line's own idle floor, for the inputs no event announces - see the constant.
    // Through the coalescer rather than folded inline, so it shares the one guarded path:
    // the fold reads two config blobs and the ledger, and a throw here would otherwise take
    // down the discovery sweep that keeps the whole dashboard current.
    if (now - this.lastLineSummaryAt >= LINE_IDLE_INTERVAL_MS) this.scheduleLineRecompute();
    if (firstSweep) this.emit("sessions_observed");
  }

  /**
   * Age out queues nothing can reach any more, at most hourly.
   *
   * Rides the discovery sweep because this is the one place a freshly-reconciled live
   * key set exists - and it must run AFTER the merge and eviction loops above, since
   * a key the map hasn't been filled in with yet reads as dead. Throttled because the
   * sweep is ~1.5s and this is neither cheap nor urgent.
   */
  private pruneQueues(now: number): void {
    if (now - this.lastQueuePrune < QUEUE_PRUNE_INTERVAL_MS) return;
    this.lastQueuePrune = now;
    try {
      pruneDeadQueues(this.liveNoteKeys(), now - QUEUE_RETENTION_MS);
    } catch (err) {
      // Retention is housekeeping: a failure here must not take down the sweep that
      // keeps the whole dashboard current.
      console.error("[registry] queue prune failed:", err);
    }
    // Independently caught so housekeeping cannot stop the discovery sweep.
    try {
      pruneEpisodes(now - EPISODE_RETENTION_MS);
    } catch (err) {
      console.error("[registry] foreman episode prune failed:", err);
    }
    // Independently caught again: these are the rows an estimate is summed from, so
    // a throw here must not be able to take the sweep or the other prunes down.
    try {
      pruneUsageLedger(now - USAGE_RETENTION_MS);
    } catch (err) {
      console.error("[registry] usage ledger prune failed:", err);
    }
    try {
      pruneUsageSources(now - USAGE_RETENTION_MS);
    } catch (err) {
      console.error("[registry] usage source prune failed:", err);
    }
  }

  private mergeDiscovered(
    prev: Session | undefined,
    d: DiscoveredSession,
    now: number,
  ): Session {
    // Read the stored binding ONCE, on first sight. After that the in-memory value
    // is the freshest truth - every rebinding goes through this process first - so
    // re-reading each sweep could only ever return what we already have.
    const known = d.agentSessionId ?? (prev ? prev.agentSessionId : lastAgentBinding(d.syntheticId));
    // Record the passive half separately - see `discoveredIdentity`. A sweep that could
    // not read the rollout this tick says nothing rather than retracting what it read
    // last tick, so one failed `lsof` does not briefly disarm the attribution guard.
    if (d.agentSessionId || d.transcriptPath) {
      const held = this.discoveredIdentity.get(d.syntheticId);
      this.discoveredIdentity.set(d.syntheticId, {
        agentSessionId: d.agentSessionId ?? held?.agentSessionId ?? null,
        transcriptPath: d.transcriptPath ?? held?.transcriptPath ?? null,
      });
    }
    const base: Session = {
      id: d.syntheticId,
      agent: d.agent,
      // Discovery finds processes on ttys, so everything it produces is pane-backed by
      // definition. An SDK session never passes through here at all - it arrives through
      // `registerSdkSession`, which is the only other door into this map.
      runtime: "terminal",
      // Resolved below with note/goal, once the overlay may have supplied the binding
      // that decides the key.
      foremanInvite: null,
      name: d.name,
      nameSource: d.nameSource,
      state: "working",
      cwd: d.cwd,
      gitBranch: d.gitBranch,
      gitRoot: d.gitRoot,
      repoRoot: d.repoRoot,
      pid: d.pid,
      tty: d.tty,
      // A mode read straight off the pane outranks every remembered value; absent
      // one (Codex, no pane, or a dialog covering Claude's mode line) we keep the
      // last we knew rather than blanking the chip.
      permissionMode: d.permissionMode ?? prev?.permissionMode ?? null,
      // Pointedly NOT sticky, unlike the mode above: a menu that has been answered
      // must leave the card, and remembering the last one we saw would leave a
      // button offering to answer a question nobody is asking any more. Undefined
      // means the pane couldn't be read at all (no capture, no information), and
      // only then do we keep what we had; a successful read that found no menu is
      // an explicit null and clears it.
      //
      // And only while there is still a pane to read it from. A session whose handle
      // has gone is never annotated at all (`annotatePaneState` skips it), so its
      // dialog would ride `prev` forward for as long as the session lives - a card
      // still offering rows that no keystroke can reach, because the answer would
      // have nowhere to land. That is the exact shape of "it has been sitting there
      // for ages and clicking does nothing", and it gets quieter, not louder, the
      // longer it lasts. `annotatePaneState` bounds the other half: a capture that
      // keeps failing on a pane that IS still there eventually clears too.
      paneDialog:
        d.paneDialog !== undefined
          ? d.paneDialog
          : canWriteTo(d)
            ? (prev?.paneDialog ?? null)
            : null,
      terminals: d.terminals,
      // Seeded from the DB for the same reason `hooksSeen` below is: only a live
      // hook/statusLine reports it, so on a daemon restart a quiet-but-healthy
      // session would rebuild with a null binding - and `noteKeyFor` would hand its
      // note and its WORK QUEUE to the synthetic id instead, making every stored
      // queue across the sessions look orphaned. See `recordAgentBinding`.
      agentSessionId: known,
      transcriptPath: d.transcriptPath ?? prev?.transcriptPath ?? null,
      instrumented: false,
      stateConfirmed: false,
      // Sticky, and seeded from the DB the first time we see a session so it
      // survives a daemon restart. `instrumented` above is rebuilt as false every
      // sweep because it tracks the overlay's freshness; this tracks whether hooks
      // exist at all, which nothing but uninstalling them can un-learn.
      hooksSeen: prev?.hooksSeen ?? hooksEverSeen(d.syntheticId),
      activity: prev?.activity ?? null,
      startedAt: d.startedAt || prev?.startedAt || null,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      lastActivity: prev?.lastActivity ?? null,
      workCycle: undefined,
      pendingReviews: this.countPending(d.syntheticId),
      task: this.taskSummaryFor(d.syntheticId, d.cwd),
      // Carried forward like the PR fields for the same reason: discovery cannot see it.
      // Re-resolved from the ledger just below, once cwd/prUrl are settled.
      inspector: prev?.inspector ?? null,
      // Derived from `cwd` against the projection's own worktree paths, exactly as `task`
      // above is derived from it against the task rows'. Null on every fleet with no
      // pipeline provider enabled, which is the check `pipelineLinkFor` makes first.
      // Re-stamped below, once cwd has settled.
      pipeline: this.pipelineLinkFor(d.cwd),
      retro: prev?.retro,
      prUrl: prev?.prUrl ?? null,
      prNumber: prev?.prNumber ?? null,
      prState: prev?.prState ?? null,
      prChecks: prev?.prChecks ?? null,
      meta: prev?.meta ?? null,
      effortBaselineReady: prev?.effortBaselineReady ?? false,
      cost: null,
      note: null,
      goal: null,
      queue: null,
      pendingTurns: prev?.pendingTurns ?? [],
      orphanedQueue: null,
    };
    const overlay = this.overlayFor(base);
    if (overlay) base.hooksSeen = true;
    if (overlay && now - overlay.updatedAt < OVERLAY_TTL_MS) {
      base.instrumented = true;
      base.stateConfirmed = true;
      base.state = overlay.state;
      base.activity = overlay.activity;
      // The hook overlay is a fallback for the pane read, never an override of it.
      base.permissionMode = d.permissionMode ?? overlay.permissionMode ?? base.permissionMode;
      base.lastActivity = overlay.lastActivity;
      base.agentSessionId = overlay.agentSessionId ?? base.agentSessionId;
      base.transcriptPath = overlay.transcriptPath ?? base.transcriptPath;
    } else {
      // No fresh hook. Fall back to the transcript-derived state that the passive
      // poller keeps current from disk, so a session whose hooks lapsed - a 30-min
      // silence, or EVERY session for the moment after a restart wipes the in-memory
      // overlays - reports a truthful idle/working instead of the base `working`
      // default that silently strands its work queue.
      //
      // Deliberately does NOT set `instrumented`: that stays "a fresh hook exists"
      // for the UI badge and `reportBucket`. `settledIdle` trusts hook-free idle
      // through the `state === "idle"` claim itself, which is only ever a real
      // report (the rebuild default is `working`), never an absence of data.
      const passive = this.passiveStateFor(base);
      if (passive && now - passive.updatedAt < OVERLAY_TTL_MS) {
        base.stateConfirmed = true;
        base.state = passive.state;
        base.lastActivity = passive.lastActivity;
      }
    }
    // Work-cycle state follows the logical conversation key, not the pane-backed map key.
    // Read SQLite only on first sight or rotation; otherwise the in-memory projection is the
    // freshest value and avoids adding one synchronous query to every discovery poll.
    base.workCycle =
      prev && noteKeyFor(prev) === noteKeyFor(base)
        ? prev.workCycle
        : (dbWorkCycleFor(noteKeyFor(base)) ?? undefined);
    // The overlay may have just supplied a binding nothing has persisted yet, and
    // that is the ORDINARY case at launch, not an edge: a hook whose session hasn't
    // been discovered yet has no live session to apply to, so it only ever reaches
    // a Session here. Left to `applyHook` alone the binding would then never be
    // written at all - its live-session branch writes on CHANGE, and by the time it
    // runs the overlay has already put the same id on the card.
    this.rememberAgentSession(base, known);
    // A sweep can itself be what rotates the note key - a Codex rollout annotation or a
    // hook overlay supplying the first agentSessionId - so carry the invite across the
    // rotation BEFORE resolving off the new key, or a freshly dispatched session's
    // `'dispatch'` row strands under the synthetic key and Foreman silently loses the
    // session it just launched. Notes and goals accept that stranding; an invite is
    // policy, not prose, so it may not.
    if (prev) this.moveForemanInviteKey(noteKeyFor(prev), noteKeyFor(base));
    // Resolve the note + queue only after the overlay may have supplied
    // agentSessionId, so their key (which prefers agentSessionId) is stable.
    base.note = this.noteSummaryFor(base);
    base.goal = this.goalSummaryFor(base);
    base.foremanInvite = this.foremanInviteFor(base);
    // Read the ledger on FIRST SIGHT and on a key rotation, and carry the figure the rest
    // of the time. First sight is the case that matters: the ledger outlives the daemon,
    // so a session rebuilt after a restart has usage recorded by a previous process and
    // must not read as unpriced until some later hook happens to fire. After that nothing
    // reaches the figure except the ingest, which re-denormalizes through
    // `syncSessionsForCost` itself - and this is an aggregate over every ledger row for
    // the key, on the ~1.5s sweep, on the synchronous handle that also serves hook ingest
    // and SSE. That is the cost `FLEET_COST_IDLE_INTERVAL_MS` throttles its own two SUMs
    // to 30s to avoid.
    base.cost =
      prev && noteKeyFor(prev) === noteKeyFor(base) ? prev.cost : sessionCostFor(noteKeyFor(base));
    base.queue = this.queueSummaryFor(base);
    base.pendingTurns = this.pendingTurnsFor(base);
    this.resolveInspectionSummaries(base);
    // The orphan hint is NOT resolved here, unlike the note and queue above: it is a
    // statement about every session ("no live session holds that key"), and this
    // runs per session while `applyDiscovery` is still filling the map. Carry the
    // last known value and let `applyDiscovery` re-resolve every hint once the map is
    // whole. `applyHook` resolves its own inline because by then the map already is.
    base.orphanedQueue = prev?.orphanedQueue ?? null;
    if (
      prev &&
      prev.agentSessionId !== null &&
      base.agentSessionId !== null &&
      prev.agentSessionId !== base.agentSessionId &&
      base.transcriptPath === prev.transcriptPath
    ) {
      base.transcriptPath = null;
    }
    if (prev && this.clearEffortTrackingOnRebind(prev, base) && base.meta) {
      base.meta = { ...base.meta, thinkingLevel: null };
    }
    this.ensureWorkEpisode(
      base,
      now,
      d.agentSessionId && d.transcriptPath
        ? {
            kind: "passive_identity",
            agentSessionId: d.agentSessionId,
            transcriptPath: d.transcriptPath,
          }
        : { kind: "none" },
    );
    base.task = this.taskSummaryFor(base.id, base.cwd);
    base.pipeline = this.pipelineLinkFor(base.cwd);
    return base;
  }

  // ---- sdk-driven sessions ----
  //
  // The counterpart of passive discovery for sessions terminal discovery deliberately does
  // not produce. Two methods, mirroring the two the terminal axis has: one that puts a
  // session in the map, one that ingests what the thing running it says about it. Everything
  // else about an SDK session - its note, goal, queue, task, cost, eviction - goes through
  // the SAME machinery a pane-backed session does, which is the entire point of making this
  // a runtime axis rather than a second kind of card.

  /**
   * Put a driver-run session in the map, as `applyDiscovery` does for a pane-backed one.
   *
   * The supervisor owns the id and mints it as `sdk:<uuid>`, disjoint from
   * `proc:<tty>:<pid>:<startMs>` by construction. That prefix is checked HERE and nowhere
   * else: it exists so the two id spaces cannot collide, not as a thing to branch on -
   * `Session.runtime` is the axis every reader asks (see `Session.runtime`'s doc).
   *
   * No attribution guard, unlike `applyHook`: the supervisor started the subprocess it is
   * reporting, which is a stronger claim than any hook can make. `discoveredIdentity` stays
   * exactly as it is - it holds what `lsof` read off a terminal session's live process, and
   * the daemon-owned subprocess behind this session is deliberately excluded from discovery.
   */
  registerSdkSession(input: SdkSessionRegistration): Session {
    const refusal = this.sdkRegistrationRefusal(input.id);
    if (refusal) throw new Error(refusal);
    const now = input.now ?? Date.now();
    this.driverDialogs.delete(input.id);
    const s: Session = {
      id: input.id,
      agent: input.agent,
      runtime: "sdk",
      // Resolved below with note/goal. Ordinarily `"sdk"` with no stored row - Mission
      // Control runs this session by definition - unless a `'withdrawn'` tombstone says
      // the operator kicked Foreman out.
      foremanInvite: null,
      name: input.name,
      // Nothing holds a pane to name this session, so the supervisor that launched it said
      // what it is called - which is what this `NameSource` value records.
      nameSource: "sdk",
      // Fresh launches learn this from `bound`; restored sessions carry the durable identity
      // immediately so note-keyed state never observes a synthetic-id interlude.
      state: input.initialState ?? "starting",
      cwd: input.cwd,
      gitBranch: input.gitBranch ?? null,
      gitRoot: input.gitRoot ?? null,
      repoRoot: input.repoRoot ?? null,
      // 0 until registration or `bound` identifies the subprocess the driver spawned. A
      // driver with no separate process leaves it there, and `signalProcess` must keep
      // refusing that sentinel because POSIX interprets pid 0 as the caller's process group.
      pid: input.pid ?? 0,
      // No controlling tty, and no pane. Both are what keeps the discovery sweep, the pane
      // lock, the capture-miss counter and the overlay maps from ever keying this session.
      tty: null,
      permissionMode: input.permissionMode ?? null,
      terminals: [],
      agentSessionId: input.agentSessionId ?? null,
      transcriptPath: null,
      instrumented: false,
      stateConfirmed: false,
      hooksSeen: false,
      activity: null,
      startedAt: now,
      firstSeen: now,
      lastSeen: now,
      lastActivity: null,
      workCycle: undefined,
      pendingReviews: this.countPending(input.id),
      task: null,
      prUrl: null,
      prNumber: null,
      prState: null,
      prChecks: null,
      meta: null,
      effortBaselineReady: false,
      cost: null,
      note: null,
      goal: null,
      queue: null,
      pendingTurns: [],
      orphanedQueue: null,
      inspector: null,
      // Always null here, and structurally so rather than by omission: an engine-driven
      // agent is a subprocess the ENGINE started in its own worktree, and this door is
      // only ever taken by a session Mission Control's own supervisor launched.
      pipeline: null,
      paneDialog: null,
    };
    s.task = this.taskSummaryFor(s.id, s.cwd);
    s.note = this.noteSummaryFor(s);
    s.goal = this.goalSummaryFor(s);
    s.foremanInvite = this.foremanInviteFor(s);
    s.cost = sessionCostFor(noteKeyFor(s));
    s.queue = this.queueSummaryFor(s);
    s.pendingTurns = this.pendingTurnsFor(s);
    s.workCycle = dbWorkCycleFor(noteKeyFor(s)) ?? undefined;
    this.resolveInspectionSummaries(s);
    this.sessions.set(s.id, s);
    this.emitSession(s);
    // A newly live key is the mirror of `remove`'s reason for doing this: a queue looks
    // orphaned exactly while no live session holds its key, so registering one can
    // un-orphan a hint on a sibling card that has no other reason to re-emit.
    this.syncAllOrphanHints();
    return s;
  }

  sdkRegistrationRefusal(id: string): string | null {
    if (!id.startsWith(SDK_SESSION_ID_PREFIX)) {
      return `an SDK session id must start with "${SDK_SESSION_ID_PREFIX}": ${id}`;
    }
    if (this.sessions.has(id)) {
      // One id per launch. A repeat means two handles believe they own one card, and
      // silently returning the existing entry would leave the loser pumping events into a
      // session it does not drive.
      return `SDK session ${id} is already registered`;
    }
    return null;
  }

  /**
   * Persist one normalized lifecycle signal, then return the matching session projection.
   *
   * The database write comes first so an emitted session can never advertise a generation
   * that a daemon restart would lose. A completion without an armed row returns no summary,
   * which is the fail-closed meaning of idle/end noise on a conversation with no work.
   */
  private withWorkCycleSignal(
    s: Session,
    signal: WorkCycleSignal,
    occurredAt: number,
    updatedAt: number,
  ): Session {
    const logicalKey = noteKeyFor(s);
    const workCycle = signal === "work_started"
      ? markWorkCycleActive(logicalKey, updatedAt)
      : completeWorkCycle(logicalKey, occurredAt, updatedAt);
    const projected = workCycle ?? undefined;
    if (JSON.stringify(s.workCycle) === JSON.stringify(projected)) return s;
    return { ...s, workCycle: projected };
  }

  /** Persist and emit a lifecycle-only change, used when an SDK completion stays busy. */
  private applyWorkCycleOnly(
    s: Session,
    signal: WorkCycleSignal,
    occurredAt: number,
    updatedAt: number,
  ): void {
    const next = this.withWorkCycleSignal(s, signal, occurredAt, updatedAt);
    this.sessions.set(next.id, next);
    if (!sessionEqual(s, next)) this.emitSession(next);
  }

  /**
   * Ingest one event from a session's driver - the first-class sibling of `applyHook`.
   *
   * Refuses anything about a session that is not driver-run, which is the same shape of
   * refusal `applyHook` makes for a harness that declares no hooks: a card we reach by
   * typing must not have its state written by something claiming to hold its handle.
   */
  applyDriverEvent(
    id: string,
    evt: SdkEvent,
    options: { deferIdle?: boolean } = {},
  ): void {
    const s = this.sessions.get(id);
    if (!s || s.runtime !== "sdk") return;
    const now = Date.now();
    switch (evt.kind) {
      case "bound":
        this.applyDriverBinding(s, evt, now);
        return;
      case "state":
        this.applyDriverState(
          s,
          evt.state,
          evt.activity,
          now,
          evt.state === "working" ? "work_started" : null,
        );
        return;
      case "turn_done":
        // The turn ended, so the session is idle - the same fact a `Stop` hook carries -
        // unless the supervisor still holds an accepted queued turn. The event still comes
        // through in that case so every non-idle projection stays observable; only the
        // transient idle transition is withheld.
        //
        // `usage` IS spent here when the driver attributed it, which reverses the rule this
        // handler used to state. The old rule - one writer per harness, OTel for Claude -
        // made the driver's figure redundant, and it was correct only while that writer
        // worked. It is a single point of failure with no error path: an exporter that stops
        // producing (an inert metrics pipeline, an org policy, a version regression) takes
        // every Claude session's spend to zero and reports nothing, because the ledger
        // cannot tell "nothing was spent" from "nobody wrote it down". The driver reads the
        // same figure off a stream it already owns, so it cannot be switched off from
        // outside, and `sdkOwnedNoteKey` makes OTel yield for these keys instead - one
        // writer per note key still, chosen by runtime rather than fixed to the exporter.
        //
        // AFTER the idle transition, and the order is load-bearing rather than stylistic.
        // `applyDriverState` rebuilds the session from the `s` captured at the top of this
        // method and writes it back to the map, so anything that re-denormalized a field onto
        // the session first is silently reverted by it - the ledger row survives, the card's
        // own figure does not, and the fleet total then disagrees with every chip on it.
        // Recording last means `applyDurableUsage` re-reads the session it is updating.
        if (!options.deferIdle) {
          this.applyDriverState(s, "idle", null, now, "turn_completed");
        } else {
          // The next accepted turn keeps the card working, but the cycle that just ended
          // still advances. Emit only that durable projection instead of a transient idle.
          this.applyWorkCycleOnly(s, "turn_completed", now, now);
        }
        this.recordDriverTurnUsage(s, evt.usage, now);
        return;
      case "rate_limits":
        this.recordRateLimits(evt.rateLimits);
        return;
      case "request":
        {
          const queue = this.driverDialogs.get(id) ?? [];
          if (!queue.some((dialog) => dialog.requestId === evt.request.id)) {
            queue.push(driverDialog(evt.request));
            this.driverDialogs.set(id, queue);
          }
          if (queue[0]?.requestId === evt.request.id) {
            this.applyDriverDialog(s, queue[0], now);
          }
        }
        return;
      case "request_resolved":
        {
          const queue = this.driverDialogs.get(id) ?? [];
          const visible = queue[0]?.requestId === evt.requestId;
          const remaining = queue.filter((dialog) => dialog.requestId !== evt.requestId);
          if (remaining.length === 0) this.driverDialogs.delete(id);
          else this.driverDialogs.set(id, remaining);
          if (visible) this.applyDriverDialog(s, remaining[0] ?? null, now);
        }
        return;
      case "pr_created":
        if (evt.urls.length > 0) this.applyDriverPrCreated(s, evt.urls);
        return;
      case "exited":
        // The same exited-then-linger-then-`session_remove` sequence a vanished pane gets.
        // `reason` and `resumable` are the supervisor's to act on (a resumable exit is what
        // a restart relaunches from); the card only ever needed to know it is over.
        this.beginEviction(s);
        return;
    }
  }

  /**
   * The driver reported the identity the harness minted for this session.
   *
   * This one event is what keeps the entire FILE-BASED READ PATH working for a session with
   * no pane: `transcript.locate` and the goal/queue/verification readers all key on
   * `agentSessionId` and `transcriptPath`, and they are the same fields a hook fills. And
   * the three instrumentation flags go true here for a reason that is stronger than a
   * hook's: an SDK session is instrumented BY CONSTRUCTION - the push channel is the handle
   * itself - so every gate that asks "can we see this session's lifecycle?"
   * (`hooksSeen` for the work queue, `stateConfirmed` for the buckets) is satisfied the
   * moment it binds rather than 20 seconds later on hope.
   */
  private applyDriverBinding(
    s: Session,
    evt: Extract<SdkEvent, { kind: "bound" }>,
    now: number,
  ): void {
    const { agentSessionId, transcriptPath, modelId, pid } = evt;
    const next: Session = {
      ...s,
      agentSessionId,
      transcriptPath,
      // A bound driver knows the actual model before the passive file reader does. Seed
      // only that fact: context and effort still come from the transcript/rollout and can
      // replace this driver-sourced placeholder on their next ordinary poll.
      meta: modelId
        ? metaFromRead(
            {
              modelId,
              contextTokens: null,
              contextWindow: null,
              contextPct: null,
              longContext: parseContextWindowSize(modelId).longContext,
              thinkingLevel: null,
              effortRevision: null,
            },
            "driver",
            now,
          )
        : s.meta,
      pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : s.pid,
      instrumented: true,
      stateConfirmed: true,
      hooksSeen: true,
      lastActivity: now,
    };
    if (this.clearEffortTrackingOnRebind(s, next) && next.meta) {
      next.meta = { ...next.meta, thinkingLevel: null };
    }
    if (noteKeyFor(next) !== noteKeyFor(s)) {
      next.workCycle = dbWorkCycleFor(noteKeyFor(next)) ?? undefined;
    }
    // Binding changes the note key, so everything keyed on it is re-resolved NOW rather
    // than on some later event, exactly as `applyHook` does and for the same reason: until
    // it is, the card shows the synthetic id's (empty) note, queue and goal.
    this.rememberAgentSession(next, s.agentSessionId);
    // A CLEARED rotation is `clear_start`'s counterpart, and it has to be distinguished
    // here or a reset that worked reports that it did not: `resetSession` arms the work
    // episode for a rebind, and only clear-grade evidence can resolve that arm (see
    // `ensureWorkEpisode`). `driver_identity` is the ordinary case - the agent reported a
    // new id for some reason of its own - and must not be able to claim a reset's arm.
    this.ensureWorkEpisode(
      next,
      now,
      evt.cleared
        ? { kind: "driver_clear", agentSessionId, transcriptPath }
        : { kind: "driver_identity" },
    );
    next.task = this.taskSummaryFor(next.id, next.cwd);
    // The invite MOVES with the rotation rather than merely re-resolving, unlike the
    // note and goal: stranding those costs stale prose, stranding this un-invites
    // Foreman from a session Mission Control launched. Move first, resolve after.
    this.moveForemanInviteKey(noteKeyFor(s), noteKeyFor(next));
    next.note = this.noteSummaryFor(next);
    next.goal = this.goalSummaryFor(next);
    next.foremanInvite = this.foremanInviteFor(next);
    if (noteKeyFor(next) !== noteKeyFor(s)) next.cost = sessionCostFor(noteKeyFor(next));
    next.queue = this.queueSummaryFor(next);
    next.pendingTurns = this.pendingTurnsFor(next);
    next.orphanedQueue = this.orphanedQueueFor(next);
    this.resolveInspectionSummaries(next);
    this.sessions.set(next.id, next);
    logEvent(next.id, now, "SdkBound", { agentSessionId });
    this.emitSession(next);
  }

  private applyDriverState(
    s: Session,
    state: "working" | "idle",
    activity: string | null,
    now: number,
    workCycleSignal: WorkCycleSignal | null = null,
  ): void {
    // A final result/state frame may race an operator stop. It can update the durable turn
    // mirror in the supervisor, but it must not make this card actionable again after the
    // supervisor has closed delivery and acknowledged that fact to the browser.
    if (s.state === "stopping") {
      if (workCycleSignal) this.applyWorkCycleOnly(s, workCycleSignal, now, now);
      return;
    }
    let next: Session = {
      ...s,
      state,
      activity,
      // Stays true for as long as the session lives, and that is truthful rather than
      // sticky: `instrumented` means "we have current push-sourced state", and for an SDK
      // session the push channel is the handle we are holding. Nothing has to age it out
      // because nothing rebuilds this entry - when the handle ends, so does the card.
      instrumented: true,
      stateConfirmed: true,
      lastActivity: now,
    };
    if (workCycleSignal) next = this.withWorkCycleSignal(next, workCycleSignal, now, now);
    this.sessions.set(next.id, next);
    if (!sessionEqual(s, next) || s.lastActivity !== now) this.emitSession(next);
  }

  private applyDriverDialog(s: Session, paneDialog: PaneDialog | null, now: number): void {
    const next: Session = { ...s, paneDialog, lastActivity: now };
    this.sessions.set(next.id, next);
    if (!sessionEqual(s, next)) this.emitSession(next);
  }

  /**
   * The driver watched this session's agent run `gh pr create`.
   *
   * The same two things a proving hook does, and for the same reasons: decorate the card at
   * once (the poller confirms it and later flips it to merged), and announce the AUTHORSHIP,
   * because nothing persists it. `prUrl` alone is a text match anything could trip; this
   * event means the command was observed, which is the only evidence `adoptPr` accepts.
   *
   * A repeat is safe HERE (the fields it writes are the same ones) and dangerous downstream,
   * which is why the announcement is not made inline - see `announcePrOpened`.
   *
   * `urls` is a LIST and every one of them is announced, but only the FIRST decorates the
   * card. That asymmetry is the `Session.prUrl` contract: the chip means "this session's
   * current-branch pull request", the poller re-decides it every tick from `gh`, and a
   * multi-repo agent that opened three pull requests still has one branch checked out at
   * `cwd`. Authorship is per pull request; the chip is per session.
   */
  private applyDriverPrCreated(s: Session, urls: string[]): void {
    const url = urls[0];
    if (!url) return;
    // Native leases are detached at registration. The driver observed `gh pr create`, so
    // read the branch from the checkout now and adopt it in place before the poller confirms
    // the PR. The ordinary discovery refresh remains authoritative for later branch moves.
    const gitBranch = s.gitBranch ?? (s.cwd ? gitInfo(s.cwd).branch : null);
    const next: Session = {
      ...s,
      gitBranch,
      prUrl: url,
      prNumber: prNumberFromUrl(url),
      prState: "open",
      // Unknown at creation, and cleared so a session cannot carry a previous PR's rollup.
      prChecks: null,
    };
    this.resolveInspectionSummaries(next);
    this.sessions.set(next.id, next);
    if (!sessionEqual(s, next)) this.emitSession(next);
    for (const opened of urls) this.announcePrOpened(next, opened);
  }

  /**
   * Announce, ONCE per session per pull request, that this session's agent opened it.
   *
   * The one emitter of `pr_opened`, shared by the hook path and the driver path, because
   * "once" is a property of the ANNOUNCEMENT and a rule with two implementations has one
   * too many. Both callers hold proof-grade evidence - the hook matched the `gh pr create`
   * COMMAND, the driver watched it on its own tool stream - and `prUrl` alone never
   * reaches here, because a text match is what `gh pr view` also trips.
   *
   * The dedupe is what makes the sentence above true rather than aspirational. A hook
   * fires once per command, but a driver's event stream is a stream: an adapter that
   * reconnects, replays, or reports a tool result twice would announce the same authorship
   * again, and the listener that catches this writes to a ledger that decides where the
   * Inspector comments in public. Today `adoptInspectorPr` absorbs a repeat (its upsert is
   * `ON CONFLICT DO NOTHING`, and every side effect the listener has is gated on the insert
   * having happened), so this closes the gap at the source rather than relying on a
   * downstream table to keep being forgiving.
   *
   * Keyed on the PR as well as the session, so a session that legitimately opens a SECOND
   * pull request still announces it - the thing being suppressed is a repeat, not a
   * sequence. Held in memory and dropped with the session (see `remove`), like every other
   * per-session decoration: nothing here is durable, because the adoption row it produces
   * is.
   */
  private announcePrOpened(s: Session, url: string): void {
    const announced = this.announcedPrs.get(s.id);
    if (announced?.has(url)) return;
    if (announced) announced.add(url);
    else this.announcedPrs.set(s.id, new Set([url]));
    try {
      this.emit("pr_opened", {
        url,
        sessionId: s.id,
        cwd: s.cwd,
        repoRoot: s.repoRoot,
      } satisfies PrOpened);
    } catch (err) {
      // Guarded because both callers are on an INGEST path: adoption must never be able to
      // break the event that a live session's whole card depends on.
      console.error("[registry] pr_opened listener threw:", err);
    }
  }

  // ---- hooks ----

  applyHook(evt: HookIngest): void {
    // Whose vocabulary this event is written in. A harness that declares no hooks has no
    // way to say what `event` means, and inventing one is how a hookless session gets
    // pinned: the old switch answered `working` for everything it didn't recognize, so
    // one stray ingest would have parked the card there until something else moved it.
    // Refusing leaves the session exactly where it belongs, on the passive path.
    const spec = hooksFor(evt.agent);
    if (!spec) return;
    const now = Date.now();
    const ts = evt.ts ?? now;
    const key = overlayKeyFromEnv(evt.env);
    const { state, activity } = spec.toState(evt);
    const workCycleSignal = spec.workCycleSignal(evt);
    const target = this.findSessionForHook(evt, key);

    // Passive PID/open-file identity is exact. A conflicting hook belongs to another
    // process/pane and must not move this card or poison its pane overlay.
    //
    // Only against what DISCOVERY read off the process (`discoveredIdentity`), never
    // against `target.agentSessionId`. That field is also where a REMEMBERED binding
    // lives, and a `/clear` mints a new agent session id on the same pane - so guarding
    // on it refuses the very event that is supposed to rebind the card, leaving its
    // note, queue and goal on a dead key that no later hook can move either.
    const witnessed = target ? this.discoveredIdentity.get(target.id) : undefined;
    if (witnessed && (
      (evt.sessionId && witnessed.agentSessionId && evt.sessionId !== witnessed.agentSessionId) ||
      (evt.transcriptPath && witnessed.transcriptPath && evt.transcriptPath !== witnessed.transcriptPath)
    )) return;

    // Permission mode is sticky: events that omit it keep the last known value
    // (from this pane's prior overlay) rather than clearing the card's chip. Only from
    // an overlay this same harness left - mode vocabularies and controls are harness-owned,
    // and carrying one across an agent change would be a chip nothing can clear.
    const prior = key ? this.overlays.get(key) : undefined;
    const priorOverlay = prior?.agent === evt.agent ? prior : undefined;
    const permissionMode =
      normalizePermissionMode(evt.permissionMode) ?? priorOverlay?.permissionMode ?? null;

    const overlay: HookOverlay = {
      agent: evt.agent,
      agentSessionId: evt.sessionId ?? null,
      transcriptPath: evt.transcriptPath ?? null,
      state,
      activity,
      permissionMode,
      lastActivity: ts,
      updatedAt: now,
    };
    if (key) this.overlays.set(key, overlay);

    // Apply immediately to a matching live session for instant feedback.
    if (target) {
      // A PR link sniffed from `gh pr create` decorates the card at once as an
      // open PR; the poller confirms it and later flips it to merged.
      const pr = evt.prUrl
        ? {
            prUrl: evt.prUrl,
            prNumber: prNumberFromUrl(evt.prUrl),
            prState: "open" as const,
            // Checks are unknown at creation; the poller fills them in. Reset so a
            // reused session can't carry the previous PR's status onto a new one.
            prChecks: null,
          }
        : {};
      const agentSessionId = evt.sessionId ?? target.agentSessionId;
      const agentRebound =
        target.agentSessionId !== null &&
        agentSessionId !== null &&
        target.agentSessionId !== agentSessionId;
      const transcriptPath = agentRebound && evt.transcriptPath === target.transcriptPath
        ? null
        : evt.transcriptPath ?? (agentRebound ? null : target.transcriptPath);
      // A native lease starts detached. A live SDK hook after the agent creates its branch
      // is a better moment to observe that branch than a later passive sweep. Keep a known
      // branch untouched, but let the first real branch replace the acquisition-time null
      // so the existing PR and workflow lifecycles can use it immediately.
      const gitBranch = target.gitBranch ??
        (target.runtime === "sdk" && target.cwd
          ? gitInfo(target.cwd).branch
          : null);
      let next: Session = {
        ...target,
        ...pr,
        instrumented: true,
        stateConfirmed: true,
        hooksSeen: true,
        state,
        activity,
        permissionMode,
        lastActivity: ts,
        agentSessionId,
        transcriptPath,
        gitBranch,
      };
      if (noteKeyFor(next) !== noteKeyFor(target)) {
        next.workCycle = dbWorkCycleFor(noteKeyFor(next)) ?? undefined;
      }
      if (workCycleSignal) {
        next = this.withWorkCycleSignal(next, workCycleSignal, ts, now);
      }
      if (this.clearEffortTrackingOnRebind(target, next) && next.meta) {
        next.meta = { ...next.meta, thinkingLevel: null };
      }
      this.ensureWorkEpisode(
        next,
        ts,
        evt.sessionId
          ? evt.event === "SessionStart" && evt.source === "clear"
            ? {
                kind: "clear_start",
                agentSessionId: evt.sessionId,
                transcriptPath: evt.transcriptPath ?? null,
              }
            : evt.event === "SessionStart" || evt.event === "SessionEnd"
              ? { kind: "hook_identity" }
              : evt.event === "UserPromptSubmit"
                ? { kind: "new_work" }
              : { kind: "hook_work" }
          : { kind: "none" },
      );
      next.task = this.taskSummaryFor(next.id, next.cwd);
      // Binding the agent session id can change the note key, so re-resolve
      // everything keyed by it NOW rather than waiting for the next discovery
      // sweep. A `/clear` mints a new agent session id mid-pane, and until this
      // re-resolves the card would keep showing the PREVIOUS key's queue while its
      // real one sits orphaned and unoffered - stale in the exact moment the human
      // is looking, since a /clear is something they just did.
      // The invite moves with the rotation - see `applyDriverBound` for why it may not
      // strand the way the note and goal below are allowed to.
      this.moveForemanInviteKey(noteKeyFor(target), noteKeyFor(next));
      next.note = this.noteSummaryFor(next);
      next.goal = this.goalSummaryFor(next);
      next.foremanInvite = this.foremanInviteFor(next);
      // On a key ROTATION only, exactly as `applyRuntimeMeta` and `mergeDiscovered`
      // decide it. The ledger is not the only writer of this field - `applyPassiveUsage`
      // puts an unpriced token count straight onto the session for a harness that reports
      // no cost - so re-reading it on every event answers null for those and blanks the
      // chip until the next poll tick restores it, several times a turn. Nothing but a
      // rotation can move the figure here anyway: the ledger's own writer re-denormalizes
      // through `syncSessionsForCost`.
      if (noteKeyFor(next) !== noteKeyFor(target)) next.cost = sessionCostFor(noteKeyFor(next));
      next.queue = this.queueSummaryFor(next);
      next.pendingTurns = this.pendingTurnsFor(next);
      next.orphanedQueue = this.orphanedQueueFor(next);
      // A hook is how a PR url first reaches a card, and the summary is keyed on it -
      // so resolving here is what makes the chip appear on the same event that
      // produced the PR, rather than up to a poll tick later.
      this.resolveInspectionSummaries(next);
      this.rememberAgentSession(next, target.agentSessionId);
      this.sessions.set(next.id, next);
      logEvent(next.id, ts, evt.event, { activity, state });
      if (!sessionEqual(target, next) || target.lastActivity !== ts) this.emitSession(next);
      // Last, deliberately. `upsertGoal` re-denormalizes and emits through
      // `syncSessionsForGoal`, so running it before the emit above would leave that emit
      // shipping the pre-goal object and the card would show the change only on the next
      // unrelated event.
      this.captureGoalPrompt(next, spec, evt, now);
      // Last of all, and only on the proof-grade signal. `prUrl` alone is a text match
      // that `gh pr view` trips; `prCreated` means the command was `gh pr create`. Nothing
      // persists that distinction, so this firing is the only chance to record that this PR
      // is ours - see `announcePrOpened`, which owns both the once-per-PR rule and the
      // guard that keeps adoption from breaking hook ingest.
      //
      // Every url the command printed, falling back to the scalar for a hook installed
      // before `prUrls` existed - those hooks keep running with the environment they were
      // installed with, so the fallback is a live path rather than a courtesy.
      if (evt.prCreated) {
        for (const url of evt.prUrls ?? (evt.prUrl ? [evt.prUrl] : [])) {
          this.announcePrOpened(next, url);
        }
      }
    } else if (workCycleSignal && evt.sessionId) {
      // Hooks can beat process discovery during launch. The harness session id is already
      // the logical key, so persist the lifecycle edge now and let the first discovery
      // projection read it back. Without this branch the first prompt of a new session can
      // be the one cycle whose active bit disappears on a daemon restart.
      if (workCycleSignal === "work_started") markWorkCycleActive(evt.sessionId, now);
      else completeWorkCycle(evt.sessionId, ts, now);
    }
    this.pruneOverlays(now);
  }

  /**
   * Record a permission mode we just *read off a session's pane*, so the chip
   * reflects it immediately instead of waiting up to a poll interval for the next
   * sweep to observe the same thing. Called after a mode change succeeds.
   *
   * This is an observation, not a guess: the caller read the mode back from the
   * terminal (see `setPermissionMode`), so unlike the mode we infer from a
   * keystroke, it can't diverge from what Claude is actually doing. A null mode -
   * one we couldn't read - is ignored rather than written, leaving the last known
   * value up for the next poll to correct.
   *
   * The pane overlay's mode is updated whenever one exists, regardless of its age.
   * Both readers handle that correctly: `mergeDiscovered` gates the overlay behind
   * its own OVERLAY_TTL_MS freshness check, so a stale one won't resurface passive
   * state (and the mode still reaches the next sweep via the updated session, which
   * `mergeDiscovered` seeds from `prev`); `applyHook` reads the overlay's mode with
   * no TTL check as its sticky fallback, so keeping it current means a later hook
   * that omits permission_mode reconciles to the new mode rather than the old one.
   * `updatedAt` is deliberately left alone: that stamp is the overlay's freshness
   * clock, and bumping it here would revive an overlay already past OVERLAY_TTL_MS,
   * re-applying all of its stale fields (instrumented, stateConfirmed, state, activity)
   * over the card.
   */
  recordObservedPermissionMode(sessionId: string, mode: PermissionMode | null): void {
    if (!mode) return;
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (capabilitiesFor(s.agent).permissionModes?.liveControl.kind === "menu") {
      this.permissionModeFreshnessGuards.set(sessionId, {
        agentSessionId: s.agentSessionId,
        transcriptPath: s.transcriptPath,
        verifiedAt: Date.now(),
      });
    }
    this.applyObservedPermissionMode(s, mode);
  }

  /**
   * Apply a mode from a harness-owned append-only file. This is deliberately separate
   * from `recordObservedPermissionMode`: passive reads must not start a freshness guard
   * of their own, and must respect the guard made by a just-completed menu selection.
   */
  applyPassivePermissionMode(
    sessionId: string,
    mode: PermissionMode | null,
    revision: string | null,
  ): void {
    if (!mode) return;
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const guard = this.permissionModeFreshnessGuards.get(sessionId);
    if (guard) {
      const identityChanged =
        (guard.agentSessionId !== null &&
          s.agentSessionId !== null &&
          guard.agentSessionId !== s.agentSessionId) ||
        (guard.transcriptPath !== null &&
          s.transcriptPath !== null &&
          guard.transcriptPath !== s.transcriptPath);
      if (!identityChanged) {
        const revisionTime = revision === null ? NaN : Date.parse(revision);
        if (!Number.isFinite(revisionTime) || revisionTime <= guard.verifiedAt) return;
      }
      this.permissionModeFreshnessGuards.delete(sessionId);
    }
    this.applyObservedPermissionMode(s, mode);
  }

  private applyObservedPermissionMode(s: Session, mode: PermissionMode): void {
    if (s.permissionMode === mode) return;
    const overlay = this.overlayFor(s);
    if (overlay) overlay.permissionMode = mode;
    const updated: Session = { ...s, permissionMode: mode };
    this.sessions.set(s.id, updated);
    this.emitSession(updated);
  }

  bindLaunchedAgentSession(
    sessionId: string,
    agent: AgentType,
    agentSessionId: string,
  ): Session | null {
    const s = this.sessions.get(sessionId);
    if (!s || s.state === "exited" || s.agent !== agent) return null;
    if (s.agentSessionId === agentSessionId) return s;
    const next: Session = {
      ...s,
      agentSessionId,
      transcriptPath: null,
      workCycle: dbWorkCycleFor(agentSessionId) ?? undefined,
    };
    if (this.clearEffortTrackingOnRebind(s, next) && next.meta) {
      next.meta = { ...next.meta, thinkingLevel: null };
    }
    // The Pi-dispatch rebind: the dispatcher wrote the `'dispatch'` invite under the
    // pre-rebind synthetic key moments ago, and Pi's runtime is `terminal`, so no
    // implicit grant catches a stranded row - missing this move silently un-invites
    // Foreman from a session Mission Control just dispatched.
    this.moveForemanInviteKey(noteKeyFor(s), noteKeyFor(next));
    next.note = this.noteSummaryFor(next);
    next.goal = this.goalSummaryFor(next);
    next.foremanInvite = this.foremanInviteFor(next);
    next.cost = sessionCostFor(noteKeyFor(next));
    next.queue = this.queueSummaryFor(next);
    next.pendingTurns = this.pendingTurnsFor(next);
    next.orphanedQueue = this.orphanedQueueFor(next);
    this.rememberAgentSession(next, s.agentSessionId);
    this.ensureWorkEpisode(next);
    this.sessions.set(sessionId, next);
    this.emitSession(next);
    return next;
  }

  recordRuntimeEffortBaseline(
    sessionId: string,
    revision: string | null,
    expected: Pick<Session, "agent" | "agentSessionId" | "transcriptPath">,
  ): boolean {
    const s = this.sessions.get(sessionId);
    if (
      !s ||
      s.agent !== expected.agent ||
      s.agentSessionId !== expected.agentSessionId ||
      s.transcriptPath !== expected.transcriptPath
    ) return false;
    this.runtimeEffortRevisions.set(sessionId, revision);
    if (s.effortBaselineReady) return true;
    const updated: Session = { ...s, effortBaselineReady: true };
    this.sessions.set(sessionId, updated);
    this.emitSession(updated);
    return true;
  }

  recordObservedSessionEffort(
    sessionId: string,
    effort: ThinkingLevel | null,
    expected?: Pick<Session, "agentSessionId" | "transcriptPath">,
  ): boolean {
    if (!effort || !this.runtimeEffortRevisions.has(sessionId)) return false;
    const s = this.sessions.get(sessionId);
    if (
      !s?.meta ||
      !s.effortBaselineReady ||
      (expected &&
        expected.agentSessionId !== null &&
        expected.agentSessionId !== s.agentSessionId) ||
      (expected &&
        expected.transcriptPath !== null &&
        expected.transcriptPath !== s.transcriptPath)
    ) return false;
    const freshness = {
      agentSessionId: s.agentSessionId,
      transcriptPath: s.transcriptPath,
      model: s.meta.model,
      modelId: s.meta.modelId,
      effortRevision: this.runtimeEffortRevisions.get(sessionId)!,
      statusLineTimestamp: this.statusLineTimestamps.get(sessionId) ?? null,
      verifiedAt: Date.now(),
    };
    this.effortFreshnessGuards.set(sessionId, freshness);
    this.observedEfforts.set(sessionId, {
      ...freshness,
      previous: s.meta.thinkingLevel ?? effort,
      effort,
    });
    if (s.meta.thinkingLevel === effort) return true;
    const updated: Session = {
      ...s,
      meta: { ...s.meta, thinkingLevel: effort },
    };
    this.sessions.set(sessionId, updated);
    this.emitSession(updated);
    return true;
  }

  clearObservedSessionEffort(sessionId: string): void {
    this.clearSessionEffortTracking(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s || (!s.effortBaselineReady && (!s.meta || s.meta.thinkingLevel === null))) return;
    const updated: Session = {
      ...s,
      meta: s.meta ? { ...s.meta, thinkingLevel: null } : null,
      effortBaselineReady: false,
    };
    this.sessions.set(sessionId, updated);
    this.emitSession(updated);
  }

  /**
   * Optimistically apply a rename to the live card the instant the terminal rename
   * lands, rather than waiting up to a poll interval for discovery to read the new
   * name back. For a multiplexer-hosted session the display name IS the multiplexer
   * session name, so that handle's `session` field moves with it - otherwise Focus
   * and Kill (which target it BY NAME) would address the now-renamed session by its
   * old name until the next sweep. The emulator handle's `tabTitle` is kept in step
   * for the same consistency, though no action keys off it.
   *
   * Discovery converges on this exact value on its next tick (the terminal really
   * was renamed), so there's nothing to reconcile - a stale in-flight sweep that
   * started before the rename can briefly show the old name, then self-heals.
   *
   * Renaming a multiplexer session renames it for every card hosted on it:
   * `correlate` groups agents by tty, so two agents in two panes of one multiplexer
   * home are two cards sharing that handle's `session`. All of them are
   * re-pointed, or a sibling's Focus would attach by a name that no longer resolves
   * until the next sweep. A sibling named by that same backend (`nameSource`) takes
   * the new display name too - its title just IS the session name.
   *
   * A dispatched task holds its own persisted copy of the home name, and that copy
   * drives destructive teardown: `reconcileOnStartup` reads `homeName` back after
   * a restart and reclaims the worktree when the name no longer resolves. Left
   * stale, a renamed agent's tree would be force-removed out from under it, so the
   * binding moves with the rename here, persisted through `upsertTask` to reach
   * SQLite. The old name alone is too weak a key: it is unique only among LIVE
   * sessions, while `homeName` is a historical record and a multiplexer frees a dead
   * session's name for immediate reuse. So the task must also hold the worktree of
   * a session actually on this terminal home (the `cwd` join `activeTaskForCwd`
   * uses) - otherwise a long-dead task that merely recorded a since-reused name
   * would be re-pointed onto a live session and later kill it. `sessionId` can't be
   * the key: the dispatcher only sets it on the success path, so a failed-but-alive
   * task - which still holds a worktree and must still follow - has none.
   */
  renameSession(sessionId: string, name: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.name === name) return;
    const priorMux = muxHandle(s)?.session ?? null;
    const priorHomeNames = terminalHomeNames(s);
    const priorResourceIds = terminalResourceIds(s);
    const renameHandle = (h: TerminalHandle): TerminalHandle => {
      if (h.kind === "emulator") return { ...h, tabTitle: name };
      return {
        ...h,
        session: h.session === h.sessionName ? name : h.session,
        sessionName: name,
      };
    };
    const renamedHandles = s.terminals.map(renameHandle);
    const resourceRenames = new Map(
      s.terminals.map((handle, index) => [terminalResourceId(handle), terminalResourceId(renamedHandles[index]!)])
    );
    const next: Session = {
      ...s,
      name,
      terminals: renamedHandles,
    };
    this.sessions.set(sessionId, next);
    this.emitSession(next);
    // Keep a scout's frozen episode title level with the card. Capture reads the live
    // `session.name` when the session is still there and this stored copy when it is not,
    // so letting the two drift would archive the same scout under two different titles
    // depending only on whether it was captured before or after its session was evicted.
    // Hung off the one rename path rather than off a second mechanism, which is also why
    // it is here and not in the route: `renameForTask` and the rename route both land here.
    //
    // It cannot throw - see the note on `prompt-journal.ts`. That matters here rather than
    // being belt and braces: the card has already been repainted and broadcast above, and
    // the sibling-pane rename and the task resource re-pointing below have not run yet, so
    // an exception escaping this line would leave a renamed session whose siblings and
    // bound tasks are silently stale.
    // The session's CURRENT episode, read rather than ensured: a rename must not mint an
    // episode as a side effect. Scoping to it is what stops a reused agent's next task
    // renaming the frozen title of the finished scout still waiting to be captured.
    refreshScoutPromptTitle(sessionId, sessionWorkEpisodeFor(sessionId)?.episodeId ?? null, name);

    const hostedCwds = new Set<string>();
    if (s.cwd) hostedCwds.add(s.cwd);
    if (priorMux) {
      for (const [id, other] of [...this.sessions]) {
        if (id === sessionId) continue;
        const pane = muxHandle(other);
        if (!pane || pane.session !== priorMux) continue;
        if (other.cwd) hostedCwds.add(other.cwd);
        const renamed: Session = {
          ...other,
          name: other.nameSource === pane.backend ? name : other.name,
          terminals: other.terminals.map((h) =>
            h.kind === "multiplexer" && h.session === priorMux ? renameHandle(h) : h,
          ),
        };
        this.sessions.set(id, renamed);
        this.emitSession(renamed);
        // A sibling pane whose name follows the multiplexer's has just been renamed too, so
        // its frozen scout title has to move with it for the same reason the direct rename's
        // does. Guarded on the name actually changing rather than fired unconditionally: a
        // sibling that carries its own name keeps it here, and refreshing that one would
        // overwrite a scout's frozen title with a heading its card never showed.
        if (renamed.name !== other.name) {
          refreshScoutPromptTitle(id, sessionWorkEpisodeFor(id)?.episodeId ?? null, renamed.name);
        }
      }
    }

    const candidates = this.listTasks().filter((t) =>
      (Boolean(t.worktreePath) || Boolean(t.homeName)) &&
      ((t.terminalResourceId !== null && priorResourceIds.has(t.terminalResourceId)) ||
        (t.homeName !== null && priorHomeNames.has(t.homeName)))
    );
    const strong = candidates.filter((t) =>
      (t.terminalResourceId !== null && priorResourceIds.has(t.terminalResourceId)) ||
      t.sessionId === sessionId ||
      Boolean(t.worktreePath && hostedCwds.has(t.worktreePath))
    );
    const owners = strong.length > 0 ? strong : candidates.length === 1 ? candidates : [];
    for (const t of owners) {
      this.upsertTask({
        ...t,
        homeName: name,
        terminalResourceId: t.terminalResourceId
          ? resourceRenames.get(t.terminalResourceId) ?? t.terminalResourceId
          : null,
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * The live card this event speaks for, or undefined.
   *
   * The agent check is the same property the overlay's is, arriving by the other door:
   * a pane is reused, and `findSessionByEnv` resolves by pane first. A Claude hook that
   * landed on the Codex session now in that pane would rewrite its state, its activity
   * and - worst - its `agentSessionId` and `transcriptPath`, which are the keys its
   * note, queue and transcript hang off. Not folded into `findSessionByEnv` itself: its
   * cwd branch deliberately does NOT filter by agent (see the note there), and its other
   * caller is the MCP channel, which identifies itself differently.
   */
  private findSessionForHook(evt: HookIngest, key: string | null): Session | undefined {
    const s = this.findSessionByEnv(evt.env, evt.sessionId, evt.cwd, key);
    return s?.agent === evt.agent ? s : undefined;
  }

  /**
   * Resolve which live session a hook / MCP call belongs to, using the terminal
   * pane it captured (preferred), then a linked agent session id, then a unique
   * cwd match. Shared by hook ingest and the MCP review channel.
   */
  findSessionByEnv(
    env: HookIngest["env"],
    agentSessionId?: string | null,
    cwd?: string | null,
    key: string | null = overlayKeyFromEnv(env),
  ): Session | undefined {
    if (key) {
      for (const s of this.sessions.values()) if (sessionKey(s) === key) return s;
    }
    if (agentSessionId) {
      for (const s of this.sessions.values())
        if (s.agentSessionId === agentSessionId) return s;
    }
    if (cwd) {
      // Every live session in that cwd, whatever it runs. The agent was pinned to
      // "claude" here, which was an accident rather than a capability: the caller is a
      // hook or an MCP call that has already identified itself, and the tie-break this
      // fallback needs is UNIQUENESS - exactly one session in the directory. Filtering by
      // agent doesn't make the match safer, it makes it wrong in the one case that
      // matters, a Claude and a Codex session sharing a worktree: the filter hides the
      // ambiguity and binds the caller to the Claude card with full confidence.
      const matches = [...this.sessions.values()].filter((s) => s.cwd === cwd);
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  private startWorkEpisode(
    sessionId: string,
    agentSessionId: string | null,
    branch: string | null,
    startedAt: number,
    invalidateOwnership = true,
    awaitingAgentRebind = false,
    rebindFromTranscriptPath: string | null = null,
    promptedAt: number | null = null,
    dependencyRebind: "none" | "all" | "session-prless" = "none",
  ): SessionWorkEpisode | null {
    const previous = sessionWorkEpisodeFor(sessionId);
    if (!agentSessionId) {
      let invalidatedTaskIds: string[] = [];
      if (invalidateOwnership) {
        invalidatedTaskIds = deleteSessionWorkEpisodeWithOwnership(sessionId, startedAt);
      } else {
        deleteSessionWorkEpisode(sessionId);
      }
      this.prObservations.delete(sessionId);
      this.publishEpisodeTaskChanges([], invalidatedTaskIds, sessionId, startedAt);
      this.cleanupDependencyProvenance();
      return null;
    }
    const episode: SessionWorkEpisode = {
      episodeId: randomUUID(),
      sessionId,
      agentSessionId,
      branch,
      prUrl: null,
      prHeadSha: null,
      mergedAt: null,
      promptedAt,
      awaitingAgentRebind,
      rebindFromTranscriptPath: awaitingAgentRebind ? rebindFromTranscriptPath : null,
      startedAt,
      updatedAt: startedAt,
    };
    const rebinds =
      previous !== null &&
      (dependencyRebind === "all" ||
        (dependencyRebind === "session-prless" && previous.prUrl === null))
        ? this.pendingDependencyRebinds(
            previous,
            episode,
            startedAt,
            dependencyRebind === "all" ? "all" : "none",
          )
        : [];
    const invalidatedTaskIds = replaceSessionWorkEpisodeWithDependencies(
      episode,
      rebinds.map(this.taskDependencyRewrite),
      invalidateOwnership ? sessionId : null,
    );
    this.prObservations.delete(sessionId);
    this.publishEpisodeTaskChanges(rebinds, invalidatedTaskIds, sessionId, startedAt);
    if (previous?.episodeId !== episode.episodeId) this.cleanupDependencyProvenance();
    return episode;
  }

  private cleanupDependencyProvenance(): void {
    const legacyTaskIds = new Set<string>();
    const episodeKeys = new Set<string>();
    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies) {
        if (dependency.satisfiedAt !== null) continue;
        if (dependency.type === "task") {
          if (dependency.episodeId === null) legacyTaskIds.add(dependency.taskId);
          else if (dependency.sessionId !== null) {
            episodeKeys.add(`${dependency.sessionId}\0${dependency.episodeId}`);
          }
        } else if (dependency.episodeId !== null) {
          episodeKeys.add(`${dependency.sessionId}\0${dependency.episodeId}`);
        }
      }
    }
    for (const binding of historicalTaskWorkEpisodeBindings()) {
      // A historical binding survives for two independent reasons, and the completion one
      // is the newer: a rolled-past episode's pull request is what `mergedPrFor` reads to
      // complete the task, and - once a merge can be observed by URL rather than only
      // through a live session - what the poller is still WATCHING before that. Both are
      // `preservesCompletionEvidence`. The dependency reason is unchanged: a legacy edge
      // still pointing at the task keeps its PR-carrying binding.
      const owner = this.tasks.get(binding.taskId);
      const mergeEvidence =
        binding.prUrl !== null &&
        preservesCompletionEvidence(owner, binding.mergedAt !== null);
      const dependencyEvidence = legacyTaskIds.has(binding.taskId) && binding.prUrl !== null;
      if (!mergeEvidence && !dependencyEvidence) {
        deleteHistoricalTaskWorkEpisodeBinding(binding.taskId, binding.episodeId);
        continue;
      }
      episodeKeys.add(`${binding.sessionId}\0${binding.episodeId}`);
    }
    for (const identity of workEpisodePromptIdentities()) {
      const current = sessionWorkEpisodeFor(identity.sessionId);
      if (current?.episodeId === identity.episodeId) continue;
      if (episodeKeys.has(`${identity.sessionId}\0${identity.episodeId}`)) continue;
      deleteWorkEpisodePrompts(identity.sessionId, identity.episodeId);
    }
  }

  private hydrateTaskDependencyProvenance(): void {
    const historical = new Map<string, TaskWorkEpisodeBinding[]>();
    for (const binding of historicalTaskWorkEpisodeBindings()) {
      const list = historical.get(binding.taskId) ?? [];
      list.push(binding);
      historical.set(binding.taskId, list);
    }
    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "task" ||
          dependency.satisfiedAt !== null ||
          dependency.episodeId !== null
        ) {
          return dependency;
        }
        const active = taskWorkEpisodeForTask(dependency.taskId);
        const binding = active ?? historical.get(dependency.taskId)?.[0] ?? null;
        if (!binding) return dependency;
        changed = true;
        return {
          ...dependency,
          sessionId: binding.sessionId,
          episodeId: binding.episodeId,
          agentSessionId: binding.agentSessionId,
          branch: binding.branch,
          prUrl: binding.prUrl,
        };
      });
      if (changed) this.upsertTask({ ...task, dependencies }, true);
    }
  }

  private bindPendingTaskDependencies(
    taskId: string,
    episode: Pick<
      SessionWorkEpisode,
      "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
    >,
    at: number,
  ): void {
    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "task" ||
          dependency.taskId !== taskId ||
          dependency.satisfiedAt !== null ||
          (dependency.episodeId !== null &&
            (dependency.sessionId !== episode.sessionId ||
              dependency.episodeId !== episode.episodeId ||
              dependency.agentSessionId !== episode.agentSessionId))
        ) {
          return dependency;
        }
        changed = true;
        return {
          ...dependency,
          sessionId: episode.sessionId,
          episodeId: episode.episodeId,
          agentSessionId: episode.agentSessionId,
          branch: episode.branch,
          prUrl: episode.prUrl,
        };
      });
      if (changed) this.upsertTask({ ...task, dependencies, updatedAt: at }, true);
    }
  }

  private pendingDependencyRebinds(
    previous: Pick<
      SessionWorkEpisode,
      "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
    >,
    next: SessionWorkEpisode,
    at: number,
    taskRebind: "all" | "bound" | "none" = "bound",
  ): Task[] {
    const rebinds: Task[] = [];
    const boundTaskMatches = new Map<string, boolean>();
    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.satisfiedAt !== null ||
          dependency.sessionId !== previous.sessionId ||
          dependency.episodeId !== previous.episodeId ||
          dependency.agentSessionId !== previous.agentSessionId ||
          dependency.branch !== previous.branch ||
          dependency.prUrl !== previous.prUrl
        ) {
          return dependency;
        }
        if (dependency.type === "task") {
          if (taskRebind === "none") return dependency;
          if (taskRebind === "bound") {
            let matches = boundTaskMatches.get(dependency.taskId);
            if (matches === undefined) {
              matches = this.taskDependencyOwnsEpisode(dependency.taskId, previous);
              boundTaskMatches.set(dependency.taskId, matches);
            }
            if (!matches) return dependency;
          }
        }
        changed = true;
        return {
          ...dependency,
          sessionId: next.sessionId,
          episodeId: next.episodeId,
          agentSessionId: next.agentSessionId,
          branch: next.branch,
          prUrl: next.prUrl,
        };
      });
      if (changed) rebinds.push({ ...task, dependencies, updatedAt: at });
    }
    return rebinds;
  }

  private taskDependencyOwnsEpisode(
    taskId: string,
    episode: Pick<
      SessionWorkEpisode,
      "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
    >,
  ): boolean {
    const binding = taskWorkEpisodeForTask(taskId);
    return Boolean(
      binding &&
      binding.sessionId === episode.sessionId &&
      binding.episodeId === episode.episodeId &&
      binding.agentSessionId === episode.agentSessionId &&
      binding.branch === episode.branch &&
      binding.prUrl === episode.prUrl,
    );
  }

  private readonly taskDependencyRewrite = (task: Task): TaskDependencyRewrite => ({
    taskId: task.id,
    dependencies: task.dependencies,
    updatedAt: task.updatedAt,
  });

  private publishEpisodeTaskChanges(
    rebinds: Task[],
    invalidatedTaskIds: string[],
    sessionId: string,
    at: number,
  ): void {
    const updates = new Map(rebinds.map((task) => [task.id, task]));
    for (const taskId of invalidatedTaskIds) {
      const task = updates.get(taskId) ?? this.tasks.get(taskId);
      if (task?.sessionId === sessionId) {
        const active = task.status === "dispatching" || task.status === "running";
        updates.set(taskId, {
          ...task,
          sessionId: null,
          status: active ? "cancelled" : task.status,
          completedAt: active ? task.completedAt ?? at : task.completedAt,
          updatedAt: Math.max(task.updatedAt, at),
        });
      }
    }
    for (const task of updates.values()) {
      this.tasks.set(task.id, task);
      this.emitEvent({ type: "task_upsert", task });
      this.syncSessionsForWorktree(task.worktreePath);
      if (task.sessionId) this.resyncSessionTask(task.sessionId);
    }
    this.resyncSessionTask(sessionId);
  }

  private rebindPendingDependencies(
    previous: Pick<
      SessionWorkEpisode,
      "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
    >,
    next: SessionWorkEpisode,
    at: number,
  ): void {
    for (const task of this.pendingDependencyRebinds(previous, next, at, "bound")) {
      this.upsertTask(task, true);
    }
  }

  private reconcileTaskDependencyEpisodes(
    episode: Pick<SessionWorkEpisode, "sessionId" | "episodeId" | "agentSessionId">,
    branch: string | null,
    prUrl: string,
    at: number,
  ): void {
    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "task" ||
          dependency.satisfiedAt !== null ||
          dependency.sessionId !== episode.sessionId ||
          dependency.episodeId !== episode.episodeId ||
          dependency.agentSessionId !== episode.agentSessionId ||
          (dependency.prUrl !== null && dependency.prUrl !== prUrl)
        ) {
          return dependency;
        }
        if (dependency.branch === branch && dependency.prUrl === prUrl) return dependency;
        changed = true;
        return { ...dependency, branch, prUrl };
      });
      if (changed) this.upsertTask({ ...task, dependencies, updatedAt: at }, true);
    }
  }

  private dropTaskDependencyProvenance(taskId: string, at: number): void {
    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "task" ||
          dependency.taskId !== taskId ||
          dependency.satisfiedAt !== null ||
          dependency.episodeId === null
        ) {
          return dependency;
        }
        changed = true;
        return {
          ...dependency,
          sessionId: null,
          episodeId: null,
          agentSessionId: null,
          branch: null,
          prUrl: null,
        };
      });
      if (changed) this.upsertTask({ ...task, dependencies, updatedAt: at }, true);
    }
  }

  private rolloverWorkEpisode(
    previous: SessionWorkEpisode,
    startedAt: number,
    session = this.sessions.get(previous.sessionId),
  ): SessionWorkEpisode | null {
    if (
      session?.agentSessionId !== null &&
      session?.agentSessionId !== undefined &&
      session.agentSessionId !== previous.agentSessionId
    ) {
      return null;
    }
    const taskId = dbTaskIdForSession(previous.sessionId);
    const next = this.startWorkEpisode(
      previous.sessionId,
      session?.agentSessionId ?? previous.agentSessionId,
      session?.gitBranch ?? previous.branch,
      startedAt,
      false,
      false,
      null,
      startedAt,
      "all",
    );
    if (!next) return null;
    if (taskId) this.bindTaskToWorkEpisode(taskId, previous.sessionId, next, startedAt);
    return next;
  }

  private reconcileWorkEpisodeMerge(
    target: Pick<
      SessionWorkEpisode,
      "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
    > & { prUrl: string },
    mergedAt: number,
    taskIds = new Set<string>(),
  ): boolean {
    const current = sessionWorkEpisodeFor(target.sessionId);
    const isCurrent = Boolean(
      current &&
        current.episodeId === target.episodeId &&
        current.agentSessionId === target.agentSessionId &&
        current.branch === target.branch &&
        current.prUrl === target.prUrl,
    );
    const latestPromptAt =
      isCurrent && typeof current?.promptedAt === "number" && current.promptedAt > mergedAt
        ? current.promptedAt
        : null;
    const promptAt = firstWorkEpisodePromptAfter(target.sessionId, target.episodeId, mergedAt);
    const dependencyBoundaryAt = promptAt ?? (latestPromptAt !== null ? mergedAt : null);
    const binding = taskWorkEpisodeForSession(target.sessionId);
    const activeTaskId =
      binding &&
      binding.episodeId === target.episodeId &&
      binding.agentSessionId === target.agentSessionId &&
      binding.branch === target.branch &&
      binding.prUrl === target.prUrl
        ? binding.taskId
        : null;
    if (activeTaskId !== null) taskIds.add(activeTaskId);

    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (dependency.satisfiedAt !== null) return dependency;
        const matchesSession =
          dependency.type === "session" &&
          dependency.sessionId === target.sessionId &&
          dependency.episodeId === target.episodeId &&
          dependency.agentSessionId === target.agentSessionId &&
          dependency.branch === target.branch &&
          dependency.prUrl === target.prUrl;
        const matchesTask =
          dependency.type === "task" &&
          ((dependency.sessionId === target.sessionId &&
            dependency.episodeId === target.episodeId &&
            dependency.agentSessionId === target.agentSessionId &&
            dependency.branch === target.branch &&
            dependency.prUrl === target.prUrl) ||
            (dependency.episodeId === null && taskIds.has(dependency.taskId)));
        if (!matchesSession && !matchesTask) return dependency;
        if (
          dependencyBoundaryAt !== null &&
          (dependency.selectedAt === null || dependency.selectedAt >= dependencyBoundaryAt)
        ) {
          return dependency;
        }
        changed = true;
        return { ...dependency, satisfiedAt: mergedAt };
      });
      if (changed) {
        this.upsertTask(
          { ...task, dependencies, updatedAt: Math.max(task.updatedAt, mergedAt) },
          true,
        );
      }
    }

    markWorkEpisodeMerged(target.sessionId, target.episodeId, target.prUrl, mergedAt);
    const rolloverAt = promptAt ?? latestPromptAt;
    let rolledOver = false;
    if (rolloverAt !== null && current && isCurrent) {
      rolledOver = this.rolloverWorkEpisode(current, rolloverAt) !== null;
    } else if (
      promptAt !== null &&
      current &&
      current.episodeId !== target.episodeId
    ) {
      this.rebindPendingDependencies(target, current, current.startedAt);
    }
    // The work this task was dispatched for has landed. Announced rather than acted on
    // here: the Registry is the store, and settling a task (and possibly ending its
    // session) is `TaskManager`'s to decide - the same split `session_remove` makes.
    //
    // `rolledOver` is only the ROLLOVER WE CAN SEE FROM HERE - one already recorded when
    // the merge was observed. The prompt that continues a task usually arrives after
    // this, so the listener re-checks `episodeId` against the session's current one
    // before acting. See `TaskManager.settleMergedTask`.
    if (activeTaskId !== null && !rolledOver) {
      this.emit("task_pr_merged", {
        taskId: activeTaskId,
        sessionId: target.sessionId,
        episodeId: target.episodeId,
        url: target.prUrl,
        mergedAt,
      } satisfies TaskPrMerged);
    }
    return rolledOver;
  }

  private resolvePendingWorkEpisode(
    episode: SessionWorkEpisode,
    agentSessionId: string,
    now: number,
  ): SessionWorkEpisode | null {
    if (!episode.awaitingAgentRebind) return episode;
    const next = {
      ...episode,
      agentSessionId,
      awaitingAgentRebind: false,
      rebindFromTranscriptPath: null,
      updatedAt: now,
    };
    const rebinds = this.pendingDependencyRebinds(episode, next, now, "bound");
    let invalidatedTaskIds: string[];
    if (episode.agentSessionId !== agentSessionId) {
      const result = rebindPendingSessionWorkEpisodeWithDependencies(
        episode.sessionId,
        episode.episodeId,
        agentSessionId,
        now,
        rebinds.map(this.taskDependencyRewrite),
        episode.sessionId,
      );
      if (!result.rebound) {
        return null;
      }
      invalidatedTaskIds = result.invalidatedTaskIds;
    } else {
      invalidatedTaskIds = replaceSessionWorkEpisodeWithDependencies(
        next,
        rebinds.map(this.taskDependencyRewrite),
        episode.sessionId,
      );
    }
    this.publishEpisodeTaskChanges(rebinds, invalidatedTaskIds, episode.sessionId, now);
    this.cleanupDependencyProvenance();
    return next;
  }

  private ensureWorkEpisode(
    session: Session,
    now = Date.now(),
    evidence:
      // `driver_identity` is `hook_identity`'s counterpart for a session whose harness
      // reports through a handle rather than a hook script: the AGENT announced who it is,
      // which is what the ownership rules below weigh (see `agentAnnouncedNewIdentity`).
      // Kept distinct from `hook_identity` rather than borrowed, because the vocabularies
      // are, and a driver event read as a hook event is the kind of thing that only shows
      // up once the two stop meaning the same thing.
      | { kind: "none" | "hook_identity" | "driver_identity" | "hook_work" | "new_work" }
      | {
          // `driver_clear` is `clear_start`'s counterpart on the driver channel: the agent
          // announced a new identity BECAUSE we asked it to wipe its context. It is grouped
          // with the two identity-carrying kinds rather than with `driver_identity` because
          // that is what it is - a rotation we caused, whose new id and transcript path are
          // both known - and that grouping is exactly what lets a pre-armed reset resolve
          // against it instead of timing out and stranding the episode on a dead key.
          kind: "clear_start" | "driver_clear" | "passive_identity";
          agentSessionId: string;
          transcriptPath: string | null;
        } = { kind: "none" },
  ): SessionWorkEpisode | null {
    if (!session.agentSessionId) return null;
    let existing = sessionWorkEpisodeFor(session.id);
    if (!existing) {
      const episode = this.startWorkEpisode(
        session.id,
        session.agentSessionId,
        session.gitBranch,
        session.startedAt ?? now,
        false,
        false,
        null,
        evidence.kind === "new_work" ? now : null,
      );
      const taskId = dbTaskIdForSession(session.id);
      if (episode && taskId && !taskWorkEpisodeForTask(taskId)) {
        this.bindTaskToWorkEpisode(taskId, session.id, episode, now);
      }
      return episode;
    }
    if (existing.agentSessionId !== session.agentSessionId) {
      const identityEvidence =
        evidence.kind === "clear_start" ||
        evidence.kind === "driver_clear" ||
        evidence.kind === "passive_identity"
          ? evidence
          : null;
      const clearEvidence =
        identityEvidence?.kind === "clear_start" || identityEvidence?.kind === "driver_clear";
      // What the transcript path is doing here is CORROBORATION: a hook can report the same
      // identity twice, so "the file it names is a different one" is what separates a genuine
      // rotation from a re-read of the session we were already on.
      //
      // A DRIVER clear needs a weaker form of it, and the difference is not a relaxation - it
      // is what the two channels can actually know. A hook fires after the harness has opened
      // the new session file, so its path is always there to compare. A driver reports the new
      // identity the instant the harness mints it, and the file is written lazily: measured
      // against Claude 2.1.220, the `bound` that follows a `/clear` carries `transcriptPath:
      // null` roughly every time, because `claudeSdkTranscriptPath` returns null for a file
      // that is not on disk YET rather than inventing a path that might never exist. Demanding
      // a non-null path there fails every embedded reset - `workIdentityReady: false` on a
      // reset that worked - and strands the episode, and with it the task's ownership of its
      // branch, on the identity the clear just destroyed.
      //
      // Nothing is being taken on trust to buy that. A `driver_clear` is latched by the
      // `clearContext()` WE issued and spent by the first rotation after it, and the id is
      // already proven different two lines below. So the path can only ever confirm what is
      // established; when the harness does report one it must still not be the old file.
      const pathReplaced = existing.rebindFromTranscriptPath === null
        ? clearEvidence || identityEvidence?.transcriptPath !== null
        : identityEvidence?.kind === "driver_clear"
          ? identityEvidence.transcriptPath !== existing.rebindFromTranscriptPath
          : identityEvidence?.transcriptPath !== null &&
            identityEvidence?.transcriptPath !== existing.rebindFromTranscriptPath;
      const canResolvePending = Boolean(
        existing.awaitingAgentRebind &&
        identityEvidence &&
        identityEvidence.agentSessionId === session.agentSessionId &&
        now >= existing.startedAt &&
        pathReplaced
      );
      if (canResolvePending) {
        const rebound = this.resolvePendingWorkEpisode(existing, session.agentSessionId, now);
        if (rebound) existing = rebound;
      } else if (existing.awaitingAgentRebind && evidence.kind === "none") {
        return existing;
      } else {
        // A session id is `proc:tty:pid:start`, so reaching here means the SAME live
        // process reported a different agent session id - our own read of a running
        // agent changed, not the agent. Dropping task ownership on that reading cancels
        // a task whose agent never stopped working, and the same write clears
        // `sessionId`, so nothing can reconcile the task back to the session still
        // sitting in its worktree: the agent ends up unable to be prompted at all, with
        // no cleanup that does not kill it.
        //
        // Giving up the task follows the AGENT saying it is someone new - a hook it
        // emitted - or an episode already awaiting a reset it cannot prove, where the
        // reset was asked for and an unproven identity must not inherit what it was
        // giving up.
        //
        // `none` and `passive_identity` are neither: they are our own passive read of a
        // process that never stopped working (for Codex, whichever rollout it had open
        // when we looked). Dropping ownership on our own re-read cancels a task whose
        // agent is mid-work, and the same write clears `sessionId`, so nothing can
        // reconcile the task back to the session still sitting in its worktree - the
        // agent ends up unpromptable, with no cleanup that does not kill it.
        const agentAnnouncedNewIdentity =
          evidence.kind !== "none" && evidence.kind !== "passive_identity";
        return this.startWorkEpisode(
          session.id,
          session.agentSessionId,
          session.gitBranch,
          now,
          agentAnnouncedNewIdentity || existing.awaitingAgentRebind,
          false,
          null,
          evidence.kind === "new_work" ? now : null,
        );
      }
    }
    if (
      existing.awaitingAgentRebind &&
      (evidence.kind === "hook_work" || evidence.kind === "new_work") &&
      now >= existing.startedAt
    ) {
      const resumed = this.resolvePendingWorkEpisode(existing, existing.agentSessionId, now);
      if (resumed) existing = resumed;
    }
    if (
      evidence.kind === "new_work" &&
      existing.mergedAt !== null &&
      now >= existing.mergedAt
    ) {
      return this.rolloverWorkEpisode(existing, now, session);
    }
    if (evidence.kind === "new_work" && now >= existing.startedAt) {
      if (recordWorkEpisodePrompt(session.id, existing.episodeId, now)) {
        existing = {
          ...existing,
          promptedAt: Math.max(existing.promptedAt ?? 0, now),
          updatedAt: Math.max(existing.updatedAt, now),
        };
      }
    }
    const branchChanged =
      existing.branch !== null &&
      session.gitBranch !== null &&
      !DEFAULT_WORK_BRANCHES.has(existing.branch) &&
      existing.branch !== session.gitBranch;
    if (branchChanged) {
      return this.startWorkEpisode(
        session.id,
        session.agentSessionId,
        session.gitBranch,
        now,
        true,
        false,
        null,
        evidence.kind === "new_work" ? now : null,
      );
    }
    if (
      session.gitBranch !== null &&
      existing.branch !== session.gitBranch &&
      session.lastSeen >= existing.startedAt &&
      (existing.branch === null || DEFAULT_WORK_BRANCHES.has(existing.branch))
    ) {
      const next = { ...existing, branch: session.gitBranch, updatedAt: now };
      replaceSessionWorkEpisode(next);
      return next;
    }
    const taskId = dbTaskIdForSession(session.id);
    if (taskId && !taskWorkEpisodeForTask(taskId)) {
      this.bindTaskToWorkEpisode(taskId, session.id, existing, now);
    }
    return existing;
  }

  resetWorkEpisode(
    sessionId: string,
    options: {
      awaitingAgentRebind?: boolean;
      previousAgentSessionId?: string | null;
      at?: number;
    } = {},
  ): SessionWorkEpisode | null {
    const session = this.sessions.get(sessionId);
    const at = options.at ?? Date.now();
    const awaitingAgentRebind = Boolean(
      options.awaitingAgentRebind &&
      session?.agentSessionId === options.previousAgentSessionId
    );
    return this.startWorkEpisode(
      sessionId,
      session?.agentSessionId ?? null,
      null,
      at,
      true,
      awaitingAgentRebind,
      session?.transcriptPath ?? null,
      null,
      "session-prless",
    );
  }

  workEpisodeForSession(sessionId: string): SessionWorkEpisode | null {
    const session = this.sessions.get(sessionId);
    return session ? this.ensureWorkEpisode(session) : sessionWorkEpisodeFor(sessionId);
  }

  workEpisodeForTask(taskId: string): TaskWorkEpisodeBinding | null {
    return taskWorkEpisodeForTask(taskId);
  }

  waitForWorkEpisodeReady(
    sessionId: string,
    episodeId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const current = sessionWorkEpisodeFor(sessionId);
    if (current?.episodeId !== episodeId) return Promise.resolve(false);
    if (!current.awaitingAgentRebind) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = unref(setTimeout(() => {
        unsub();
        resolve(false);
      }, timeoutMs));
      const unsub = this.subscribe((event) => {
        if (event.type !== "session_upsert" || event.session.id !== sessionId) return;
        const episode = sessionWorkEpisodeFor(sessionId);
        if (episode?.episodeId === episodeId && episode.awaitingAgentRebind) return;
        clearTimeout(timer);
        unsub();
        resolve(episode?.episodeId === episodeId);
      });
    });
  }

  bindTaskToWorkEpisode(
    taskId: string,
    sessionId: string,
    episode = this.workEpisodeForSession(sessionId),
    at = Date.now(),
  ): boolean {
    if (!episode || episode.awaitingAgentRebind) return false;
    const binding: TaskWorkEpisodeBinding = {
      taskId,
      episodeId: episode.episodeId,
      sessionId,
      agentSessionId: episode.agentSessionId,
      branch: episode.branch,
      prUrl: episode.prUrl,
      prHeadSha: episode.prHeadSha,
      mergedAt: episode.mergedAt,
      boundAt: at,
      updatedAt: at,
    };
    dbBindTaskWorkEpisode(binding);
    this.bindPendingTaskDependencies(taskId, binding, at);
    this.cleanupDependencyProvenance();
    return true;
  }

  taskOwnsWorkEpisode(taskId: string, sessionId: string, prUrl: string): boolean {
    const binding = taskWorkEpisodeForTask(taskId);
    const episode = sessionWorkEpisodeFor(sessionId);
    return Boolean(
      binding &&
        episode &&
        binding.sessionId === sessionId &&
        binding.episodeId === episode.episodeId &&
        binding.agentSessionId === episode.agentSessionId &&
        binding.branch === episode.branch &&
        binding.prUrl === prUrl &&
        binding.prHeadSha === episode.prHeadSha,
    );
  }

  private acceptPrForEpisode(
    session: Session,
    match: PrMatch,
    at: number,
  ): SessionWorkEpisode | null {
    if (!match.episodeId || !session.agentSessionId) return null;
    const episode = sessionWorkEpisodeFor(session.id);
    const firstAssociation = episode?.prUrl === null;
    const matchesPolledWorktreeHead =
      match.worktreeHeadSha !== null && match.headSha === match.worktreeHeadSha;
    const createdDuringEpisode =
      episode !== null && match.createdAt !== null && match.createdAt >= episode.startedAt;
    if (
      !episode ||
      episode.awaitingAgentRebind ||
      episode.episodeId !== match.episodeId ||
      episode.agentSessionId !== match.agentSessionId ||
      match.branch !== session.gitBranch ||
      match.headSha === null ||
      (firstAssociation && !matchesPolledWorktreeHead && !createdDuringEpisode) ||
      (match.createdAt !== null && match.createdAt < episode.startedAt) ||
      (episode.prUrl !== null && episode.prUrl !== match.url)
    ) {
      return null;
    }
    if (
      !updateWorkEpisodePr(
        session.id,
        episode.episodeId,
        match.branch,
        match.url,
        match.headSha,
        at,
      )
    ) {
      return null;
    }
    return {
      ...episode,
      branch: match.branch,
      prUrl: match.url,
      prHeadSha: match.headSha,
      updatedAt: at,
    };
  }

  /**
   * Live sessions the PR poller should consider, with the branch and cwd it needs
   * to ask `gh` for an open PR. Sessions with no cwd or that have exited are
   * dropped (nothing to poll, and an exited session's link is about to go away
   * with it). Everything else is a candidate - the poller decides which actually
   * warrant a `gh` call, and any candidate left without a match is cleared.
   */
  prPollTargets(): {
    id: string;
    cwd: string;
    branch: string | null;
    prUrl: string | null;
    agentSessionId: string | null;
    episodeId: string | null;
  }[] {
    const out: {
      id: string;
      cwd: string;
      branch: string | null;
      prUrl: string | null;
      agentSessionId: string | null;
      episodeId: string | null;
    }[] = [];
    for (const s of this.sessions.values()) {
      if (!s.cwd || s.state === "exited") continue;
      const episode = this.ensureWorkEpisode(s);
      out.push({
        id: s.id,
        cwd: s.cwd,
        branch: s.gitBranch,
        prUrl: s.prUrl,
        agentSessionId: s.agentSessionId,
        episodeId: episode?.episodeId ?? null,
      });
    }
    return out;
  }

  /**
   * The SECONDARY repositories of every live multi-repo task, as the branch poller needs to
   * ask `gh` about them: one `(cwd, branch)` pair per attached worktree.
   *
   * The fan-out that makes a secondary repo's pull request discoverable at all. The primary
   * list above is one entry per SESSION, because `Session.prUrl` is one chip; a multi-repo
   * task has one branch checked out in each of N worktrees, and `gh pr list --head` only
   * answers for the repo it is run in. Still one `gh` call per distinct cwd, which is the
   * cost rule the poller has always kept - these cwds are simply new ones.
   *
   * Empty on a single-repo install, and empty for every single-repo task, so the poller's
   * shape is unchanged for the tasks that are nearly all of them.
   */
  extraRepoPrPollTargets(): RepoPrPollTarget[] {
    const out: RepoPrPollTarget[] = [];
    for (const s of this.sessions.values()) {
      if (!s.cwd || s.state === "exited") continue;
      const task = this.activeTaskFor(s.id, s.cwd);
      if (!task || task.extraRepos.length === 0) continue;
      const episode = sessionWorkEpisodeFor(s.id);
      for (const entry of task.extraRepos) {
        // Native acquisition records the detached checkout honestly as `branch: null`.
        // Agents create their branches later, so use the recorded provision-time branch
        // when one exists and otherwise observe the checkout now. Do not write it back to
        // the task: its resource record remains the exact acquisition result.
        if (!entry.worktreePath) continue;
        const branch = entry.branch ?? gitInfo(entry.worktreePath).branch;
        if (!branch) continue;
        out.push({
          key: repoPrTargetKey(s.id, entry.repoRoot),
          sessionId: s.id,
          taskId: task.id,
          repoRoot: entry.repoRoot,
          cwd: entry.worktreePath,
          branch,
          agentSessionId: s.agentSessionId,
          episodeId: episode?.episodeId ?? null,
        });
      }
    }
    return out;
  }

  /**
   * Adopt the pull requests the poller found in each attached repository's worktree.
   *
   * Deliberately NOT part of `reconcilePrs`, and not because it would be awkward there. That
   * function's single rule is "every session not in `skip` is set to what `gh` says about its
   * branch, including to nothing", which is what retracts a stale chip. A secondary repo has
   * no chip and no session field to retract: what it has is a durable per-repo association on
   * the work episode, which - exactly like the primary's - is never retracted once made. So a
   * repo absent from `found` is a no-op here rather than a clear.
   *
   * `skip` is honoured for the same reason it is there: a `gh` that timed out says nothing.
   */
  reconcileRepoPrs(found: Map<string, PrMatch>, skip: Set<string>): void {
    const at = Date.now();
    const touchedTasks = new Set<string>();
    const observedSessions = new Set<string>();
    for (const target of this.extraRepoPrPollTargets()) {
      if (skip.has(target.key)) continue;
      const match = found.get(target.key);
      // The live observation, recorded before the durable one and on a different rule: this
      // repository has an open pull request right now, or it has not. `!match` here is `gh`
      // answering "nothing on this branch", which the durable association below deliberately
      // ignores and Foreman's follow-through must not.
      const moved = this.recordLivePr(
        target.key,
        match && match.state === "open" && match.number !== null
          ? { url: match.url, number: match.number, checks: match.checks }
          : null,
      );
      // A live observation moving changes this session's card and nothing in the DATABASE, so
      // the durable refresh below cannot notice it: a repository whose pull request merely
      // went red touches no row. Without this the new reading waits for the next poll pass to
      // rebuild the summary for some unrelated reason, and Foreman decides on the old one.
      if (moved) observedSessions.add(target.sessionId);
      if (!match) continue;
      // A merged pull request whose merge instant `gh` did not report is not yet a merge -
      // the same refusal `reconcilePrs` makes, so nothing lands a null `mergedAt`.
      if (match.state === "merged" && match.mergedAt === null) continue;
      const episodeId = this.acceptRepoPrForEpisode(target, match, at);
      if (!episodeId) continue;
      touchedTasks.add(target.taskId);
      // The measurement that fixes adoption's one blind spot: the hook proved WE opened this
      // pull request but could only name the session's own repo, and `gh` has now answered
      // for it from inside this repository's worktree. See `retargetInspectorPrCheckout`.
      const parsed = parsePrUrl(match.url);
      if (parsed && retargetInspectorPrCheckout(parsed.key, target.repoRoot, target.cwd, at)) {
        this.refreshInspections();
      }
      if (match.state === "merged" && match.mergedAt !== null) {
        markWorkEpisodeMerged(target.sessionId, episodeId, match.url, match.mergedAt);
      }
    }
    for (const taskId of touchedTasks) this.refreshTaskRepoPrs(taskId);
    // After the durable refresh, which already resyncs the sessions it moved: this covers the
    // ones it did not, and re-deriving a summary that is already current is a no-op.
    for (const sessionId of observedSessions) this.resyncSessionTask(sessionId);
  }

  /**
   * Associate one pull request with one SECONDARY repository of a task's current episode.
   *
   * The per-repo twin of `acceptPrForEpisode`, guard for guard, with two substitutions that
   * are the whole of the difference:
   *
   *  - the branch compared against is the ENTRY's branch, not `session.gitBranch`. The
   *    session's branch is the primary worktree's; a pooled secondary lease can legitimately
   *    arrive on a different one, which phase 1 records per entry and the manifest states.
   *  - "does this episode already hold a pull request" is asked per repository, so repo A
   *    holding one does not refuse repo B's, while a SECOND, different url for repo A is
   *    refused exactly as the scalar guard refuses a second primary pull request.
   */
  private acceptRepoPrForEpisode(
    target: RepoPrPollTarget,
    match: PrMatch,
    at: number,
  ): string | null {
    const session = this.sessions.get(target.sessionId);
    if (!session?.agentSessionId) return null;
    const episode = sessionWorkEpisodeFor(session.id);
    if (!episode || episode.awaitingAgentRebind) return null;
    const existing = workEpisodeRepoPr(episode.episodeId, target.repoRoot);
    const firstAssociation = existing === null;
    const matchesPolledWorktreeHead =
      match.worktreeHeadSha !== null && match.headSha === match.worktreeHeadSha;
    const createdDuringEpisode = match.createdAt !== null && match.createdAt >= episode.startedAt;
    if (
      episode.episodeId !== match.episodeId ||
      episode.agentSessionId !== match.agentSessionId ||
      match.branch !== target.branch ||
      match.headSha === null ||
      (firstAssociation && !matchesPolledWorktreeHead && !createdDuringEpisode) ||
      (match.createdAt !== null && match.createdAt < episode.startedAt) ||
      (existing !== null && existing.prUrl !== match.url)
    ) {
      return null;
    }
    const recorded = recordWorkEpisodeRepoPr(
      {
        episodeId: episode.episodeId,
        repoRoot: target.repoRoot,
        sessionId: session.id,
        taskId: target.taskId,
        prUrl: match.url,
        prState: match.state,
        prHeadSha: match.headSha,
      },
      at,
    );
    return recorded ? episode.episodeId : null;
  }

  /**
   * Re-read a task's per-repo pull request state and broadcast it if anything moved.
   *
   * The one place the projection reaches the board. `Task.extraRepos` is filled on READ from
   * `work_episode_prs`, so the in-memory row a card was last sent goes stale the moment a
   * pull request is adopted or observed merged - and nothing else would push it out, because
   * none of the task's own columns changed.
   */
  private refreshTaskRepoPrs(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.extraRepos.length === 0) return;
    const extraRepos = taskReposFor(taskId);
    if (JSON.stringify(extraRepos) === JSON.stringify(task.extraRepos)) return;
    const next = { ...task, extraRepos };
    this.tasks.set(taskId, next);
    this.emitEvent({ type: "task_upsert", task: next });
    if (next.sessionId) this.resyncSessionTask(next.sessionId);
  }

  /**
   * A freshly derived task summary when this session is running a MULTI-repo task, and the
   * one the session already carries otherwise.
   *
   * The narrow half of `taskSummaryFor`, for the one caller that has to notice a change the
   * task row cannot express. Single-repo sessions get back the identical object, so the
   * caller's equality check sees no movement and nothing about them is re-emitted.
   */
  private repoPrSummaryFor(s: Session): TaskSummary | null {
    const task = this.activeTaskFor(s.id, s.cwd);
    if (!task || task.extraRepos.length === 0) return s.task;
    return this.taskSummaryFor(s.id, s.cwd);
  }

  /**
   * Record (or retract) what a poll saw of ONE repository's pull request. See `livePrs`.
   *
   * `null` is the retraction and it is the whole reason this is a method rather than two map
   * writes: the caller that has an answer and the caller that has "nothing here" must reach
   * the same place, or the map keeps saying `open` about a pull request somebody closed.
   */
  private recordLivePr(key: string, observed: LivePrObservation | null): boolean {
    const prev = this.livePrs.get(key) ?? null;
    if (
      prev?.url === observed?.url &&
      prev?.number === observed?.number &&
      prev?.checks === observed?.checks
    ) {
      return false;
    }
    if (observed) this.livePrs.set(key, observed);
    else this.livePrs.delete(key);
    return true;
  }

  /**
   * The live feedback for one repository of a multi-repo task, or null when the last poll saw
   * no open pull request there.
   *
   * The url is compared, not just the key: the durable association and the live observation
   * are written by different passes, and answering with the checks of a pull request this
   * repository has since moved off would be worse than answering with nothing.
   */
  private repoPrFeedbackFor(
    sessionId: string,
    repoRoot: string,
    prUrl: string | null,
  ): RepoPrFeedback | null {
    if (!prUrl) return null;
    const live = this.livePrs.get(repoPrTargetKey(sessionId, repoRoot));
    if (!live || live.url !== prUrl) return null;
    return {
      prNumber: live.number,
      prChecks: live.checks,
      inspector: this.inspectorSummaryForUrl(prUrl),
    };
  }

  /**
   * The worktrees whose head the completion quorum still needs read.
   *
   * Every repository of every multi-repo task a merge could still complete - and no others,
   * so a fleet with no multi-repo task in flight spends nothing on this. The PRIMARY is in
   * the list: it is a repository like any other to the changed-set rule, and leaving it out
   * is precisely how a task whose primary changed without opening a primary pull request
   * would complete on a merged secondary alone.
   */
  worktreeHeadTargets(): string[] {
    const paths = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.extraRepos.length === 0 || !completableByMerge(task.status)) continue;
      for (const ref of taskRepoRefs(task)) {
        if (ref.worktreePath) paths.add(ref.worktreePath);
      }
    }
    return [...paths];
  }

  /**
   * Record what a head sweep saw. `null` means "we looked and could not answer" - a tree that
   * has been torn down or a `git` that failed - which the changed-set rule reads as unchanged.
   *
   * In memory rather than persisted, and that is what makes the three-state
   * `undefined`/`null`/sha distinction in `repoChangeVerdict` load-bearing: after a restart
   * nothing has been observed yet, and a quorum that read "unobserved" as "unchanged" would
   * complete a task on one merged sibling in the seconds before the first sweep.
   */
  recordWorktreeHeads(heads: Map<string, string | null>): void {
    for (const [path, sha] of heads) this.worktreeHeads.set(path, sha);
    // Bounded by what is still worth asking about, so a long-lived daemon does not
    // accumulate an entry per worktree it ever polled.
    const live = new Set(this.worktreeHeadTargets());
    for (const path of this.worktreeHeads.keys()) {
      if (!live.has(path)) this.worktreeHeads.delete(path);
    }
  }

  /**
   * The last observed head of a worktree: a sha, `null` for "looked and could not answer",
   * or `undefined` for "nothing has looked yet".
   */
  worktreeHead(path: string | null): string | null | undefined {
    return path === null ? null : this.worktreeHeads.get(path);
  }

  /**
   * Driver-run sessions whose checkout has to be re-read, with the cwd to read it in.
   *
   * The counterpart to `applyDiscovery` for the one runtime that never passes through it.
   * A pane-backed session's Git facts are re-resolved from its cwd on every sweep, so it
   * follows the agent onto whatever branch it cuts. A driver-run session is registered once
   * and never passes through that sweep. Without this counterpart a pooled worktree can stay
   * branchless for its whole session.
   *
   * Scoped to `runtime === "sdk"` for the same reason `applyDiscovery`'s unseen-means-exited
   * loop is scoped to `"terminal"`: this is the arm for sessions the sweep cannot answer for,
   * not a second answer for the ones it already does.
   */
  driverGitTargets(): { id: string; cwd: string }[] {
    const out: { id: string; cwd: string }[] = [];
    for (const s of this.sessions.values()) {
      if (s.runtime !== "sdk" || !s.cwd || s.state === "exited") continue;
      out.push({ id: s.id, cwd: s.cwd });
    }
    return out;
  }

  /**
   * Adopt the mutable Git facts for each driver-run session's checkout.
   *
   * `null` overwrites a known branch rather than being ignored, which is deliberate and is
   * exactly what a pane-backed session already does: a detached HEAD (every `git rebase`
   * passes through one) and a worktree that has gone away both read as "no branch", and
   * `branchFromHead` returning null is what lets the first REAL branch be adopted in place
   * instead of looking like a branch change that invalidates task ownership
   * (`ensureWorkEpisode`). Making the driver arm agree with the pane arm is the fix; a
   * special case that held the last value here would be a third answer to "what branch is
   * this session on".
   *
   * `cwd` is fixed for the life of a driver-run session, so `gitRoot` and `repoRoot` cannot
   * have changed and the launch-time answers stay authoritative. The branch is mutable as
   * agents cut branches after the session launches.
   */
  applyDriverGit(
    snapshots: Map<string, { branch: string | null }>,
  ): void {
    for (const [id, snapshot] of snapshots) {
      const s = this.sessions.get(id);
      if (!s || s.runtime !== "sdk" || s.state === "exited") continue;
      if (s.gitBranch === snapshot.branch) continue;
      const next: Session = {
        ...s,
        gitBranch: snapshot.branch,
      };
      this.sessions.set(next.id, next);
      if (!sessionEqual(s, next)) this.emitSession(next);
    }
  }

  prObservationFor(sessionId: string): PrObservation | null {
    return this.prObservations.get(sessionId) ?? null;
  }

  /**
   * Reconcile each session's PR chip against what `gh` reported this tick.
   * `found` holds the open-or-merged PR for every session that has one right now;
   * `skip` holds sessions whose `gh` query failed (missing/unauthenticated `gh`, a
   * timeout) so their existing chip is left untouched rather than wrongly wiped.
   * Every other session is set to "no PR": that single rule retracts the chip when
   * the session is reset onto a branch with no matching PR (the branch drops out
   * of `found`) - so a reused session never carries a stale chip from its previous
   * branch. A merged PR stays in `found` (the poller keeps reporting it) and so
   * lingers until the branch changes; only a closed-unmerged PR falls out.
   */
  reconcilePrs(found: Map<string, PrMatch>, skip: Set<string>): void {
    for (const [id, s] of this.sessions) {
      if (skip.has(id)) continue;
      let match = found.get(id) ?? null;
      const currentEpisode = sessionWorkEpisodeFor(id);
      if (
        match &&
        (match.branch !== s.gitBranch ||
          match.agentSessionId !== s.agentSessionId ||
          match.episodeId !== (currentEpisode?.episodeId ?? null))
      )
        continue;
      if (match?.state === "merged" && match.mergedAt === null) continue;
      const at = Date.now();
      const acceptedEpisode = match?.episodeId ? this.acceptPrForEpisode(s, match, at) : null;
      if (match?.episodeId && !acceptedEpisode) match = null;
      if (match && acceptedEpisode) {
        this.reconcileSessionDependencies(s, match, at);
        this.reconcileTaskDependencyEpisodes(acceptedEpisode, match.branch, match.url, at);
        const binding = taskWorkEpisodeForSession(s.id);
        if (
          binding &&
          binding.episodeId === acceptedEpisode.episodeId &&
          binding.agentSessionId === acceptedEpisode.agentSessionId
        ) {
          this.bindPendingTaskDependencies(
            binding.taskId,
            { ...acceptedEpisode, prUrl: match.url },
            at,
          );
        }
      }
      if (match?.state === "merged" && match.mergedAt !== null && acceptedEpisode) {
        if (
          this.reconcileWorkEpisodeMerge(
            { ...acceptedEpisode, prUrl: match.url },
            match.mergedAt,
          )
        ) {
          match = null;
        }
      }
      // Re-read this session AFTER the merge reconciliation above, which is not a pure write:
      // it announces `task_pr_merged`, and the listener that settles the task runs
      // synchronously up to its first await - completing the task, upserting it, and
      // rewriting this very map entry with the finished summary. `s` is the snapshot the
      // loop started with, so spreading it below would revert the card to the summary it had
      // BEFORE its task completed, and nothing would rebuild it: the task row has already
      // stopped changing. That leaves a finished task drawn as still running until some
      // unrelated event happens along.
      const live = this.sessions.get(id) ?? s;
      const url = match?.url ?? null;
      const number = match?.number ?? null;
      const state = match?.state ?? null;
      const checks = match?.checks ?? null;
      if (match && acceptedEpisode) {
        this.prObservations.set(id, {
          url: match.url,
          branch: match.branch,
          agentSessionId: match.agentSessionId,
          episodeId: acceptedEpisode.episodeId,
          headSha: match.headSha,
        });
      } else {
        this.prObservations.delete(id);
      }
      // The PRIMARY repository's live observation, recorded on exactly the rule its
      // secondaries get in `reconcileRepoPrs` - because to the follow-through the primary is
      // a repository like any other, and reading its feedback off the session scalars while
      // reading its siblings' off this map is how the two come apart. Written for every
      // session; only a multi-repo task's summary ever reads it back.
      const primaryRoot = this.activeTaskFor(id, live.cwd)?.repoRoot;
      if (primaryRoot !== undefined) {
        this.recordLivePr(
          repoPrTargetKey(id, primaryRoot),
          match && state === "open" && number !== null
            ? { url: match.url, number, checks }
            : null,
        );
      }
      // A multi-repo task's per-repo lines live on THIS session's card, and the PRIMARY
      // repo's line moves the moment the merge recorded just above lands. Nothing else
      // re-derives that summary - the task ROW did not change, only the binding its pull
      // request hangs off - so without this the card would go on saying "open" until some
      // unrelated event happened to rebuild it. Identical for a single-repo session, which
      // gets back the summary it already had.
      const task = this.repoPrSummaryFor(live);
      const taskMoved = JSON.stringify(task) !== JSON.stringify(live.task);
      if (
        !taskMoved &&
        live.prUrl === url &&
        live.prNumber === number &&
        live.prState === state &&
        live.prChecks === checks
      )
        continue;
      const next: Session = {
        ...live,
        prUrl: url,
        prNumber: number,
        prState: state,
        prChecks: checks,
        task,
      };
      // `prUrl` is the key the Inspector summary hangs off, so changing it here without
      // re-resolving leaves the chip answering for the PREVIOUS pull request - or, on the
      // ordinary startup ordering (this poller runs seconds after the first sweep, which
      // saw no PR yet), leaves an adopted PR with no chip at all until something unrelated
      // happens to rebuild the session. Same reason `applyHook` re-resolves.
      this.resolveInspectionSummaries(next);
      this.sessions.set(id, next);
      this.emitSession(next);
    }
    this.cleanupDependencyProvenance();
  }

  dependencyPrPollTargets(): string[] {
    const urls = new Set<string>();
    const bindings = new Map<string, TaskWorkEpisodeBinding | null>();
    const historical = new Map<string, TaskWorkEpisodeBinding[]>();
    for (const binding of historicalTaskWorkEpisodeBindings()) {
      const list = historical.get(binding.taskId) ?? [];
      list.push(binding);
      historical.set(binding.taskId, list);
    }
    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies) {
        if (dependency.satisfiedAt !== null) continue;
        if (dependency.type === "session") {
          if (dependency.prUrl) urls.add(dependency.prUrl);
          continue;
        }
        if (dependency.prUrl) {
          urls.add(dependency.prUrl);
          continue;
        }
        let binding = bindings.get(dependency.taskId);
        if (binding === undefined) {
          binding = taskWorkEpisodeForTask(dependency.taskId);
          bindings.set(dependency.taskId, binding);
        }
        if (binding?.prUrl) urls.add(binding.prUrl);
        for (const prior of historical.get(dependency.taskId) ?? []) {
          if (prior.prUrl) urls.add(prior.prUrl);
        }
      }
    }
    return [...urls];
  }

  /**
   * Every pull request URL a task's OWN completion could still be waiting on.
   *
   * The second harvest feeding the one by-URL poller; `dependencyPrPollTargets` above is
   * the first, and the two share a cadence rather than each keeping one. A standalone
   * task - one nothing declared a dependency on - had no merge observer at all once its
   * agent was gone: the branch poller asks `gh` about LIVE sessions only, so a killed
   * agent's pull request could merge on GitHub and nothing here would ever look. Its task
   * then sat `running` or `failed` for ever, holding a blocker over every dependent for
   * work that shipped.
   *
   * Only bindings whose merge has NOT been recorded are returned: `merged_at` is stamped
   * once and never re-read from GitHub, so a landed pull request costs exactly one `gh`
   * call in total. Statuses come from `completableByMerge`, so the harvest and the
   * reconciler cannot disagree about which rows are still in question.
   *
   * URLs, not episode tuples: the poller only needs to know what to ask about, and
   * `reconcilePrMerges` re-reads the binding that owns each merged URL anyway - handing
   * tuples out and back would be a second copy of the same lookup, free to drift.
   */
  taskPrPollTargets(): string[] {
    const urls = new Set<string>();
    const historical = new Map<string, TaskWorkEpisodeBinding[]>();
    for (const binding of historicalTaskWorkEpisodeBindings()) {
      const list = historical.get(binding.taskId) ?? [];
      list.push(binding);
      historical.set(binding.taskId, list);
    }
    for (const task of this.tasks.values()) {
      if (!completableByMerge(task.status)) continue;
      const candidates = [
        taskWorkEpisodeForTask(task.id),
        ...(historical.get(task.id) ?? []),
      ];
      for (const candidate of candidates) {
        if (candidate?.prUrl && candidate.mergedAt === null) urls.add(candidate.prUrl);
      }
      // And the SECONDARY repositories' pull requests, on the same rule. Without them a
      // multi-repo task's quorum could never be met once its agent was gone: the branch
      // poller only asks about LIVE sessions, so nothing would ever observe repo B's merge
      // and the task would sit `running` for ever with repo A's already landed.
      for (const repoPr of workEpisodeRepoPrsForTask(task.id)) {
        if (repoPr.mergedAt === null) urls.add(repoPr.prUrl);
      }
    }
    return [...urls];
  }

  /**
   * Record every merge the by-URL poller observed, against the episode that produced it.
   *
   * One entry point for both harvests on purpose. `reconcileWorkEpisodeMerge` is not a
   * pure write - it satisfies dependency edges, can roll a live episode over and announces
   * `task_pr_merged` - so running a dependency pass and a task-completion pass separately
   * would put the same episode through it twice in one tick.
   */
  reconcilePrMerges(mergedUrls: Map<string, number>): void {
    if (mergedUrls.size === 0) return;
    const bindings = new Map<string, TaskWorkEpisodeBinding | null>();
    const targets = new Map<string, {
      episode: Pick<
        SessionWorkEpisode,
        "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
      > & { prUrl: string };
      taskIds: Set<string>;
      historical: Array<{ taskId: string; episodeId: string }>;
    }>();
    const addTarget = (
      episode: Pick<
        SessionWorkEpisode,
        "sessionId" | "episodeId" | "agentSessionId" | "branch" | "prUrl"
      > & { prUrl: string },
      taskId: string | null = null,
      retained = false,
    ): void => {
      const key = `${episode.sessionId}\0${episode.episodeId}\0${episode.prUrl}`;
      const target = targets.get(key) ?? {
        episode,
        taskIds: new Set<string>(),
        historical: [],
      };
      if (taskId !== null) {
        target.taskIds.add(taskId);
        if (retained) target.historical.push({ taskId, episodeId: episode.episodeId });
      }
      targets.set(key, target);
    };
    const historical = new Map<string, TaskWorkEpisodeBinding[]>();
    for (const binding of historicalTaskWorkEpisodeBindings()) {
      const list = historical.get(binding.taskId) ?? [];
      list.push(binding);
      historical.set(binding.taskId, list);
    }
    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies) {
        if (dependency.satisfiedAt !== null) continue;
        if (dependency.type === "session") {
          if (
            !dependency.prUrl ||
            !mergedUrls.has(dependency.prUrl) ||
            dependency.episodeId === null ||
            dependency.agentSessionId === null
          ) {
            continue;
          }
          addTarget({
            sessionId: dependency.sessionId,
            episodeId: dependency.episodeId,
            agentSessionId: dependency.agentSessionId,
            branch: dependency.branch,
            prUrl: dependency.prUrl,
          });
          continue;
        }
        if (
          dependency.prUrl &&
          mergedUrls.has(dependency.prUrl) &&
          dependency.sessionId !== null &&
          dependency.episodeId !== null &&
          dependency.agentSessionId !== null
        ) {
          addTarget(
            {
              sessionId: dependency.sessionId,
              episodeId: dependency.episodeId,
              agentSessionId: dependency.agentSessionId,
              branch: dependency.branch,
              prUrl: dependency.prUrl,
            },
            dependency.taskId,
          );
          continue;
        }
        let binding = bindings.get(dependency.taskId);
        if (binding === undefined) {
          binding = taskWorkEpisodeForTask(dependency.taskId);
          bindings.set(dependency.taskId, binding);
        }
        const candidates = [binding, ...(historical.get(dependency.taskId) ?? [])];
        for (const candidate of candidates) {
          if (!candidate?.prUrl || !mergedUrls.has(candidate.prUrl)) continue;
          addTarget(
            {
              sessionId: candidate.sessionId,
              episodeId: candidate.episodeId,
              agentSessionId: candidate.agentSessionId,
              branch: candidate.branch,
              prUrl: candidate.prUrl,
            },
            dependency.taskId,
            candidate !== binding,
          );
        }
      }
    }
    // The other harvest's merges: a URL carried by a task's own binding, whether or not
    // anything ever declared a dependency on that task. Recorded with THAT binding's
    // episode tuple, which is what lets `markWorkEpisodeMerged` reach a row that rolled to
    // historical long before the merge was seen - the ordering a standalone task produces.
    //
    // No task id is contributed to `taskIds`, and no historical row is queued for deletion.
    // Both belong to dependency satisfaction, which the loop above decides and
    // `complete(..., satisfyDependents)` finishes once `TaskManager` acts on this record.
    // Widening either here would satisfy an edge from a merge that has completed nothing
    // yet, and would delete the very evidence the completion is about to read.
    for (const task of this.tasks.values()) {
      if (!completableByMerge(task.status)) continue;
      let binding = bindings.get(task.id);
      if (binding === undefined) {
        binding = taskWorkEpisodeForTask(task.id);
        bindings.set(task.id, binding);
      }
      for (const candidate of [binding, ...(historical.get(task.id) ?? [])]) {
        if (!candidate?.prUrl || !mergedUrls.has(candidate.prUrl)) continue;
        addTarget({
          sessionId: candidate.sessionId,
          episodeId: candidate.episodeId,
          agentSessionId: candidate.agentSessionId,
          branch: candidate.branch,
          prUrl: candidate.prUrl,
        });
      }
    }
    for (const target of targets.values()) {
      this.reconcileWorkEpisodeMerge(
        target.episode,
        mergedUrls.get(target.episode.prUrl)!,
        target.taskIds,
      );
      for (const binding of target.historical) {
        // This cleanup ran unconditionally before durable completion. Now the same
        // historical binding is also this task's merge evidence: `reconcileWorkEpisodeMerge`
        // just stamped its `merged_at`, and `mergedPrFor` must still be able to read it to
        // complete the task - including from `failed` or `cancelled`, which is precisely the
        // upgrade this row is the evidence for. Only a `backlog` task (rescheduled: being
        // re-run, so a previous attempt's merge is not its outcome) drops it here; the rest
        // are pruned with the task itself.
        const owner = this.tasks.get(binding.taskId);
        if (!preservesCompletionEvidence(owner, true)) {
          deleteHistoricalTaskWorkEpisodeBinding(binding.taskId, binding.episodeId);
        }
      }
    }
    // The SECONDARY repositories' merges. Their own pass rather than a `reconcileWorkEpisodeMerge`
    // target, because none of what that function does applies to one: dependency edges are
    // scalar and bind to the primary's pull request, a rollover is decided by the episode's own
    // pull request, and `task_pr_merged` announces "this task's work landed" - which a single
    // sibling merge on a multi-repo task is precisely not. What a secondary merge is, is a
    // durable stamp plus a reason to re-ask the quorum, and that is what this does.
    let repoMerges = 0;
    for (const task of this.tasks.values()) {
      if (!completableByMerge(task.status) || task.extraRepos.length === 0) continue;
      let stamped = false;
      for (const repoPr of workEpisodeRepoPrsForTask(task.id)) {
        if (repoPr.mergedAt !== null) continue;
        const mergedAt = mergedUrls.get(repoPr.prUrl);
        if (mergedAt === undefined) continue;
        if (markWorkEpisodeMerged(repoPr.sessionId, repoPr.episodeId, repoPr.prUrl, mergedAt)) {
          repoMerges += 1;
          stamped = true;
        }
      }
      if (stamped) this.refreshTaskRepoPrs(task.id);
    }
    this.cleanupDependencyProvenance();
    // Announced after the cleanup above, so the listener that reads this record reads it
    // settled. See `onPrMergesRecorded`.
    if (targets.size > 0 || repoMerges > 0) this.emit("pr_merges_recorded");
  }

  /** MCP `report_status`: update a session's activity line without a hook. */
  applyStatus(env: HookIngest["env"], agentSessionId: string | null, activity: string): void {
    const s = this.findSessionByEnv(env, agentSessionId);
    if (!s) return;
    const nextAgentSessionId = agentSessionId ?? s.agentSessionId;
    const agentRebound =
      s.agentSessionId !== null &&
      nextAgentSessionId !== null &&
      s.agentSessionId !== nextAgentSessionId;
    const next: Session = {
      ...s,
      instrumented: true,
      stateConfirmed: true,
      hooksSeen: true,
      activity,
      lastActivity: Date.now(),
      agentSessionId: nextAgentSessionId,
      transcriptPath: agentRebound ? null : s.transcriptPath,
    };
    if (this.clearEffortTrackingOnRebind(s, next) && next.meta) {
      next.meta = { ...next.meta, thinkingLevel: null };
    }
    if (noteKeyFor(next) !== noteKeyFor(s)) {
      // `report_status` can carry the first (or a new) agent session id, which rotates
      // the note key like any other binding - and the invite moves with the key.
      this.moveForemanInviteKey(noteKeyFor(s), noteKeyFor(next));
      next.foremanInvite = this.foremanInviteFor(next);
      next.workCycle = dbWorkCycleFor(noteKeyFor(next)) ?? undefined;
    }
    this.rememberAgentSession(next, s.agentSessionId);
    this.sessions.set(next.id, next);
    this.emitSession(next);
  }

  /**
   * Persist a session's agent binding the moment it changes, so the note/queue key
   * it decides outlives this process. Written only on a CHANGE because every hook
   * event reaches here: on a restart the row is what seeded `agentSessionId` in the
   * first place, so a hook merely restating it has nothing to record.
   */
  private rememberAgentSession(s: Session, prev: string | null): void {
    if (s.agentSessionId && s.agentSessionId !== prev) {
      recordAgentBinding(s.id, s.agentSessionId, Date.now());
    }
  }

  // ---- runtime metadata (model / thinking level / context %) ----

  /** Non-exited sessions, for the runtime-meta poller to read model/context from. */
  liveSessions(): Session[] {
    return [...this.sessions.values()].filter((s) => s.state !== "exited");
  }

  /**
   * Apply a Claude statusLine reading (the authoritative live source: exact
   * context %, thinking level, model). Binds to a session by pane/id/cwd like a
   * hook. Always records the reading (so its freshness governs precedence) but
   * only emits when a *displayed* value changed.
   */
  applyStatusLine(ingest: StatusLineIngest): void {
    // Rate limits FIRST, and outside the session lookup on purpose: they are an
    // account-global fact, so a reading from a session we haven't discovered yet (or
    // can't bind) is still the truth about the subscription. Gating them on the bind
    // would blank the topbar meters for exactly the sessions the binder is worst at.
    this.recordRateLimits(ingest.rateLimits);
    const s = this.findSessionByEnv(ingest.env, ingest.sessionId, ingest.cwd);
    if (!s) return;
    const statusLineTimestamp = ingest.ts ?? null;
    if (statusLineTimestamp !== null) {
      const previousTimestamp = this.statusLineTimestamps.get(s.id);
      if (previousTimestamp !== undefined && statusLineTimestamp <= previousTimestamp) return;
      this.statusLineTimestamps.set(s.id, statusLineTimestamp);
    }
    const agentSessionId = ingest.sessionId ?? s.agentSessionId;
    const agentRebound =
      s.agentSessionId !== null &&
      agentSessionId !== null &&
      s.agentSessionId !== agentSessionId;
    const transcriptPath = agentRebound ? null : s.transcriptPath;
    const guarded = this.guardEffortFreshness(
      s.id,
      s.meta?.thinkingLevel ?? null,
      metaFromStatusLine(ingest, Date.now()),
      agentSessionId,
      transcriptPath,
      "statusline",
      null,
      statusLineTimestamp,
    );
    const reconciled = this.reconcileObservedEffort(
      s.id,
      guarded.meta,
      agentSessionId,
      transcriptPath,
      "statusline",
      null,
      statusLineTimestamp,
    );
    const rejectedStatusLineEffort =
      guarded.rejectedStatusLineEffort || reconciled.rejectedStatusLineEffort;
    const meta = rejectedStatusLineEffort && s.meta
      ? { ...reconciled.meta, source: s.meta.source, updatedAt: s.meta.updatedAt }
      : reconciled.meta;
    const next: Session = { ...s, meta, agentSessionId, transcriptPath };
    this.clearEffortTrackingOnRebind(s, next);
    // A statusLine can be the first thing to bind an agent session id (it carries one and
    // fires on every render, where a hook fires on events). That rotates the note key, so
    // re-resolve the cost the same way `applyHook` re-resolves note/goal/queue - otherwise
    // a session picks up its already-ledgered estimate only on the next unrelated change.
    //
    // On a ROTATION only, though, and that is the whole of the condition below. This runs
    // on every terminal render, and `sessionCostFor` aggregates every ledger row for the
    // key on the same synchronous handle that serves hook ingest and SSE - the very cost
    // `FLEET_COST_IDLE_INTERVAL_MS` throttles the idle recompute to 30s to avoid. Nothing
    // else here can move the figure: the ledger's own writer re-denormalizes through
    // `syncSessionsForCost` the moment it changes.
    const key = noteKeyFor(next);
    if (key !== noteKeyFor(s)) {
      next.cost = sessionCostFor(key);
      // Same rotation, same rule as `applyDriverBound`: the invite moves with the key.
      // Inside the rotation guard for the same per-render economy the cost re-read is.
      this.moveForemanInviteKey(noteKeyFor(s), key);
      next.foremanInvite = this.foremanInviteFor(next);
      next.workCycle = dbWorkCycleFor(key) ?? undefined;
    }
    this.rememberAgentSession(next, s.agentSessionId);
    this.sessions.set(s.id, next);
    if (!sessionEqual(s, next)) this.emitSession(next);
  }

  // ---- cost telemetry ingest + fleet roll-up ----

  /**
   * Record the subscription's rate-limit windows from either live Claude transport.
   *
   * An ABSENT reading is not a clearing signal, and that asymmetry is the whole of this
   * method. It is ordinary for an API-key user and before a Pro/Max session's first API
   * response, so clearing on absence would make the meters strobe. Only a transport that
   * actually carries windows updates them; nothing takes them away but their own reset
   * time passing (applied where the value is read, in `fleetCostNow`).
   *
   * A payload that RESTATES the windows we already hold is not a change and is dropped
   * here, before `updatedAt` is restamped. That matters more than it looks: the
   * forwarder posts on every terminal render, `updatedAt` is a reading timestamp rather
   * than anything a human sees, and leaving it to move would make the fleet emit's
   * suppression always miss - putting a `cost_fleet` frame on every open dashboard
   * several times a second, per session, carrying numbers that never moved.
   */
  private recordRateLimits(
    rl: Partial<Pick<RateLimits, "fiveHour" | "sevenDay">> | null | undefined,
  ): void {
    if (!rl) return;
    if (!rl.fiveHour && !rl.sevenDay) return;
    // One window present without the other is ordinary, not an error: keep whichever
    // this payload carried and hold the last known value of the one it didn't.
    const prev = this.latestRateLimits;
    const fiveHour = rl.fiveHour ?? prev?.fiveHour ?? null;
    const sevenDay = rl.sevenDay ?? prev?.sevenDay ?? null;
    if (prev && rateWindowEqual(prev.fiveHour, fiveHour) && rateWindowEqual(prev.sevenDay, sevenDay)) {
      return;
    }
    this.latestRateLimits = { fiveHour, sevenDay, updatedAt: Date.now() };
    this.recomputeFleetCost();
  }

  /**
   * Ingest one OTLP/HTTP JSON metrics export from Claude Code.
   *
   * Reads exactly four attributes off each datapoint - `session.id`, `model`,
   * `query_source`, `type` - and discards the rest AT PARSE TIME. That is not tidiness:
   * the datapoints carry `user.email`, `user.account_uuid`, `user.account_id` and
   * `organization.id`, and the ledger is a durable file in the user's home directory.
   * PII that is never read cannot be written by a later change to a row mapper.
   *
   * A datapoint with no `session.id` is DROPPED rather than bucketed under a placeholder.
   * It is unattributable by construction (that attribute is what ties usage to a card),
   * and a synthetic bucket would quietly become the fleet's largest "session" the moment
   * `OTEL_METRICS_INCLUDE_SESSION_ID` were ever set false - which is precisely the
   * misconfiguration the daemon warns about at boot.
   *
   * A datapoint for a note key a DRIVEN session owns is dropped too, and for a different
   * reason: not that it cannot be attributed, but that it already has been. This ingest is no
   * longer Claude's only writer - see the `turn_done` handler - and it is now the FALLBACK of
   * the two, covering the sessions no driver owns. Those are the ones Mission Control merely
   * discovered: a human's terminal `claude`, which exports here or is not counted at all.
   */
  applyOtelMetrics(body: OtlpMetrics): void {
    const touched = new Set<string>();
    const sdkOwned = new Map<string, boolean>();
    let sawAttributableExport = false;
    for (const rm of body.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const isCost = m.name === "claude_code.cost.usage";
          const isTokens = m.name === "claude_code.token.usage";
          // `claude_code.session.count` and `claude_code.active_time.total` also arrive
          // on this stream and are deliberately ignored - neither is cost or token usage.
          if (!isCost && !isTokens) continue;
          const sum = m.sum;
          if (!sum) continue;
          // 2 = cumulative: the value is a running total for a series with one fixed
          // start, so the START is the row identity and each export REPLACES it. 1 =
          // delta (Claude Code's default, verified on the wire): each export is its own
          // window and the rows accumulate. Either way `SUM` at read time is correct.
          const cumulative = sum.aggregationTemporality === 2;
          for (const dp of sum.dataPoints ?? []) {
            const attrs = attrMap(dp.attributes);
            const noteKey = attrs["session.id"];
            if (!noteKey) continue;
            // The exporter is ALIVE, and this is the only place that can honestly say so -
            // before a single datapoint has been filtered. Recorded here rather than inferred
            // from rows later because the next few lines throw most of these away on a driven
            // fleet, and a row test would then read a healthy exporter as a dead one.
            sawAttributableExport = true;
            // A DRIVEN session's subprocess is ordinary Claude Code, so it exports these
            // datapoints for turns its driver has already written under the same note key.
            // Whichever of the two wrote it, the spend is recorded once; admitting both
            // would make every embedded card read roughly double. Resolved per note key and
            // cached for the export, because one POST carries many datapoints for the same
            // handful of sessions and this is a database read on the ingest path.
            let owned = sdkOwned.get(noteKey);
            if (owned === undefined) {
              owned = sdkOwnedNoteKey(noteKey);
              sdkOwned.set(noteKey, owned);
            }
            if (owned) continue;
            const col: UsageCol | undefined = isCost
              ? "costUsd"
              : TOKEN_TYPE_COL[attrs["type"] ?? ""];
            if (!col) continue;
            const endNs = nanoString(dp.timeUnixNano);
            const startNs = nanoString(dp.startTimeUnixNano);
            const windowEndNs = cumulative ? (startNs ?? endNs) : (endNs ?? startNs);
            if (!windowEndNs) continue;
            const ts = epochMsFromNanos(endNs ?? windowEndNs);
            if (ts == null) continue;
            const value = Number(dp.asDouble ?? dp.asInt ?? 0);
            if (!Number.isFinite(value)) continue;
            upsertUsageCell(
              {
                noteKey,
                sessionId: this.sessionIdForNoteKey(noteKey),
                agent: "claude",
                // Empty string, never null: the UNIQUE index the upsert conflicts on
                // treats NULLs as distinct, so a null here would insert a fresh row on
                // every retry instead of replacing one. See the table definition.
                modelId: attrs["model"] ?? "",
                querySource: attrs["query_source"] ?? "",
                windowEndNs,
                ts,
              },
              col,
              value,
            );
            touched.add(noteKey);
          }
        }
      }
    }
    // Stamped even when every datapoint was dropped: an export whose rows all belonged to
    // driven sessions still proves the exporter ran, which is the one thing this records.
    if (sawAttributableExport) noteOtelExportSeen(Date.now());
    if (touched.size === 0) return;
    for (const key of touched) this.syncSessionsForCost(key);
    this.recomputeFleetCost();
  }

  /**
   * Spend one driven turn's usage into the ledger.
   *
   * Requires BOTH halves of the driver's attribution - a turn identity and a per-model
   * breakdown - and writes nothing without them. A breakdown with no identity cannot
   * deduplicate, and an identity with no breakdown has nothing to record; Codex's driver
   * supplies neither, which is how the rollout reader keeps sole ownership of Codex spend
   * without this method having to name a harness.
   */
  private recordDriverTurnUsage(s: Session, usage: SdkUsage | null, now: number): void {
    if (!usage?.turnId || !usage.models?.length) return;
    const noteKey = noteKeyFor(s);
    recordDriverSessionUsage({
      noteKey,
      sessionId: s.id,
      agent: s.agent,
      turnId: usage.turnId,
      ts: now,
      models: usage.models,
    });
    this.applyDurableUsage(noteKey);
  }

  /** Which live session currently holds this note key, for the ledger's provenance column. */
  private sessionIdForNoteKey(noteKey: string): string | null {
    for (const s of this.sessions.values()) if (noteKeyFor(s) === noteKey) return s.id;
    return null;
  }

  /**
   * Re-denormalize `cost` onto every session holding `key`. The `syncSessionsForGoal`
   * shape exactly, for the same reason: the ledger is keyed on the note key, and more
   * than one map entry can hold it across a restart.
   */
  private syncSessionsForCost(key: string): void {
    const cost = sessionCostFor(key);
    for (const [id, s] of this.sessions) {
      if (noteKeyFor(s) !== key) continue;
      if (JSON.stringify(s.cost) === JSON.stringify(cost)) continue;
      const next: Session = { ...s, cost };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  /** Refresh denormalized session and fleet summaries after a durable usage commit. */
  applyDurableUsage(noteKey: string): void {
    this.syncSessionsForCost(noteKey);
    this.recomputeFleetCost();
  }

  /**
   * Refresh the fleet strip after a headless run was recorded.
   *
   * No `syncSessionsForCost`, and that absence is the point rather than an omission: an
   * automation row's note key is a ROLE, so no session holds it and there is no card
   * whose denormalized cost could have changed. Calling the session sync with a role key
   * would walk every session to match a key none of them can ever have.
   */
  applyAutomationUsage(): void {
    this.recomputeFleetCost();
  }

  /** The fleet figures as of now, read straight from the ledger. */
  private fleetCostNow(now = Date.now()): FleetCost {
    const dayStart = startOfLocalDay(now);
    return {
      estimatedCostToday: fleetEstimatedCostSince(dayStart),
      estimatedBurnPerHour: fleetEstimatedCostSince(now - 3_600_000),
      tokensToday: fleetTokensSince(dayStart),
      // The one figure here that is not the ledger's. Cheap - a COUNT over an adoption
      // table that gains single-digit rows a day - and it shares the local-midnight
      // boundary with the estimate, which is what makes dividing one by the other mean
      // anything.
      prsToday: prsOpenedSince(dayStart),
      // Expired at READ, not on a timer: nothing then depends on a tick having fired,
      // and a snapshot served between recomputes is as honest as an emitted one.
      rateLimits: unexpiredRateLimits(this.latestRateLimits, now),
      rateLimitSources: [...this.latestRateLimitSources.values()]
        .map((source) => ({ ...source, windows: source.windows.filter((w) => w.resetsAt * 1000 > now) }))
        .filter((source) => source.windows.length > 0),
      // The app's own spend, on the same local-midnight boundary as everything above so the
      // two lines are comparable, and kept out of every figure above so they are distinct.
      automation: {
        estimatedCostToday: automationEstimatedCostSince(dayStart),
        tokensToday: automationTokensSince(dayStart),
        roles: automationSpendSince(dayStart),
      },
      updatedAt: now,
    };
  }

  /**
   * Recompute the fleet strip and emit only when a figure a human can see moved.
   *
   * BOTH `updatedAt`s are excluded on purpose, the strip's and the nested reading's -
   * they are timestamps, not figures, and each changes by construction. Including
   * either makes the suppression do nothing and puts an SSE frame on every browser for
   * a strip that hasn't moved: the strip's own on every sweep, forever, and the
   * reading's on every terminal render of every session, which is far worse.
   */
  private recomputeFleetCost(now = Date.now()): void {
    const fleet = this.fleetCostNow(now);
    this.lastFleetCostAt = now;
    const same =
      this.lastFleetCost != null &&
      this.lastFleetCost.estimatedCostToday === fleet.estimatedCostToday &&
      this.lastFleetCost.estimatedBurnPerHour === fleet.estimatedBurnPerHour &&
      this.lastFleetCost.tokensToday === fleet.tokensToday &&
      this.lastFleetCost.prsToday === fleet.prsToday &&
      // Compared through the same `JSON.stringify` shortcut `syncSessionsForCost` uses on
      // `SessionCost`, and for the same reason: the roles array is a handful of flat
      // records built in a fixed order by one SQL ORDER BY, so structural equality and
      // string equality coincide, and a hand-rolled comparator would be a third place the
      // shape has to be kept in step. Without this the strip would sit on a stale
      // automation line whenever the loops spent but the fleet did not.
      JSON.stringify(this.lastFleetCost.automation) === JSON.stringify(fleet.automation) &&
      rateLimitsDisplayEqual(this.lastFleetCost.rateLimits, fleet.rateLimits) &&
      rateLimitSourcesEqual(this.lastFleetCost.rateLimitSources, fleet.rateLimitSources);
    this.lastFleetCost = fleet;
    if (same) return;
    this.emitEvent({ type: "cost_fleet", fleet });
  }

  // ---- the Line ----

  /**
   * Gather every store the Line folds over and hand them to the pure builder.
   *
   * This method is the ONLY thing that knows where each input lives, which is what keeps
   * `line-summary.ts` free of the registry, the database and the clock. Two inputs come
   * from outside the registry - the task-source sweeper's in-memory status map and Foreman's
   * plan blob - and both are read exactly the way their existing owners are read
   * (`settings-status.ts` reads the same sweeper; `readyBacklog` takes the same plan), so
   * the strip cannot disagree with the settings dot or the board's "next up" marker.
   */
  lineSummaryNow(now = Date.now()): LineSummary {
    const sources = getTaskSourcesConfig().sources;
    const status = new Map(taskSourceStatuses(sources).map((s) => [s.sourceId, s]));
    return foldLineSummary({
      now,
      sessions: [...this.sessions.values()],
      tasks: [...this.tasks.values()],
      backlogPlan: getBacklogPlan(),
      schedules: [...this.schedules.values()],
      taskSources: sources.map((source) => ({ source, status: status.get(source.id) })),
      workflowRuns: [...this.workflowRuns.values()],
      ensembles: [...this.ensembles.values()],
      // The same `COUNT` over the adoption ledger `prsToday` uses, on a seven-day cutoff.
      // A week rather than a day because "shipped" is the one stage whose emptiness on a
      // Monday morning would say nothing true about a fleet that shipped four things on
      // Friday.
      prsThisWeek: prsOpenedSince(now - SEVEN_DAY_MS),
      // Consumed exactly as the strip consumes it and never recomputed: `fleetCostNow` is
      // already the one answer to what today cost.
      cost: this.fleetCostNow(now),
    });
  }

  /**
   * Ask for a fold at the end of this event-loop turn.
   *
   * Every store mutation calls this; the coalescing is what makes that affordable. See
   * `lineRecomputeHandle` for why it is `setImmediate` and not a debounce.
   */
  private scheduleLineRecompute(): void {
    if (this.lineRecomputeHandle) return;
    this.lineRecomputeHandle = setImmediate(() => {
      this.lineRecomputeHandle = null;
      try {
        this.recomputeLineSummary();
      } catch (err) {
        // The one place this MUST be caught, and it is not defensiveness. Every other
        // recompute in this file runs inside its caller - an HTTP handler, an ingest - where
        // a throw becomes that request's 500. This one runs detached on the event loop, so
        // an uncaught throw is an uncaught exception and the daemon exits. The Line is a
        // strip of summary text; it must never be able to take the fleet down with it, so
        // it degrades to a stale strip and a log line, the way `pruneQueues` degrades.
        console.error("[registry] line summary fold failed:", err);
      }
    });
    this.lineRecomputeHandle.unref?.();
  }

  /**
   * Recompute the strip and emit only when a stage a human can read actually moved.
   *
   * Public so a test can fold synchronously instead of waiting on the coalescer, and so a
   * caller that has just finished a batch can settle it now. Idempotent either way: a
   * recompute that changes nothing emits nothing.
   */
  recomputeLineSummary(now = Date.now()): void {
    const line = this.lineSummaryNow(now);
    this.lastLineSummaryAt = now;
    const same = lineSummaryEqual(this.lastLineSummary, line);
    this.lastLineSummary = line;
    if (same) return;
    this.emitEvent({ type: "line_summary", line });
  }

  /**
   * Apply a passive runtime read (transcript for Claude, rollout for Codex). A
   * null read means "nothing found this tick" and is a no-op, so a briefly
   * unreadable file never clears a good reading. A fresh statusLine reading wins
   * over any passive source, so an installed forwarder is never downgraded.
   */
  applyRuntimeMeta(sessionId: string, read: RuntimeMetaRead | null, source: MetaSource): void {
    const s = this.sessions.get(sessionId);
    if (!s || !read) return;
    this.runtimeEffortRevisions.set(sessionId, read.effortRevision);
    const now = Date.now();
    const statusLineHasPrecedence =
      s.meta?.source === "statusline" &&
      source !== "statusline" &&
      now - s.meta.updatedAt < STATUSLINE_TTL_MS;
    const hasEffortFreshnessGuard = this.effortFreshnessGuards.has(sessionId);
    if (statusLineHasPrecedence && !hasEffortFreshnessGuard) {
      if (!s.effortBaselineReady) {
        const next: Session = { ...s, effortBaselineReady: true };
        this.sessions.set(sessionId, next);
        this.emitSession(next);
      }
      return;
    }
    const guarded = this.guardEffortFreshness(
      sessionId,
      s.meta?.thinkingLevel ?? null,
      metaFromRead(read, source, now),
      s.agentSessionId,
      s.transcriptPath,
      source,
      read.effortRevision,
      null,
    );
    const reconciled = this.reconcileObservedEffort(
      sessionId,
      guarded.meta,
      s.agentSessionId,
      s.transcriptPath,
      source,
      read.effortRevision,
      null,
    );
    const meta = statusLineHasPrecedence && s.meta
      ? { ...s.meta, thinkingLevel: reconciled.meta.thinkingLevel }
      : reconciled.meta;
    const changed = !metaDisplayEqual(s.meta, meta) || !s.effortBaselineReady;
    const next: Session = { ...s, meta, effortBaselineReady: true };
    this.sessions.set(sessionId, next);
    if (changed) this.emitSession(next);
  }

  /**
   * Record a transcript-derived idle/working read for a live session, keyed by pane
   * token like a hook overlay so it survives the next discovery sweep. Consulted by
   * `mergeDiscovered` only when the session has no fresh hook. A null read (nothing
   * datable this tick) is a no-op, so a briefly unreadable file never clears a good
   * reading; a session with no pane key is skipped (nothing to type into anyway).
   *
   * The actual apply happens on the next discovery sweep (which rebuilds the card
   * from `passiveStateFor`), matching how hook overlays that arrive before discovery
   * take effect - the poller runs at the discovery cadence, so the lag is one tick.
   */
  applyPassiveActivity(session: Session, read: SessionActivityRead | null): void {
    if (!read) return;
    const key = sessionKey(session);
    if (!key) return;
    const discovered = this.discoveredIdentity.get(session.id);
    this.passiveStates.set(key, {
      sessionId: session.id,
      agentSessionId: discovered?.agentSessionId ?? session.agentSessionId,
      transcriptPath: discovered?.transcriptPath ?? session.transcriptPath,
      state: read.state,
      lastActivity: read.lastActivity,
      updatedAt: Date.now(),
    });
  }

  /** Apply cumulative unpriced usage from a passive harness source without touching the daily ledger. */
  applyPassiveUsage(sessionId: string, cost: SessionCost | null): void {
    if (!cost) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const prev = session.cost;
    // A durable ledger summary outranks this cumulative tail convenience. The empty
    // pricing metadata is the signature of the passive Codex reading.
    if (prev && (prev.basis !== "unpriced" || prev.pricingModels.length > 0 || prev.pricingVersions.length > 0)) return;
    if (prev && prev.costUsd === null && prev.input === cost.input && prev.output === cost.output &&
        prev.cacheRead === cost.cacheRead && prev.reasoningOutput === cost.reasoningOutput) return;
    const next = { ...session, cost };
    this.sessions.set(sessionId, next);
    this.emitSession(next);
  }

  applyPassiveRateLimits(read: RateLimitSource | null): void {
    if (!read) return;
    const prev = this.latestRateLimitSources.get(read.source);
    if (prev && rateLimitSourceEqual(prev, read)) return;
    this.latestRateLimitSources.set(read.source, read);
    this.recomputeFleetCost();
  }

  /**
   * The hook overlay speaking for this session, if any.
   *
   * Scoped to the session's own harness on both lookups - see `HookOverlay.agent`. An
   * overlay left by a different agent is not a stale reading to be aged out, it is a
   * reading about someone else, so it is skipped rather than returned and TTL'd.
   */
  private overlayFor(s: Session): HookOverlay | undefined {
    const key = sessionKey(s);
    const byKey = key ? this.overlays.get(key) : undefined;
    if (byKey && byKey.agent === s.agent) return byKey;
    if (s.agentSessionId) {
      for (const o of this.overlays.values())
        if (o.agent === s.agent && o.agentSessionId === s.agentSessionId) return o;
    }
    return undefined;
  }

  /**
   * The transcript-derived state for this exact process + conversation.
   *
   * The map is pane-keyed so the reading survives ordinary discovery rebuilds, but a
   * pane is not identity: the terminal can replace its process, and `/clear` can replace
   * the rollout under the same process. Refuse either mismatch rather than confirming
   * the new card from the old occupant's lifecycle marker.
   */
  private passiveStateFor(s: Session): PassiveState | undefined {
    const key = sessionKey(s);
    const passive = key ? this.passiveStates.get(key) : undefined;
    if (!passive || passive.sessionId !== s.id) return undefined;
    const discovered = this.discoveredIdentity.get(s.id);
    const agentSessionId = discovered?.agentSessionId ?? s.agentSessionId;
    const transcriptPath = discovered?.transcriptPath ?? s.transcriptPath;
    if (passive.agentSessionId !== agentSessionId || passive.transcriptPath !== transcriptPath) {
      return undefined;
    }
    return passive;
  }

  private pruneOverlays(now: number): void {
    for (const [k, o] of this.overlays)
      if (now - o.updatedAt > OVERLAY_TTL_MS) this.overlays.delete(k);
    for (const [k, p] of this.passiveStates)
      if (now - p.updatedAt > OVERLAY_TTL_MS) this.passiveStates.delete(k);
  }

  /**
   * Mark a session exited and start its eviction timer - the ONE way a session leaves.
   *
   * Extracted from `applyDiscovery`'s unseen loop so the supervisor's `exited` event runs
   * the identical sequence rather than a lookalike: exited state emitted first (the card
   * greys out immediately), then `remove` after the linger, which is what emits
   * `session_remove`. All three durable subscribers - `WorkflowManager` orphaning its
   * bindings, `TaskManager.reconcileTasksBoundTo` settling the task, and
   * `ReviewManager` orphaning the questions that session was blocked on - are keyed on that
   * event and on nothing else, so a second teardown path would be a session that disappears
   * from the dashboard while its task stays `running` forever.
   *
   * Idempotent by way of the timer: a session already on its way out keeps its original
   * deadline instead of having it pushed back by a repeat signal.
   */
  private beginEviction(s: Session): void {
    if (this.exitTimers.has(s.id)) return;
    if (s.state !== "exited") {
      const exited: Session = { ...s, state: "exited" };
      this.sessions.set(s.id, exited);
      this.emitSession(exited);
    }
    const t = unref(setTimeout(() => this.remove(s.id), EXIT_LINGER_MS));
    this.exitTimers.set(s.id, t);
    // AFTER the timer is armed, so the `exitTimers` guard above has already made this
    // once-per-eviction, and BEFORE `remove` can run, so a listener still finds the row it
    // wants to write to. Handed the current projection rather than `s`, which may be the
    // pre-exit copy.
    const current = this.sessions.get(s.id);
    if (current) this.emit("session_exit", current);
  }

  private remove(id: string): void {
    this.exitTimers.delete(id);
    this.prObservations.delete(id);
    // Per-repo observations are keyed `(session, repo)`, so one session leaves several. The
    // poller retracts them while the session lives; this is what stops a finished multi-repo
    // task's entries outliving the row that could ever read them again.
    for (const key of this.livePrs.keys()) {
      if (key.startsWith(repoPrTargetKey(id, ""))) this.livePrs.delete(key);
    }
    this.announcedPrs.delete(id);
    this.discoveredIdentity.delete(id);
    this.clearSessionEffortTracking(id);
    this.permissionModeFreshnessGuards.delete(id);
    this.statusLineTimestamps.delete(id);
    this.driverDialogs.delete(id);
    // Held until the ROW goes, not until the agent stopped - see `retroCorrections`. This is
    // where "the row goes", so this is where it is forgotten.
    this.retroCorrections.delete(id);
    if (!this.sessions.delete(id)) return;
    this.emitEvent({ type: "session_remove", id });
    // Eviction is the INSTANT a queue becomes orphaned - `orphanedQueueFor` derives
    // liveness from this very map - so no sibling's hint is right until this runs.
    // Waiting for the next sweep to notice isn't enough on its own either: the card
    // that should show the hint is typically an idle session at the same cwd, which
    // is exactly the case where nothing else about it moves.
    this.syncAllOrphanHints();
  }

  private reconcileObservedEffort(
    sessionId: string,
    meta: SessionMeta,
    agentSessionId: string | null,
    transcriptPath: string | null,
    source: MetaSource,
    effortRevision: string | null,
    statusLineTimestamp: number | null,
  ): { meta: SessionMeta; rejectedStatusLineEffort: boolean } {
    const observed = this.observedEfforts.get(sessionId);
    if (!observed) return { meta, rejectedStatusLineEffort: false };
    const identityChanged =
      (observed.agentSessionId !== null && agentSessionId !== null && agentSessionId !== observed.agentSessionId) ||
      (observed.transcriptPath !== null && transcriptPath !== null && transcriptPath !== observed.transcriptPath);
    if (identityChanged) {
      this.observedEfforts.delete(sessionId);
      return { meta, rejectedStatusLineEffort: false };
    }
    const freshStatusLine =
      source !== "statusline" ||
      (statusLineTimestamp !== null &&
        statusLineTimestamp > observed.verifiedAt &&
        (observed.statusLineTimestamp === null || statusLineTimestamp > observed.statusLineTimestamp));
    if (!freshStatusLine) {
      return {
        meta: { ...meta, thinkingLevel: observed.effort },
        rejectedStatusLineEffort: source === "statusline",
      };
    }
    if (
      meta.modelId !== observed.modelId ||
      meta.thinkingLevel === observed.effort ||
      (meta.thinkingLevel !== null &&
        (meta.thinkingLevel !== observed.previous ||
          source === "statusline" ||
          isLaterEffortRevision(observed.effortRevision, effortRevision)))
    ) {
      this.observedEfforts.delete(sessionId);
      return { meta, rejectedStatusLineEffort: false };
    }
    observed.agentSessionId ??= agentSessionId;
    observed.transcriptPath ??= transcriptPath;
    return {
      meta: { ...meta, thinkingLevel: observed.effort },
      rejectedStatusLineEffort: false,
    };
  }

  private guardEffortFreshness(
    sessionId: string,
    currentEffort: ThinkingLevel | null,
    meta: SessionMeta,
    agentSessionId: string | null,
    transcriptPath: string | null,
    source: MetaSource,
    effortRevision: string | null,
    statusLineTimestamp: number | null,
  ): { meta: SessionMeta; rejectedStatusLineEffort: boolean } {
    const guard = this.effortFreshnessGuards.get(sessionId);
    if (!guard) return { meta, rejectedStatusLineEffort: false };
    const identityChanged =
      (guard.agentSessionId !== null && agentSessionId !== null && agentSessionId !== guard.agentSessionId) ||
      (guard.transcriptPath !== null && transcriptPath !== null && transcriptPath !== guard.transcriptPath);
    if (identityChanged) {
      this.effortFreshnessGuards.delete(sessionId);
      return { meta, rejectedStatusLineEffort: false };
    }
    const fresh = source === "statusline"
      ? statusLineTimestamp !== null &&
        statusLineTimestamp > guard.verifiedAt &&
        (guard.statusLineTimestamp === null || statusLineTimestamp > guard.statusLineTimestamp)
      : isLaterEffortRevision(guard.effortRevision, effortRevision);
    if (!fresh) {
      return {
        // This reading has not proved it is newer than the setting we just verified.
        // Its model is as stale as its effort: keeping one but not the other lets the
        // reconciliation below treat the stale model id as a real model change and
        // discard the verified observation.
        meta: { ...meta, model: guard.model, modelId: guard.modelId, thinkingLevel: currentEffort },
        rejectedStatusLineEffort: source === "statusline",
      };
    }
    if (meta.modelId !== guard.modelId) this.effortFreshnessGuards.delete(sessionId);
    return { meta, rejectedStatusLineEffort: false };
  }

  private clearEffortTrackingOnRebind(previous: Session, next: Session): boolean {
    const rebound =
      (previous.agentSessionId !== null &&
        next.agentSessionId !== null &&
        previous.agentSessionId !== next.agentSessionId) ||
      (previous.transcriptPath !== null &&
        next.transcriptPath !== null &&
        previous.transcriptPath !== next.transcriptPath);
    if (rebound) {
      this.clearSessionEffortTracking(next.id);
      this.permissionModeFreshnessGuards.delete(next.id);
      next.effortBaselineReady = false;
    }
    return rebound;
  }

  private clearSessionEffortTracking(sessionId: string): void {
    this.observedEfforts.delete(sessionId);
    this.runtimeEffortRevisions.delete(sessionId);
    this.effortFreshnessGuards.delete(sessionId);
  }

  // ---- reviews (used by phase 3) ----

  private countPending(sessionId: string): number {
    let n = 0;
    for (const r of this.reviews.values())
      if (r.sessionId === sessionId && r.status === "pending") n++;
    return n;
  }

  upsertReview(review: ReviewItem): void {
    this.reviews.set(review.id, review);
    this.emitEvent({ type: "review_upsert", review });
    this.refreshPendingCount(review.sessionId);
  }

  getReview(id: string): ReviewItem | undefined {
    return this.reviews.get(id);
  }

  /**
   * Every review still awaiting a human, optionally narrowed to one session.
   *
   * The read half of the map `ReviewManager` decides over - the registry stores, the
   * manager decides, the same split `session_remove` makes. Its two callers are that
   * manager's eviction halves, which have to ask "what is still outstanding for a session
   * that has gone?" and "which of these is bound to nothing at all?" without either
   * reaching into this map or re-querying SQLite for rows already held here.
   */
  pendingReviews(sessionId?: string): ReviewItem[] {
    const out: ReviewItem[] = [];
    for (const r of this.reviews.values()) {
      if (r.status !== "pending") continue;
      if (sessionId !== undefined && r.sessionId !== sessionId) continue;
      out.push(r);
    }
    return out;
  }

  private refreshPendingCount(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const n = this.countPending(sessionId);
    if (s.pendingReviews !== n) {
      const next = { ...s, pendingReviews: n };
      this.sessions.set(sessionId, next);
      this.emitSession(next);
    }
  }

  // ---- tasks (dispatch, phase: agents) ----

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  private reconcileSessionDependencies(session: Session, match: PrMatch | null, at: number): void {
    for (const task of [...this.tasks.values()]) {
      let changed = false;
      const dependencies = task.dependencies.map((dependency) => {
        if (
          dependency.type !== "session" ||
          dependency.sessionId !== session.id ||
          dependency.satisfiedAt !== null
        ) {
          return dependency;
        }
        if (
          !match ||
          dependency.episodeId === null ||
          dependency.agentSessionId === null ||
          dependency.episodeId !== match.episodeId
        ) {
          return dependency;
        }
        if (dependency.prUrl !== null) {
          if (match.url !== dependency.prUrl) return dependency;
        }
        const branch = match.branch;
        const agentSessionId = match.agentSessionId;
        const prUrl = dependency.prUrl ?? match.url;
        if (
          branch === dependency.branch &&
          agentSessionId === dependency.agentSessionId &&
          prUrl === dependency.prUrl
        ) {
          return dependency;
        }
        changed = true;
        return { ...dependency, branch, agentSessionId, prUrl };
      });
      if (changed) this.upsertTask({ ...task, dependencies, updatedAt: at }, true);
    }
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /**
   * True when a terminal task's resources passed to the session's CURRENT work rather
   * than being stranded by an outcome the session predates.
   *
   * An episode rollover - the agent restarts under a new session id - invalidates task
   * ownership in the same transaction that opens the new episode, so the two share a
   * timestamp. The session still holding the worktree there is the live agent that never
   * stopped working, not a leftover squatter, and it is the only session that can ever
   * hold those resources: the rollover cleared `sessionId` too, so nothing can reconcile
   * the task back to it and no "clean up" exists that does not kill the running agent.
   *
   * A session whose work began BEFORE the outcome is the case the barrier is for - the
   * operator cancelled a task, teardown failed, and the resources it named are still on
   * disk under an agent nobody meant to keep talking to.
   *
   * The task keeps naming its resources either way, deliberately: `reconcileOnStartup`
   * reclaims the worktree once the agent's home is gone, so clearing them here to settle
   * the barrier would leak the lease instead.
   *
   * Only prompt delivery reads this. Handing the agent a DIFFERENT task is a separate
   * question - `assign` still refuses, because reusing an agent whose last outcome left
   * resources behind is exactly the reset it is guarding.
   */
  private outcomePrecedesSessionWork(task: Task, sessionId: string): boolean {
    if (task.completedAt === null) return false;
    const episode = sessionWorkEpisodeFor(sessionId);
    return episode !== null && episode.startedAt >= task.completedAt;
  }

  taskResourceOwnerForSession(
    sessionId: string,
    status?: Task["status"],
    accept: (task: Task) => boolean = () => true,
  ): Task | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const homeNames = terminalHomeNames(session);
    const resourceIds = terminalResourceIds(session);
    return this.listTasks().find((task) =>
      (status === undefined || task.status === status) &&
      (Boolean(task.worktreePath) || Boolean(task.homeName)) &&
      (task.sessionId === sessionId ||
        (task.terminalResourceId !== null && resourceIds.has(task.terminalResourceId)) ||
        (Boolean(session.cwd) && task.worktreePath === session.cwd) ||
        (task.homeName !== null && homeNames.has(task.homeName))) &&
      accept(task)
    );
  }

  promptResourceBlockerForSession(sessionId: string): string | null {
    const owner = this.taskResourceOwnerForSession(
      sessionId,
      "cancelled",
      (task) => !this.outcomePrecedesSessionWork(task, sessionId),
    );
    return owner
      ? `this session still holds resources for ${owner.title} - clean up that cancelled task before sending new work`
      : null;
  }

  /** Persist + broadcast a task, and refresh any session bound to it. */
  upsertTask(task: Task, deferDependencyCleanup = false): void {
    const previous = this.tasks.get(task.id);
    const dependenciesChanged = Boolean(
      previous && JSON.stringify(previous.dependencies) !== JSON.stringify(task.dependencies),
    );
    const displaced = dbUpsertTask(task);
    for (const id of displaced) {
      const prior = this.tasks.get(id);
      if (!prior) continue;
      const unbound = { ...prior, sessionId: null };
      this.tasks.set(id, unbound);
      this.emitEvent({ type: "task_upsert", task: unbound });
    }
    this.tasks.set(task.id, task);
    this.emitEvent({ type: "task_upsert", task });
    this.syncSessionsForWorktree(task.worktreePath);
    // Pipeline tasks deliberately have neither `sessionId` nor a Mission Control worktree.
    // Their nested agents still need their task card refreshed when the durable provider
    // lifecycle moves, including when explicit cleanup releases the terminal home.
    if (previous) this.syncSessionsForTaskResources(previous);
    this.syncSessionsForTaskResources(task);
    if (previous?.sessionId && previous.sessionId !== task.sessionId) {
      this.resyncSessionTask(previous.sessionId);
    }
    if (task.sessionId) this.resyncSessionTask(task.sessionId);
    if (isTerminalTask(task.status)) this.pruneTerminalTasks();
    if (dependenciesChanged && !deferDependencyCleanup) this.cleanupDependencyProvenance();
  }

  /**
   * Keep the in-memory map bounded: evict all but the most recent terminal tasks
   * (the DB retains the full history; a restart rehydrates the same cap). Without
   * this, every finished task would linger in memory and in every SSE snapshot.
   */
  private pruneTerminalTasks(): void {
    // Only evict fully-cleaned terminal tasks. A failed-but-alive task still holds
    // a worktree + terminal home and decorates its live card, so it must never be
    // evicted (that would orphan its resources and drop the card's chip).
    const evictable = [...this.tasks.values()].filter(
      (t) => isTerminalTask(t.status) && !t.worktreePath && !t.homeName,
    );
    if (evictable.length <= RECENT_TERMINAL_TASKS) return;
    evictable.sort((a, b) => b.updatedAt - a.updatedAt);
    let removed = false;
    for (const t of evictable.slice(RECENT_TERMINAL_TASKS)) {
      // A loose OUTCOME keeps a row here just as a loose RESOURCE does above, and it is
      // asked only of the handful actually being dropped. `taskPrPollTargets` reads this
      // map, so evicting a task still waiting on its pull request would silently stop the
      // polling that was going to settle it - and undo `loadPrPendingTerminalTasks` on the
      // very next terminal task to arrive. A `done` row never qualifies, so this costs no
      // query at all in the ordinary case.
      if (completableByMerge(t.status) && taskHasPrCarryingBinding(t.id)) continue;
      this.tasks.delete(t.id);
      this.emitEvent({ type: "task_remove", id: t.id });
      removed = true;
    }
    if (removed) this.cleanupDependencyProvenance();
  }

  removeTask(id: string): void {
    const t = this.tasks.get(id);
    dbDeleteTask(id);
    this.dropTaskDependencyProvenance(id, Date.now());
    if (this.tasks.delete(id)) this.emitEvent({ type: "task_remove", id });
    if (t) this.syncSessionsForWorktree(t.worktreePath);
    if (t?.sessionId) this.resyncSessionTask(t.sessionId);
    this.cleanupDependencyProvenance();
  }

  /**
   * Resolve a session running in a given worktree, once discovery has bound one.
   * Resolves immediately if already present, else waits for the next matching
   * `session_upsert`, else null on timeout.
   *
   * This proves a PROCESS exists at `cwd`. It does NOT prove the agent can read
   * input, and the difference is not academic: discovery is a `ps` sweep, so this
   * fires the moment the binary is exec'd - seconds before a TUI is up. Injecting
   * on this signal types into a pty nobody is reading yet, and tmux reports that
   * write as a success. Callers about to type want `waitForReadySessionAtCwd`.
   */
  waitForSessionAtCwd(cwd: string, timeoutMs: number): Promise<Session | null> {
    return this.waitForSessionAtCwdMatching(cwd, timeoutMs, () => true);
  }

  /**
   * Resolve the named session at `cwd` once it has proven it can read input. Returns
   * null if that session is missing, exits while watched, or reaches the timeout.
   *
   * The proof is `hooksSeen`: a hook fired, which means the agent booted far enough to
   * run one - so its input loop exists. Nothing weaker works. Discovery only sees a
   * process, and a fixed post-discovery sleep is a guess about boot time that a cold
   * cache or a loaded machine invalidates (a 2s guess lost to a ~4s boot is how a
   * dispatched task's opening prompt was silently swallowed; the task sat `running`
   * against an empty session).
   *
   * For a session that is still live, timeout does NOT mean "not ready" - it means "no
   * evidence either way", which is the honest answer for an agent with no hooks installed.
   * A caller that needs to distinguish that silence from exit must re-read `sessionId`.
   */
  waitForReadySessionAtCwd(
    cwd: string,
    sessionId: string,
    timeoutMs: number,
  ): Promise<Session | null> {
    return this.waitForSessionAtCwdMatching(cwd, timeoutMs, (s) => s.hooksSeen, sessionId);
  }

  /**
   * Resolve true on POSITIVE evidence that an agent at `cwd` ingested a prompt: a
   * hook-driven transition into `working`, which only `UserPromptSubmit` produces.
   *
   * False means "no evidence", never "it definitely didn't land" - an uninstrumented
   * session can't produce this signal at all. Callers must not treat a false as proof
   * of non-delivery unless they know hooks are live (see the dispatcher).
   *
   * Subscribe BEFORE typing, then await this after: the hook can beat the caller's next
   * line, and a check-after-the-fact would miss it and re-type over a live prompt.
   */
  waitForPromptAcceptedAtCwd(
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub = (): void => {};
      const finish = (accepted: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsub();
        signal?.removeEventListener("abort", onAbort);
        resolve(accepted);
      };
      const onAbort = (): void => finish(false);

      timer = unref(setTimeout(() => finish(false), timeoutMs));
      unsub = this.subscribe((e) => {
        if (e.type === "session_upsert" && e.session.cwd === cwd && e.session.state === "working") {
          finish(true);
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) finish(false);
    });
  }

  /**
   * Shared wait: an existing match short-circuits, else the next `session_upsert` that
   * fits. A watched id must already name a live session at this cwd, and its exit ends
   * the wait rather than allowing another process at the same cwd to satisfy it.
   */
  private waitForSessionAtCwdMatching(
    cwd: string,
    timeoutMs: number,
    ready: (s: Session) => boolean,
    watchedId?: string,
  ): Promise<Session | null> {
    const existing = watchedId ? this.sessions.get(watchedId) : this.firstSessionAtCwd(cwd);
    if (
      watchedId &&
      (!existing || existing.cwd !== cwd || existing.state === "exited")
    ) {
      return Promise.resolve(null);
    }
    if (existing && ready(existing)) return Promise.resolve(existing);
    return new Promise<Session | null>((resolve) => {
      const timer = unref(
        setTimeout(() => {
          unsub();
          resolve(null);
        }, timeoutMs),
      );
      const unsub = this.subscribe((e) => {
        if (
          e.type === "session_upsert" &&
          watchedId !== undefined &&
          e.session.id === watchedId &&
          e.session.state === "exited"
        ) {
          clearTimeout(timer);
          unsub();
          resolve(null);
          return;
        }
        if (
          e.type === "session_upsert" &&
          e.session.cwd === cwd &&
          e.session.state !== "exited" &&
          (watchedId === undefined || e.session.id === watchedId) &&
          ready(e.session)
        ) {
          clearTimeout(timer);
          unsub();
          resolve(e.session);
        }
      });
    });
  }

  private firstSessionAtCwd(cwd: string): Session | undefined {
    for (const s of this.sessions.values())
      if (s.cwd === cwd && s.state !== "exited") return s;
    return undefined;
  }

  /** The active task a session is executing, as a compact card summary. */
  private taskSummaryFor(sessionId: string, cwd: string | null): TaskSummary | null {
    const t = this.activeTaskFor(sessionId, cwd);
    return t
      ? {
          id: t.id,
          title: t.title,
          fullTitle: fullTaskTitle(t.title, t.intent),
          kind: t.kind,
          workflowId: t.workflowId,
          status: t.status,
          outcome: t.outcome,
          outcomeUrl: t.outcomeUrl,
          scheduleId: t.scheduleId,
          scheduleOccurrenceId: t.scheduleOccurrenceId,
          scheduledFor: t.scheduledFor,
          // Null in every build with no ensembles, and in every build where nothing has
          // registered the projection - which is the whole product until a member is
          // launched. The join lives on the daemon side of one seam rather than on
          // `Session`, so it needs no comparator: `task` is already compared by JSON.
          ensemble: this.ensembleProjection?.(t.id) ?? null,
          // Guarded on the empty case rather than inside, so a single-repo card - which is
          // nearly every card, re-emitted several times a second - pays no query at all.
          repoPrs:
            t.extraRepos.length === 0
              ? []
              : taskRepoPrSummaries(t, primaryRepoPrForTask(t.id), (repoRoot, prUrl) =>
                  this.repoPrFeedbackFor(sessionId, repoRoot, prUrl)),
        }
      : null;
  }

  /**
   * The task this session is executing.
   *
   * Two ways a task reaches an agent, so two ways to correlate one back:
   *  - ASSIGNED (dropped onto an already-running agent from the backlog). It owns no
   *    worktree of its own - the agent keeps its existing checkout - so the only link
   *    is the `sessionId` the assignment stamped on it. Checked first: it is the
   *    stronger claim, being an explicit binding rather than a path coincidence.
   *  - DISPATCHED (the daemon cut a worktree and launched an agent in it), which
   *    correlates by that worktree path - see `activeTaskForCwd`.
   *
   * A session runs tasks SERIALLY over its life, so the row this finds CHANGES: it is
   * whatever `Task.sessionId` currently points at, never "the task this session ran".
   * Exactly one row can point here - `idx_tasks_session` is a partial UNIQUE index and
   * `upsertTask` moves the pointer rather than duplicating it - so the loop's job is not
   * to choose between rivals, it is to be independent of iteration order all the same:
   * a non-terminal row wins outright, and among terminal rows the newest `updatedAt`.
   * Stated here because the guarantee lives in a schema three thousand lines away in
   * another file, and a reader whose correctness rests on that silently is one a second
   * in-memory writer would break with nothing failing.
   */
  private activeTaskFor(sessionId: string, cwd: string | null): Task | undefined {
    let bound: Task | undefined;
    for (const t of this.tasks.values()) {
      if (t.sessionId !== sessionId) continue;
      if (t.status === "backlog" || t.status === "cancelled") continue;
      if (t.status === "running" || t.status === "dispatching") return t;
      if (!bound || t.updatedAt > bound.updatedAt) bound = t;
    }
    if (bound) return bound;
    const pipelineTask = this.taskResourceOwnerForSession(
      sessionId,
      undefined,
      (task) =>
        task.kind === "pipeline" &&
        task.status !== "backlog" &&
        task.status !== "cancelled",
    );
    if (pipelineTask) return pipelineTask;
    const task = this.activeTaskForCwd(cwd);
    if (!task) return undefined;
    const episode = sessionWorkEpisodeFor(sessionId);
    if (!episode) return task;
    const binding = taskWorkEpisodeForTask(task.id);
    return binding?.sessionId === sessionId && binding.episodeId === episode.episodeId
      ? task
      : undefined;
  }

  /**
   * The task a live session is running, for a server-side attribution boundary.
   *
   * The same correlation `taskSummaryFor` decorates a card with, exposed for the one caller
   * that needs the whole Task rather than the compact summary: an MCP submission resolves its
   * session through `findSessionByEnv`, then this to the member Task it is running, then the
   * ensemble member off that Task's id. Public because attribution must come from the live
   * session and its worktree, never from an id a caller could name.
   */
  taskForSession(sessionId: string, cwd: string | null): Task | undefined {
    return this.activeTaskFor(sessionId, cwd);
  }

  /**
   * Most-recently-updated task whose worktree matches this cwd. A backlog task has
   * no worktree; a cancelled or cleanly-failed task cleared its worktree fields, so
   * it can't match a cwd here. A failed-but-alive task keeps its worktree, so it
   * still decorates its live session's card - the agent stays actionable there.
   */
  private activeTaskForCwd(cwd: string | null): Task | undefined {
    if (!cwd) return undefined;
    let best: Task | undefined;
    for (const t of this.tasks.values()) {
      if (t.worktreePath !== cwd) continue;
      if (t.status === "backlog" || t.status === "cancelled") continue;
      if (!best || t.updatedAt > best.updatedAt) best = t;
    }
    return best;
  }

  /**
   * The pipeline run whose worktree this session is working inside, or null.
   *
   * THE CORRELATION RULE, in one place: a session whose cwd is at or below a projected run's
   * own worktree is doing that run's work. The projection is the only thing consulted, which
   * is what makes consent free rather than a second check - the watcher retires every run of
   * a repository the operator switched off (`reconcilePipelineConsent`), so a disabled
   * repository has no rows here and every session in it goes back to being an ordinary one.
   * A fleet observing nothing pays one `size === 0` per session per sweep.
   *
   * CONTAINMENT, not equality, because an agent legitimately works below the worktree root -
   * conductor spawns it at the top, but a shell that has `cd`'d into `src/` is the same
   * session doing the same run's work. Segment-safe (`withinRoot`), so `.worktrees/add`
   * cannot claim a session sitting in `.worktrees/add-widgets`.
   *
   * DEEPEST WINS when two runs' worktrees nest, which they can: nothing stops an operator's
   * engine from cutting `.worktrees/a` and `.worktrees/a/.worktrees/b`, and the inner run is
   * the one whose work is happening there. Ties break on the run key so two projections of
   * one fleet cannot disagree about which of two equally-deep runs claimed a session.
   *
   * Paths are compared as the two sides spell them. Both sides descend from a repository root
   * the daemon resolved through `realpathSync` (`resolveRepoRoot`), and a session's cwd comes
   * from `lsof`, which prints the kernel's own physical path - so the one arrangement this
   * cannot see is a `.worktrees/<slug>` that is itself a symlink somewhere else. That is not
   * a shape the engine produces (it cuts real git worktrees), and reading it wrong fails
   * OPEN: the session is simply not correlated and behaves exactly as it does today.
   */
  private pipelineLinkFor(cwd: string | null): SessionPipelineLink | null {
    if (!cwd || this.pipelineRuns.size === 0) return null;
    let best: PipelineRun | null = null;
    for (const run of this.pipelineRuns.values()) {
      if (!run.worktree || !withinRoot(run.worktree, cwd)) continue;
      if (
        !best ||
        run.worktree.length > best.worktree!.length ||
        (run.worktree.length === best.worktree!.length &&
          pipelineRunKeyOf(run) < pipelineRunKeyOf(best))
      ) {
        best = run;
      }
    }
    return best
      ? {
          provider: best.provider,
          repoRoot: best.repoRoot,
          slug: best.slug,
          step: best.lastStep,
        }
      : null;
  }

  /**
   * Re-stamp the sessions one pipeline run's movement could have changed, and emit.
   *
   * The counterpart of `syncSessionsForWorktree` for the other correlation, and needed for
   * the same reason: a run's `lastStep` advances with nothing about the session moving, so a
   * card that only re-derived on a discovery sweep would show the step the run was on when
   * the agent was first seen. Called from `upsertPipelineRun`/`removePipelineRun` AFTER their
   * own no-op suppression, so a quiet fleet does no work here at all.
   *
   * The candidate set is deliberately wider than "sessions inside this worktree": a run that
   * was just retired has no worktree to test against any more, and the sessions that must be
   * cleared are exactly the ones still NAMING it. Both halves are cheap - the map is the
   * fleet, and `pipelineLinkFor` returns on an empty projection.
   *
   * DRIVER-RUN SESSIONS ARE SKIPPED, which is the same invariant `upsertSdkSession` states by
   * writing `pipeline: null` structurally - repeated here because this is the only other door
   * to the field, and an invariant one door enforces is not an invariant. A session Mission
   * Control's own supervisor launched is YOURS: the fact that its worktree happens to sit
   * inside a directory an engine also manages does not make it somebody else's, and taking its
   * composer away over a path coincidence would strand a conversation nothing else can answer.
   */
  private syncSessionsForPipelineRun(
    provider: PipelineProviderId,
    repoRoot: string,
    slug: string,
    worktree: string | null,
  ): void {
    const key = pipelineRunKey(provider, repoRoot, slug);
    for (const session of [...this.sessions.values()]) {
      if (session.runtime !== "terminal") continue;
      const named = session.pipeline
        ? pipelineRunKey(
            session.pipeline.provider,
            session.pipeline.repoRoot,
            session.pipeline.slug,
          ) === key
        : false;
      const inside =
        worktree !== null && session.cwd !== null && withinRoot(worktree, session.cwd);
      if (!named && !inside) continue;
      const link = this.pipelineLinkFor(session.cwd);
      if (JSON.stringify(session.pipeline) === JSON.stringify(link)) continue;
      const next = { ...session, pipeline: link };
      this.sessions.set(session.id, next);
      this.emitSession(next);
    }
  }

  private syncSessionsForWorktree(cwd: string | null): void {
    if (!cwd) return;
    for (const id of this.sessions.keys()) {
      if (this.sessions.get(id)?.cwd === cwd) this.resyncSessionTask(id);
    }
  }

  /** Refresh cards sharing a pipeline task's terminal home, without binding its children. */
  private syncSessionsForTaskResources(task: Pick<Task, "homeName" | "terminalResourceId">): void {
    if (task.homeName === null && task.terminalResourceId === null) return;
    for (const session of this.sessions.values()) {
      const sharesHome = task.homeName !== null && terminalHomeNames(session).has(task.homeName);
      const sharesResource =
        task.terminalResourceId !== null &&
        terminalResourceIds(session).has(task.terminalResourceId);
      if (sharesHome || sharesResource) this.resyncSessionTask(session.id);
    }
  }

  /**
   * Recompute one session's task chip and emit only if it actually changed.
   * Per-session rather than per-worktree because an assigned task binds to a single
   * session id, not to a directory that may hold several agents.
   */
  private resyncSessionTask(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const summary = this.taskSummaryFor(id, s.cwd);
    if (JSON.stringify(s.task) === JSON.stringify(summary)) return;
    const next = { ...s, task: summary };
    this.sessions.set(id, next);
    this.emitSession(next);
  }

  // ---- Foreman notes (auto-responder) ----

  /** Full note for a session (includes handledMarker), or null. For the worker. */
  getNote(id: string): SessionNote | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.notes.get(noteKeyFor(s)) ?? null;
  }

  /** All stored Foreman notes (for the status counts). */
  listNotes(): SessionNote[] {
    return [...this.notes.values()];
  }

  /** The compact note view denormalized onto a session card. */
  private noteSummaryFor(s: Session): SessionNoteSummary | null {
    const n = this.notes.get(noteKeyFor(s));
    if (!n) return null;
    return {
      purpose: n.purpose,
      brief: n.brief,
      recommendation: n.recommendation,
      disposition: n.disposition,
      lastAction: n.lastAction,
      handledMarker: n.handledMarker,
      updatedAt: n.updatedAt,
    };
  }

  /**
   * Patch a session's Foreman note (create on first write), merging over the
   * existing row so a purpose-only update never wipes a brief. Persists, then
   * re-denormalizes onto every live session sharing the note key. Returns the
   * stored note, or null when the session id is unknown.
   */
  upsertNote(id: string, patch: SetNote, now = Date.now()): SessionNote | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const key = noteKeyFor(s);
    const prev = this.notes.get(key) ?? getSessionNote(key);
    const next: SessionNote = {
      noteKey: key,
      purpose: patch.purpose !== undefined ? patch.purpose : prev?.purpose ?? null,
      brief: patch.brief !== undefined ? patch.brief : prev?.brief ?? null,
      recommendation:
        patch.recommendation !== undefined ? patch.recommendation : prev?.recommendation ?? null,
      disposition: patch.disposition ?? prev?.disposition ?? "pending",
      lastAction: patch.lastAction !== undefined ? patch.lastAction : prev?.lastAction ?? null,
      handledMarker:
        patch.handledMarker !== undefined ? patch.handledMarker : prev?.handledMarker ?? null,
      updatedAt: now,
    };
    this.notes.set(key, next);
    upsertSessionNote(next);
    this.syncSessionsForNote(key);
    return next;
  }

  // ---- Foreman episodes (the append-only record behind the note) ----

  /**
   * Record one Foreman decision against this session's note key.
   *
   * Keyed the same way the note is, and deliberately so: the episode IS the note's
   * history, so a session whose key re-mints (a `/clear`) starts a fresh log for the
   * same reason it starts a fresh note. Unlike the note, nothing is denormalized onto
   * the session - the list is fetched by the panel that shows it, because a card
   * carrying every pane it ever saw would put a screen capture into every SSE frame.
   */
  recordEpisode(id: string, e: RecordEpisode, now = Date.now()): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    dbRecordEpisode({
      noteKey: noteKeyFor(s),
      sessionId: s.id,
      marker: e.marker,
      situation: e.situation,
      surface: e.surface,
      question: e.question,
      pane: e.pane ?? null,
      menu: e.menu ?? null,
      reviewId: e.reviewId ?? null,
      purpose: e.purpose ?? null,
      brief: e.brief ?? null,
      recommendation: e.recommendation ?? null,
      classification: e.classification ?? null,
      confidence: e.confidence ?? null,
      tier: e.tier ?? null,
      // Absent on every posture but `shadow`, where the worker measured the cheap tier
      // against the full review. Undefined and null are the same claim - not measured.
      cheapAction: e.cheapAction ?? null,
      divergence: e.divergence ?? null,
      // Why the ladder landed here, and why a skip was not a judgment. Absent on the
      // postures and paths that have no answer, where undefined and null again mean the
      // same thing - the ledger renders the reason it was given or nothing at all, and
      // never a reason nobody reported.
      triageReason: e.triageReason ?? null,
      skipReason: e.skipReason ?? null,
      disposition: e.disposition,
      lastAction: e.lastAction ?? null,
      sentText: e.sentText ?? null,
      sentOption: e.sentOption ?? null,
      sentBy: e.sentBy ?? null,
      createdAt: now,
      // An episode Foreman closed itself is resolved the moment it is recorded;
      // one it handed over stays open until a human acts on it.
      resolvedAt: e.disposition === "answered" || e.disposition === "skipped" ? now : null,
      // Derived from the same test, and deliberately not from `sentBy`: Foreman
      // resolves an episode by skipping it as well as by answering it, and only the
      // latter sends anything. A `skipped` episode with no author is one Foreman left
      // for the human; the human's own dismissal comes through `resolveEpisode` and
      // stamps `you` here, which is what keeps the two legible apart in the record.
      resolvedBy: e.disposition === "answered" || e.disposition === "skipped" ? "foreman" : null,
    });
    return true;
  }

  /** Stamp the human's answer onto an open episode. */
  resolveEpisode(id: string, p: ResolveEpisode, now = Date.now()): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    dbResolveEpisode({
      noteKey: noteKeyFor(s),
      marker: p.marker,
      disposition: p.disposition,
      sentText: p.sentText ?? null,
      resolvedBy: "you",
      resolvedAt: now,
    });
    return true;
  }

  /**
   * You answered the ask yourself, so retire the note Foreman pinned about that same ask.
   *
   * Foreman's note is a claim on your attention: "needs your decision", with a suggested
   * answer and an Approve button. Answering the question through any other channel spends
   * that claim - the decision is made, the child is unblocked, and the recommendation is
   * about a question that is closed. Nothing used to say so, so the note stayed pinned with
   * a live Approve on it until someone clicked Dismiss, and on the driver surface that
   * button would have injected Foreman's prose into a session that already had its answer.
   *
   * Keyed on the MARKER rather than on "this session has a note", and that is the whole
   * safety argument. A note whose marker names a DIFFERENT ask - a `no-question`
   * escalation, a `terminal-no-pane` one - is a decision you still owe, raised about
   * something other than the question just answered. Retiring it because an unrelated
   * permission prompt got answered would silently drop it, which is strictly worse than the
   * stale note this method exists to clear. Marker equality is the only evidence that the
   * thing you answered is the thing Foreman was waiting on.
   *
   * Episode first, then the note, because `upsertNote` nulls the recommendation and the
   * record must be stamped while the evidence is still there - the ordering rule
   * `closeForemanNote` documents for the dashboard's own Approve and Dismiss.
   *
   * The note write is what reaches the browser: `upsertNote` re-denormalizes onto every
   * live session sharing the key and emits `session_upsert`, so the strip unmounts on
   * `noteAwaitsYou` with no reload and no poll.
   *
   * Returns whether anything was retired, which is what lets a caller stay quiet: every
   * answer route calls this, and almost none of them have a note to clear.
   */
  retireNoteAnsweredByYou(sessionId: string, marker: string, now = Date.now()): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const note = this.notes.get(noteKeyFor(s));
    // `answered` and `skipped` are terminal and own no pin, so there is nothing to retire -
    // and rewriting one would overwrite a decision that was already reached.
    if (!note || !noteAwaitsYou(note.disposition)) return false;
    if (note.handledMarker !== marker) return false;
    // `skipped` + the "you" author `resolveEpisode` stamps is what `episodeOutcome` reads as
    // `dismissed`: the escalation was closed without Foreman's answer being used. Identical
    // in the ledger to the Dismiss a human used to have to click, which is the point - the
    // outcome was always this, and all that changes is who had to do the clicking.
    this.resolveEpisode(sessionId, { marker, disposition: "skipped", sentText: null }, now);
    this.upsertNote(
      sessionId,
      {
        disposition: "skipped",
        lastAction: "you answered this yourself",
        // The question is closed, so neither the suggestion nor the reasoning behind it is
        // live any more. Both survive on the episode, which is where a finished decision
        // belongs; leaving them on the note would keep offering an answer to nothing.
        recommendation: null,
        brief: null,
      },
      now,
    );
    return true;
  }

  /** Every episode recorded for this session's key, newest first. */
  listEpisodes(id: string): ForemanEpisode[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    return episodesFor(noteKeyFor(s));
  }

  // ---- goals (what a session is attempting to solve) ----

  /**
   * Keep the human's ask from a `UserPromptSubmit`, as the raw material for this session's
   * Goal.
   *
   * The full prompt already arrives on every one of these events and is thrown away:
   * the spec's `toState` trims it to 120 chars for `activity`, which is the right thing for a
   * ticker ("what is it doing this second") and the wrong length and lifetime for a goal.
   * `evt.prompt` is the only place the whole text exists, and only for this tick.
   *
   * Most of what arrives here is not a prompt at all - 200 of 396 real events on this
   * machine were `<task-notification>` blocks from background tasks reporting in - so
   * `substantivePrompt` returning null is the COMMON path, not an error one. Storing
   * nothing then is what keeps a goal describing the last thing a human actually asked for,
   * rather than being overwritten by machinery every time a task finishes.
   *
   * The first prompt establishes an immediate provisional objective. Later prompts update the
   * tactical focus but deliberately leave that objective standing until the intent reconciler
   * classifies them. This is the safety boundary between "fix this small thing next" and "the
   * whole session is now about this small thing". Prompt revisions, not `source`, are the
   * reconciler's durable queue.
   *
   * WHICH event carries a prompt and WHAT inside it a human actually typed are both the
   * harness's to answer - `UserPromptSubmit` is Claude's event name and the scaffolding
   * grammar is Claude's syntax - so both live behind `HookSpec.promptText` and this
   * reads neither. A harness whose bridge fires no prompt event answers null throughout,
   * and a session simply has no captured prompt for the refiner to work from.
   */
  private captureGoalPrompt(s: Session, spec: HookSpec, evt: HookIngest, now: number): void {
    const prompt = spec.promptText(evt);
    if (!prompt) return;
    const raw = clampPrompt(prompt);
    const prev = this.getGoal(s.id);
    const firstObjective = !prev?.objective;
    const revision = (prev?.promptRevision ?? 0) + 1;
    this.upsertGoal(s.id, {
      prompt: raw,
      focus: goalLine(raw),
      relationship: null,
      rationale: null,
      promptRevision: revision,
      pendingPrompts: [...(prev?.pendingPrompts ?? []), { revision, prompt: raw }],
      ...(firstObjective
        ? {
            objective: raw,
            text: goalLine(raw),
            source: "heuristic" as const,
            objectiveVersion: Math.max(1, prev?.objectiveVersion ?? 0),
          }
        : {}),
    }, now);
  }

  /** The compact goal view denormalized onto a session card. */
  private goalSummaryFor(s: Session): SessionGoalSummary | null {
    const g = this.goals.get(noteKeyFor(s));
    // A row exists as soon as a prompt is captured, which is BEFORE any sentence is derived
    // from it. Reporting that as a goal would put an empty line on the card, so a goal with
    // no text is reported as no goal.
    if (!g || !g.text) return null;
    return {
      text: g.text,
      source: g.source,
      focus: g.focus,
      relationship: g.relationship,
      objectiveVersion: g.objectiveVersion,
      promptRevision: g.promptRevision,
      resolvedPromptRevision: g.resolvedPromptRevision,
      updatedAt: g.updatedAt,
    };
  }

  /** A session's full goal record, including the refiner's stored input. */
  getGoal(id: string): SessionGoal | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.goals.get(noteKeyFor(s)) ?? null;
  }

  /**
   * Patch a session's goal (create on first write), merging like `upsertNote` so capturing
   * a prompt never clears the durable objective from an earlier one, and intent
   * reconciliation never drops the latest prompt it classified.
   *
   * `updatedAt` moves only when the effective objective changes. A steering prompt moves the
   * focus and prompt revision, but not the "when did this session change course" timestamp.
   */
  upsertGoal(id: string, patch: SetGoal, now = Date.now()): SessionGoal | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const key = noteKeyFor(s);
    const prev = this.goals.get(key) ?? getSessionGoal(key);
    const text = patch.text !== undefined ? patch.text : prev?.text ?? null;
    const objective = patch.objective !== undefined ? patch.objective : prev?.objective ?? null;
    const changed = text !== (prev?.text ?? null) || objective !== (prev?.objective ?? null);
    const next: SessionGoal = {
      noteKey: key,
      text,
      source: patch.source !== undefined ? patch.source : prev?.source ?? null,
      objective,
      prompt: patch.prompt !== undefined ? patch.prompt : prev?.prompt ?? null,
      focus: patch.focus !== undefined ? patch.focus : prev?.focus ?? null,
      relationship:
        patch.relationship !== undefined ? patch.relationship : prev?.relationship ?? null,
      rationale: patch.rationale !== undefined ? patch.rationale : prev?.rationale ?? null,
      objectiveVersion:
        patch.objectiveVersion !== undefined
          ? patch.objectiveVersion
          : prev?.objectiveVersion ?? (objective ? 1 : 0),
      promptRevision:
        patch.promptRevision !== undefined ? patch.promptRevision : prev?.promptRevision ?? 0,
      resolvedPromptRevision:
        patch.resolvedPromptRevision !== undefined
          ? patch.resolvedPromptRevision
          : prev?.resolvedPromptRevision ?? 0,
      pendingPrompts:
        patch.pendingPrompts !== undefined
          ? patch.pendingPrompts
          : prev?.pendingPrompts ?? [],
      updatedAt: changed ? now : prev?.updatedAt ?? now,
    };
    this.goals.set(key, next);
    upsertSessionGoal(next);
    this.syncSessionsForGoal(key);
    return next;
  }

  /**
   * Drop goals belonging to no live session and older than `olderThan`. Returns how many.
   *
   * Owned here rather than called straight against `db.ts` because the table is only half the
   * accumulation: `this.goals` holds every row `loadSessionGoals` read at boot plus one per
   * key seen since, so a sweep that pruned only the table would leave the map to grow for the
   * daemon's whole life and quietly refill the table on nothing. Both drop together, keyed on
   * the same live set, or neither does.
   *
   * `sessions` - not `liveSessions()` - is the protected set on purpose. An exited card is
   * still on screen with its goal showing, and it keeps that goal until the session is
   * evicted; pruning by liveness would blank a card a human is still reading.
   *
   * Gated on `sweptSessions` for the same reason `orphaned` and `reattachQueue` are: "no live
   * session holds this key" is a claim about the session map, and before the first sweep that
   * map is empty because nobody has filled it in - not because there are no sessions. The
   * constructor loads the whole goal table while `sessions` is still empty, so an ungated
   * sweep at boot would read every goal as stranded and delete each one past the window. See
   * `sessionsObserved`.
   */
  pruneGoals(olderThan: number): number {
    if (!this.sweptSessions) return 0;
    const liveKeys = new Set([...this.sessions.values()].map((s) => noteKeyFor(s)));
    const removed = pruneSessionGoals(liveKeys, olderThan);
    if (!removed) return 0;
    for (const [key, g] of this.goals) {
      if (liveKeys.has(key) || g.updatedAt >= olderThan) continue;
      this.goals.delete(key);
    }
    return removed;
  }

  private syncSessionsForGoal(key: string): void {
    for (const [id, s] of this.sessions) {
      if (noteKeyFor(s) !== key) continue;
      const summary = this.goalSummaryFor(s);
      if (JSON.stringify(s.goal) === JSON.stringify(summary)) continue;
      const next = { ...s, goal: summary };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  private syncSessionsForNote(key: string): void {
    for (const [id, s] of this.sessions) {
      if (noteKeyFor(s) !== key) continue;
      const summary = this.noteSummaryFor(s);
      if (JSON.stringify(s.note) === JSON.stringify(summary)) continue;
      const next = { ...s, note: summary };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  // ---- Foreman invites ----
  //
  // Whether Foreman may act in a session. One resolution rule, three write doors, and a
  // key-move that rides every noteKey rotation. The registry is the ONLY writer of the
  // `foreman_invites` table (through `setForemanInvite` / `inviteForeman` /
  // `withdrawForemanInvite`); the dispatcher and the Foreman worker reach it through
  // these methods and HTTP respectively, never through SQLite. Nothing reads the
  // resolved field yet - worker gating is phase 2 of docs/plans/foreman-invite.

  /**
   * Resolve a session's invite state: a `'withdrawn'` row means `null` (the tombstone
   * beats even the implicit grant); any other row speaks for itself; no row means the
   * runtime decides - an SDK session is invited by construction, everything else is not.
   */
  private foremanInviteFor(s: Session): ForemanInvite | null {
    const row = this.invites.get(noteKeyFor(s));
    if (row) return row.source === "withdrawn" ? null : row.source;
    return s.runtime === "sdk" ? "sdk" : null;
  }

  /**
   * Carry an invite (tombstones included - a withdrawal belongs to the pane as much as a
   * grant does) across a note-key rotation or a session reset. A no-op when the keys
   * match or nothing is stored under `fromKey`; when a row already sits under `toKey`,
   * the moved row wins - it followed the pane, and the resident row is the same pane's
   * earlier state (see `moveForemanInvite` in db.ts).
   *
   * Public for `resetSession` (src/server/reset.ts), which moves the invite to the
   * post-reset key beside its `clearPendingTurns` pair. Not a write door: it changes
   * which key holds the state, never what the state is.
   *
   * Only the DESTINATION key re-syncs. The rotation call sites re-resolve their own
   * `next` before emitting, and syncing `fromKey` here would emit the mid-rotation
   * session they are about to replace with a momentarily-stranded (null) invite - a
   * false frame on every /clear. A session left holding `fromKey` in some path this
   * reasoning misses is corrected by the next discovery sweep's re-resolution.
   */
  moveForemanInviteKey(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    const row = this.invites.get(fromKey);
    if (!row) return;
    moveForemanInviteDb(fromKey, toKey);
    this.invites.delete(fromKey);
    this.invites.set(toKey, { ...row, noteKey: toKey });
    this.syncSessionsForInvite(toKey);
  }

  /**
   * The dispatcher's door: record that Mission Control launched this terminal session
   * for a task, the moment discovery confirms the spawn. A plain upsert - a dispatch
   * into a pane whose key holds an old tombstone is a fresh grant, and `'dispatch'`
   * replacing `'withdrawn'` is exactly the restore the phased plan documents.
   *
   * Returns the resolved state, or undefined when the session is unknown.
   */
  setForemanInvite(sessionId: string, source: "dispatch"): ForemanInvite | null | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const key = noteKeyFor(s);
    const row: ForemanInviteRow = { noteKey: key, source, createdAt: Date.now() };
    upsertForemanInvite(key, source, row.createdAt);
    this.invites.set(key, row);
    this.syncSessionsForInvite(key);
    return this.foremanInviteFor(this.sessions.get(sessionId) ?? s);
  }

  /**
   * The operator's door - restore-then-elevate, never a blind `'operator'` upsert:
   *
   * 1. Already invited: a no-op. This is also what keeps the API from downgrading a
   *    live `'dispatch'` row to `'operator'`.
   * 2. A `'withdrawn'` tombstone exists: delete it and re-resolve, so runtime-implied
   *    grants resume - a withdrawn SDK session gets `"sdk"` back (backlog eligibility
   *    included, once phase 2 reads the field) rather than a permanent, invisible
   *    `"operator"` downgrade.
   * 3. Still `null` after that: write `'operator'`. One documented residue: a
   *    withdrawn, previously dispatched terminal re-invites as `"operator"` (its
   *    `'dispatch'` row was replaced by the tombstone) until a fresh dispatch restores
   *    `"dispatch"`.
   *
   * Returns the resolved state, or undefined when the session is unknown.
   */
  inviteForeman(sessionId: string): ForemanInvite | null | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const key = noteKeyFor(s);
    if (this.foremanInviteFor(s) !== null) return this.foremanInviteFor(s);
    if (this.invites.get(key)?.source === "withdrawn") {
      deleteForemanInvite(key);
      this.invites.delete(key);
    }
    if (this.foremanInviteFor(s) === null) {
      const row: ForemanInviteRow = { noteKey: key, source: "operator", createdAt: Date.now() };
      upsertForemanInvite(key, "operator", row.createdAt);
      this.invites.set(key, row);
    }
    this.syncSessionsForInvite(key);
    return this.foremanInviteFor(s);
  }

  /**
   * Withdraw Foreman from a session: upsert the `'withdrawn'` tombstone. A stored fact
   * rather than a deleted row because the withdrawal must beat the implicit SDK grant -
   * which no absence of a row can do - and must survive a restart. Authoritative for
   * every session, embedded ones included.
   *
   * Returns the resolved state (always `null` for a live session), or undefined when
   * the session is unknown.
   */
  withdrawForemanInvite(sessionId: string): ForemanInvite | null | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const key = noteKeyFor(s);
    const row: ForemanInviteRow = { noteKey: key, source: "withdrawn", createdAt: Date.now() };
    upsertForemanInvite(key, "withdrawn", row.createdAt);
    this.invites.set(key, row);
    this.syncSessionsForInvite(key);
    return this.foremanInviteFor(s);
  }

  /**
   * Drop invites belonging to no live session and older than `olderThan`. Returns how
   * many. `pruneGoals`' twin, for `pruneGoals`' reasons: the map holds every row read at
   * boot, the table gains a row per key a dispatch or an operator ever touched, and
   * every rotation the move above could not see (a daemon that was down when the key
   * changed) strands one for good. Same protected set (`sessions`, not `liveSessions()` -
   * an exited card's key stays protected until eviction), same `sweptSessions` gate.
   */
  pruneForemanInvites(olderThan: number): number {
    if (!this.sweptSessions) return 0;
    const liveKeys = new Set([...this.sessions.values()].map((s) => noteKeyFor(s)));
    const removed = pruneForemanInvitesDb(liveKeys, olderThan);
    if (!removed) return 0;
    for (const [key, row] of this.invites) {
      if (liveKeys.has(key) || row.createdAt >= olderThan) continue;
      this.invites.delete(key);
    }
    return removed;
  }

  private syncSessionsForInvite(key: string): void {
    for (const [id, s] of this.sessions) {
      if (noteKeyFor(s) !== key) continue;
      const resolved = this.foremanInviteFor(s);
      if (s.foremanInvite === resolved) continue;
      const next = { ...s, foremanInvite: resolved };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  // ---- Foreman work queues ----

  /** Re-read pending turns after the outbox manager commits a lifecycle transition. */
  refreshPendingTurns(key: string): void {
    this.syncSessionsForPendingTurns(key);
  }

  /** Reset cleanup for human turns authored against discarded conversation state. */
  clearPendingTurns(key: string, preserveIds: readonly string[] = []): boolean {
    const changed = clearPendingTurnsDb(key, preserveIds) > 0;
    if (changed) this.syncSessionsForPendingTurns(key);
    return changed;
  }

  /** The compact queue view denormalized onto a session card. */
  private queueSummaryFor(s: Session): SessionQueueSummary | null {
    const key = noteKeyFor(s);
    const row = getQueueRow(key);
    const items = listQueueItems(key);
    if (!row && items.length === 0) return null;
    return summarizeQueue(
      items,
      { askedAt: row?.wrapupAskedAt ?? null, answer: row?.wrapupAnswer ?? null },
      row?.updatedAt ?? 0,
    );
  }

  /** The complete editable outbox projection for one conversation. */
  private pendingTurnsFor(s: Session): PendingTurn[] {
    return listPendingTurns(noteKeyFor(s));
  }

  /**
   * The Inspector's state for this session's pull request, keyed on `prUrl`.
   *
   * Keyed on the PR rather than the session because that is what the ledger is about:
   * a PR outlives the session that opened it, gets reviewed after that session exits,
   * and can be shown on a different session that later checks out the same branch.
   *
   * Null when the PR was never adopted, and that is INFORMATION rather than an absence:
   * the Inspector only adopts what it can prove Mission Control opened, so a card with
   * a PR chip and no inspector chip is saying that PR came from somewhere else.
   */
  private inspectorSummaryFor(s: Session): InspectorSummary | null {
    return this.inspectorSummaryForUrl(s.prUrl);
  }

  /**
   * The same projection for a pull request named by url rather than by session.
   *
   * Split out for the per-repository summaries: a multi-repo task's secondary pull request is
   * in this very ledger and reaches no session scalar, so the only difference between its chip
   * facts and the primary's is which url you ask about.
   */
  private inspectorSummaryForUrl(prUrl: string | null): InspectorSummary | null {
    if (!prUrl) return null;
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return null;
    const row = this.inspections.get(parsed.key);
    if (!row) return null;
    return {
      prKey: row.key,
      url: row.url,
      mode: getInspectorConfig().mode,
      open: row.openFindings,
      postedOpen: row.postedOpenFindings,
      round: row.round,
      lastReviewedAt: row.lastReviewedAt,
      failed: row.lastError !== null,
    };
  }

  /**
   * Whether this session is worth retrospecting, and why.
   *
   * Sits beside `inspectorSummaryFor` and is resolved with it at every one of its call sites,
   * because half of it is the SAME ledger row: `resolvedFindings` comes out of the grouped
   * query that already produced the chip's counts, so the findings half costs one map read
   * and follows `prUrl` wherever the inspector summary follows it. The corrections half is a
   * flag the poller sets; combining them here is what keeps one answer on the wire.
   *
   * `undefined` rather than `null` for "nothing to retrospect", so the field is simply absent
   * from the JSON a browser receives - see `Session.retro`.
   */
  private retroSummaryFor(s: Session): RetroSummary | undefined {
    const parsed = s.prUrl ? parsePrUrl(s.prUrl) : null;
    const row = parsed ? this.inspections.get(parsed.key) : undefined;
    return retroSummary({
      corrections: this.retroCorrections.has(s.id),
      resolvedFindings: row?.resolvedFindings ?? 0,
    }) ?? undefined;
  }

  /**
   * Re-resolve every summary derived from the Inspector's ledger.
   *
   * One call rather than two assignments at each of the seven sites that re-resolve after a
   * pull request moves. `inspector` and `retro` read the same row for the same reason - the
   * ledger is keyed on the PR, so a session that gains, loses or switches one has both facts
   * go stale at once - and a site that remembered only the first would leave the retro offer
   * answering for the previous pull request.
   */
  private resolveInspectionSummaries(s: Session): void {
    s.inspector = this.inspectorSummaryFor(s);
    s.retro = this.retroSummaryFor(s);
  }

  /**
   * Record that this session's human has corrected it, and light the offer if that is new.
   *
   * Idempotent and one-way, because the fact is: the poller calls this on every tick once a
   * session has flipped, and a correction cannot be taken back. The early return is what
   * keeps that from being an emit per tick.
   */
  recordRetroCorrections(sessionId: string): void {
    if (this.retroCorrections.has(sessionId)) return;
    this.retroCorrections.add(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const next: Session = { ...s, retro: this.retroSummaryFor(s) };
    if (sessionEqual(s, next)) return;
    this.sessions.set(sessionId, next);
    this.emitSession(next);
  }

  /**
   * Re-read the ledger and push any changed summary onto its session.
   *
   * Called by the Inspector at the end of a tick rather than on a timer: a review round
   * is minutes of work and then one moment where the counts change, so polling the DB
   * per sweep would be constant reads to observe an event that happens rarely.
   */
  refreshInspections(): void {
    this.inspections.clear();
    for (const row of loadInspectorInspections()) this.inspections.set(row.key, row);
    for (const [id, s] of this.sessions) {
      const updated: Session = { ...s };
      this.resolveInspectionSummaries(updated);
      // A THIRD summary off the same rows, for a multi-repo task: each repository's line
      // carries that repository's own findings, and this is the only pass that runs when they
      // move. Without it a secondary pull request's review would land and nothing on the wire
      // would say so until the branch poller happened to change something else. A no-op for a
      // single-repo session, which gets its existing summary back by identity.
      updated.task = this.repoPrSummaryFor(updated);
      // Both summaries, because both are derived from the row this just re-read: a round
      // that resolves the last finding clears the chip AND is the moment the retro becomes
      // worth offering, and checking only the chip would hold the offer back until some
      // unrelated change happened to rebuild the session.
      if (sessionEqual(s, updated)) continue;
      this.sessions.set(id, updated);
      this.emitSession(updated);
    }
    // The adoption that triggered this is also the denominator of the strip's cost-per-PR,
    // and the recompute suppresses itself when nothing moved - so this is free on the
    // ticks that only re-read comment counts, and saves the figure sitting a whole idle
    // interval behind the PR chip that appeared beside it.
    this.recomputeFleetCost();
  }

  /**
   * A queue whose own session is gone but whose cwd matches this live one - the
   * re-attach hint.
   *
   * Without this a queue orphaned by a `/clear` (which mints a new agent session
   * id) would match NO live session, so it would appear on NO card and nothing
   * would drive its tick. It is deliberately only a hint: a different agent at
   * that cwd may be doing something else entirely, so rebinding is always an
   * explicit click, never automatic.
   */
  private orphanedQueueFor(s: Session): OrphanedQueueHint | null {
    if (!s.cwd) return null;
    // No sweep yet means no evidence, only an empty map - and "no live session holds
    // that key" read off it is a statement about a map nobody has filled in, not a
    // finding. Same rule as the exit linger, and the same reason: the hint is what
    // `reattachQueue` relies on to know a queue is really orphaned. See sessionsObserved.
    if (!this.sweptSessions) return null;
    const key = noteKeyFor(s);
    // Every OTHER live session's key, plus this session's CURRENT one. Its stored copy
    // is deliberately excluded: `s` may be in the map under a key it just moved off -
    // a `/clear` rebinds agentSessionId, and the queue it just orphaned is keyed on
    // the old id. Counting that stale entry as live would mean the queue this session
    // just abandoned looks like it still has a session, so the hint that offers to
    // resume it never appears. Liveness goes through `holdsKey`, the same predicate
    // the worker's sweep uses, so the card and the sweep cannot disagree about who is
    // still here.
    const liveKeys = new Set<string>();
    for (const [id, o] of this.sessions) {
      if (o.id !== s.id && this.holdsKey(id, o)) liveKeys.add(noteKeyFor(o));
    }
    liveKeys.add(key);
    let best: OrphanedQueueHint | null = null;
    // Indexed by cwd rather than scanning every queue the DB has ever held: this runs
    // per discovered session per sweep, i.e. O(sessions x queues) several times a
    // second, on the one synchronous SQLite handle that also serves hook ingest and
    // SSE.
    for (const q of listQueueRowsForCwd(s.cwd)) {
      if (liveKeys.has(q.noteKey)) continue;
      const open = countOpenQueueItems(q.noteKey);
      if (open === 0) continue; // nothing left to resume - not worth a hint
      if (!best || open > best.itemCount) {
        best = { noteKey: q.noteKey, itemCount: open, branch: q.branch };
      }
    }
    return best;
  }

  /** Full queue for a session (items + wrap-up state), or null when it has none. */
  getQueue(id: string): SessionQueue | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const key = noteKeyFor(s);
    const intent = resolvedSessionIntent(this.getGoal(s.id));
    if (intent) bootstrapPromptedConsumedGeneration(key, intent.episodeKey);
    return this.getQueueByKey(key);
  }

  /** Full queue by note key - the orphan path, where no live session resolves it. */
  getQueueByKey(key: string): SessionQueue | null {
    const row = getQueueRow(key);
    const items = listQueueItems(key);
    if (!row && items.length === 0) return null;
    return {
      noteKey: key,
      cwd: row?.cwd ?? null,
      branch: row?.branch ?? null,
      wrapupAskedAt: row?.wrapupAskedAt ?? null,
      wrapupAnswer: row?.wrapupAnswer ?? null,
      promptedGoal: row?.promptedGoal ?? null,
      promptedEvidence: row?.promptedEvidence ?? null,
      promptedActivityAt: row?.promptedActivityAt ?? null,
      promptedLegacyCutoverGeneration: row?.promptedLegacyCutoverGeneration ?? null,
      promptedConsumedGeneration: row?.promptedConsumedGeneration ?? null,
      updatedAt: row?.updatedAt ?? 0,
      items,
    };
  }

  /** Every stored queue (items included) - the orphan sweep + the cross-session list. */
  listQueues(): SessionQueue[] {
    const out: SessionQueue[] = [];
    for (const row of listQueueRows()) {
      out.push({ ...row, items: listQueueItems(row.noteKey) });
    }
    return out;
  }

  /**
   * Whether a session in the map still counts as holding its note key.
   *
   * A session inside its exit linger counts as LIVE. `exited` is provisional by
   * design: `applyDiscovery` marks any session missing from a single sweep as exited
   * and only evicts it EXIT_LINGER_MS later, cancelling that timer if it reappears.
   * Reading `state === "exited"` as gone ignores the very guard the linger exists to
   * provide - one hiccuping `ps` sweep would mark every session exited, and
   * `sweepOrphanedQueues` (which runs several times a second) would escalate every
   * in-flight item before the next poll un-marked them. Escalation is terminal and
   * has no undo, so it must not turn on a single missed poll.
   *
   * Defined ONCE because two readers must agree on it: `liveNoteKeys` (the worker's
   * orphan sweep) and `orphanedQueueFor` (the card's re-attach hint). They previously
   * held separate copies, and the copies disagreed about a session marked exited by a
   * hook - the sweep skipped it and escalated its in-flight item, while the hint
   * counted it as live and so never offered the leftover queue to anyone.
   */
  private holdsKey(id: string, s: Session): boolean {
    return s.state !== "exited" || this.exitTimers.has(id);
  }

  /** Note keys with at least one live session - what makes a queue "not orphaned". */
  liveNoteKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [id, s] of this.sessions) {
      if (this.holdsKey(id, s)) keys.add(noteKeyFor(s));
    }
    return keys;
  }

  /**
   * Whether the session map has ever been reconciled against the OS - i.e. whether
   * "no live session holds this key" is a FINDING or merely a fact about a map
   * nobody has filled in yet.
   *
   * The daemon serves `/api/*` the instant it binds its port, while the first
   * discovery sweep is an async `ps` scan that lands some time after. Anything
   * reading `liveNoteKeys` in that window sees an empty set and concludes the whole
   * session list is gone - and the orphan sweep polls several times a second, so it will be
   * in that window. Same rule as the exit linger just above, and the same reason:
   * escalation is terminal and has no undo, so it must not turn on an absence of
   * evidence. A sweep that completes and genuinely finds nothing DOES flip this -
   * that's a session list we looked at, so a queue with no session really is orphaned.
   */
  sessionsObserved(): boolean {
    return this.sweptSessions;
  }

  /**
   * Ensure a queue row exists for a session, refreshing its cwd/branch (the
   * re-attach hint must track where the session actually is). Returns the key.
   *
   * Refused when the harness has no `workQueue` capability or this session has never
   * reported a hook, and refused HERE because this is the boundary the write crosses -
   * the panel hiding its add box is presentation, not enforcement, and the loopback API
   * goes straight past it. A queue on such a session cannot be observed through pickup
   * and completion, yet its live key would keep both recovery surfaces from offering the
   * batch elsewhere. `reattachQueue` enforces the same rule at its write boundary.
   */
  ensureQueue(id: string, now = Date.now()): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (workQueueBlockedReason(s)) return null;
    const key = noteKeyFor(s);
    const prev = getQueueRow(key);
    upsertQueue({
      noteKey: key,
      cwd: s.cwd,
      branch: s.gitBranch,
      wrapupAskedAt: prev?.wrapupAskedAt ?? null,
      wrapupAnswer: prev?.wrapupAnswer ?? null,
      promptedGoal: prev?.promptedGoal ?? null,
      promptedEvidence: prev?.promptedEvidence ?? null,
      promptedActivityAt: prev?.promptedActivityAt ?? null,
      promptedLegacyCutoverGeneration: prev?.promptedLegacyCutoverGeneration ?? null,
      promptedConsumedGeneration: prev?.promptedConsumedGeneration ?? null,
      updatedAt: now,
    });
    return key;
  }

  /** Patch a queue's wrap-up state, then re-denormalize. */
  setQueueWrapup(
    key: string,
    patch: {
      wrapupAskedAt?: number | null;
      wrapupAnswer?: string | null;
      promptedGoal?: string | null;
      promptedEvidence?: string | null;
      promptedActivityAt?: number | null;
      promptedLegacyCutoverGeneration?: number | null;
      promptedConsumedGeneration?: number | null;
    },
    now = Date.now(),
  ): void {
    const prev = getQueueRow(key);
    if (!prev) return;
    upsertQueue({
      ...prev,
      wrapupAskedAt: patch.wrapupAskedAt !== undefined ? patch.wrapupAskedAt : prev.wrapupAskedAt,
      wrapupAnswer: patch.wrapupAnswer !== undefined ? patch.wrapupAnswer : prev.wrapupAnswer,
      promptedGoal: patch.promptedGoal !== undefined ? patch.promptedGoal : prev.promptedGoal,
      promptedEvidence:
        patch.promptedEvidence !== undefined
          ? patch.promptedEvidence
          : patch.promptedGoal === null
            ? null
            : prev.promptedEvidence,
      promptedActivityAt:
        patch.promptedActivityAt !== undefined
          ? patch.promptedActivityAt
          : patch.promptedGoal === null
            ? null
            : prev.promptedActivityAt,
      promptedLegacyCutoverGeneration:
        patch.promptedLegacyCutoverGeneration !== undefined
          ? patch.promptedLegacyCutoverGeneration
          : prev.promptedLegacyCutoverGeneration,
      promptedConsumedGeneration:
        patch.promptedConsumedGeneration !== undefined
          ? patch.promptedConsumedGeneration
          : prev.promptedConsumedGeneration,
      updatedAt: now,
    });
    this.syncSessionsForQueue(key);
  }

  /** Re-read a queue after another daemon-owned transaction updated its guard columns. */
  refreshQueue(key: string): void {
    this.syncSessionsForQueue(key);
  }

  /** Atomically consume the expected settled generation for one live logical session. */
  consumePromptedGeneration(
    id: string,
    input: {
      logicalKey: string;
      generation: number;
      expectedIntent: SessionIntentGuard;
      ask: boolean;
    },
    now = Date.now(),
  ): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state === "exited" || workQueueBlockedReason(session)) return false;
    if (noteKeyFor(session) !== input.logicalKey) return false;
    if (session.state !== "idle" || reportBucket(session, [...this.sessions.values()]) === "needs-you") {
      return false;
    }
    if (listQueueItems(input.logicalKey).length > 0) return false;
    if (!sessionIntentMatches(this.getGoal(id), input.expectedIntent)) return false;
    const cycle = session.workCycle;
    if (
      !cycle ||
      cycle.logicalKey !== input.logicalKey ||
      cycle.generation !== input.generation ||
      cycle.generation < 1 ||
      cycle.active ||
      cycle.completedAt === null
    ) return false;
    // Upgrade compatibility is resolved at the daemon mutation boundary too, not
    // only when the worker happened to read the queue first. A matching historical
    // guard must remain spent even for a direct HTTP consumer.
    bootstrapPromptedConsumedGeneration(input.logicalKey, input.expectedIntent.episodeKey);
    const consumed = dbConsumePromptedGeneration({
      noteKey: input.logicalKey,
      sessionCwd: session.cwd,
      generation: input.generation,
      ask: input.ask,
      now,
    });
    if (consumed) this.syncSessionsForQueue(input.logicalKey);
    return consumed;
  }

  /**
   * Persist an item and re-denormalize onto every live session sharing its key.
   *
   * The item write also touches its QUEUE ROW's `updatedAt`, which is what makes the
   * card's summary move at all. `SessionQueueSummary` is a deliberately compact
   * projection - counts, the in-flight state - so transitions it doesn't model
   * produce a byte-identical summary, `syncSessionsForQueue` short-circuits on its
   * equality check, and no `session_upsert` is emitted. `queued -> proposed` is
   * exactly that shape: `proposed` isn't in-flight and isn't terminal, so neither
   * `inFlightState` nor `openCount` moves, and in dry-run - the default mode - the
   * panel would never learn a draft was waiting on the one action that advances the
   * queue. Timestamping the row makes "an item changed" observable to the summary
   * without teaching it every state, and keeps the fix at the write rather than
   * spreading a special case across the readers.
   */
  putQueueItem(item: WorkItem): void {
    upsertQueueItem(item);
    this.touchQueue(item.noteKey, item.updatedAt);
    this.syncSessionsForQueue(item.noteKey);
  }

  /**
   * Move a queue row's `updatedAt`, so any item write is visible in the summary.
   *
   * STRICTLY increasing, not just `max(now, …)`: this is a change token, not a
   * displayed time (nothing renders it - the panel only diffs it), and two writes
   * inside the same millisecond are ordinary. A signal that silently fails to move
   * when the clock doesn't tick is a signal that works until it doesn't.
   */
  private touchQueue(key: string, now: number): void {
    const row = getQueueRow(key);
    if (!row) return;
    upsertQueue({ ...row, updatedAt: Math.max(now, row.updatedAt + 1) });
  }

  getQueueItem(id: string): WorkItem | undefined {
    return getQueueItem(id);
  }

  /**
   * Drop an item, then make the change observable.
   *
   * `touchQueue` for the reason `putQueueItem` documents, and removing a TERMINAL
   * item is the case that needs it most: the summary projects `openCount` and the
   * in-flight state, neither of which a finished item contributes to, so the delete
   * produced a byte-identical summary and every OTHER viewer kept rendering the item
   * that is no longer there - indefinitely, on an idle queue, since nothing would
   * ever heal it. Removing a waiting item happened to be fine only because
   * `openCount` moved; that's a coincidence of the projection, not a rule.
   */
  removeQueueItem(id: string, now = Date.now()): void {
    const item = getQueueItem(id);
    if (!item) return;
    deleteQueueItem(id);
    this.touchQueue(item.noteKey, now);
    this.syncSessionsForQueue(item.noteKey);
  }

  /**
   * Clear a whole queue - every item AND the row - then make it observable.
   *
   * The RESET action's cleanup: a reset discards the task these items were authored
   * for, so the batch goes with it. Distinct from a bare /clear, whose backlog
   * deliberately survives (orphaned) for the re-attach affordance - this is the
   * explicit "start over", so it drops in-flight items too (see `clearQueueDb`).
   *
   * Two syncs, mirroring `reattachQueue`, because clearing changes the queue
   * landscape twice over: `syncSessionsForQueue` blanks the summary on the card
   * whose key this was, and `syncAllOrphanHints` retracts any sibling's re-attach
   * hint that pointed at the batch just deleted. A no-op (no emit) when the key held
   * no queue. Returns whether anything was cleared.
   */
  clearQueue(key: string): boolean {
    if (!getQueueRow(key)) return false;
    clearQueueDb(key);
    this.syncSessionsForQueue(key);
    this.syncAllOrphanHints();
    return true;
  }

  /**
   * Re-sequence a queue, then make the change observable.
   *
   * `touchQueue` for the reason `putQueueItem` documents, and a reorder is the
   * purest case of it: the summary projects counts and the in-flight item but never
   * `seq`, so re-ordering produces a byte-identical summary and every reader other
   * than the tab that dragged would keep rendering the old order - indefinitely, on
   * an idle queue, since nothing else would ever heal it.
   */
  reorderQueue(key: string, ids: string[], now = Date.now()): void {
    reorderQueueItems(key, ids, now);
    this.touchQueue(key, now);
    this.syncSessionsForQueue(key);
  }

  /**
   * Re-key a queue onto a live session (the explicit re-attach). Rewrites the
   * queue row and every item to the new note key, so the queue resumes on the
   * session the human pointed at.
   *
   * The SOURCE must actually be orphaned, and that is checked HERE rather than
   * trusted from the hint the button was drawn from. The hint is stale by
   * construction: `applyHook` re-resolves only the hooked session's own
   * `orphanedQueue`, so a sibling card's copy waits for the next `applyDiscovery`,
   * and a browser tab holds whatever it last received over SSE for longer still. A
   * session can reappear on `fromKey` in that gap (an exit-linger cancel after a
   * missed `ps` sweep), and by then Foreman may have typed its in-flight item into
   * that pane - so a click on the stale button would re-key live work onto another
   * session, verify it against the wrong transcript and diff (baseSha and
   * transcriptAnchor are anchored on the session it was sent to), and delete the
   * source row inside the transaction with no undo.
   *
   * `sessionsObserved` is required for the same reason `orphaned()` requires it, in the
   * same direction: "no live session holds this key" read off a map no sweep has
   * filled in is a statement about the map, not about the sessions. The daemon answers
   * routes the instant it binds its port, so a tab that outlives a restart can land a
   * click in exactly that window. Refusing costs a re-click; guessing costs the batch.
   */
  reattachQueue(fromKey: string, toSessionId: string, now = Date.now()): boolean {
    const s = this.sessions.get(toSessionId);
    const row = getQueueRow(fromKey);
    if (!s || !row) return false;
    // Only onto a session that can actually RUN a queue. `orphanedQueueFor` matches
    // on cwd alone, so the hint can be offered beside a session with no queue capability
    // or no hook authorization. Re-keying onto it is a one-way trip to nowhere: the
    // target's live key prevents either recovery surface from offering the batch again.
    if (workQueueBlockedReason(s)) return false;
    const toKey = noteKeyFor(s);
    // Already where the human wants it: nothing to write, so nothing to guard.
    if (toKey === fromKey) return true;
    // The source must really be orphaned - see the note above on why the hint that
    // drew the button cannot be the thing that authorises the write.
    if (!this.sweptSessions) return false;
    if (this.liveNoteKeys().has(fromKey)) return false;
    // A live queue at the target key would collide on the single-flight index and
    // silently merge two batches of work; refuse rather than guess which wins.
    //
    // Only OPEN items count. A finished batch left on this key can't collide (the
    // index only covers in-flight states) and isn't work anyone is waiting on, so
    // refusing over it would block the re-attach in a case that is actually safe -
    // and the card would be offering a button that always 409s.
    const existing = listQueueItems(toKey);
    if (existing.some((i) => !isTerminalItem(i.state))) return false;
    const items = listQueueItems(fromKey);
    // Renumber onto the END of whatever the target already holds. Source seqs start
    // at 0 and so do the finished batch's the guard above deliberately allows, so
    // preserving them would collide - and `listQueueItems` orders by seq with an
    // arbitrary tiebreak, leaving the re-attached work interleaved among completed
    // items. `items` is already in seq order, so the offset keeps their order.
    const base = existing.reduce((max, i) => Math.max(max, i.seq + 1), 0);
    rekeyQueue(
      fromKey,
      {
        noteKey: toKey,
        cwd: s.cwd,
        branch: s.gitBranch,
        wrapupAskedAt: row.wrapupAskedAt,
        wrapupAnswer: row.wrapupAnswer,
        promptedGoal: row.promptedGoal,
        promptedEvidence: row.promptedEvidence,
        promptedActivityAt: row.promptedActivityAt,
        promptedLegacyCutoverGeneration: row.promptedLegacyCutoverGeneration,
        promptedConsumedGeneration: row.promptedConsumedGeneration,
        updatedAt: now,
      },
      items.map((i, n) => ({ ...i, noteKey: toKey, seq: base + n, updatedAt: now })),
    );
    // BOTH keys, not just the target. The guard above proves no LIVE session holds
    // `fromKey`, but a session ended by a `SessionEnd` hook is marked exited without
    // an exit timer - so it stops holding its key while staying in the map until a
    // sweep evicts it. Its card would go on rendering a summary of the queue that is
    // no longer there, and with no sessions moving nothing else would ever heal it.
    this.syncSessionsForQueue(fromKey);
    this.syncSessionsForQueue(toKey);
    this.syncAllOrphanHints();
    return true;
  }

  private syncSessionsForQueue(key: string): void {
    for (const [id, s] of this.sessions) {
      if (noteKeyFor(s) !== key) continue;
      const summary = this.queueSummaryFor(s);
      if (JSON.stringify(s.queue) === JSON.stringify(summary)) continue;
      const next = { ...s, queue: summary };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  private syncSessionsForPendingTurns(key: string): void {
    const pendingTurns = listPendingTurns(key);
    for (const [id, s] of this.sessions) {
      if (noteKeyFor(s) !== key) continue;
      if (JSON.stringify(s.pendingTurns) === JSON.stringify(pendingTurns)) continue;
      const next = { ...s, pendingTurns };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  /** Re-resolve every card's orphan hint (after a re-attach changes who's orphaned). */
  private syncAllOrphanHints(): void {
    for (const [id, s] of this.sessions) {
      const hint = this.orphanedQueueFor(s);
      if (JSON.stringify(s.orphanedQueue) === JSON.stringify(hint)) continue;
      const next = { ...s, orphanedQueue: hint };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }
}

/**
 * The lifecycle predicates, exported under this module's historical names.
 *
 * The definitions live in @shared/queue.ts because the DB's partial unique index is
 * built from the same constant - one set of states, one place to change it.
 */
export const isTerminalItem = isTerminalState;
export const inFlightOf = inFlightItemOf;

/** Project a queue's items into the compact card summary. Pure, for tests. */
export function summarizeQueue(
  items: WorkItem[],
  /**
   * The row's wrap-up state, taken as a pair rather than as two positional args: the
   * card has to tell an OPEN question from an answered one, and passing only the
   * timestamp is what made that undecidable at the call site.
   */
  wrapup: { askedAt: number | null; answer: string | null },
  updatedAt: number,
): SessionQueueSummary {
  const open = items.filter((i) => !isTerminalItem(i.state));
  const inFlight = inFlightOf(items);
  return {
    openCount: open.length,
    totalCount: items.length,
    inFlightState: inFlight?.state ?? null,
    inFlightIntent: inFlight?.intent ?? null,
    round: inFlight?.round ?? 0,
    blockingGaps: inFlight ? inFlight.gaps.filter((g) => g.severity === "blocking").length : 0,
    verifiedCount: items.filter((i) => i.state === "verified").length,
    escalatedCount: items.filter((i) => i.state === "escalated").length,
    drained: items.length > 0 && open.length === 0,
    wrapupAskedAt: wrapup.askedAt,
    wrapupAnswered: wrapup.answer !== null,
    updatedAt,
  };
}

// ---- pure helpers ----

/** A task in a terminal state has no further lifecycle - safe to evict from memory. */
function isTerminalTask(status: Task["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/**
 * The task statuses a merged pull request can still decide.
 *
 * Three readers share it so they cannot drift: `taskPrPollTargets` (which URLs are still
 * worth a `gh` call), `preservesCompletionEvidence` (which bindings must outlive rollover
 * to be read later), and `TaskManager.reconcileMergedTasks` (which rows a merge completes).
 *
 * `failed` and `cancelled` are in it because a merge UPGRADES them - the adopted decision
 * that a pull request which actually landed is the task's outcome, whatever was concluded
 * before anyone could see it merge. Only a merge does that; a closed-unmerged pull request
 * changes nothing. `done` is not in it: its outcome is already recorded, and rewriting one
 * would overwrite what an operator typed. `backlog` is not either: a rescheduled task is
 * being re-run, so its previous attempt's merge is not this run's outcome.
 */
export function completableByMerge(status: Task["status"]): boolean {
  return (
    status === "running" ||
    status === "dispatching" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/**
 * Does a rolled-past binding still answer a question about its task?
 *
 * Two answers, retiring at different moments. A binding whose pull request was OBSERVED
 * MERGED is the task's outcome - what `mergedPrFor` reads - and is kept for every status
 * but `backlog`: `done` because an idle auto-completion may still be reopened by a prompt,
 * `failed` and `cancelled` because `reconcileMergedTasks` upgrades them from exactly this
 * row. A binding whose pull request has NOT been seen merged is what the by-URL poller is
 * still watching, so it survives precisely while `taskPrPollTargets` would harvest it;
 * once the task is `done` there is nothing left for that URL to decide, and deleting it
 * is what stops an abandoned branch being polled for ever.
 *
 * A task that has left memory keeps nothing - nothing can read the row again.
 */
function preservesCompletionEvidence(task: Task | undefined, merged: boolean): boolean {
  if (!task) return false;
  return merged ? task.status !== "backlog" : completableByMerge(task.status);
}

/**
 * Pane token for a hook's captured env: tmux pane wins over the outer wezterm pane.
 *
 * Built from the same two constructors `paneToken` uses, so a hook's key and the
 * discovered session's key are spelled identically - which is the whole mechanism
 * by which an overlay finds its session (`test/hooks.test.ts` pins the agreement).
 * The env carries pane ids as STRINGS, so it cannot go through `paneToken` itself.
 */
export function overlayKeyFromEnv(env: HookIngest["env"]): string | null {
  if (env.tmuxPane) return tmuxPaneToken(env.tmuxPane);
  if (env.weztermPane) return weztermPaneToken(env.weztermPane);
  return null;
}

/** Pane token for a discovered session: its own pane, tmux preferred. */
export function sessionKey(s: Session): string | null {
  return paneToken(s);
}

/** Every permission mode this build knows; unknown newer values remain unreadable. */
const KNOWN_PERMISSION_MODES = new Set<PermissionMode>(PERMISSION_MODES);

/**
 * Narrow a raw `permission_mode` string to a known PermissionMode, or null when
 * it's absent or a value we don't recognize (a mode a newer Claude adds) - so an
 * unknown mode never masquerades as a known one on the card.
 */
export function normalizePermissionMode(raw: string | undefined | null): PermissionMode | null {
  return raw && KNOWN_PERMISSION_MODES.has(raw as PermissionMode) ? (raw as PermissionMode) : null;
}

/**
 * Stable key for a session's Foreman note. Prefers the Claude agent session id
 * (stable across the synthetic discovery id churning as pids/ttys change), and
 * falls back to the synthetic id for an uninstrumented session. Foreman only
 * writes a note once it has read the transcript, by which point agentSessionId
 * is known, so a note is keyed on the agent id in practice.
 */
export function noteKeyFor(s: Session): string {
  return s.agentSessionId ?? s.id;
}

/**
 * OTLP attribute list -> lookup, keeping ONLY the four keys the ledger stores.
 *
 * The allowlist is the PII boundary, and it is here rather than at the write so nothing
 * downstream can reach a value it was never meant to see. Datapoints carry `user.email`,
 * `user.account_uuid`, `user.account_id` and `organization.id`; none of them survives
 * this function, and a future column added to the ledger cannot accidentally pick one up.
 */
export function attrMap(
  attributes: Array<{ key: string; value: { stringValue?: string } }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attributes ?? []) {
    if (!OTEL_KEPT_ATTRS.has(a.key)) continue;
    const v = a.value?.stringValue;
    if (typeof v === "string" && v) out[a.key] = v;
  }
  return out;
}

/** The only datapoint attributes that ever leave `attrMap`. Everything else is PII or noise. */
const OTEL_KEPT_ATTRS = new Set(["session.id", "model", "query_source", "type"]);

/**
 * `claude_code.token.usage`'s `type` attribute -> the ledger column it belongs in.
 *
 * The names are camelCase on the wire (`cacheRead`, not `cache_read`) while the columns
 * are snake_case, which is exactly the sort of near-miss that silently drops half the
 * tokens - hence a table rather than a transformation. An unknown type has no entry and
 * is skipped: a tier we cannot name is a tier we cannot bill to a column.
 */
const TOKEN_TYPE_COL: Record<string, UsageCol | undefined> = {
  input: "input",
  output: "output",
  cacheRead: "cacheRead",
  cacheCreation: "cacheWrite",
};

/**
 * A `timeUnixNano` field as a decimal STRING, or null when it isn't one.
 *
 * OTLP/JSON encodes 64-bit ints as strings and these are ~1.78e18 - well past
 * `Number.MAX_SAFE_INTEGER` (9.007e15). A number that reached here has already lost
 * precision, so it is stringified through `BigInt` where possible and rejected outright
 * when it can't be: a truncated nano value collides adjacent export windows, which is
 * silent data loss dressed as idempotency.
 */
export function nanoString(v: string | number | undefined): string | null {
  if (typeof v === "string") return /^\d+$/.test(v) ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

/** Nanos (as text) -> epoch ms, via BigInt so the division never rounds through a double. */
export function epochMsFromNanos(ns: string | null): number | null {
  if (!ns) return null;
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return null;
  }
}

/** Local midnight for `now`, the boundary "estimated cost today" is measured from. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Two readings compared on what a human can see, so `updatedAt` never forces an emit. */
export function rateLimitsDisplayEqual(a: RateLimits | null, b: RateLimits | null): boolean {
  if (!a || !b) return a === b;
  return rateWindowEqual(a.fiveHour, b.fiveHour) && rateWindowEqual(a.sevenDay, b.sevenDay);
}

function rateLimitSourceEqual(a: RateLimitSource, b: RateLimitSource): boolean {
  return a.source === b.source && a.windows.length === b.windows.length && a.windows.every((w, i) => {
    const other = b.windows[i];
    return !!other && w.id === other.id && w.label === other.label &&
      w.durationMinutes === other.durationMinutes && rateWindowEqual(w, other);
  });
}

function rateLimitSourcesEqual(a: RateLimitSource[] | undefined, b: RateLimitSource[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((source, i) => !!right[i] && rateLimitSourceEqual(source, right[i]!));
}

/** Two rate-limit windows compared on what a human can see, ignoring when we read them. */
export function rateWindowEqual(a: RateLimitWindow | null, b: RateLimitWindow | null): boolean {
  if (!a || !b) return a === b;
  return a.usedPercentage === b.usedPercentage && a.resetsAt === b.resetsAt;
}

/**
 * The reading with any window whose reset time has already passed dropped.
 *
 * `resetsAt` is epoch SECONDS. Once it passes, the window has rolled over and the
 * percentage we hold describes a quota that no longer exists - so it goes, rather than
 * sitting in the topbar as "85% used" next to a countdown that has collapsed to "now".
 * Absent renders as no meter at all, which is the same way this feature already treats
 * an API-key user: not told and no longer true are both better said than guessed at.
 */
export function unexpiredRateLimits(rl: RateLimits | null, now: number): RateLimits | null {
  if (!rl) return null;
  const live = (w: RateLimitWindow | null): RateLimitWindow | null =>
    w && w.resetsAt * 1000 > now ? w : null;
  const fiveHour = live(rl.fiveHour);
  const sevenDay = live(rl.sevenDay);
  if (!fiveHour && !sevenDay) return null;
  if (fiveHour === rl.fiveHour && sevenDay === rl.sevenDay) return rl;
  return { ...rl, fiveHour, sevenDay };
}

/** How one `Session` field decides whether a change is worth an emit. */
type FieldEqual<K extends keyof Session> = (a: Session[K], b: Session[K]) => boolean;

/**
 * A comparator for EVERY field of `Session`, with no gaps allowed: the mapped type
 * makes a missing key and a stray key both compile errors, so growing `Session`
 * breaks the build until the new field says how it participates here.
 *
 * That enforcement is the whole point, because the failure it replaces is silent.
 * Sessions reach the dashboard only when `sessionEqual` returns false, so a field
 * added to `Session` and forgotten here renders once from the initial snapshot and
 * then never updates again - no error, no failing test, just a card that quietly
 * goes stale while the daemon holds the fresh value. See `orphanedQueue` below for
 * an instance that actually shipped.
 */
type SessionFieldComparators = { [K in keyof Session]-?: FieldEqual<K> };

/** Scalar identity - the default for a field the card renders directly. */
const byValue = <T>(a: T, b: T): boolean => a === b;

/** Structural compare, for a nested object the card renders as a unit. */
const byJson = <T>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Never triggers an emit on its own. Only valid with a reason at the use site -
 * "I did not think about this one" is exactly what the record exists to prevent.
 */
const alwaysEqual = (): boolean => true;

/**
 * The identity fields (`id`, `agent`, `tty`, `startedAt`, `firstSeen`) are grouped
 * into a deliberate block up top since they share one reason; everything after
 * follows `Session`'s own field order, so the two can be diffed by eye.
 */
export const SESSION_FIELD_COMPARATORS: SessionFieldComparators = {
  // Invariant for the life of a map entry, not state: terminal sessions use one
  // `proc:<tty>:<pid>:<startMs>` identity and SDK sessions one `sdk:<uuid>` registration;
  // both call sites compare a session against its prior value under that same key. These
  // fields cannot differ without creating a new entry, so comparing them would only cost work.
  id: alwaysEqual,
  agent: alwaysEqual,
  tty: alwaysEqual,
  startedAt: alwaysEqual,
  // Set once, on first sight (`prev?.firstSeen ?? now`), and never rewritten.
  firstSeen: alwaysEqual,

  // Fixed for the life of an entry, like the identity block above - but compared anyway
  // rather than declared `alwaysEqual`, because it decides which affordances a card draws
  // and the cost of the compare is one string. `alwaysEqual` is for fields whose comparison
  // could only ever waste work; this one would be a silent lie if the invariant ever
  // loosened.
  runtime: byValue,
  // Scalar, and it moves: an invite, a withdrawal, or a rotation-carried row landing
  // resolves to a new value with often nothing else on the session changing - left out,
  // the phase 3 rail control would swap only when something unrelated shook the card.
  foremanInvite: byValue,
  name: byValue,
  nameSource: byValue,
  state: byValue,
  cwd: byValue,
  gitBranch: byValue,
  gitRoot: byValue,
  repoRoot: byValue,
  pid: byValue,
  permissionMode: byValue,
  terminals: terminalsEqual,
  agentSessionId: byValue,
  transcriptPath: byValue,
  instrumented: byValue,
  stateConfirmed: byValue,
  hooksSeen: byValue,
  activity: byValue,
  // Excluded so a still-alive session doesn't spam the UI every poll: `lastSeen`
  // moves on every sweep and `lastActivity` on every hook, both by definition. The
  // stall detector consumes `lastActivity` server-side for this exact reason - see
  // the note in `shared/stall.ts`. `applyHook` re-checks `lastActivity` itself at
  // its call site when it needs the timestamp to force an emit.
  lastSeen: alwaysEqual,
  lastActivity: alwaysEqual,
  // Small durable projection. A generation or active edge can be the only change on an
  // SDK session whose next accepted turn suppresses the transient idle state.
  workCycle: byJson,
  pendingReviews: byValue,
  task: byJson,
  prUrl: byValue,
  prNumber: byValue,
  prState: byValue,
  // Only the *visible* fields of SessionMeta, so re-reading an identical model /
  // context% doesn't re-render the meter. See `metaDisplayEqual`.
  meta: metaDisplayEqual,
  effortBaselineReady: byValue,
  // A nested object the chip renders as a unit, so structural. Not `alwaysEqual` despite
  // being written only by the ingest: a session that binds its agent session id LATE
  // rotates its note key, and `mergeDiscovered` / `applyHook` / `applyStatusLine` each
  // re-resolve the figure on that rotation - picking up a whole backlog of usage with no
  // other field moving. Left out, the badge would appear only on the next unrelated
  // change. (`syncSessionsForCost` emits directly for the key it touched, so the ingest
  // itself does not depend on this.)
  cost: byJson,
  note: byJson,
  goal: byJson,
  // The other denormalized fields `mergeDiscovered` resolves next to `note`.
  // Omitting them made a sweep's recomputation invisible: `orphanedQueue` in
  // particular depends on OTHER sessions (a queue is orphaned only once its own
  // session is evicted), so the session whose hint changes need not have changed
  // in any way of its own - an idle sibling is equal by every other field, stays
  // quiet, and never surfaces the stranded batch.
  queue: byJson,
  pendingTurns: byJson,
  orphanedQueue: byJson,
  prChecks: byValue,
  // byJson: a small object the chip renders as a unit - counts, mode and a timestamp
  // that all change together at the end of a review round.
  inspector: byJson,
  // byJson over an OPTIONAL field, which `byValue` could not do: absent and present-with-one
  // -reason are different offers, and two present summaries differ by the contents of an
  // array. Included rather than excluded because this field is the offer's whole condition -
  // the tick that flips it is a tick where, on a finished session, nothing else moves at all,
  // so leaving it out would withhold the prompt until something unrelated shook the card.
  retro: byJson,
  // byJson over a small nested object the badge renders as a unit, and the one field here
  // whose comparison matters most while it is NULL: on a fleet with no pipeline provider
  // enabled every session carries null and this is one `undefined === undefined` per
  // session per sweep. When it is set, its `step` moves on its own - an engine-driven
  // session walking from `build` to `test_suite` changes nothing else about the card - so
  // leaving it out would freeze the chip at whichever step happened to be running when
  // something unrelated last shook the session.
  pipeline: byJson,
  // Load-bearing: a dialog opening is a tick where almost nothing ELSE changes.
  // `permissionMode` is sticky and so doesn't flip when the menu covers the
  // footer, and a session parked on a question is by definition not doing
  // anything to move the other fields - so leaving this out doesn't merely delay
  // the buttons, it withholds them until some unrelated change happens to shake
  // the card loose. That reads as a flaky parser rather than a missing compare.
  paneDialog: byJson,
};

/**
 * Whether two projections of one pipeline run would draw the same thing, or move a session.
 *
 * `updatedAt` is deliberately excluded: it is the projection's own clock rather than a
 * fact about the run, and every re-derivation moves it, so including it would make this
 * comparison always false and the suppression it exists for a no-op.
 *
 * Everything else is compared structurally, in one `JSON.stringify` over a record whose
 * keys are written out. Written out rather than spread-and-delete so that a field added
 * to `PipelineRun` has to be considered here - a new field silently omitted would be one
 * the browser never sees move.
 *
 * **`worktree` is in here and is not drawn anywhere.** It is the one field whose comparison
 * is about CORRELATION rather than about pixels: `upsertPipelineRun` returns early when this
 * says nothing moved, and that early return is all that stands between an engine re-cutting a
 * feature's worktree and `syncSessionsForPipelineRun` following it. Drop it as dead weight -
 * which is what "would draw the same thing" alone invites, since no surface renders a
 * worktree path - and the symptom appears nowhere near here: the agent left in the old path
 * keeps a chip and a suppressed composer for a directory the run no longer owns, and the
 * agent in the new one goes on looking like an ordinary session anybody may interrupt, both
 * until some unrelated change happens to shake the run loose. `pipeline-correlation.test.ts`
 * pins that update and this comparison separately, so removing the field fails a test that
 * names the reason rather than one about a rail.
 */
export function pipelineRunDisplayEqual(a: PipelineRun, b: PipelineRun): boolean {
  const display = (run: PipelineRun): string =>
    JSON.stringify([
      run.provider,
      run.repoRoot,
      run.slug,
      run.worktree,
      run.tier,
      run.track,
      run.steps,
      run.lastStep,
      run.halt,
      run.group,
      run.prUrl,
      run.costTokens,
    ]);
  return display(a) === display(b);
}

/**
 * Compare the fields that decide whether the UI would look different. Only real
 * changes emit; see `SESSION_FIELD_COMPARATORS` for what each field contributes
 * and why the excluded ones are excluded.
 */
export function sessionEqual(a: Session, b: Session): boolean {
  for (const key of Object.keys(SESSION_FIELD_COMPARATORS) as (keyof Session)[]) {
    // The record's type pins each comparator to its own field; that per-key
    // correlation just isn't expressible while iterating a union of keys.
    const equal = SESSION_FIELD_COMPARATORS[key] as (a: unknown, b: unknown) => boolean;
    if (!equal(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Compare two handle lists by what a card actually reads off them.
 *
 * Field-by-field rather than `byJson`, and the reason is the loop it runs in: this is the
 * 1500ms discovery sweep, every session, every tick, and the two per-vendor comparators it
 * replaces were each a single `===`. Stringifying a two-element array of six-key objects to
 * answer a question three string compares answer is the kind of cost that only shows up on
 * the machine with forty sessions open.
 *
 * WHICH fields is the same judgement those two made - would the UI look different? - and
 * the answer grew by two, both of which the old pair missed. `paneId` reaches the subtitle
 * (`tmux · %3`) and the multiplexer session name reaches Kill's confirm tooltip, so a pane
 * or session that moved under a card whose every other field held still would have gone on
 * displaying the old one until something unrelated shook it loose. The geometry that churns
 * without ever being rendered - `windowIndex`, `windowId` - stays out.
 */
function terminalsEqual(a: readonly TerminalHandle[], b: readonly TerminalHandle[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (!y || x.kind !== y.kind || x.backend !== y.backend || x.paneId !== y.paneId) return false;
    if (x.kind === "multiplexer") {
      const o = y as MuxHandle;
      return x.session === o.session && x.sessionName === o.sessionName && x.windowName === o.windowName;
    }
    const o = y as EmulatorHandle;
    return x.tabTitle === o.tabTitle && x.isActive === o.isActive;
  });
}

/**
 * Compare only the *visible* fields of two SessionMeta - the model, thinking
 * level, and rounded context% (plus the 1M marker). `updatedAt`, `source`, and
 * the raw token counts are deliberately excluded so refreshing a still-identical
 * reading (a statusLine ping, a poll tick) doesn't spam the UI; the meter only
 * re-renders when a displayed value actually moves.
 */
function metaDisplayEqual(a: SessionMeta | null, b: SessionMeta | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.model === b.model &&
    a.modelId === b.modelId &&
    a.longContext === b.longContext &&
    a.thinkingLevel === b.thinkingLevel &&
    a.thinkingEnabled === b.thinkingEnabled &&
    a.contextPct === b.contextPct
  );
}

/** Build a SessionMeta from a transcript/rollout read (friendly name applied). */
function metaFromRead(read: RuntimeMetaRead, source: MetaSource, now: number): SessionMeta {
  return {
    model: modelLabel(read.modelId),
    modelId: read.modelId,
    longContext: read.longContext,
    thinkingLevel: read.thinkingLevel,
    thinkingEnabled: null,
    contextPct: read.contextPct,
    contextTokens: read.contextTokens,
    contextWindow: read.contextWindow,
    source,
    updatedAt: now,
  };
}

/** Build a SessionMeta from a normalized Claude statusLine payload. */
function metaFromStatusLine(ingest: StatusLineIngest, now: number): SessionMeta {
  const modelId = ingest.model?.id ?? null;
  const inferred = parseContextWindowSize(modelId);
  // Claude's own `contextWindowSize` is authoritative; when it's absent we fall
  // back to the id-inferred size, floored up by observed tokens so a marker-less
  // 1M session isn't mistaken for the 200k default (same correction as the
  // transcript path).
  const usedPct = ingest.contextWindow?.usedPercentage;
  const tokens = ingest.contextWindow?.tokens ?? null;
  const window =
    ingest.contextWindow?.contextWindowSize ?? effectiveContextWindow(inferred.size, tokens);
  let contextPct: number | null = null;
  if (typeof usedPct === "number") contextPct = Math.round(Math.max(0, Math.min(100, usedPct)));
  else if (tokens !== null && window > 0) contextPct = Math.round(Math.min(100, (tokens / window) * 100));
  return {
    model: modelLabel(modelId) ?? ingest.model?.displayName ?? null,
    modelId,
    // `window` is Claude's authoritative size when given, else the floored inference -
    // so it governs the 1M badge directly (an explicit 200k must not be overridden).
    longContext: isLongContext(window),
    thinkingLevel: ingest.effort ?? null,
    thinkingEnabled: ingest.thinkingEnabled ?? null,
    contextPct,
    contextTokens: contextPct !== null ? tokens : null,
    contextWindow: contextPct !== null ? window : null,
    source: "statusline",
    updatedAt: now,
  };
}

/** Parse the numeric id out of a GitHub PR URL, or null when absent. */
export function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}
