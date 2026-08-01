import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PERMISSION_MODES } from "@shared/types.ts";
import type {
  AgentType,
  ForemanEpisode,
  MetaSource,
  NmFixSummary,
  NmRunSummary,
  FleetCost,
  OrphanedQueueHint,
  PaneDialog,
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
  WorkItemState,
  InspectorInspection,
  InspectorSummary,
  InspectionUpdated,
  SettingsStatus,
} from "@shared/types.ts";
import type { EnsembleSummary, TaskEnsembleLink } from "@shared/ensemble.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
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
import { goalLine } from "@shared/goal.ts";
import { capabilitiesFor, workQueueBlockedReason } from "@shared/harness-capabilities.ts";
import { canWriteTo, muxHandle, paneToken, terminalHomeNames, terminalResourceId, terminalResourceIds, tmuxPaneToken, weztermPaneToken } from "@shared/pane.ts";
import type { EmulatorHandle, MuxHandle, TerminalHandle } from "@shared/terminal.ts";
import type { PersonaView, WorkflowRunSummary, WorkflowSummary } from "@shared/workflow.ts";
import {
  effectiveContextWindow,
  isLongContext,
  modelLabel,
  parseContextWindowSize,
} from "@shared/model.ts";
import type { DiscoveredSession } from "./discovery/correlate.ts";
import type { RuntimeMetaRead, SdkEvent, SessionActivityRead } from "./harness/types.ts";
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
import { clampPrompt } from "./util/prompt-text.ts";
import {
  clearQueue as clearQueueDb,
  deleteQueueItem,
  deleteTask as dbDeleteTask,
  getQueueItem,
  getQueueRow,
  getSessionGoal,
  getSessionNote,
  listQueueItems,
  listQueueRows,
  loadActiveTasks,
  loadResourceHoldingTerminalTasks,
  loadPrPendingTerminalTasks,
  loadPendingReviews,
  loadRecentTerminalTasks,
  loadSessionGoals,
  pruneSessionGoals,
  loadSessionNotes,
  hooksEverSeen,
  lastAgentBinding,
  logEvent,
  recordAgentBinding,
  rekeyQueue,
  listQueueRowsForCwd,
  countOpenQueueItems,
  pruneDeadQueues,
  pruneGateReplies,
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
  reorderQueueItems,
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
import type { SessionWorkEpisode, TaskWorkEpisodeBinding, UsageCol } from "./db.ts";
import { unref } from "./util/timers.ts";
import { getInspectorConfig } from "./inspector/config.ts";
import { parsePrUrl } from "./inspector/github.ts";

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
  pid?: number;
  permissionMode?: PermissionMode | null;
  gitBranch?: string | null;
  gitRoot?: string | null;
  repoRoot?: string | null;
  nomistakesGated?: boolean;
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
 * How long a no-mistakes gate reply is kept before it's pruned.
 *
 * Much longer than the queue window, because the thing it dates is much longer
 * lived: the fix log reads `origin..HEAD`, so a byline stays useful for as long
 * as the BRANCH does, and a branch outlives the session that opened it by weeks.
 * The cost of being generous is a row per gate verdict; the cost of being tight
 * is a fix log that says "replied" and can't say by whom on the exact branch a
 * human finally sat down to review. See `pruneGateReplies` for why this is aged
 * rather than scoped to a session.
 */
const GATE_REPLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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
 * Caps on remembered no-mistakes dismissals (see `nmDismissed`): how many
 * checkouts we keep at all, and how many retired runs per checkout. Only a reset
 * ever adds one, so these sit far above any real session's worth of resets; they
 * exist so the map can't grow with a long-lived daemon's uptime.
 */
const NM_DISMISSED_CHECKOUTS = 200;
const NM_DISMISSED_RUNS_PER_CHECKOUT = 8;

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
  private reviews = new Map<string, ReviewItem>();
  private tasks = new Map<string, Task>();
  /** Reusable workflow Personas, including archived rows for durable history links. */
  private personas = new Map<string, PersonaView>();
  /** Bounded catalog projections only; full drafts and guidance stay on HTTP. */
  private workflowSummaries = new Map<string, WorkflowSummary>();
  /** Compact execution projections only. Graphs, evidence, and timelines stay on HTTP. */
  private workflowRuns = new Map<string, WorkflowRunSummary>();
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
   * How a task finds out it is an ensemble member.
   *
   * Registered by the daemon rather than imported, so nothing in here has to know what an
   * ensemble store is - the same seam `registerWorkflowReset` uses. Null until the manager
   * is constructed, which is also every build and test that has no ensembles at all.
   */
  private ensembleProjection: ((taskId: string) => TaskEnsembleLink | null) | null = null;
  private workflowReset: ((noteKey: string) => void) | null = null;
  /** A terminal side effect must not cross the asynchronous reset boundary. */
  private resettingSessionIds = new Set<string>();
  /** Foreman notes keyed by note key (agentSessionId ?? synthetic id). */
  private notes = new Map<string, SessionNote>();
  /** Session goals, keyed by the SAME note key - a sibling record, not part of the note. */
  private goals = new Map<string, SessionGoal>();
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
  /**
   * No-mistakes launcher bindings: sessionId -> worktree cwd -> {branch, seen}.
   * Records which worktree(s) a session is driving a run in, so a run dispatched
   * off `main` is attributed to its launcher and not to idle same-checkout
   * siblings. Refreshed by discovery, remembered across a parked gate (when the
   * driver process is momentarily gone), and dropped by TTL or on session exit.
   */
  private nmBindings = new Map<string, Map<string, { branch: string | null; updatedAt: number }>>();
  /**
   * Runs retired from a checkout: `checkoutKey` (worktree root + branch) -> run
   * ids. A reset moves the branch pointer but not the branch *name*, and `axi
   * status` goes on reporting a finished run for that branch indefinitely - so
   * clearing the decoration alone doesn't hold, the next poll just re-attaches
   * it. Remembering the run is what makes the clear stick.
   *
   * Keyed on the *checkout*, because that is what a reset acts on: `reset --hard`
   * wipes one worktree, so the run stops describing anything real for whoever
   * stands in that worktree on that branch - a property of the checkout, not of
   * the session that happened to click the button. Keying on the session id
   * instead would drop the dismissal on the next agent restart (a new pid mints a
   * new synthetic id), and the strip would come back on a card the user already
   * cleared. Keyed on run id within the checkout, so a *new* run on the same
   * branch still decorates the card.
   *
   * Bounded by eviction rather than reaped on the run disappearing from `axi
   * status`: the active-run set only covers worktrees we polled, and those come
   * from live sessions (`nomistakesPollCwds`), so "the run is gone" and "nobody
   * asked about it this tick" are indistinguishable - reaping on absence would be
   * session-presence reaping in disguise, reopening the very bug. Entries are
   * tiny and only a reset creates one, so the caps are far above real use.
   */
  private nmDismissed = new Map<string, Set<string>>();
  /** Whether a discovery sweep has ever completed - see `sessionsObserved`. */
  private sweptSessions = false;
  /** The Inspector's ledger, by PR key. Rebuilt from the DB; see `refreshInspections`. */
  private inspections = new Map<string, InspectorInspection>();
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

  constructor() {
    super();
    for (const r of loadPendingReviews()) this.reviews.set(r.id, r);
    for (const n of loadSessionNotes()) this.notes.set(n.noteKey, n);
    for (const g of loadSessionGoals()) this.goals.set(g.noteKey, g);
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
    workflowSummaries: WorkflowSummary[];
    workflowRunSummaries: WorkflowRunSummary[];
    ensembleSummaries: EnsembleSummary[];
    schedules: MissionSchedule[];
    fleetCost: FleetCost | null;
    settingsStatus: SettingsStatus;
  } {
    return {
      sessions: [...this.sessions.values()],
      reviews: [...this.reviews.values()],
      tasks: [...this.tasks.values()],
      personas: [...this.personas.values()],
      workflowSummaries: [...this.workflowSummaries.values()],
      workflowRunSummaries: [...this.workflowRuns.values()],
      ensembleSummaries: [...this.ensembles.values()],
      schedules: [...this.schedules.values()],
      // Computed on demand rather than served from `lastFleetCost`, which is null until
      // the first ingest: a dashboard opened before any export would otherwise show a
      // blank strip over a ledger that already holds a week of estimated usage.
      fleetCost: this.fleetCostNow(),
      // Composed fresh for the same reason: the rail dots and gear must be right on the
      // first render, not blank until the next config write happens to change something.
      settingsStatus: settingsStatus(),
    };
  }

  /**
   * Emit the settings status tuple, dropping a frame that restates the last one.
   *
   * The suppression mirrors `recomputeFleetCost`: `publishSettingsStatus` recomposes on
   * every config write and after every sweep, so without this an operator toggling one
   * source's interval would push an identical tuple to every open dashboard. The compare
   * is a shallow field walk - the shape is three small scalars, so `byJson` would be the
   * same answer at more cost.
   */
  emitSettingsStatus(status: SettingsStatus): void {
    const prev = this.lastSettingsStatus;
    const same =
      prev != null &&
      prev.inspector.enabled === status.inspector.enabled &&
      prev.inspector.mode === status.inspector.mode &&
      prev.shipping.autoMerge === status.shipping.autoMerge &&
      prev.taskSources.failing === status.taskSources.failing;
    this.lastSettingsStatus = status;
    if (same) return;
    this.emitEvent({ type: "settings_status", status });
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  beginSessionReset(id: string): void {
    this.resettingSessionIds.add(id);
  }

  endSessionReset(id: string): void {
    this.resettingSessionIds.delete(id);
  }

  sessionResetInProgress(id: string): boolean {
    return this.resettingSessionIds.has(id);
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

  private emitEvent(e: ServerEvent): void {
    this.emit("event", e);
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
      this.recordNmLaunches(d, now);
      if (!prev || !sessionEqual(prev, next)) this.emitSession(next);
    }
    this.pruneNmBindings(now);

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
    // Its own try: a gate-reply prune that threw must not stop the queue prune above
    // (or vice versa), since they share only this timer and nothing else.
    try {
      pruneGateReplies(now - GATE_REPLY_RETENTION_MS);
    } catch (err) {
      console.error("[registry] gate reply prune failed:", err);
    }
    // And its own again, for the same reason.
    try {
      pruneEpisodes(now - EPISODE_RETENTION_MS);
    } catch (err) {
      console.error("[registry] foreman episode prune failed:", err);
    }
    // Fourth, and independently caught like the three above: these are the rows an estimate
    // is summed from, so a throw here must not be able to take the sweep - or the
    // other three prunes - down with it.
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
      name: d.name,
      nameSource: d.nameSource,
      state: "working",
      cwd: d.cwd,
      gitBranch: d.gitBranch,
      gitRoot: d.gitRoot,
      repoRoot: d.repoRoot,
      nomistakesGated: d.nomistakesGated,
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
      pendingReviews: this.countPending(d.syntheticId),
      nomistakes: prev?.nomistakes ?? null,
      nomistakesFixes: prev?.nomistakesFixes ?? [],
      task: this.taskSummaryFor(d.syntheticId, d.cwd),
      nomistakesNarration: prev?.nomistakesNarration ?? null,
      // Carried forward like the PR fields for the same reason: discovery cannot see it.
      // Re-resolved from the ledger just below, once cwd/prUrl are settled.
      inspector: prev?.inspector ?? null,
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
    // The overlay may have just supplied a binding nothing has persisted yet, and
    // that is the ORDINARY case at launch, not an edge: a hook whose session hasn't
    // been discovered yet has no live session to apply to, so it only ever reaches
    // a Session here. Left to `applyHook` alone the binding would then never be
    // written at all - its live-session branch writes on CHANGE, and by the time it
    // runs the overlay has already put the same id on the card.
    this.rememberAgentSession(base, known);
    // Resolve the note + queue only after the overlay may have supplied
    // agentSessionId, so their key (which prefers agentSessionId) is stable.
    base.note = this.noteSummaryFor(base);
    base.goal = this.goalSummaryFor(base);
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
    base.inspector = this.inspectorSummaryFor(base);
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
      name: input.name,
      // Nothing holds a pane to name this session, so the supervisor that launched it said
      // what it is called - which is what this `NameSource` value records.
      nameSource: "sdk",
      // Fresh launches learn this from `bound`; restored sessions carry the durable identity
      // immediately so note-keyed state never observes a synthetic-id interlude.
      state: "starting",
      cwd: input.cwd,
      gitBranch: input.gitBranch ?? null,
      gitRoot: input.gitRoot ?? null,
      repoRoot: input.repoRoot ?? null,
      nomistakesGated: input.nomistakesGated ?? false,
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
      pendingReviews: this.countPending(input.id),
      nomistakes: null,
      nomistakesFixes: [],
      task: null,
      nomistakesNarration: null,
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
      orphanedQueue: null,
      inspector: null,
      paneDialog: null,
    };
    s.task = this.taskSummaryFor(s.id, s.cwd);
    s.note = this.noteSummaryFor(s);
    s.goal = this.goalSummaryFor(s);
    s.cost = sessionCostFor(noteKeyFor(s));
    s.queue = this.queueSummaryFor(s);
    s.inspector = this.inspectorSummaryFor(s);
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
        this.applyDriverState(s, evt.state, evt.activity, now);
        return;
      case "turn_done":
        // The turn ended, so the session is idle - the same fact a `Stop` hook carries -
        // unless the supervisor still holds an accepted queued turn. The event still comes
        // through in that case so every non-idle projection stays observable; only the
        // transient idle transition is withheld.
        // `usage` is deliberately NOT applied: the usage ledger has one writer per harness
        // (OTel for Claude, the rollout reader for Codex) and both still see an SDK
        // session's own files, so spending this figure here would double-count. It stays on
        // the event as display enrichment for the phase that verifies that (see the plan's
        // Automation parity section).
        if (!options.deferIdle) this.applyDriverState(s, "idle", null, now);
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
        if (evt.url) this.applyDriverPrCreated(s, evt.url);
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
    next.note = this.noteSummaryFor(next);
    next.goal = this.goalSummaryFor(next);
    if (noteKeyFor(next) !== noteKeyFor(s)) next.cost = sessionCostFor(noteKeyFor(next));
    next.queue = this.queueSummaryFor(next);
    next.orphanedQueue = this.orphanedQueueFor(next);
    next.inspector = this.inspectorSummaryFor(next);
    this.sessions.set(next.id, next);
    logEvent(next.id, now, "SdkBound", { agentSessionId });
    this.emitSession(next);
  }

  private applyDriverState(
    s: Session,
    state: "working" | "idle",
    activity: string | null,
    now: number,
  ): void {
    const next: Session = {
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
   */
  private applyDriverPrCreated(s: Session, url: string): void {
    const next: Session = {
      ...s,
      prUrl: url,
      prNumber: prNumberFromUrl(url),
      prState: "open",
      // Unknown at creation, and cleared so a session cannot carry a previous PR's rollup.
      prChecks: null,
    };
    next.inspector = this.inspectorSummaryFor(next);
    this.sessions.set(next.id, next);
    if (!sessionEqual(s, next)) this.emitSession(next);
    this.announcePrOpened(next, url);
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
      const next: Session = {
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
      };
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
      next.note = this.noteSummaryFor(next);
      next.goal = this.goalSummaryFor(next);
      // On a key ROTATION only, exactly as `applyRuntimeMeta` and `mergeDiscovered`
      // decide it. The ledger is not the only writer of this field - `applyPassiveUsage`
      // puts an unpriced token count straight onto the session for a harness that reports
      // no cost - so re-reading it on every event answers null for those and blanks the
      // chip until the next poll tick restores it, several times a turn. Nothing but a
      // rotation can move the figure here anyway: the ledger's own writer re-denormalizes
      // through `syncSessionsForCost`.
      if (noteKeyFor(next) !== noteKeyFor(target)) next.cost = sessionCostFor(noteKeyFor(next));
      next.queue = this.queueSummaryFor(next);
      next.orphanedQueue = this.orphanedQueueFor(next);
      // A hook is how a PR url first reaches a card, and the summary is keyed on it -
      // so resolving here is what makes the chip appear on the same event that
      // produced the PR, rather than up to a poll tick later.
      next.inspector = this.inspectorSummaryFor(next);
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
      if (evt.prCreated && evt.prUrl) this.announcePrOpened(next, evt.prUrl);
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
    };
    if (this.clearEffortTrackingOnRebind(s, next) && next.meta) {
      next.meta = { ...next.meta, thinkingLevel: null };
    }
    next.note = this.noteSummaryFor(next);
    next.goal = this.goalSummaryFor(next);
    next.cost = sessionCostFor(noteKeyFor(next));
    next.queue = this.queueSummaryFor(next);
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

  /** Refresh a session's launcher bindings from this discovery sweep (never clears). */
  private recordNmLaunches(d: DiscoveredSession, now: number): void {
    if (!d.nomistakesRuns || d.nomistakesRuns.length === 0) return;
    let map = this.nmBindings.get(d.syntheticId);
    if (!map) this.nmBindings.set(d.syntheticId, (map = new Map()));
    for (const { cwd, branch } of d.nomistakesRuns) map.set(cwd, { branch, updatedAt: now });
  }

  /** Drop launcher bindings that haven't been re-seen within the TTL. */
  private pruneNmBindings(now: number): void {
    for (const [id, map] of this.nmBindings) {
      for (const [cwd, b] of map) if (now - b.updatedAt > OVERLAY_TTL_MS) map.delete(cwd);
      if (map.size === 0) this.nmBindings.delete(id);
    }
  }

  /**
   * Worktree dirs to poll `no-mistakes axi status` from. `axi status` is
   * branch-scoped when run from a worktree checked out on a run's branch, so we
   * poll each gated session's own checkout (a session literally on a run branch)
   * plus every remembered launcher worktree (where a run dispatched off `main`
   * actually lives). Distinct, so one worktree is polled once.
   */
  nomistakesPollCwds(): string[] {
    const set = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.nomistakesGated && s.cwd && s.state !== "exited") set.add(s.cwd);
    }
    for (const map of this.nmBindings.values()) for (const cwd of map.keys()) set.add(cwd);
    return [...set];
  }

  /**
   * Gated sessions that can carry a fix log, with their checkout. Unlike
   * `nomistakesPollCwds` this is per-session, not a deduped cwd set: the log is
   * denormalized onto each card, and two sessions sharing a checkout each get it.
   * Not conditional on an active run - the log outliving the run is the point.
   */
  nomistakesFixTargets(): Array<{ id: string; cwd: string }> {
    const out: Array<{ id: string; cwd: string }> = [];
    for (const [id, s] of this.sessions) {
      if (s.nomistakesGated && s.cwd && s.state !== "exited") out.push({ id, cwd: s.cwd });
    }
    return out;
  }

  /** Set a session's fix log. No-op when unchanged, so it doesn't churn the stream. */
  applyNomistakesFixes(sessionId: string, fixes: NmFixSummary[]): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (JSON.stringify(s.nomistakesFixes) === JSON.stringify(fixes)) return;
    const next: Session = { ...s, nomistakesFixes: fixes };
    this.sessions.set(sessionId, next);
    this.emitSession(next);
  }

  /**
   * Drop the session's fix log. Called on reset, which discards the very commits
   * the log is derived from - so unlike `dismissNomistakes` there's no dismissal
   * to remember: the next poll re-reads git and agrees the log is empty. This
   * just makes the card clean the moment the reset returns instead of a poll later.
   */
  clearNomistakesFixes(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.nomistakesFixes.length === 0) return;
    const next: Session = { ...s, nomistakesFixes: [] };
    this.sessions.set(sessionId, next);
    this.emitSession(next);
  }

  /**
   * Set each session's no-mistakes run from the full set of active runs (keyed by
   * branch). A session owns a run when it is literally checked out on the run's
   * branch (exact worktree owner), or when it launched that run in a worktree it
   * drives (remembered binding on the run's branch). Sessions that merely share a
   * checkout with a launcher get nothing - a run never leaks onto idle siblings.
   *
   * The full run set is applied in one pass so two concurrent runs don't clobber
   * each other (each launcher keeps its own run rather than fighting over one).
   */
  reconcileNomistakes(runs: NmRunSummary[]): void {
    const byBranch = new Map<string, NmRunSummary>();
    for (const r of runs) if (r.branch) byBranch.set(r.branch, r);

    for (const [id, s] of this.sessions) {
      const owned = this.ownedRun(id, s, byBranch);
      const narration = owned ? s.nomistakesNarration : null; // narration clears with its run
      if (
        JSON.stringify(s.nomistakes) === JSON.stringify(owned) &&
        s.nomistakesNarration === narration
      )
        continue;
      const next = { ...s, nomistakes: owned, nomistakesNarration: narration };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  /**
   * The active run this session owns: the one on its own branch (exact worktree
   * owner) or, failing that, one it drives in a worktree it launched (binding).
   *
   * A retired run is skipped *while* matching rather than nulled out afterwards,
   * so it never shadows a run the session still owns. A reset retires the run on
   * the session's own branch, but `axi status` keeps reporting it for that branch
   * for good - so once the session dispatches new work elsewhere, its own branch
   * still resolves to the dead run. Skipping it falls through to the binding, and
   * a run parked at a gate keeps the approve/fix/skip buttons that are the only
   * way to answer it; returning null there would blank the card instead.
   */
  private ownedRun(id: string, s: Session, byBranch: Map<string, NmRunSummary>): NmRunSummary | null {
    const key = checkoutKey(s.gitRoot, s.gitBranch);
    const retired = key ? this.nmDismissed.get(key) : undefined;
    const live = (branch: string | null): NmRunSummary | null => {
      const run = branch ? byBranch.get(branch) : undefined;
      return run && !retired?.has(run.id) ? run : null;
    };
    const own = live(s.gitBranch);
    if (own) return own;
    for (const { branch } of this.nmBindings.get(id)?.values() ?? []) {
      const bound = live(branch);
      if (bound) return bound;
    }
    return null;
  }

  /**
   * Retire `run` from the checkout a reset just wiped - `root`, standing on
   * `branch` - for good. A reset throws away the very work the run validated, so
   * the run - finished or not - no longer describes that checkout, and the strip
   * would otherwise sit there forever (see `nmDismissed`).
   *
   * Scoped to that one checkout: `reset --hard` only touches one worktree, so the
   * run is retired exactly for whoever stands in that worktree on the branch whose
   * work just went away - now or after a restart. That covers a sibling sharing
   * the checkout (its strip describes the same dead work), while a same-branch
   * twin in an independent worktree keeps its strip, its work being still on disk.
   *
   * A run on a *different* branch than the reset checkout lives in a different
   * worktree that the reset never touched (git won't check one branch out twice),
   * so it is never retired - keeping the approve/fix/skip buttons that are the
   * only way to answer a parked gate.
   *
   * The caller passes the run it saw before the reset, rather than us re-reading
   * it after: a fetch can take ~30s, and the poller may have swapped or cleared
   * the run in that window. We retire the run the user was actually looking at.
   */
  dismissNomistakes(run: NmRunSummary, root: string | null, branch: string | null): void {
    // No id means we can't name the run, and dismissing "" would gag every
    // id-less run on the card for good. Leave the strip rather than over-suppress.
    if (!run.id || branch !== run.branch) return;
    const key = checkoutKey(root, branch);
    if (!key) return;
    this.rememberDismissal(key, run.id);
    for (const [id, s] of this.sessions) {
      if (checkoutKey(s.gitRoot, s.gitBranch) !== key || s.nomistakes?.id !== run.id) continue;
      const next: Session = { ...s, nomistakes: null, nomistakesNarration: null };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  /** Record a retired run against its checkout, evicting the oldest past the caps. */
  private rememberDismissal(key: string, runId: string): void {
    const ids = this.nmDismissed.get(key) ?? new Set<string>();
    ids.add(runId);
    // Re-insert, so this checkout moves to the tail. A Map keeps first-insertion
    // order, so mutating the set in place would leave the checkout ranked by its
    // *oldest* dismissal and let eviction drop one reset seconds ago.
    this.nmDismissed.delete(key);
    this.nmDismissed.set(key, ids);
    // `axi status` reports the latest run for a branch, so once newer runs have
    // been retired on this checkout the older ids can no longer suppress anything.
    evictOldest(ids, NM_DISMISSED_RUNS_PER_CHECKOUT);
    evictOldest(this.nmDismissed, NM_DISMISSED_CHECKOUTS);
  }

  /**
   * Update the "what the skill is doing now" narration for a session, sourced
   * from its Claude transcript (see readCurrentTodo). Cleared to null when there
   * is no active run or nothing is in progress.
   */
  applyNomistakesNarration(sessionId: string, narration: string | null): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.nomistakesNarration === narration) return;
    const next: Session = { ...s, nomistakesNarration: narration };
    this.sessions.set(sessionId, next);
    this.emitSession(next);
  }

  /** Sessions currently showing a no-mistakes run (for narration polling). */
  nomistakesSessions(): Session[] {
    return [...this.sessions.values()].filter((s) => s.nomistakes !== null);
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
   * Driver-run sessions whose checkout has to be re-read, with the cwd to read it in.
   *
   * The counterpart to `applyDiscovery` for the one runtime that never passes through it.
   * A pane-backed session's Git facts are re-resolved from its cwd on every sweep, so it
   * follows the agent onto whatever branch it cuts and notices when no-mistakes gating is
   * added or removed. A driver-run session is registered once and never passes through that
   * sweep. Without this counterpart a pooled worktree can stay branchless for its whole
   * session, and an SDK-only no-mistakes run is never polled because its checkout remains
   * marked ungated. A terminal sibling can accidentally mask the latter by polling the
   * shared branch on the SDK session's behalf.
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
   * have changed and the launch-time answers stay authoritative. The branch and
   * `nomistakesGated` are mutable: agents cut branches, and no-mistakes can add its remote
   * after the session launches.
   */
  applyDriverGit(
    snapshots: Map<string, { branch: string | null; nomistakesGated: boolean }>,
  ): void {
    for (const [id, snapshot] of snapshots) {
      const s = this.sessions.get(id);
      if (!s || s.runtime !== "sdk" || s.state === "exited") continue;
      if (
        s.gitBranch === snapshot.branch &&
        s.nomistakesGated === snapshot.nomistakesGated
      )
        continue;
      const next: Session = {
        ...s,
        gitBranch: snapshot.branch,
        nomistakesGated: snapshot.nomistakesGated,
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
      if (s.prUrl === url && s.prNumber === number && s.prState === state && s.prChecks === checks)
        continue;
      const next: Session = { ...s, prUrl: url, prNumber: number, prState: state, prChecks: checks };
      // `prUrl` is the key the Inspector summary hangs off, so changing it here without
      // re-resolving leaves the chip answering for the PREVIOUS pull request - or, on the
      // ordinary startup ordering (this poller runs seconds after the first sweep, which
      // saw no PR yet), leaves an adopted PR with no chip at all until something unrelated
      // happens to rebuild the session. Same reason `applyHook` re-resolves.
      next.inspector = this.inspectorSummaryFor(next);
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
    this.cleanupDependencyProvenance();
    // Announced after the cleanup above, so the listener that reads this record reads it
    // settled. See `onPrMergesRecorded`.
    if (targets.size > 0) this.emit("pr_merges_recorded");
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
    if (key !== noteKeyFor(s)) next.cost = sessionCostFor(key);
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
   */
  applyOtelMetrics(body: OtlpMetrics): void {
    const touched = new Set<string>();
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
    if (touched.size === 0) return;
    for (const key of touched) this.syncSessionsForCost(key);
    this.recomputeFleetCost();
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
  }

  private remove(id: string): void {
    this.exitTimers.delete(id);
    this.prObservations.delete(id);
    this.announcedPrs.delete(id);
    this.nmBindings.delete(id);
    this.discoveredIdentity.delete(id);
    this.clearSessionEffortTracking(id);
    this.permissionModeFreshnessGuards.delete(id);
    this.statusLineTimestamps.delete(id);
    this.driverDialogs.delete(id);
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
          kind: t.kind,
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

  private syncSessionsForWorktree(cwd: string | null): void {
    if (!cwd) return;
    for (const id of this.sessions.keys()) {
      if (this.sessions.get(id)?.cwd === cwd) this.resyncSessionTask(id);
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
   * Writes BOTH the stored prompt (the refiner's input) and Tier 1's provisional goal: the
   * human's own words, shortened to a line. Rough, but instant, free, and true - and it means
   * a card is never blank while waiting on a model. `source: "heuristic"` is also the
   * refiner's queue: it says "this prompt has not been summarised yet", so re-stamping it on
   * every new prompt is what makes the goal refresh at all.
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
    this.upsertGoal(
      s.id,
      { prompt: clampPrompt(prompt), text: goalLine(prompt), source: "heuristic" },
      now,
    );
  }

  /** The compact goal view denormalized onto a session card. */
  private goalSummaryFor(s: Session): SessionGoalSummary | null {
    const g = this.goals.get(noteKeyFor(s));
    // A row exists as soon as a prompt is captured, which is BEFORE any sentence is derived
    // from it. Reporting that as a goal would put an empty line on the card, so a goal with
    // no text is reported as no goal.
    if (!g || !g.text) return null;
    return { text: g.text, source: g.source, updatedAt: g.updatedAt };
  }

  /** A session's full goal record, including the refiner's stored input. */
  getGoal(id: string): SessionGoal | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return this.goals.get(noteKeyFor(s)) ?? null;
  }

  /**
   * Patch a session's goal (create on first write), merging like `upsertNote` so capturing
   * a prompt never clears the sentence derived from an earlier one - and so a refinement
   * never drops the prompt it was derived from.
   *
   * `updatedAt` moves only when the SENTENCE changes. A re-derived identical goal is the
   * common case (most follow-up prompts refine what a session is doing rather than redefine
   * it), and letting those bump the stamp would make "when did this session last change
   * course" unanswerable. Capturing a prompt alone never moves it either: that is input,
   * not a change of goal.
   */
  upsertGoal(id: string, patch: SetGoal, now = Date.now()): SessionGoal | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const key = noteKeyFor(s);
    const prev = this.goals.get(key) ?? getSessionGoal(key);
    const text = patch.text !== undefined ? patch.text : prev?.text ?? null;
    const changed = text !== (prev?.text ?? null);
    const next: SessionGoal = {
      noteKey: key,
      text,
      source: patch.source !== undefined ? patch.source : prev?.source ?? null,
      prompt: patch.prompt !== undefined ? patch.prompt : prev?.prompt ?? null,
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

  // ---- Foreman work queues ----

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
    if (!s.prUrl) return null;
    const parsed = parsePrUrl(s.prUrl);
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
      const next = this.inspectorSummaryFor(s);
      if (JSON.stringify(next) === JSON.stringify(s.inspector)) continue;
      const updated: Session = { ...s, inspector: next };
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
    return this.getQueueByKey(noteKeyFor(s));
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
      updatedAt: now,
    });
    this.syncSessionsForQueue(key);
  }

  /** Re-read a queue after another daemon-owned transaction updated its guard columns. */
  refreshQueue(key: string): void {
    this.syncSessionsForQueue(key);
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

/**
 * Identity of a checkout: the worktree root plus the branch standing in it. Two
 * sessions share a key exactly when they share a working tree, which is the unit
 * `git reset --hard` acts on. Null when either half is unknown, so an
 * unreadable checkout never collides with another under a partial key. Encoded
 * rather than concatenated, so no root/branch pair can spell another's key.
 */
function checkoutKey(root: string | null, branch: string | null): string | null {
  return root && branch ? JSON.stringify([root, branch]) : null;
}

/** Drop oldest-inserted entries until `m` is within `cap`. */
function evictOldest(m: Pick<Map<string, unknown>, "size" | "keys" | "delete">, cap: number): void {
  while (m.size > cap) {
    const oldest = m.keys().next();
    if (oldest.done) return;
    m.delete(oldest.value);
  }
}

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
  name: byValue,
  nameSource: byValue,
  state: byValue,
  cwd: byValue,
  gitBranch: byValue,
  gitRoot: byValue,
  repoRoot: byValue,
  // Re-read from the checkout: no-mistakes can add or remove its remote while a session is
  // live, and both the gated chip and whether the status poller visits the cwd follow it.
  nomistakesGated: byValue,
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
  pendingReviews: byValue,
  nomistakes: byJson,
  nomistakesFixes: byJson,
  task: byJson,
  nomistakesNarration: byValue,
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
  orphanedQueue: byJson,
  prChecks: byValue,
  // byJson: a small object the chip renders as a unit - counts, mode and a timestamp
  // that all change together at the end of a review round.
  inspector: byJson,
  // Load-bearing: a dialog opening is a tick where almost nothing ELSE changes.
  // `permissionMode` is sticky and so doesn't flip when the menu covers the
  // footer, and a session parked on a question is by definition not doing
  // anything to move the other fields - so leaving this out doesn't merely delay
  // the buttons, it withholds them until some unrelated change happens to shake
  // the card loose. That reads as a flaky parser rather than a missing compare.
  paneDialog: byJson,
};

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
