import { EventEmitter } from "node:events";
import type {
  NmRunSummary,
  ReviewItem,
  ServerEvent,
  Session,
  SessionState,
  Task,
  TaskSummary,
} from "@shared/types.ts";
import type { HookIngest } from "@shared/protocol.ts";
import type { DiscoveredSession } from "./discovery/correlate.ts";
import {
  deleteTask as dbDeleteTask,
  loadActiveTasks,
  loadPendingReviews,
  loadRecentTerminalTasks,
  logEvent,
  upsertTask as dbUpsertTask,
} from "./db.ts";

/** How many finished tasks to rehydrate on start, so "recent outcomes" survives a restart. */
const RECENT_TERMINAL_TASKS = 50;

/** How long an exited session lingers on the dashboard before removal (ms). */
const EXIT_LINGER_MS = 8000;
/** Hook overlays older than this are ignored/pruned (a session went quiet). */
const OVERLAY_TTL_MS = 30 * 60 * 1000;

/** Hook-derived state for a session, applied over passive discovery. */
interface HookOverlay {
  agentSessionId: string | null;
  state: SessionState;
  activity: string | null;
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
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** overlay keyed by pane token ("tmux:%12" | "wez:12"). */
  private overlays = new Map<string, HookOverlay>();

  constructor() {
    super();
    for (const r of loadPendingReviews()) this.reviews.set(r.id, r);
    for (const t of loadActiveTasks()) this.tasks.set(t.id, t);
    for (const t of loadRecentTerminalTasks(RECENT_TERMINAL_TASKS)) this.tasks.set(t.id, t);
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

    for (const [id, s] of this.sessions) {
      if (seen.has(id) || s.state === "exited") continue;
      const exited: Session = { ...s, state: "exited" };
      this.sessions.set(id, exited);
      this.emitSession(exited);
      const t = setTimeout(() => this.remove(id), EXIT_LINGER_MS);
      if (typeof t === "object" && "unref" in t) t.unref();
      this.exitTimers.set(id, t);
    }
  }

  private mergeDiscovered(
    prev: Session | undefined,
    d: DiscoveredSession,
    now: number,
  ): Session {
    const base: Session = {
      id: d.syntheticId,
      agent: d.agent,
      name: d.name,
      nameSource: d.nameSource,
      state: "working",
      cwd: d.cwd,
      gitBranch: d.gitBranch,
      nomistakesGated: d.nomistakesGated,
      pid: d.pid,
      tty: d.tty,
      wezterm: d.wezterm,
      tmux: d.tmux,
      agentSessionId: prev?.agentSessionId ?? null,
      instrumented: false,
      activity: prev?.activity ?? null,
      startedAt: d.startedAt || prev?.startedAt || null,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      lastActivity: prev?.lastActivity ?? null,
      pendingReviews: this.countPending(d.syntheticId),
      nomistakes: prev?.nomistakes ?? null,
      task: this.taskSummaryForCwd(d.cwd),
    };
    const overlay = this.overlayFor(base);
    if (overlay && now - overlay.updatedAt < OVERLAY_TTL_MS) {
      base.instrumented = true;
      base.state = overlay.state;
      base.activity = overlay.activity;
      base.lastActivity = overlay.lastActivity;
      base.agentSessionId = overlay.agentSessionId ?? base.agentSessionId;
    }
    return base;
  }

  // ---- hooks ----

  applyHook(evt: HookIngest): void {
    const now = Date.now();
    const ts = evt.ts ?? now;
    const key = overlayKeyFromEnv(evt.env);
    const { state, activity } = hookToState(evt);

    const overlay: HookOverlay = {
      agentSessionId: evt.sessionId ?? null,
      state,
      activity,
      lastActivity: ts,
      updatedAt: now,
    };
    if (key) this.overlays.set(key, overlay);

    // Apply immediately to a matching live session for instant feedback.
    const target = this.findSessionForHook(evt, key);
    if (target) {
      const next: Session = {
        ...target,
        instrumented: true,
        state,
        activity,
        lastActivity: ts,
        agentSessionId: evt.sessionId ?? target.agentSessionId,
      };
      this.sessions.set(next.id, next);
      logEvent(next.id, ts, evt.event, { activity, state });
      if (!sessionEqual(target, next) || target.lastActivity !== ts) this.emitSession(next);
    }
    this.pruneOverlays(now);
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

  /**
   * Apply a no-mistakes run status to the sessions it belongs to in a repo dir.
   *
   * `no-mistakes axi status` reports per-repo (shared `.git`), so querying from
   * one worktree returns the repo's active run even when it belongs to a sibling
   * worktree on a different branch. We therefore only decorate sessions whose
   * branch matches the run's - git allows a branch in a single worktree, so the
   * branch uniquely identifies the worktree that owns the run. Sessions in the
   * same dir on a different branch are cleared, so a run for branch X never
   * leaks onto every session that merely shares the repo.
   */
  applyNomistakes(cwd: string, summary: NmRunSummary | null): void {
    for (const [id, s] of this.sessions) {
      if (s.cwd !== cwd) continue;
      const owned = summary && s.gitBranch === summary.branch ? summary : null;
      if (JSON.stringify(s.nomistakes) === JSON.stringify(owned)) continue;
      const next = { ...s, nomistakes: owned };
      this.sessions.set(id, next);
      this.emitSession(next);
    }
  }

  /** Distinct cwds of sessions whose repo is gated by no-mistakes. */
  gatedCwds(): string[] {
    const set = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.nomistakesGated && s.cwd) set.add(s.cwd);
    }
    return [...set];
  }

  /** MCP `report_status`: update a session's activity line without a hook. */
  applyStatus(env: HookIngest["env"], agentSessionId: string | null, activity: string): void {
    const s = this.findSessionByEnv(env, agentSessionId);
    if (!s) return;
    const next: Session = {
      ...s,
      instrumented: true,
      activity,
      lastActivity: Date.now(),
      agentSessionId: agentSessionId ?? s.agentSessionId,
    };
    this.sessions.set(next.id, next);
    this.emitSession(next);
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
    if (this.sessions.delete(id)) this.emitEvent({ type: "session_remove", id });
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

  // ---- tasks (dispatch, phase: crewmates) ----

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
    const terminal = [...this.tasks.values()].filter((t) => isTerminalTask(t.status));
    if (terminal.length <= RECENT_TERMINAL_TASKS) return;
    terminal.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of terminal.slice(RECENT_TERMINAL_TASKS)) {
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
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
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
   * Most-recently-updated task whose worktree matches this cwd. A queued task has
   * no worktree; a cancelled or cleanly-failed task cleared its worktree fields, so
   * it can't match a cwd here. A failed-but-alive task keeps its worktree, so it
   * still decorates its live session's card - the crewmate stays actionable there.
   */
  private activeTaskForCwd(cwd: string | null): Task | undefined {
    if (!cwd) return undefined;
    let best: Task | undefined;
    for (const t of this.tasks.values()) {
      if (t.worktreePath !== cwd) continue;
      if (t.status === "queued" || t.status === "cancelled") continue;
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
}

// ---- pure helpers ----

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
      return { state: "awaiting_input", activity: trim(evt.message) ?? "waiting for you" };
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
    a.pid === b.pid &&
    a.nameSource === b.nameSource &&
    a.agentSessionId === b.agentSessionId &&
    a.instrumented === b.instrumented &&
    a.activity === b.activity &&
    a.pendingReviews === b.pendingReviews &&
    a.wezterm?.isActive === b.wezterm?.isActive &&
    a.tmux?.window === b.tmux?.window &&
    JSON.stringify(a.nomistakes) === JSON.stringify(b.nomistakes) &&
    JSON.stringify(a.task) === JSON.stringify(b.task)
  );
}
