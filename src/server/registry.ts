import { EventEmitter } from "node:events";
import type {
  MetaSource,
  NmRunSummary,
  OrphanedQueueHint,
  PermissionMode,
  PrChecks,
  PrState,
  ReviewItem,
  ServerEvent,
  Session,
  SessionMeta,
  SessionNote,
  SessionNoteSummary,
  SessionQueue,
  SessionQueueSummary,
  SessionState,
  Task,
  TaskSummary,
  WorkItem,
  WorkItemState,
} from "@shared/types.ts";
import type { HookIngest, SetNote, StatusLineIngest } from "@shared/protocol.ts";
import { inFlightItem as inFlightItemOf, isTerminalState } from "@shared/queue.ts";
import {
  effectiveContextWindow,
  isLongContext,
  modelLabel,
  parseContextWindowSize,
} from "@shared/model.ts";
import type { DiscoveredSession } from "./discovery/correlate.ts";
import type { RuntimeMetaRead } from "./transcript.ts";
import {
  deleteQueueItem,
  deleteTask as dbDeleteTask,
  getQueueItem,
  getQueueRow,
  getSessionNote,
  listQueueItems,
  listQueueRows,
  loadActiveTasks,
  loadResourceHoldingTerminalTasks,
  loadPendingReviews,
  loadRecentTerminalTasks,
  loadSessionNotes,
  hooksEverSeen,
  lastAgentBinding,
  logEvent,
  recordAgentBinding,
  rekeyQueue,
  listQueueRowsForCwd,
  countOpenQueueItems,
  pruneDeadQueues,
  reorderQueueItems,
  upsertQueue,
  upsertQueueItem,
  upsertSessionNote,
  upsertTask as dbUpsertTask,
} from "./db.ts";
import { unref } from "./util/timers.ts";

/** An open-or-merged PR the poller matched to a session's current branch. */
export type PrMatch = {
  url: string;
  number: number | null;
  state: PrState;
  /** Rolled-up CI status for the PR, or null when it carries no checks. */
  checks: PrChecks | null;
};

/** How many finished tasks to rehydrate on start, so "recent outcomes" survives a restart. */
const RECENT_TERMINAL_TASKS = 50;

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
/** How often the retention sweep runs. It rides the discovery sweep, which is ~1.5s. */
const QUEUE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
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

/** Hook-derived state for a session, applied over passive discovery. */
interface HookOverlay {
  agentSessionId: string | null;
  transcriptPath: string | null;
  state: SessionState;
  activity: string | null;
  /** Last-known Claude permission mode; sticky across events that omit it. */
  permissionMode: PermissionMode | null;
  lastActivity: number;
  updatedAt: number;
}

/**
 * In-memory source of truth for live sessions and pending reviews. Emits a
 * `ServerEvent` on every change; the SSE layer forwards those to browsers.
 *
 * Sessions are keyed by their synthetic discovery id (tty+pid+start). Hook
 * events can't see that id, so they bind to a session by its terminal pane
 * (tmux `%id` or wezterm pane id) via a "hook overlay" that also survives the
 * next discovery sweep, keeping hook-driven state from being clobbered.
 */
export class Registry extends EventEmitter {
  private sessions = new Map<string, Session>();
  private reviews = new Map<string, ReviewItem>();
  private tasks = new Map<string, Task>();
  /** Foreman notes keyed by note key (agentSessionId ?? synthetic id). */
  private notes = new Map<string, SessionNote>();
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** overlay keyed by pane token ("tmux:%12" | "wez:12"). */
  private overlays = new Map<string, HookOverlay>();
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
  /** Whether a discovery sweep has ever completed - see `fleetObserved`. */
  private sweptFleet = false;
  private lastQueuePrune = 0;

  constructor() {
    super();
    for (const r of loadPendingReviews()) this.reviews.set(r.id, r);
    for (const n of loadSessionNotes()) this.notes.set(n.noteKey, n);
    for (const t of loadActiveTasks()) this.tasks.set(t.id, t);
    for (const t of loadRecentTerminalTasks(RECENT_TERMINAL_TASKS)) this.tasks.set(t.id, t);
    // Always load terminal tasks that still hold a worktree (done-awaiting-reclaim
    // or failed-but-alive) so their live resources get reconciled, even if newer
    // terminal tasks would push them past the recent cap.
    for (const t of loadResourceHoldingTerminalTasks()) this.tasks.set(t.id, t);
  }

  snapshot(): { sessions: Session[]; reviews: ReviewItem[]; tasks: Task[] } {
    return {
      sessions: [...this.sessions.values()],
      reviews: [...this.reviews.values()],
      tasks: [...this.tasks.values()],
    };
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }

  private emitEvent(e: ServerEvent): void {
    this.emit("event", e);
  }
  private emitSession(s: Session): void {
    this.emitEvent({ type: "session_upsert", session: s });
  }

  // ---- passive discovery ----

  applyDiscovery(discovered: DiscoveredSession[]): void {
    const now = Date.now();
    const seen = new Set<string>();
    // Only a COMPLETED sweep reaches here - the poller logs and skips on failure -
    // so this is the moment the session map starts meaning anything. See `fleetObserved`.
    this.sweptFleet = true;

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
    for (const [id, s] of this.sessions) {
      if (seen.has(id) || this.exitTimers.has(id)) continue;
      if (s.state !== "exited") {
        const exited: Session = { ...s, state: "exited" };
        this.sessions.set(id, exited);
        this.emitSession(exited);
      }
      const t = unref(setTimeout(() => this.remove(id), EXIT_LINGER_MS));
      this.exitTimers.set(id, t);
    }

    // Hints LAST, once the map is whole. `mergeDiscovered` resolved each session's
    // hint as it merged, i.e. against a map still being filled one session at a time:
    // on the first sweep after a restart the first session merged saw only its own
    // key as live, so every OTHER live session's queue looked orphaned to it. That
    // hint is actionable, and `reattachQueue` trusts it - it checks only that the
    // target is Claude and holds no open items, never that the source is really
    // orphaned - so a click inside that window re-keys a healthy session's live queue
    // onto another card and drops the original row. The hint's correctness is the
    // only guard on that write, so it must never be computed from a partial map.
    this.syncAllOrphanHints();
    this.pruneQueues(now);
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
  }

  private mergeDiscovered(
    prev: Session | undefined,
    d: DiscoveredSession,
    now: number,
  ): Session {
    // Read the stored binding ONCE, on first sight. After that the in-memory value
    // is the freshest truth - every rebinding goes through this process first - so
    // re-reading each sweep could only ever return what we already have.
    const known = prev ? prev.agentSessionId : lastAgentBinding(d.syntheticId);
    const base: Session = {
      id: d.syntheticId,
      agent: d.agent,
      name: d.name,
      nameSource: d.nameSource,
      state: "working",
      cwd: d.cwd,
      gitBranch: d.gitBranch,
      gitRoot: d.gitRoot,
      nomistakesGated: d.nomistakesGated,
      pid: d.pid,
      tty: d.tty,
      // A mode read straight off the pane outranks every remembered value; absent
      // one (Codex, no pane, or a dialog covering Claude's mode line) we keep the
      // last we knew rather than blanking the chip.
      permissionMode: d.permissionMode ?? prev?.permissionMode ?? null,
      wezterm: d.wezterm,
      tmux: d.tmux,
      // Seeded from the DB for the same reason `hooksSeen` below is: only a live
      // hook/statusLine reports it, so on a daemon restart a quiet-but-healthy
      // session would rebuild with a null binding - and `noteKeyFor` would hand its
      // note and its WORK QUEUE to the synthetic id instead, making every stored
      // queue in the fleet look orphaned. See `recordAgentBinding`.
      agentSessionId: known,
      transcriptPath: prev?.transcriptPath ?? null,
      instrumented: false,
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
      task: this.taskSummaryForCwd(d.cwd),
      nomistakesNarration: prev?.nomistakesNarration ?? null,
      prUrl: prev?.prUrl ?? null,
      prNumber: prev?.prNumber ?? null,
      prState: prev?.prState ?? null,
      prChecks: prev?.prChecks ?? null,
      meta: prev?.meta ?? null,
      note: null,
      queue: null,
      orphanedQueue: null,
    };
    const overlay = this.overlayFor(base);
    if (overlay) base.hooksSeen = true;
    if (overlay && now - overlay.updatedAt < OVERLAY_TTL_MS) {
      base.instrumented = true;
      base.state = overlay.state;
      base.activity = overlay.activity;
      // The hook overlay is a fallback for the pane read, never an override of it.
      base.permissionMode = d.permissionMode ?? overlay.permissionMode ?? base.permissionMode;
      base.lastActivity = overlay.lastActivity;
      base.agentSessionId = overlay.agentSessionId ?? base.agentSessionId;
      base.transcriptPath = overlay.transcriptPath ?? base.transcriptPath;
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
    base.queue = this.queueSummaryFor(base);
    // The orphan hint is NOT resolved here, unlike the note and queue above: it is a
    // statement about the whole fleet ("no live session holds that key"), and this
    // runs per session while `applyDiscovery` is still filling the map. Carry the
    // last known value and let `applyDiscovery` re-resolve every hint once the map is
    // whole. `applyHook` resolves its own inline because by then the map already is.
    base.orphanedQueue = prev?.orphanedQueue ?? null;
    return base;
  }

  // ---- hooks ----

  applyHook(evt: HookIngest): void {
    const now = Date.now();
    const ts = evt.ts ?? now;
    const key = overlayKeyFromEnv(evt.env);
    const { state, activity } = hookToState(evt);

    // Permission mode is sticky: events that omit it keep the last known value
    // (from this pane's prior overlay) rather than clearing the card's chip.
    const priorOverlay = key ? this.overlays.get(key) : undefined;
    const permissionMode =
      normalizePermissionMode(evt.permissionMode) ?? priorOverlay?.permissionMode ?? null;

    const overlay: HookOverlay = {
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
    const target = this.findSessionForHook(evt, key);
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
      const next: Session = {
        ...target,
        ...pr,
        instrumented: true,
        hooksSeen: true,
        state,
        activity,
        permissionMode,
        lastActivity: ts,
        agentSessionId: evt.sessionId ?? target.agentSessionId,
        transcriptPath: evt.transcriptPath ?? target.transcriptPath,
      };
      // Binding the agent session id can change the note key, so re-resolve
      // everything keyed by it NOW rather than waiting for the next discovery
      // sweep. A `/clear` mints a new agent session id mid-pane, and until this
      // re-resolves the card would keep showing the PREVIOUS key's queue while its
      // real one sits orphaned and unoffered - stale in the exact moment the human
      // is looking, since a /clear is something they just did.
      next.note = this.noteSummaryFor(next);
      next.queue = this.queueSummaryFor(next);
      next.orphanedQueue = this.orphanedQueueFor(next);
      this.rememberAgentSession(next, target.agentSessionId);
      this.sessions.set(next.id, next);
      logEvent(next.id, ts, evt.event, { activity, state });
      if (!sessionEqual(target, next) || target.lastActivity !== ts) this.emitSession(next);
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
   * re-applying all of its stale fields (instrumented, state, activity) over the card.
   */
  recordObservedPermissionMode(sessionId: string, mode: PermissionMode | null): void {
    if (!mode) return;
    const s = this.sessions.get(sessionId);
    if (!s || s.permissionMode === mode) return;
    const overlay = this.overlayFor(s);
    if (overlay) overlay.permissionMode = mode;
    const updated: Session = { ...s, permissionMode: mode };
    this.sessions.set(sessionId, updated);
    this.emitSession(updated);
  }

  /**
   * Optimistically apply a rename to the live card the instant the tmux/wezterm
   * rename lands, rather than waiting up to a poll interval for discovery to read
   * the new name back. For a tmux session the display name IS the tmux session
   * name, so the tmux handle's `session` field moves with it - otherwise Focus and
   * Kill (which target `tmux.session` by name) would address the now-renamed
   * session by its old name until the next sweep. The wezterm handle's `tabTitle`
   * is kept in step for the same consistency, though no action keys off it.
   *
   * Discovery converges on this exact value on its next tick (the terminal really
   * was renamed), so there's nothing to reconcile - a stale in-flight sweep that
   * started before the rename can briefly show the old name, then self-heals.
   *
   * Renaming a tmux session renames it for every card hosted on it: `correlate`
   * groups agents by tty, so two agents in two windows of one tmux session are two
   * cards sharing a `tmux.session`. All of them are re-pointed, or a sibling's Focus
   * would attach by a name that no longer resolves until the next sweep. A sibling
   * named after tmux (`nameSource`) takes the new display name too - its title just
   * IS the tmux session name.
   *
   * A dispatched task holds its own persisted copy of the tmux name, and that copy
   * drives destructive teardown: `reconcileOnStartup` reads `tmuxSession` back after
   * a restart and reclaims the worktree when the name no longer resolves. Left
   * stale, a renamed agent's tree would be force-removed out from under it, so the
   * binding moves with the rename here, persisted through `upsertTask` to reach
   * SQLite. The old name alone is too weak a key: it is unique only among LIVE
   * sessions, while `tmuxSession` is a historical record and tmux frees a dead
   * session's name for immediate reuse. So the task must also hold the worktree of
   * a session actually on this tmux session (the `cwd` join `activeTaskForCwd`
   * uses) - otherwise a long-dead task that merely recorded a since-reused name
   * would be re-pointed onto a live session and later kill it. `sessionId` can't be
   * the key: the dispatcher only sets it on the success path, so a failed-but-alive
   * task - which still holds a worktree and must still follow - has none.
   */
  renameSession(sessionId: string, name: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.name === name) return;
    const priorTmux = s.tmux?.session ?? null;
    const next: Session = {
      ...s,
      name,
      tmux: s.tmux ? { ...s.tmux, session: name } : s.tmux,
      wezterm: s.wezterm ? { ...s.wezterm, tabTitle: name } : s.wezterm,
    };
    this.sessions.set(sessionId, next);
    this.emitSession(next);
    if (!priorTmux || priorTmux === name) return;

    const hostedCwds = new Set<string>();
    if (s.cwd) hostedCwds.add(s.cwd);
    for (const [id, other] of [...this.sessions]) {
      if (id === sessionId) continue;
      const pane = other.tmux;
      if (!pane || pane.session !== priorTmux) continue;
      if (other.cwd) hostedCwds.add(other.cwd);
      const renamed: Session = {
        ...other,
        name: other.nameSource === "tmux" ? name : other.name,
        tmux: { ...pane, session: name },
      };
      this.sessions.set(id, renamed);
      this.emitSession(renamed);
    }

    for (const t of this.listTasks()) {
      if (t.tmuxSession !== priorTmux) continue;
      if (!t.worktreePath || !hostedCwds.has(t.worktreePath)) continue;
      this.upsertTask({ ...t, tmuxSession: name, updatedAt: Date.now() });
    }
  }

  private findSessionForHook(evt: HookIngest, key: string | null): Session | undefined {
    return this.findSessionByEnv(evt.env, evt.sessionId, evt.cwd, key);
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
      const matches = [...this.sessions.values()].filter(
        (s) => s.cwd === cwd && s.agent === "claude",
      );
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

  /**
   * Live sessions the PR poller should consider, with the branch and cwd it needs
   * to ask `gh` for an open PR. Sessions with no cwd or that have exited are
   * dropped (nothing to poll, and an exited session's link is about to go away
   * with it). Everything else is a candidate - the poller decides which actually
   * warrant a `gh` call, and any candidate left without a match is cleared.
   */
  prPollTargets(): { id: string; cwd: string; branch: string | null; prUrl: string | null }[] {
    const out: { id: string; cwd: string; branch: string | null; prUrl: string | null }[] = [];
    for (const s of this.sessions.values()) {
      if (!s.cwd || s.state === "exited") continue;
      out.push({ id: s.id, cwd: s.cwd, branch: s.gitBranch, prUrl: s.prUrl });
    }
    return out;
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
      const match = found.get(id) ?? null;
      const url = match?.url ?? null;
      const number = match?.number ?? null;
      const state = match?.state ?? null;
      const checks = match?.checks ?? null;
      if (s.prUrl === url && s.prNumber === number && s.prState === state && s.prChecks === checks)
        continue;
      const next: Session = { ...s, prUrl: url, prNumber: number, prState: state, prChecks: checks };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  /** MCP `report_status`: update a session's activity line without a hook. */
  applyStatus(env: HookIngest["env"], agentSessionId: string | null, activity: string): void {
    const s = this.findSessionByEnv(env, agentSessionId);
    if (!s) return;
    const next: Session = {
      ...s,
      instrumented: true,
      hooksSeen: true,
      activity,
      lastActivity: Date.now(),
      agentSessionId: agentSessionId ?? s.agentSessionId,
    };
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
    const s = this.findSessionByEnv(ingest.env, ingest.sessionId, ingest.cwd);
    if (!s) return;
    const meta = metaFromStatusLine(ingest, Date.now());
    const agentSessionId = ingest.sessionId ?? s.agentSessionId;
    const changed = !metaDisplayEqual(s.meta, meta) || s.agentSessionId !== agentSessionId;
    const next: Session = { ...s, meta, agentSessionId };
    this.rememberAgentSession(next, s.agentSessionId);
    this.sessions.set(s.id, next);
    if (changed) this.emitSession(next);
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
    const now = Date.now();
    if (
      s.meta?.source === "statusline" &&
      source !== "statusline" &&
      now - s.meta.updatedAt < STATUSLINE_TTL_MS
    )
      return;
    const meta = metaFromRead(read, source, now);
    const changed = !metaDisplayEqual(s.meta, meta);
    const next: Session = { ...s, meta };
    this.sessions.set(sessionId, next);
    if (changed) this.emitSession(next);
  }

  private overlayFor(s: Session): HookOverlay | undefined {
    const key = sessionKey(s);
    if (key && this.overlays.has(key)) return this.overlays.get(key);
    if (s.agentSessionId) {
      for (const o of this.overlays.values())
        if (o.agentSessionId === s.agentSessionId) return o;
    }
    return undefined;
  }

  private pruneOverlays(now: number): void {
    for (const [k, o] of this.overlays)
      if (now - o.updatedAt > OVERLAY_TTL_MS) this.overlays.delete(k);
  }

  private remove(id: string): void {
    this.exitTimers.delete(id);
    this.nmBindings.delete(id);
    if (!this.sessions.delete(id)) return;
    this.emitEvent({ type: "session_remove", id });
    // Eviction is the INSTANT a queue becomes orphaned - `orphanedQueueFor` derives
    // liveness from this very map - so no sibling's hint is right until this runs.
    // Waiting for the next sweep to notice isn't enough on its own either: the card
    // that should show the hint is typically an idle session at the same cwd, which
    // is exactly the case where nothing else about it moves.
    this.syncAllOrphanHints();
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

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /** Persist + broadcast a task, and refresh any session bound to its worktree. */
  upsertTask(task: Task): void {
    dbUpsertTask(task);
    this.tasks.set(task.id, task);
    this.emitEvent({ type: "task_upsert", task });
    this.syncSessionsForWorktree(task.worktreePath);
    if (isTerminalTask(task.status)) this.pruneTerminalTasks();
  }

  /**
   * Keep the in-memory map bounded: evict all but the most recent terminal tasks
   * (the DB retains the full history; a restart rehydrates the same cap). Without
   * this, every finished task would linger in memory and in every SSE snapshot.
   */
  private pruneTerminalTasks(): void {
    // Only evict fully-cleaned terminal tasks. A failed-but-alive task still holds
    // a worktree + tmux session and decorates its live card, so it must never be
    // evicted (that would orphan its resources and drop the card's chip).
    const evictable = [...this.tasks.values()].filter(
      (t) => isTerminalTask(t.status) && !t.worktreePath,
    );
    if (evictable.length <= RECENT_TERMINAL_TASKS) return;
    evictable.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of evictable.slice(RECENT_TERMINAL_TASKS)) {
      this.tasks.delete(t.id);
      this.emitEvent({ type: "task_remove", id: t.id });
    }
  }

  removeTask(id: string): void {
    const t = this.tasks.get(id);
    dbDeleteTask(id);
    if (this.tasks.delete(id)) this.emitEvent({ type: "task_remove", id });
    if (t) this.syncSessionsForWorktree(t.worktreePath);
  }

  /**
   * Resolve a session running in a given worktree, once discovery has bound one.
   * Used by the dispatcher to know the agent's pane is up before injecting the
   * first prompt. Resolves immediately if already present, else waits for the
   * next matching `session_upsert`, else null on timeout.
   */
  waitForSessionAtCwd(cwd: string, timeoutMs: number): Promise<Session | null> {
    const existing = this.firstSessionAtCwd(cwd);
    if (existing) return Promise.resolve(existing);
    return new Promise<Session | null>((resolve) => {
      const timer = unref(
        setTimeout(() => {
          unsub();
          resolve(null);
        }, timeoutMs),
      );
      const unsub = this.subscribe((e) => {
        if (e.type === "session_upsert" && e.session.cwd === cwd && e.session.state !== "exited") {
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

  /** The active task a session in `cwd` is executing, as a compact card summary. */
  private taskSummaryForCwd(cwd: string | null): TaskSummary | null {
    const t = this.activeTaskForCwd(cwd);
    return t
      ? { id: t.id, title: t.title, kind: t.kind, status: t.status, outcome: t.outcome, outcomeUrl: t.outcomeUrl }
      : null;
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
    const summary = this.taskSummaryForCwd(cwd);
    for (const [id, s] of this.sessions) {
      if (s.cwd !== cwd) continue;
      if (JSON.stringify(s.task) === JSON.stringify(summary)) continue;
      const next = { ...s, task: summary };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
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
    return summarizeQueue(items, row?.wrapupAskedAt ?? null, row?.updatedAt ?? 0);
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
    // `reattachQueue` relies on to know a queue is really orphaned. See fleetObserved.
    if (!this.sweptFleet) return null;
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
      updatedAt: row?.updatedAt ?? 0,
      items,
    };
  }

  /** Every stored queue (items included) - the orphan sweep + the fleet-level list. */
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
   * provide - one hiccuping `ps` sweep would mark the whole fleet exited, and
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
   * fleet is gone - and the orphan sweep polls several times a second, so it will be
   * in that window. Same rule as the exit linger just above, and the same reason:
   * escalation is terminal and has no undo, so it must not turn on an absence of
   * evidence. A sweep that completes and genuinely finds nothing DOES flip this -
   * that's a fleet we looked at, so a queue with no session really is orphaned.
   */
  fleetObserved(): boolean {
    return this.sweptFleet;
  }

  /**
   * Ensure a queue row exists for a session, refreshing its cwd/branch (the
   * re-attach hint must track where the session actually is). Returns the key.
   */
  ensureQueue(id: string, now = Date.now()): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const key = noteKeyFor(s);
    const prev = getQueueRow(key);
    upsertQueue({
      noteKey: key,
      cwd: s.cwd,
      branch: s.gitBranch,
      wrapupAskedAt: prev?.wrapupAskedAt ?? null,
      wrapupAnswer: prev?.wrapupAnswer ?? null,
      updatedAt: now,
    });
    return key;
  }

  /** Patch a queue's wrap-up state, then re-denormalize. */
  setQueueWrapup(
    key: string,
    patch: { wrapupAskedAt?: number | null; wrapupAnswer?: string | null },
    now = Date.now(),
  ): void {
    const prev = getQueueRow(key);
    if (!prev) return;
    upsertQueue({
      ...prev,
      wrapupAskedAt: patch.wrapupAskedAt !== undefined ? patch.wrapupAskedAt : prev.wrapupAskedAt,
      wrapupAnswer: patch.wrapupAnswer !== undefined ? patch.wrapupAnswer : prev.wrapupAnswer,
      updatedAt: now,
    });
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
   */
  reattachQueue(fromKey: string, toSessionId: string, now = Date.now()): boolean {
    const s = this.sessions.get(toSessionId);
    const row = getQueueRow(fromKey);
    if (!s || !row) return false;
    // Only onto a session that can actually RUN a queue. `orphanedQueueFor` matches
    // on cwd alone, so the hint is offered beside any live session at the orphan's
    // directory - including a Codex one, which `tickTargets` filters out of every
    // tick. Re-keying onto it is a one-way trip to nowhere: the queue never ticks
    // again, and because the target now holds the key, the queue counts as live, so
    // neither the cwd hint nor the fleet-level orphan sweep will ever offer it
    // again. Refusing here is what makes the button agree with the panel's own
    // "Claude-only for now" copy instead of silently stranding the batch.
    if (s.agent !== "claude") return false;
    const toKey = noteKeyFor(s);
    if (toKey === fromKey) return true;
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
        updatedAt: now,
      },
      items.map((i, n) => ({ ...i, noteKey: toKey, seq: base + n, updatedAt: now })),
    );
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
  wrapupAskedAt: number | null,
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
    escalatedCount: items.filter((i) => i.state === "escalated").length,
    drained: items.length > 0 && open.length === 0,
    wrapupAskedAt,
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

/** Pane token for a hook's captured env: tmux pane wins over the outer wezterm pane. */
export function overlayKeyFromEnv(env: HookIngest["env"]): string | null {
  if (env.tmuxPane) return `tmux:${env.tmuxPane}`;
  if (env.weztermPane) return `wez:${env.weztermPane}`;
  return null;
}

/** Pane token for a discovered session: its own pane, tmux preferred. */
export function sessionKey(s: Session): string | null {
  if (s.tmux) return `tmux:${s.tmux.paneId}`;
  if (s.wezterm) return `wez:${s.wezterm.paneId}`;
  return null;
}

/** The permission modes Claude reports; anything else is treated as unknown. */
const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

/**
 * Narrow a raw `permission_mode` string to a known PermissionMode, or null when
 * it's absent or a value we don't recognize (a mode a newer Claude adds) - so an
 * unknown mode never masquerades as a known one on the card.
 */
export function normalizePermissionMode(raw: string | undefined | null): PermissionMode | null {
  return raw && PERMISSION_MODES.has(raw as PermissionMode) ? (raw as PermissionMode) : null;
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
 * True when a `Notification` is Claude's idle nudge rather than a real ask.
 *
 * Claude Code fires the same hook for two unrelated things: it needs something from
 * you, and the prompt has simply sat idle for ~60s. Only the first needs you.
 * Treating both as `awaiting_input` made *every* settled session claim it needed
 * you a minute after it went quiet, which is noise in exactly the bucket that is
 * supposed to be signal - and it never recovered, because nothing moves a session
 * out of `awaiting_input` on its own.
 *
 * The message is the only discriminator the payload carries. These are the only
 * three we have ever actually observed, across 61 Notification events in this
 * daemon's own `session_events` log (the counts are real sessions on one machine,
 * so treat them as "what Claude sends", not "all Claude can send"):
 *
 *   41x  "Claude is waiting for your input"              <- the idle nudge
 *   19x  "Claude needs your permission"                  <- a real ask
 *    1x  "Claude Code needs your approval for the plan"  <- a real ask
 *
 * Hence the match is on the nudge, narrowly, and everything else - including any
 * wording a future Claude introduces - keeps its `awaiting_input` meaning. The
 * failure mode is therefore safe by construction: if this string ever changes we
 * regress to the old over-reporting (an idle session says "needs you"), never to
 * swallowing a genuine ask. That asymmetry is the reason to match the nudge rather
 * than to match the asks.
 *
 * Known tradeoff: a session that ends its turn with a question in *prose* (no
 * permission prompt) is indistinguishable from an idle one in the hook stream -
 * both are a `Stop` followed by this same nudge - so it now reads `idle` and won't
 * nag at 60s. Foreman's triage still catches those, because it reads transcripts.
 */
export function isIdleNudge(message: string | undefined | null): boolean {
  return /waiting for your input/i.test(message ?? "");
}

/** Map a Claude hook event to a session state + one-line activity. */
export function hookToState(evt: HookIngest): { state: SessionState; activity: string | null } {
  const trim = (s: string | undefined, n = 120): string | null =>
    s ? (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\s+/g, " ").trim() : null;

  switch (evt.event) {
    case "SessionStart":
      return { state: "idle", activity: evt.source ? `started (${evt.source})` : "started" };
    case "UserPromptSubmit":
      return { state: "working", activity: trim(evt.prompt) };
    case "PreToolUse":
      return { state: "working", activity: evt.toolName ? `running ${evt.toolName}` : "working" };
    case "PostToolUse":
      return { state: "working", activity: evt.toolName ? `${evt.toolName} done` : "working" };
    case "Notification":
      // The idle nudge means "still parked at the prompt", which is the same thing
      // Stop reports - so report it identically rather than inventing a state.
      return isIdleNudge(evt.message)
        ? { state: "idle", activity: "idle" }
        : { state: "awaiting_input", activity: trim(evt.message) ?? "waiting for you" };
    case "Stop":
      return { state: "idle", activity: "idle" };
    case "SubagentStop":
      return { state: "working", activity: "subagent finished" };
    case "PreCompact":
      return { state: "working", activity: "compacting context" };
    case "SessionEnd":
      return { state: "exited", activity: evt.reason ? `ended (${evt.reason})` : "ended" };
    default:
      return { state: "working", activity: null };
  }
}

/**
 * Compare user-visible fields; `lastSeen`/`lastActivity` excluded so a still-alive
 * session doesn't spam the UI every poll. Only real changes emit.
 */
function sessionEqual(a: Session, b: Session): boolean {
  return (
    a.name === b.name &&
    a.state === b.state &&
    a.cwd === b.cwd &&
    a.gitBranch === b.gitBranch &&
    a.gitRoot === b.gitRoot &&
    a.pid === b.pid &&
    a.nameSource === b.nameSource &&
    a.agentSessionId === b.agentSessionId &&
    a.transcriptPath === b.transcriptPath &&
    a.instrumented === b.instrumented &&
    a.hooksSeen === b.hooksSeen &&
    a.activity === b.activity &&
    a.permissionMode === b.permissionMode &&
    a.pendingReviews === b.pendingReviews &&
    a.wezterm?.isActive === b.wezterm?.isActive &&
    a.tmux?.window === b.tmux?.window &&
    a.nomistakesNarration === b.nomistakesNarration &&
    a.prUrl === b.prUrl &&
    a.prNumber === b.prNumber &&
    a.prState === b.prState &&
    a.prChecks === b.prChecks &&
    metaDisplayEqual(a.meta, b.meta) &&
    JSON.stringify(a.nomistakes) === JSON.stringify(b.nomistakes) &&
    JSON.stringify(a.task) === JSON.stringify(b.task) &&
    JSON.stringify(a.note) === JSON.stringify(b.note) &&
    // The other two denormalized fields `mergeDiscovered` resolves next to `note`.
    // Omitting them made a sweep's recomputation invisible: `orphanedQueue` in
    // particular depends on OTHER sessions (a queue is orphaned only once its own
    // session is evicted), so the session whose hint changes need not have changed
    // in any way of its own - an idle sibling is equal by every field above, stays
    // quiet, and never surfaces the stranded batch.
    JSON.stringify(a.queue) === JSON.stringify(b.queue) &&
    JSON.stringify(a.orphanedQueue) === JSON.stringify(b.orphanedQueue)
  );
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
