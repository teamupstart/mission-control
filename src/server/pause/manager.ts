import {
  bulkPauseTargets,
  canPause,
  EMPTY_PAUSE_STATE,
  PAUSED_SESSION_REASON,
  pauseFreezes,
  type PauseState,
  type SessionPause,
  type SessionPauseMode,
  type SessionPauseReason,
} from "@shared/pause.ts";
import type { StoredPauseState, StoredSessionPause } from "@shared/protocol.ts";
import { FLEET_PAUSE_MAX_MS } from "@shared/protocol.ts";
import { MESSAGE_INTERRUPT_AFTER_MS } from "@shared/message-delivery.ts";
import type { ServerEvent, Session } from "@shared/types.ts";

/**
 * The daemon's one owner of pausing (issue #1471): one session, Pause all, and the priority
 * session. It decides, persists and publishes; it is the only writer of `Session.pause` (through
 * `Registry.setSessionPause`) and of the fleet-wide `pause_state`.
 *
 * WHAT A PAUSE IS. Two things, in this order:
 *
 *  1. A HOLD, from the moment it is asked for: `isHeld(id)` answers true, and every automated
 *     writer that could start a turn - the pending-turn outbox, Foreman, workflow packets, the
 *     resident loop, queue autopilot - asks it before typing. Nothing new starts.
 *  2. A FREEZE, at once for `now` and when the turn ends for `after-turn`: the agent's process
 *     tree is stopped with SIGSTOP. A frozen process sends and receives nothing, which is what
 *     frees the network. Resume sends SIGCONT and lifts the hold.
 *
 * OWNERSHIP. Every pause has one reason, and a bulk lift resumes only what that bulk action
 * paused: ending priority leaves a session you paused yourself paused, and so does the fleet's
 * scheduled resume. A person resuming one session lifts it whatever paused it.
 *
 * DURABILITY. The state is one `pause.state` row. A pane's agent outlives the daemon, so a
 * frozen terminal tree stays frozen across a daemon stop and is re-adopted on the next start;
 * an SDK child is ours and is drained at shutdown, so its tree is thawed first and frozen again
 * once the supervisor has restored it. A record whose session never comes back is thawed by
 * the pids it recorded and dropped.
 */

/** The mechanism, behind a seam so the decisions above are testable without real processes. */
export interface ProcessFreezer {
  /**
   * Every pid that makes up this session's agent right now - its process and each descendant -
   * or an empty list when there is no process this daemon may stop (an SDK session whose
   * driver runs inside the daemon, say).
   */
  treeOf(session: Session): Promise<ProcessRef[]>;
  /**
   * SIGSTOP each pid, parents first so none spawns a child mid-freeze. A vanished pid is fine.
   * Answers the pids that REFUSED: each of those is still running, so the caller must not call
   * the session frozen.
   */
  stop(procs: readonly ProcessRef[]): SignalFailure[];
  /**
   * SIGCONT each pid. A vanished pid is fine; so is one that was never stopped. Answers the
   * pids that refused: each of those is still stopped, so the caller must not call it resumed.
   */
  resume(procs: readonly ProcessRef[]): SignalFailure[];
}

/**
 * One process a pause stopped: its pid, and the digest of the identity (start time and command)
 * it had then. `resume` continues a pid only while it still has that identity.
 */
export interface ProcessRef {
  pid: number;
  identity: string;
}

/** The refs of `procs` whose pid is among `failures` - what is still stopped. */
function stuckOf(procs: readonly ProcessRef[], failures: readonly SignalFailure[]): ProcessRef[] {
  const failed = new Set(failures.map((f) => f.pid));
  return procs.filter((p) => failed.has(p.pid));
}

/** One pid a signal could not reach, and why (`EPERM`). An exited pid is never one. */
export interface SignalFailure {
  pid: number;
  code: string;
}

function described(failures: readonly SignalFailure[]): string {
  return failures.map((f) => `pid ${f.pid} (${f.code})`).join(", ");
}

export interface PauseStore {
  load(): StoredPauseState | undefined;
  save(state: StoredPauseState): void;
}

/** The registry surface the manager needs, named so a test can hand it a small fake. */
export interface PauseRegistry {
  getSession(id: string): Session | undefined;
  liveSessions(): Session[];
  setSessionPause(id: string, pause: SessionPause | null): boolean;
  /** When this session last resumed from a pause, for the outbox's escalation clock. */
  setSessionResumedAt(id: string, at: number | null): void;
  setPauseState(state: PauseState): void;
  subscribe(fn: (event: ServerEvent) => void): () => void;
  onSessionsObserved(fn: () => void): () => void;
}

export interface PauseManagerDeps {
  registry: PauseRegistry;
  freezer: ProcessFreezer;
  store: PauseStore;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

/** A refusal a route can hand straight back to the browser. */
export type PauseResult = { ok: true } | { ok: false; status: 404 | 409 | 400 | 500; error: string };

/** A pause that could not be saved: a restart would forget it, so the operator is told. */
const UNSAVED: PauseResult = {
  ok: false,
  status: 500,
  error: "The pause could not be saved, so a restart of Mission Control would forget it. Try again.",
};

/** A pause that stands, but whose change of owner to you could not be saved. */
const OWNER_UNSAVED: PauseResult = {
  ok: false,
  status: 500,
  error: "This session is paused, but making it yours could not be saved, so Resume all or ending priority will still resume it. Try again.",
};

/** The first retry of a freeze that failed, and the longest wait between retries. */
const FREEZE_RETRY_BASE_MS = 15_000;
const FREEZE_RETRY_MAX_MS = 5 * 60_000;

/** One session held, but its freeze refused: what the operator is told. */
function heldButRunning(why: string): PauseResult {
  return {
    ok: false,
    status: 409,
    error: `Held - nothing new will start in it - but not frozen: ${why}. It may still be running.`,
  };
}

/** A bulk pause that went through, except for the sessions whose freeze refused. */
function bulkResult(failures: readonly string[]): PauseResult {
  if (failures.length === 0) return { ok: true };
  const shown = failures.slice(0, 3).join("; ");
  const more = failures.length > 3 ? ` and ${failures.length - 3} more` : "";
  return {
    ok: false,
    status: 409,
    error: `Paused, but ${failures.length} session${failures.length === 1 ? " is" : "s are"} held without being frozen - ${shown}${more}.`,
  };
}

/**
 * Whether a record that came back after a restart has to be frozen again. A pane agent's
 * stopped processes outlive the daemon untouched, so a frozen pane record with processes needs
 * no rescan. An SDK driver is ours and was restored as a new process - drained at shutdown, or
 * gone with a crash - so it is frozen again, as is any record with nothing stopped yet: a
 * pending hold whose turn has ended, or a freeze that never recorded a process.
 *
 * A pending record that lists processes is a freeze already under way - they are saved before
 * the first SIGSTOP - which the last daemon did not live to mark frozen. Its processes may be
 * stopped, so the turn the session still reports can never end, and waiting for it would leave
 * the record pending for good: it is completed now.
 */
function needsFreezeAfterRestart(record: StoredSessionPause, session: Session): boolean {
  if (record.phase === "pending") return record.procs.length > 0 || waitsForNothing(record, session);
  if (record.runtime === "sdk") return true;
  return record.procs.length === 0;
}

/**
 * Whether this record's processes are stopped, as far as a write into the session goes: every
 * write gate refuses on this. A frozen record with processes is; so is a pending one, whose
 * freeze was begun and not finished. The exception is a restored SDK driver (`restored`) that
 * this daemon has stopped nothing of yet: it is a new process, the pids its record lists belong
 * to the driver before it, and its restart continuation has to land until its own freeze does.
 * Once this daemon has stopped any of its processes - even a freeze rolled back with a pid that
 * would not continue - those are real stopped processes, and it is gated like any other.
 */
function processesStopped(record: StoredSessionPause, restored: boolean): boolean {
  if (record.procs.length === 0) return false;
  // Whatever the phase: a frozen record a crash left behind lists the previous driver's pids.
  return record.runtime !== "sdk" || !restored;
}

/**
 * A pending pause with nothing to wait for: the turn is over, or it was a `now` pause whose
 * freeze failed and is owed again whatever the session is doing.
 */
function waitsForNothing(record: StoredSessionPause, session: Session): boolean {
  return record.mode === "now" || !turnRunning(session);
}

/** How many rescans a freeze makes after its stop, to catch what the tree spawned meanwhile. */
const SETTLE_PASSES = 4;

/** States in which a turn is still running, so an after-turn pause keeps waiting. */
function turnRunning(session: Session): boolean {
  // `awaiting_input` too: the agent asked a question mid-turn, and answering it is how the turn
  // gets to end. An after-turn pause that froze it there would leave nothing able to answer.
  return session.state === "working" || session.state === "starting" || session.state === "awaiting_input";
}

export class PauseManager {
  private readonly registry: PauseRegistry;
  private readonly freezer: ProcessFreezer;
  private readonly store: PauseStore;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string) => void;

  private records = new Map<string, StoredSessionPause>();
  /**
   * When each recently resumed session resumed. The outbox counts a queued message's steer and
   * interrupt deadlines from here rather than from its enqueue, so a message that waited through
   * a pause does not interrupt the turn the resume thawed. Persisted, so a daemon restart just
   * after a resume keeps that clock; dropped once it can no longer move a deadline.
   */
  private resumed = new Map<string, number>();
  /**
   * Freezes that failed and are waiting to be retried, by session. A failed freeze is retried on
   * a backing-off timer rather than on the next `session_upsert`, because publishing the failed
   * attempt IS a `session_upsert`: retrying on it would hammer the process table in a loop.
   */
  private freezeRetries = new Map<string, { attempt: number; timer: unknown }>();
  /**
   * SDK records that came back from the last daemon and whose current driver this daemon has
   * not stopped anything of yet (`processesStopped`). In memory on purpose: "restored" is a fact
   * about this start, and a record leaves the set the moment this daemon stops one of its pids.
   */
  private restoredSdk = new Set<string>();
  /** The pending retry of a final save that failed after a freeze (`persistSettled`), or null. */
  private saveRetry: unknown = null;
  private fleet: StoredPauseState["fleet"] = null;
  private priority: StoredPauseState["priority"] = null;
  private resumeTimer: unknown = null;
  /** How many times in a row the scheduled resume could not be saved; sets the next wait. */
  private resumeRetries = 0;
  private unsubscribe: (() => void) | null = null;
  private unobserved: (() => void) | null = null;
  /** True once startup reconciliation ran; records are not judged against an empty registry. */
  private reconciled = false;
  /** Serializes every freeze and thaw, so two clicks cannot interleave a tree walk. */
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(deps: PauseManagerDeps) {
    this.registry = deps.registry;
    this.freezer = deps.freezer;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? ((message) => console.log(`[pause] ${message}`));
  }

  /**
   * Load what the last daemon left, publish the fleet half at once, and reconcile sessions
   * after the first completed observation - before it, an absent session proves nothing.
   */
  start(): void {
    const stored = this.store.load();
    if (stored) {
      this.fleet = stored.fleet;
      this.priority = stored.priority;
      for (const [id, record] of Object.entries(stored.sessions)) {
        this.records.set(id, record);
        if (record.runtime === "sdk") this.restoredSdk.add(id);
      }
      for (const [id, at] of Object.entries(stored.resumed)) this.resumed.set(id, at);
    }
    this.pruneResumed();
    for (const [id, at] of this.resumed) this.registry.setSessionResumedAt(id, at);
    // Published at once, before any session is observed: the registry keeps the answer for an
    // id it does not hold yet, so a session restored or rediscovered before reconciliation is
    // already held, and nothing automated can start a turn in it in that window.
    for (const id of this.records.keys()) this.publishSession(id);
    this.publishFleet();
    this.armResumeTimer();
    this.unsubscribe = this.registry.subscribe((event) => this.onEvent(event));
    this.unobserved = this.registry.onSessionsObserved(() => {
      void this.serialize(() => this.reconcile());
    });
  }

  /**
   * Shutdown: thaw the SDK trees (the supervisor is about to drain those children, and a
   * stopped child cannot drain), keep their records so the next start freezes the restored
   * driver again, and leave pane trees frozen - they outlive us, and a person who paused for
   * the night did not ask for a quit to resume them. Awaits any freeze already in flight.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unobserved?.();
    if (this.resumeTimer !== null) this.clearTimer(this.resumeTimer);
    this.resumeTimer = null;
    for (const id of [...this.freezeRetries.keys()]) this.clearRetry(id);
    if (this.saveRetry !== null) this.clearTimer(this.saveRetry);
    this.saveRetry = null;
    await this.chain.catch(() => {});
    for (const [id, record] of this.records) {
      if (record.runtime !== "sdk" || record.procs.length === 0) continue;
      const stuck = this.freezer.resume(record.procs);
      if (stuck.length > 0) this.log(`${id}: could not continue ${described(stuck)} before shutdown`);
      // What would not continue stays recorded, so the next start can try again.
      record.procs = stuckOf(record.procs, stuck);
      // Frozen again once restored: the hold stands, the freeze is re-applied in `reconcile`.
    }
    this.persist();
  }

  // ---- queries --------------------------------------------------------------------------

  /** Resolves once every freeze and thaw already asked for has run. */
  idle(): Promise<void> {
    return this.chain.then(() => {});
  }

  /** Whether anything automated must refrain from starting a turn in this session. */
  isHeld(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  /**
   * The transport gate: a refusal only while this session's processes are actually stopped
   * (`processesStopped`). Narrower than `isHeld` on purpose - a restored SDK driver is not
   * stopped until reconciliation freezes it, and its restart continuation must still land.
   */
  frozenRefusal(sessionId: string): string | null {
    const record = this.records.get(sessionId);
    return record && processesStopped(record, this.restoredSdk.has(sessionId)) ? PAUSED_SESSION_REASON : null;
  }

  /** Whether automatic launches (backlog autopilot, recurring missions) are held right now. */
  dispatchHeld(): boolean {
    return (this.fleet?.holdDispatch ?? false) || this.priority !== null;
  }

  /** The refusal an automatic launch gets while launches are held, or null. */
  launchHoldReason(): string | null {
    if (this.priority) return "a priority session is running - automatic launches are held until priority ends";
    if (this.fleet?.holdDispatch) return "everything is paused - automatic launches are held until you resume";
    return null;
  }

  state(): PauseState {
    return {
      fleet: this.fleet ? { ...this.fleet } : null,
      priority: this.priority ? { ...this.priority } : null,
    };
  }

  // ---- one session ----------------------------------------------------------------------

  pause(sessionId: string, mode: SessionPauseMode = "now"): Promise<PauseResult> {
    return this.serialize(async () => {
      const session = this.registry.getSession(sessionId);
      if (!session || !canPause(session)) return { ok: false, status: 404, error: "No live session to pause" };
      if (sessionId === this.priority?.sessionId) {
        return { ok: false, status: 409, error: "This is the priority session - end priority before pausing it" };
      }
      const existing = this.records.get(sessionId);
      if (existing) {
        // Already held. A person's own pause takes ownership, so a later bulk lift leaves it;
        // asking for `now` on a session still waiting for its turn freezes it at once.
        if (mode === "now") existing.mode = "now";
        const failed = mode === "now" && existing.phase === "pending" ? await this.attemptFreeze(session, existing) : null;
        // The owner changes only with a save behind it. Unsaved, a restart would bring back the
        // old owner, so this daemon keeps it too: Resume all or ending priority still lifts the
        // session, exactly as the next one would. The freeze above saved under the old owner.
        const previous = existing.reason;
        existing.reason = "operator";
        if (!this.persist()) {
          existing.reason = previous;
          this.publishSession(sessionId);
          return OWNER_UNSAVED;
        }
        this.publishSession(sessionId);
        return failed ? heldButRunning(failed) : { ok: true };
      }
      // Saved before anything is frozen, like the bulk pauses: a pause reported as not saved
      // must not stand, or automation stays held behind it and a restart forgets it.
      const record = this.holdOnly(session, "operator", mode);
      if (!this.persist()) {
        if (this.records.get(sessionId) === record) {
          this.records.delete(sessionId);
          this.publishSession(sessionId);
        }
        return UNSAVED;
      }
      const failed = await this.freezeHeld(session, record, mode);
      // The hold and the processes it stopped are already saved (the freeze saves them before
      // its SIGSTOP), so what happened stands whatever this last save does: it is reported as
      // it is, and the save is retried rather than the operator told the pause did not happen.
      this.persistSettled();
      return failed ? heldButRunning(failed) : { ok: true };
    });
  }

  resume(sessionId: string): Promise<PauseResult> {
    return this.serialize(async () => {
      if (!this.records.has(sessionId)) {
        return this.registry.getSession(sessionId)
          ? { ok: true }
          : { ok: false, status: 404, error: "No such session" };
      }
      const failed = this.liftAll([sessionId]);
      return failed ?? { ok: true };
    });
  }

  // ---- Pause all ------------------------------------------------------------------------

  pauseFleet(options: { holdDispatch: boolean; resumeAt: number | null }): Promise<PauseResult> {
    return this.serialize(async () => {
      const now = this.now();
      if (options.resumeAt !== null && (options.resumeAt <= now || options.resumeAt - now > FLEET_PAUSE_MAX_MS)) {
        return { ok: false, status: 400, error: "The automatic resume must be in the future and within a week" };
      }
      const previousFleet = this.fleet;
      const previousPriority = this.priority;
      const converted: string[] = [];
      // Pause all supersedes priority: the priority session pauses with everything else, and
      // the sessions priority paused become the fleet's, so one Resume all brings them back.
      if (this.priority) {
        for (const [id, record] of this.records) {
          if (record.reason !== "priority") continue;
          record.reason = "fleet";
          converted.push(id);
          this.publishSession(id);
        }
        this.priority = null;
      }
      this.fleet = { since: this.fleet?.since ?? now, resumeAt: options.resumeAt, holdDispatch: options.holdDispatch };
      const held = this.holdAllSaved(bulkPauseTargets(this.liveWithPause()), "fleet", () => {
        for (const id of converted) {
          const record = this.records.get(id);
          if (!record) continue;
          record.reason = "priority";
          this.publishSession(id);
        }
        this.fleet = previousFleet;
        this.priority = previousPriority;
      });
      if (!held) return UNSAVED;
      const failures = await this.freezeAll(held);
      this.armResumeTimer();
      this.publishFleet();
      // As for one session: the holds and every freeze are already saved; only the final state
      // write remains, and it is retried rather than reported as a pause that did not happen.
      this.persistSettled();
      return bulkResult(failures);
    });
  }

  resumeFleet(): Promise<PauseResult> {
    return this.serialize(async () => this.resumeFleetNow() ?? { ok: true });
  }

  // ---- priority -------------------------------------------------------------------------

  setPriority(sessionId: string): Promise<PauseResult> {
    return this.serialize(async () => {
      const session = this.registry.getSession(sessionId);
      if (!session || !canPause(session)) return { ok: false, status: 404, error: "No live session to prioritize" };
      if (this.fleet) return { ok: false, status: 409, error: "Everything is paused - resume all before choosing a priority session" };
      if (this.priority?.sessionId === sessionId) return { ok: true };
      // A new priority session replaces the old one: the old one is never paused, so it is a
      // bulk target like any other running session, and anything already paused for priority
      // stays paused for the new one.
      //
      // Committed before anything is thawed. The new priority, the holds on the others and the
      // target's resume (as a saved intent, `resuming`) go into ONE save; until it lands nothing
      // has changed, so a save that fails undoes it all and the target stays paused as it was.
      // Only then is the target continued.
      const target = this.records.get(sessionId);
      const targetWasResuming = target?.resuming ?? false;
      const previousPriority = this.priority;
      this.priority = { sessionId, since: this.now() };
      if (target) target.resuming = true;
      const held = this.holdAllSaved(bulkPauseTargets(this.liveWithPause(), sessionId), "priority", () => {
        this.priority = previousPriority;
        if (target) target.resuming = targetWasResuming;
      });
      if (!held) return UNSAVED;
      if (target) {
        const failed = this.liftAll([sessionId]);
        if (failed) {
          // The priority session could not be continued, so it cannot have the machine: the
          // priority is withdrawn before anything is frozen for it. Its own failed resume stays
          // recorded, as any failed resume does, so Resume can finish it.
          this.dropHolds(held);
          this.priority = previousPriority;
          this.publishFleet();
          this.persist();
          return failed;
        }
      }
      const failures = await this.freezeAll(held);
      this.publishFleet();
      this.persistSettled();
      return bulkResult(failures);
    });
  }

  endPriority(): Promise<PauseResult> {
    return this.serialize(async () => this.endPriorityNow() ?? { ok: true });
  }

  // ---- internals ------------------------------------------------------------------------

  private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private liveWithPause(): Session[] {
    return this.registry.liveSessions().map((s) => ({ ...s, pause: this.publicPause(s.id) }));
  }

  /**
   * The hold alone: recorded and published, nothing awaited.
   *
   * The hold is PUBLISHED before anything is awaited. Reading the process table takes a moment,
   * and every automated writer - the outbox, Foreman, workflow packets - asks `session.pause`;
   * publishing only after the freeze would leave that moment open for one of them to start the
   * very turn the operator just paused.
   */
  private holdOnly(session: Session, reason: SessionPauseReason, mode: SessionPauseMode): StoredSessionPause {
    const record: StoredSessionPause = {
      reason,
      phase: "pending",
      since: this.now(),
      interrupted: null,
      runtime: session.runtime,
      procs: [],
      resuming: false,
      mode,
    };
    // A hold this daemon makes is never a restored driver's, whatever the id held before.
    this.restoredSdk.delete(session.id);
    this.records.set(session.id, record);
    this.publishSession(session.id);
    return record;
  }

  /** Freeze a held session now, unless an after-turn pause is still waiting for its turn. */
  private async freezeHeld(session: Session, record: StoredSessionPause, mode: SessionPauseMode): Promise<string | null> {
    const failed = mode === "now" || !turnRunning(session) ? await this.attemptFreeze(session, record) : null;
    this.publishSession(session.id);
    return failed;
  }

  /**
   * Pause all and Make priority: hold EVERY target first, then freeze them one by one. Freezing
   * one reads the process table, and holding the next only afterwards would leave every later
   * session open to automated work for as long as the earlier freezes took. Answers the
   * sessions whose freeze failed.
   */
  /**
   * Hold every target and SAVE that, before anything is frozen. A bulk pause that cannot be saved
   * is reported as failed, so it must not stand either: the holds are dropped again, `undo`
   * restores whatever else the caller changed, and null is answered. Otherwise launches and
   * deliveries would stay blocked behind a pause the operator was told did not happen, and a
   * restart would silently forget it.
   */
  private holdAllSaved(
    targets: readonly Session[],
    reason: SessionPauseReason,
    undo: () => void,
  ): Array<readonly [Session, StoredSessionPause]> | null {
    const held = targets.map((session) => [session, this.holdOnly(session, reason, "now")] as const);
    if (this.persist()) return held;
    this.dropHolds(held);
    undo();
    this.publishFleet();
    return null;
  }

  /** Drop holds that froze nothing yet: each record this call made, if it is still the one held. */
  private dropHolds(held: ReadonlyArray<readonly [Session, StoredSessionPause]>): void {
    for (const [session, record] of held) {
      if (this.records.get(session.id) !== record) continue;
      this.records.delete(session.id);
      this.publishSession(session.id);
    }
  }

  private async holdAll(targets: readonly Session[], reason: SessionPauseReason): Promise<string[]> {
    return this.freezeAll(targets.map((session) => [session, this.holdOnly(session, reason, "now")] as const));
  }

  private async freezeAll(held: ReadonlyArray<readonly [Session, StoredSessionPause]>): Promise<string[]> {
    const failures: string[] = [];
    for (const [session, record] of held) {
      if (this.records.get(session.id) !== record) continue;
      const failed = await this.freezeHeld(session, record, "now");
      if (failed) failures.push(`${session.name || session.id}: ${failed}`);
    }
    return failures;
  }

  /** One freeze attempt; a failure that leaves the record pending arms a backing-off retry. */
  private async attemptFreeze(session: Session, record: StoredSessionPause): Promise<string | null> {
    const failed = await this.freezeRecord(session, record);
    if (this.records.get(session.id) !== record) return failed;
    if (failed && record.phase === "pending") this.scheduleFreezeRetry(session.id);
    else if (!failed) this.clearRetry(session.id);
    return failed;
  }

  private scheduleFreezeRetry(sessionId: string): void {
    const previous = this.freezeRetries.get(sessionId);
    if (previous) this.clearTimer(previous.timer);
    if (this.stopped) return;
    const attempt = (previous?.attempt ?? 0) + 1;
    const delay = Math.min(FREEZE_RETRY_BASE_MS * 2 ** (attempt - 1), FREEZE_RETRY_MAX_MS);
    const timer = this.setTimer(() => {
      void this.serialize(() => this.retryFreeze(sessionId));
    }, delay);
    this.freezeRetries.set(sessionId, { attempt, timer });
  }

  private clearRetry(sessionId: string): void {
    const retry = this.freezeRetries.get(sessionId);
    if (!retry) return;
    this.clearTimer(retry.timer);
    this.freezeRetries.delete(sessionId);
  }

  private async retryFreeze(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    const live = this.registry.getSession(sessionId);
    if (!record || !live || record.phase !== "pending") {
      this.clearRetry(sessionId);
      return;
    }
    if (record.procs.length === 0 && !waitsForNothing(record, live)) {
      // An after-turn pause whose turn started meanwhile: its end is the next attempt, through
      // `onEvent`. Not a `now` pause, which keeps its timer whatever the turn is doing, and not
      // when processes are already recorded: stopped, they cannot end the turn it reports.
      this.clearRetry(sessionId);
      return;
    }
    await this.attemptFreeze(live, record);
    this.publishSession(sessionId);
    this.persistSettled();
  }

  /**
   * Stop the session's process tree and mark it frozen, or say why it could not be: null when
   * the record ends frozen (or is a hold over nothing this daemon may stop), else the reason.
   *
   * Never loses what is already stopped. A re-freeze - reconciliation after a restart - whose
   * scan fails or misses the tree keeps the pids an earlier freeze stopped, because those are
   * the only record of what a resume must continue. A verified tree is added to them.
   *
   * Never claims a freeze that did not happen. A pid that refuses SIGSTOP is still running, so
   * what this attempt newly stopped is continued again and the record stays a pending hold:
   * nothing automated starts a turn, and the card does not say frozen over a live agent.
   */
  private async freezeRecord(session: Session, record: StoredSessionPause): Promise<string | null> {
    // What it was doing is recorded at the first freeze only; a re-freeze after a restart
    // reads a session that has been standing still and would overwrite it with nothing.
    if (record.phase === "pending" && record.interrupted === null) {
      record.interrupted = turnRunning(session) ? (session.activity ?? null) : null;
    }
    let tree: ProcessRef[];
    try {
      tree = await this.freezer.treeOf(session);
    } catch (error) {
      // Lifted while the tree was being read: a resume that landed mid-walk wins.
      if (this.records.get(session.id) !== record) return null;
      const why = `its process tree could not be read (${error instanceof Error ? error.message : String(error)})`;
      this.log(`${session.id}: ${why}`);
      if (record.procs.length === 0) record.phase = "pending";
      return why;
    }
    if (this.records.get(session.id) !== record) return null;
    if (tree.length === 0) {
      // A restored SDK driver that runs as a process of its own but was not found: it has not
      // started yet. Nothing has been stopped, so it is not frozen - held, and read again on the
      // backing-off timer until it appears. Only a driver with no process of its own settles here.
      //
      // The same for a fresh driver mid-turn: a starting session has no driver pid until its
      // child spawns, and Pause now must not settle over a turn still using the network.
      if (record.runtime === "sdk" && pauseFreezes(session) && (this.restoredSdk.has(session.id) || turnRunning(session))) {
        record.phase = "pending";
        return "its driver process has not started yet";
      }
      // A scan that found none of a recorded tree is not a replacement for it: what was stopped
      // is still the record of what to continue, and there is nothing more to stop. That holds
      // for a freeze a restart interrupted too, whose session still reports the turn it was in.
      if (record.procs.length > 0) {
        this.settleFrozen(record);
        return null;
      }
      // Nothing this daemon may stop (an in-process driver). Mid-turn it stays a hold and
      // settles when the turn ends - the honest "paused" for an agent we cannot freeze.
      if (turnRunning(session)) record.phase = "pending";
      else this.settleFrozen(record);
      return null;
    }
    const before = record.procs;
    // Matched by pid AND identity. A recorded pid the tree now shows as a DIFFERENT process -
    // a restored SDK driver given its predecessor's pid, say - is stale: its process is gone,
    // and keeping its identity would make the resume skip the process that really is stopped.
    // One the tree does not show at all is kept, since a scan that misses a stopped process is
    // not proof it has gone.
    const current = new Map(tree.map((p) => [p.pid, p.identity]));
    const kept = before.filter((p) => !current.has(p.pid) || current.get(p.pid) === p.identity);
    const known = new Set(kept.map((p) => `${p.pid}:${p.identity}`));
    const fresh = tree.filter((p) => !known.has(`${p.pid}:${p.identity}`));
    // Saved BEFORE the first SIGSTOP. A pane agent outlives the daemon, and the next one finds
    // what to continue only in this record: a freeze it could not record is not made at all.
    record.procs = [...kept, ...fresh];
    if (!this.persist()) {
      record.procs = before;
      if (before.length === 0) record.phase = "pending";
      return "the pause could not be saved, so nothing was frozen";
    }
    const refused = this.freezer.stop(tree);
    if (refused.length > 0) {
      const stuck = this.freezer.resume(fresh);
      // Anything that would not continue again is still stopped, so it stays recorded - and
      // is this daemon's own stopped process, so the write gates hold it from here on.
      const stillStopped = stuckOf(fresh, stuck);
      if (stillStopped.length > 0) this.restoredSdk.delete(session.id);
      record.procs = [...kept, ...stillStopped];
      if (record.procs.length === 0) record.phase = "pending";
      this.persist();
      const why = `${described(refused)} refused to stop`;
      this.log(`${session.id}: ${why}`);
      return why;
    }
    this.restoredSdk.delete(session.id);
    // Published before the rescan is awaited: the tree IS stopped now, and the pane and SDK write
    // gates read `stopped` from the registry - an old projection would let a write through.
    this.publishSession(session.id);
    const unsettled = await this.settle(session, record);
    if (unsettled !== undefined) return unsettled;
    this.settleFrozen(record);
    return null;
  }

  /** Settle a record frozen, stamping when it first did: a re-freeze keeps the original time. */
  private settleFrozen(record: StoredSessionPause): void {
    record.phase = "frozen";
    record.frozenAt ??= this.now();
  }

  /**
   * After a stop, read the tree again until nothing in it is new. A process the walk had not
   * reached yet could spawn a child between the snapshot and its own SIGSTOP, and that child is
   * still running. A process that exec'd in that window keeps its pid and its place in the tree
   * but not its command line, so the identity read before the stop would never match it again
   * and a resume would leave it stopped; stopped now, it cannot change again, so the identity
   * read here is the one recorded. Each new process is saved before it is stopped, as in the
   * first pass. Answers undefined once the tree is settled, null when the pause was lifted
   * meanwhile, or why it could not be confirmed - the record then pending, for the retry.
   */
  private async settle(session: Session, record: StoredSessionPause): Promise<string | null | undefined> {
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      let tree: ProcessRef[];
      try {
        tree = await this.freezer.treeOf(session);
      } catch (error) {
        if (this.records.get(session.id) !== record) return null;
        record.phase = "pending";
        this.persist();
        const why = `its process tree could not be read again after the stop (${error instanceof Error ? error.message : String(error)})`;
        this.log(`${session.id}: ${why}`);
        return why;
      }
      if (this.records.get(session.id) !== record) return null;
      const now = new Map(tree.map((p) => [p.pid, p]));
      const before = record.procs;
      const restamped = before.map((p) => now.get(p.pid) ?? p);
      const changed = restamped.some((p, i) => p.identity !== before[i]!.identity);
      const known = new Set(before.map((p) => p.pid));
      const fresh = tree.filter((p) => !known.has(p.pid));
      if (fresh.length === 0) {
        if (changed) {
          record.procs = restamped;
          this.persist();
        }
        return undefined;
      }
      record.procs = [...restamped, ...fresh];
      if (!this.persist()) {
        record.procs = before;
        record.phase = "pending";
        return "the pause could not be saved, so the processes its tree started meanwhile were not frozen";
      }
      const refused = this.freezer.stop(fresh);
      if (refused.length > 0) {
        const stuck = this.freezer.resume(fresh);
        record.procs = [...restamped, ...stuckOf(fresh, stuck)];
        record.phase = "pending";
        this.persist();
        const why = `${described(refused)} refused to stop`;
        this.log(`${session.id}: ${why}`);
        return why;
      }
    }
    // Still finding new processes after every pass: something keeps spawning. Held and retried,
    // never called frozen over processes that may still be running.
    record.phase = "pending";
    this.persist();
    const why = "its process tree kept starting new processes while it was being stopped";
    this.log(`${session.id}: ${why}`);
    return why;
  }

  /**
   * Lift a pause at once, synchronously, because something is about to need the agent to
   * answer: a stop, a kill, an interrupt or a reset. A frozen SDK child never answers its
   * driver's interrupt, and a SIGTERM to a stopped process waits for a SIGCONT, so every such
   * path calls this first. The priority session is never frozen, so it has nothing to
   * release; priority ends when that session leaves (`forget`).
   */
  releaseNow(sessionId: string): string | null {
    if (!this.records.has(sessionId)) return null;
    const failed = this.liftAll([sessionId]);
    return failed && !failed.ok ? failed.error : null;
  }

  /**
   * Lift these sessions' pauses. Answers null, or the refusal to give the operator.
   *
   * Three steps, so the record of what is stopped is never lost and never wrong:
   *
   *  1. The INTENT, saved before any SIGCONT: each record is marked `resuming` and stays on
   *     disk. A lift that cannot be saved is not made - nothing is thawed - since a resume
   *     recorded nowhere would leave a restart freezing again what the operator resumed.
   *  2. The thaw. A record whose processes all continued leaves memory; one with a pid that
   *     refused keeps exactly those pids and goes back to plain frozen, so Resume can be pressed
   *     again.
   *  3. The OUTCOME, saved. If this save fails, disk still holds the `resuming` records with
   *     every pid they had: a restart finishes them (a second SIGCONT to a running process is
   *     harmless) and keeps any that still refuse. A refused pid is never left unrecorded.
   */
  private liftAll(sessionIds: readonly string[]): PauseResult | null {
    const lifting: [string, StoredSessionPause][] = [];
    for (const id of sessionIds) {
      const record = this.records.get(id);
      if (record) lifting.push([id, record]);
    }
    if (lifting.length === 0) return null;
    for (const [, record] of lifting) record.resuming = true;
    if (!this.persist()) {
      for (const [, record] of lifting) record.resuming = false;
      return {
        ok: false,
        status: 500,
        error: "The resume could not be saved, so nothing was resumed. Try again.",
      };
    }
    const failures: string[] = [];
    for (const [id, record] of lifting) {
      this.clearRetry(id);
      const stuck = this.thaw(id, record);
      if (stuck.length > 0) {
        record.procs = stuckOf(record.procs, stuck);
        record.phase = "frozen";
        record.resuming = false;
        failures.push(`${this.registry.getSession(id)?.name || id}: ${described(stuck)} would not continue`);
      } else {
        this.records.delete(id);
      }
      this.publishSession(id);
    }
    if (!this.persist()) this.log("could not save a resume's outcome; the next start finishes it");
    if (failures.length === 0) return null;
    return {
      ok: false,
      status: 409,
      error: `Not everything could be resumed - ${failures.join("; ")}. Those stay paused; press Resume again.`,
    };
  }

  /**
   * Continue a record's processes. Answers the pids that refused (empty when all continued). A
   * full continue records the resume time - before the caller clears the pause, because
   * clearing it is the session_upsert the outbox reacts to, and it must already count a held
   * message's deadlines from now.
   */
  private thaw(sessionId: string, record: StoredSessionPause): SignalFailure[] {
    const stuck = record.procs.length > 0 ? this.freezer.resume(record.procs) : [];
    if (stuck.length > 0) {
      this.log(`${sessionId}: could not continue ${described(stuck)}`);
      return stuck;
    }
    const at = this.now();
    this.resumed.set(sessionId, at);
    this.registry.setSessionResumedAt(sessionId, at);
    return [];
  }

  private resumeFleetNow(): PauseResult | null {
    if (this.fleet === null) return null;
    const fleet = this.fleet;
    this.fleet = null;
    const failed = this.endBulk("fleet");
    if (failed && !failed.ok && failed.status === 500) {
      // Not saved, so not lifted: Pause all - and its launch hold - still stands.
      this.fleet = fleet;
      return failed;
    }
    if (this.resumeTimer !== null) this.clearTimer(this.resumeTimer);
    this.resumeTimer = null;
    this.publishFleet();
    return failed;
  }

  private endPriorityNow(): PauseResult | null {
    if (this.priority === null) return null;
    const priority = this.priority;
    this.priority = null;
    const failed = this.endBulk("priority");
    if (failed && !failed.ok && failed.status === 500) {
      this.priority = priority;
      return failed;
    }
    this.publishFleet();
    return failed;
  }

  /**
   * Lift what one bulk control paused, after the caller has cleared the control in memory. The
   * cleared control is saved in the same write as the lift's intent - or, when nothing is left
   * for it to lift (each session already resumed one by one, or a priority that paused nobody),
   * in a write of its own. Either way it is saved BEFORE success is reported: a cleared control
   * recorded nowhere would come back, launch hold and all, on the next start.
   */
  private endBulk(reason: "fleet" | "priority"): PauseResult | null {
    const ids = [...this.records].filter(([, r]) => r.reason === reason).map(([id]) => id);
    if (ids.length === 0) {
      return this.persist()
        ? null
        : { ok: false, status: 500, error: "The change could not be saved, so nothing was changed. Try again." };
    }
    return this.liftAll(ids);
  }

  private armResumeTimer(): void {
    if (this.resumeTimer !== null) this.clearTimer(this.resumeTimer);
    this.resumeTimer = null;
    this.resumeRetries = 0;
    const at = this.fleet?.resumeAt;
    if (at == null || this.stopped) return;
    // Clamped: a resume time that passed while the daemon was down fires at once.
    this.resumeTimer = this.setTimer(() => this.fireScheduledResume(), Math.max(0, at - this.now()));
  }

  /**
   * The scheduled resume. One that could not be saved left the fleet paused, and is tried again
   * on the freeze retry's backing-off timer - never at once: the resume time is in the past, so
   * re-arming for it would fire immediately and loop for as long as storage keeps failing.
   */
  private fireScheduledResume(): void {
    this.resumeTimer = null;
    this.log("scheduled resume reached");
    void this.serialize(() => {
      const failed = this.resumeFleetNow();
      if (!failed || failed.ok || failed.status !== 500 || this.stopped || this.fleet === null) {
        this.resumeRetries = 0;
        if (failed && !failed.ok) this.log(`scheduled resume: ${failed.error}`);
        return;
      }
      this.resumeRetries += 1;
      const delay = Math.min(FREEZE_RETRY_BASE_MS * 2 ** (this.resumeRetries - 1), FREEZE_RETRY_MAX_MS);
      this.log(`scheduled resume: ${failed.error} Retrying in ${Math.round(delay / 1000)}s.`);
      this.resumeTimer = this.setTimer(() => this.fireScheduledResume(), delay);
    });
  }

  private onEvent(event: ServerEvent): void {
    if (event.type === "session_remove") {
      void this.serialize(() => this.forget(event.id));
      return;
    }
    if (event.type !== "session_upsert") return;
    const record = this.records.get(event.session.id);
    // An after-turn pause freezes the moment its turn ends.
    // Not while a failed freeze waits for its retry: that retry's timer owns the next attempt,
    // and this event may be the manager's own publish of the failure.
    if (record?.phase === "pending" && !turnRunning(event.session) && this.reconciled
      && !this.freezeRetries.has(event.session.id)) {
      void this.serialize(async () => {
        const live = this.registry.getSession(event.session.id);
        const current = this.records.get(event.session.id);
        if (!live || current !== record || record.phase !== "pending" || turnRunning(live)) return;
        if (this.freezeRetries.has(live.id)) return;
        await this.attemptFreeze(live, record);
        this.publishSession(live.id);
        this.persistSettled();
      });
    }
  }

  /** A session left for good: thaw whatever it left stopped, and end priority if it was it. */
  private forget(sessionId: string): void {
    const record = this.records.get(sessionId);
    this.clearRetry(sessionId);
    if (record) {
      const stuck = record.procs.length > 0 ? this.freezer.resume(record.procs) : [];
      if (stuck.length > 0) {
        // Its session is gone, but these may not be: kept as a resume to finish, so the next
        // start tries again rather than leaving them stopped with nothing to say so.
        this.log(`${sessionId} left, and ${described(stuck)} would not continue`);
        this.records.set(sessionId, { ...record, procs: stuckOf(record.procs, stuck), resuming: true });
      } else {
        this.records.delete(sessionId);
      }
    }
    if (this.resumed.delete(sessionId)) this.registry.setSessionResumedAt(sessionId, null);
    if (this.priority?.sessionId === sessionId) {
      const failed = this.endPriorityNow();
      if (failed && !failed.ok) this.log(`ending priority for ${sessionId}: ${failed.error}`);
      return;
    }
    if (record) this.persist();
  }

  /**
   * After the first completed observation: re-freeze every record whose session came back,
   * thaw and drop every record whose session did not, and drop a priority session that is gone.
   */
  private async reconcile(): Promise<void> {
    // Once per start. It re-reads process trees, and a paused fleet must not be rescanned and
    // re-signalled on every later observation for the length of the pause.
    if (this.reconciled) return;
    this.reconciled = true;
    for (const [id, record] of [...this.records]) {
      const session = this.registry.getSession(id);
      const present = session !== undefined && canPause(session);
      if (record.resuming || !present) {
        // A resume the last daemon asked for, or a session that did not come back: continue its
        // processes, and keep only a pid that still refuses, as a resume still to finish.
        const stuck = this.thaw(id, record);
        if (stuck.length > 0) {
          this.log(`${id}: ${described(stuck)} would not continue after the restart`);
          record.procs = stuckOf(record.procs, stuck);
          record.phase = "frozen";
          record.resuming = !present;
        } else {
          this.records.delete(id);
          if (!present) this.log(`dropped the pause of ${id}, which did not come back`);
        }
        // `start` published it so a returning session would be held; this is the answer now.
        this.publishSession(id);
        continue;
      }
      if (needsFreezeAfterRestart(record, session)) {
        // A restored SDK driver is a new process, so its freeze is INCOMPLETE until this one
        // succeeds, whatever processes the record still lists from the driver before it. Marked
        // pending - those references kept for a resume to continue - so a failed read is
        // retried on the backing-off timer and the card never says frozen over a live driver.
        if (record.runtime === "sdk") record.phase = "pending";
        await this.attemptFreeze(session, record);
      }
      this.publishSession(id);
    }
    if (this.priority && !this.registry.getSession(this.priority.sessionId)) {
      const failed = this.endPriorityNow();
      if (failed && !failed.ok) this.log(`ending priority after a restart: ${failed.error}`);
    }
    this.publishFleet();
    this.persistSettled();
  }

  /** Forget resume times too old to move any deadline: past the interrupt, both clocks agree. */
  private pruneResumed(): void {
    const cutoff = this.now() - MESSAGE_INTERRUPT_AFTER_MS;
    for (const [id, at] of [...this.resumed]) {
      if (at >= cutoff) continue;
      this.resumed.delete(id);
      this.registry.setSessionResumedAt(id, null);
    }
  }

  private publicPause(sessionId: string): SessionPause | null {
    const record = this.records.get(sessionId);
    if (!record) return null;
    return {
      reason: record.reason,
      phase: record.phase,
      since: record.since,
      interrupted: record.interrupted,
      stopped: processesStopped(record, this.restoredSdk.has(sessionId)),
      frozenAt: record.frozenAt ?? null,
    };
  }

  private publishSession(sessionId: string): void {
    this.registry.setSessionPause(sessionId, this.publicPause(sessionId));
  }

  private publishFleet(): void {
    this.registry.setPauseState(this.fleet || this.priority ? this.state() : EMPTY_PAUSE_STATE);
  }

  /** Save the whole state; false when it could not be written. */
  /**
   * The save after a freeze that already happened. Everything a restart needs to recover is
   * saved before each SIGSTOP, so this write's failure undoes nothing and is not the operator's
   * problem to retry: it is retried here on the backing-off timer until a save lands. Any later
   * successful save covers it too, and cancels the retry (`persist`).
   */
  private persistSettled(): void {
    if (!this.persist()) this.scheduleSaveRetry(1);
  }

  private scheduleSaveRetry(attempt: number): void {
    if (this.stopped) return;
    if (this.saveRetry !== null) this.clearTimer(this.saveRetry);
    const delay = Math.min(FREEZE_RETRY_BASE_MS * 2 ** (attempt - 1), FREEZE_RETRY_MAX_MS);
    this.saveRetry = this.setTimer(() => {
      void this.serialize(() => {
        this.saveRetry = null;
        if (!this.persist()) this.scheduleSaveRetry(attempt + 1);
      });
    }, delay);
  }

  private persist(): boolean {
    try {
      this.pruneResumed();
      this.store.save({
        fleet: this.fleet,
        priority: this.priority,
        sessions: Object.fromEntries(this.records),
        resumed: Object.fromEntries(this.resumed),
      });
      if (this.saveRetry !== null) {
        this.clearTimer(this.saveRetry);
        this.saveRetry = null;
      }
      return true;
    } catch (error) {
      this.log(`could not save pause state: ${String(error)}`);
      return false;
    }
  }
}
