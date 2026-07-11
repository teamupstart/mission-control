import { EventEmitter } from "node:events";
import type { NmRunSummary, ReviewItem, ServerEvent, Session, SessionState } from "@shared/types.ts";
import type { HookIngest } from "@shared/protocol.ts";
import type { DiscoveredSession } from "./discovery/correlate.ts";
import { loadPendingReviews, logEvent } from "./db.ts";

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
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** overlay keyed by pane token ("tmux:%12" | "wez:12"). */
  private overlays = new Map<string, HookOverlay>();

  constructor() {
    super();
    for (const r of loadPendingReviews()) this.reviews.set(r.id, r);
  }

  snapshot(): { sessions: Session[]; reviews: ReviewItem[] } {
    return {
      sessions: [...this.sessions.values()],
      reviews: [...this.reviews.values()],
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
}

// ---- pure helpers ----

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
    JSON.stringify(a.nomistakes) === JSON.stringify(b.nomistakes)
  );
}
