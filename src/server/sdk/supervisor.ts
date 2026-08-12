import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  AgentType,
  PermissionMode,
  SdkSendDisposition,
  Session,
  ThinkingLevel,
} from "@shared/types.ts";
import type { Registry, SdkSessionRegistration } from "../registry.ts";
import type { SdkSessionHandle, SdkTurn, SessionRequestAnswer } from "../harness/types.ts";
import { sdkFor } from "../harness/index.ts";
import { missionMcpDescriptor, type MissionMcpDescriptor } from "../mission-mcp.ts";
import { SDK_SESSION_ID_PREFIX } from "../registry.ts";
import { sleep } from "../util/timers.ts";
import {
  listSdkSessions,
  recordSdkSessionBinding,
  sdkSessionIsLive,
  setSdkSessionEffort,
  setSdkSessionModel,
  setSdkSessionPermissionMode,
  setSdkSessionStatus,
  setSdkSessionTurnInProgress,
  upsertSdkSession,
  type SdkSessionRow,
  type SdkSessionStatus,
} from "./store.ts";

/**
 * What an interrupt FOUND, as distinct from whether the driver took the call.
 *
 * `idle` is the case that needs a name. A driver accepts an interrupt that arrives after its
 * turn already ended, so a successful call is not evidence that anything was stopped - and
 * the follow-through the operator asked for (dropping the messages queued behind that turn)
 * is destructive, so it has to know the difference. See `SdkSupervisor.interrupt`.
 */
export type SdkInterruptOutcome = "interrupted" | "idle";

const RESTART_CONTINUATION_PROMPT =
  "Mission Control restarted while your previous turn was still in progress. " +
  "Continue that work from the current checkout and conversation. Inspect the current " +
  "state before acting, do not repeat completed work, and ask again for any approval or " +
  "input you still need.";

/**
 * The owner of every embedded (SDK-runtime) session: its handle, its row, and its events.
 *
 * IN THE DAEMON, and for the Inspector's two reasons rather than by default. A packaged
 * Electron build never starts the Foreman worker, so a feature living there would silently
 * not exist in the shipped app; and every piece of this state has to survive a restart,
 * which means it has to sit next to the process that owns the database. The Foreman stays
 * HTTP-only and reaches these sessions through routes like any other client.
 *
 * What it is FOR, put another way: `applyDiscovery` exists because the OS can rebuild a
 * pane-backed session, and this exists because nothing can rebuild one of these. There is no
 * process on a tty to re-find - the subprocess is our child, its conversation lives in the
 * harness's own session file, and the only thing that knows the two belong together is the
 * row this class keeps.
 */
export class SdkSupervisor {
  /** Live handles by session id. The only reference to a running driver. */
  private handles = new Map<string, SdkSessionHandle>();
  /**
   * The tail of each session's delivery chain.
   *
   * This is the pane lock's job without the pane: two turns delivered concurrently to one
   * conversation is the same interleaving hazard as two pastes into one composer, minus the
   * screen. Per session rather than global, because sessions are genuinely independent here -
   * unlike panes, which can be nested.
   */
  private sends = new Map<string, Promise<unknown>>();
  private pumps = new Map<string, Promise<void>>();
  private unfinishedTurns = new Map<string, number>();
  private acceptingTurns = new Set<string>();
  private stopping = new Set<string>();
  private stopPromises = new Map<string, Promise<void>>();
  /** Sessions with a terminal handoff in flight. See `beginHandoff`. */
  private handingOff = new Set<string>();
  /**
   * Set once the daemon is going down, and read by the event pump.
   *
   * It decides ONE thing, and that thing is the whole of resume-on-restart: whether a
   * driver ending gets written as `exited` (it finished, or it broke) or as `suspended` (we
   * ended it, and promised to pick it up). Without the distinction, a clean restart would
   * be indistinguishable from an agent that completed, and `reconcileOnStartup` would
   * reclaim the worktree of work that was merely interrupted.
   */
  private shuttingDown = false;

  constructor(
    private readonly registry: Registry,
    private readonly deps: {
      missionMcpDescriptor?: typeof missionMcpDescriptor;
    } = {},
  ) {}

  /**
   * Restore what the previous daemon left behind - BEFORE the discovery poller starts.
   *
   * That ordering is a contract, not a nicety. `registry.onSessionsObserved` is the moment
   * task and workflow reconciliation runs, and it fires on the first COMPLETED sweep; a
   * session registered after it has already fired is invisible to the reconciliation that
   * would have settled its task, so an embedded session's task would sit `running` with
   * nothing able to see it. Registering first makes an SDK session look exactly like a
   * rediscovered terminal one to every restart twin.
   *
   * A row that cannot be resumed - no driver for its harness any more, no identity to
   * resume from, or a relaunch that threw - is still REGISTERED and then evicted through
   * the ordinary sequence, rather than quietly failed in the database. That is what makes
   * `TaskManager.reconcileTasksBoundTo` settle its task visibly; a row marked `failed` with
   * no card ever appearing leaves the task `running` for ever with nothing to look at.
   */
  async restore(): Promise<void> {
    for (const row of listSdkSessions()) {
      if (row.status === null) {
        // Written by a build that knows a status this one does not. Left exactly as it is:
        // failing a row we cannot read would discard a session a newer daemon could resume.
        console.warn(
          `[sdk] leaving ${row.id} alone: unreadable status ${JSON.stringify(row.statusRaw)}`,
        );
        continue;
      }
      if (!sdkSessionIsLive(row)) continue;
      try {
        await this.resume(row);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[sdk] could not resume ${row.id}: ${why}`);
        this.registerAndEvict(row, why);
      }
    }
  }

  /**
   * Launch a new embedded session and put its card on the dashboard.
   *
   * The order is load-bearing at both ends. The DRIVER starts first, because a launch that
   * throws must leave nothing behind - no row, no card, no SSE frame anyone has to unsay -
   * and `SdkSpec.launch` is documented to reject rather than degrade for exactly this. The
   * handle is then adopted, and an adoption that refuses stops the driver it could not take
   * ownership of rather than leaking a subprocess nothing is pumping.
   */
  async start(input: {
    agent: AgentType;
    /** What the card is called. The dispatcher passes the task's label. */
    name: string;
    cwd: string;
    /** Turn one. There is no separate "type the prompt" step for an embedded session. */
    prompt: string;
    model: string | null;
    effort: ThinkingLevel | null;
    permissionMode: PermissionMode | null;
    mcp: MissionMcpDescriptor | null;
    /**
     * Secondary worktrees this session must be able to write to (multi-repo tasks).
     * Optional so every existing caller is unchanged; omitted means the ordinary
     * single-checkout session.
     */
    extraDirs?: readonly string[];
    taskId: string | null;
    gitBranch?: string | null;
    gitRoot?: string | null;
    repoRoot?: string | null;
  }): Promise<Session> {
    const spec = sdkFor(input.agent);
    if (!spec) throw new Error(`${input.agent} has no embedded driver`);
    const id = `${SDK_SESSION_ID_PREFIX}${randomUUID()}`;
    const handle = await spec.launch({
      cwd: input.cwd,
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      mcp: input.mcp,
      extraDirs: input.extraDirs ?? [],
      resume: null,
    });
    return this.adopt({
      registration: {
        id,
        agent: input.agent,
        name: input.name,
        cwd: input.cwd,
        permissionMode: input.permissionMode,
        gitBranch: input.gitBranch ?? null,
        gitRoot: input.gitRoot ?? null,
        repoRoot: input.repoRoot ?? null,
      },
      handle,
      durable: {
        taskId: input.taskId,
        model: input.model,
        effort: input.effort,
        // The driver accepted turn one before `adopt` can persist anything. Recording it
        // here closes the startup window before the detached event pump catches up.
        turnInProgress: input.prompt.length > 0,
      },
    });
  }

  /**
   * Take ownership of a launched handle: persist it, put the card on the dashboard, then pump.
   *
   * Refusal comes first because an invalid id must not leave an orphan row and a duplicate
   * must not erase a live row's binding with null and `starting`. The row comes next because
   * registration emits an SSE frame that cannot be rolled back if SQLite then refuses the
   * write. The pump starts last so its first `bound` cannot race the card into existence.
   */
  adopt(input: {
    registration: SdkSessionRegistration;
    handle: SdkSessionHandle;
    /**
     * What only the ROW needs: the facts a resume has to be cut from, which the dashboard
     * has no question to ask of. Kept apart from the registration rather than folded into
     * it, so nothing durable is inferred from what a card happens to render.
     */
    durable: {
      taskId: string | null;
      model: string | null;
      effort: ThinkingLevel | null;
      /** Carried on a RESUME, so the row keeps the identity it is being picked up from. */
      agentSessionId?: string | null;
      /** Carried on a resume; adopting a fresh handle must not forgive unfinished work. */
      turnInProgress: boolean;
      acceptedTurns?: number;
    };
  }): Session {
    const { registration, handle, durable } = input;
    const refusal = this.registry.sdkRegistrationRefusal(registration.id);
    if (refusal) {
      // The handle is ours and nothing will ever pump it, so let it go rather than leaving
      // a subprocess alive with no card, no row and no way for anyone to find it.
      void handle.stop().catch(() => {});
      throw new Error(refusal);
    }
    upsertSdkSession({
      id: registration.id,
      agent: registration.agent,
      agentSessionId: durable.agentSessionId ?? null,
      cwd: registration.cwd,
      taskId: durable.taskId,
      model: durable.model,
      effort: durable.effort,
      permissionMode: registration.permissionMode ?? null,
      status: "starting",
      turnInProgress: durable.turnInProgress,
    });
    const session = this.registry.registerSdkSession({
      ...registration,
      agentSessionId: durable.agentSessionId ?? null,
    });
    this.handles.set(registration.id, handle);
    this.unfinishedTurns.set(
      registration.id,
      durable.acceptedTurns ?? (durable.turnInProgress ? 1 : 0),
    );
    const pump = this.pump(registration.id, handle);
    this.pumps.set(registration.id, pump);
    void pump.catch((err) => {
      console.error(`[sdk] detached event pump for ${registration.id} failed:`, err);
    });
    return session;
  }

  /** The live handle for a session, or null when nothing is driving it. */
  handleFor(id: string): SdkSessionHandle | null {
    return this.handles.get(id) ?? null;
  }

  /**
   * Claim this session for a terminal handoff, or refuse because one is already under way.
   *
   * The pane lock's job again, for the one operation that is neither a send nor a stop.
   * A handoff is NOT idempotent: it clears the task binding, stops the driver, and spawns
   * `claude --resume` on the conversation. Two of them racing would each pass their own
   * preflight, both stop a driver only one of them actually stopped, and both spawn - two
   * agents continuing ONE conversation in one checkout, with the task binding reachable by
   * only one of them. So the second is REFUSED rather than queued: waiting would just run
   * the same duplicate spawn a moment later.
   *
   * Lives here rather than in `handoff.ts` because per-session exclusion is what this class
   * already owns (`sends`, `stopping`), and a second place that serializes one session is a
   * second place to get it wrong.
   */
  beginHandoff(id: string): boolean {
    if (this.handingOff.has(id)) return false;
    this.handingOff.add(id);
    return true;
  }

  /** Release the claim. Safe to call whether the handoff succeeded or not. */
  endHandoff(id: string): void {
    this.handingOff.delete(id);
  }

  /**
   * Deliver a turn, serialized behind whatever this session is already being sent.
   *
   * Rejects when there is no handle rather than resolving: "delivered to nobody" is the
   * shape of failure the acked send exists to remove, so it must not be reintroduced here.
   */
  send(
    id: string,
    turn: SdkTurn,
    beforeSend?: () => string | null,
  ): Promise<SdkSendDisposition> {
    return this.serialize(id, async (handle) => {
      const blocked = beforeSend?.();
      if (blocked) throw new Error(blocked);
      const unfinished = this.unfinishedTurns.get(id) ?? 0;
      // Cross the durable boundary BEFORE the driver can accept the turn. If this write
      // fails, delivery must reject without invoking the driver; accepting first leaves a
      // crash window where restart reads an idle row and silently drops acknowledged work.
      setSdkSessionTurnInProgress(id, true);
      this.unfinishedTurns.set(id, unfinished + 1);
      this.acceptingTurns.add(id);
      try {
        const disposition = await handle.send(turn);
        if (disposition === "steered") {
          // Steering joins the active turn instead of creating another completion to wait
          // for. Release this send's pessimistic reservation, while conservatively keeping
          // one outstanding turn if the driver knew it was working before our event pump did.
          this.unfinishedTurns.set(
            id,
            Math.max(1, (this.unfinishedTurns.get(id) ?? 1) - 1),
          );
        }
        return disposition;
      } catch (err) {
        // The driver rejected the turn, so it will not produce a completion for the slot we
        // reserved. Retire exactly that slot; any older accepted turn remains recoverable.
        const remaining = Math.max(0, (this.unfinishedTurns.get(id) ?? 1) - 1);
        this.unfinishedTurns.set(id, remaining);
        this.recordTurnInProgress(id, remaining > 0);
        throw err;
      } finally {
        this.acceptingTurns.delete(id);
      }
    });
  }

  /**
   * Start a turn only if the driver remains idle at its own acceptance boundary.
   *
   * This is intentionally not implemented as `registry says idle` followed by `send`:
   * Codex would steer if work began in that gap, and Claude would accept into its private
   * queue. A null rolls back the durable reservation and leaves the caller's outbox row
   * untouched for the next confirmed idle transition.
   */
  sendWhenIdle(
    id: string,
    turn: SdkTurn,
    beforeSend?: () => string | null,
  ): Promise<"started" | null> {
    return this.serialize(id, async (handle) => {
      const blocked = beforeSend?.();
      if (blocked) throw new Error(blocked);
      const unfinished = this.unfinishedTurns.get(id) ?? 0;
      setSdkSessionTurnInProgress(id, true);
      this.unfinishedTurns.set(id, unfinished + 1);
      this.acceptingTurns.add(id);
      try {
        const disposition = await handle.sendIfIdle(turn);
        if (disposition === null) {
          const remaining = Math.max(0, (this.unfinishedTurns.get(id) ?? 1) - 1);
          this.unfinishedTurns.set(id, remaining);
          this.recordTurnInProgress(id, remaining > 0);
        }
        return disposition;
      } catch (err) {
        const remaining = Math.max(0, (this.unfinishedTurns.get(id) ?? 1) - 1);
        this.unfinishedTurns.set(id, remaining);
        this.recordTurnInProgress(id, remaining > 0);
        throw err;
      } finally {
        this.acceptingTurns.delete(id);
      }
    });
  }

  /** Resolve a pending request. Serialized with sends - it is input to the same turn. */
  answer(id: string, requestId: string, answer: SessionRequestAnswer): Promise<void> {
    return this.serialize(id, (handle) => handle.answer(requestId, answer));
  }

  setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    return this.serialize(id, async (handle) => {
      if (!handle.setPermissionMode) {
        throw new Error("this session's embedded driver cannot change permission mode");
      }
      await handle.setPermissionMode(mode);
      setSdkSessionPermissionMode(id, mode);
    });
  }

  setEffort(id: string, effort: ThinkingLevel): Promise<void> {
    return this.serialize(id, async (handle) => {
      if (!handle.setEffort) {
        throw new Error("this session's embedded driver cannot change reasoning effort");
      }
      await handle.setEffort(effort);
      setSdkSessionEffort(id, effort);
    });
  }

  /**
   * The third control, completing the pair above.
   *
   * All three follow one order and it is the order that matters: ask the DRIVER first, and
   * persist only once it accepted. A row written first would promise a posture across a
   * restart that the live session refused - and Codex refuses a mode whose sandbox its
   * running thread cannot move to, so that is a real branch rather than a hypothetical.
   *
   * The durable write is what carries an accepted change through a restart: `resume`
   * relaunches from these columns, so a change made while a session is idle is re-asserted
   * on its next turn rather than lost. That is deliberately SEPARATE from the card's
   * observed value, which the routes leave alone until the harness confirms the change -
   * one says what the session will run under, the other what it is running under now.
   */
  setModel(id: string, model: string): Promise<void> {
    return this.serialize(id, async (handle) => {
      if (!handle.setModel) {
        throw new Error("this session's embedded driver cannot change model");
      }
      await handle.setModel(model);
      setSdkSessionModel(id, model);
    });
  }

  /**
   * Wipe this session's conversation, and say whether the driver could.
   *
   * Serialized with sends because it IS one on every driver that implements it by sending a
   * command: a clear that overtook a queued turn would wipe the context that turn was
   * written for.
   *
   * A false is the honest answer for a driver whose transport cannot clear, and it lands on
   * the byte-identical `cleared: false` a pane-less terminal session has always produced -
   * the tested degradation, not a new branch. It REJECTS only when there is no live driver
   * at all, which is a different fact and the caller's to report as one.
   */
  clearContext(id: string): Promise<boolean> {
    return this.serialize(id, async (handle) => {
      if (!handle.clearContext) return false;
      await handle.clearContext();
      return true;
    });
  }

  /**
   * Stop the turn this session is running right now, and leave the session alive.
   *
   * The thing `stop` is not. Kill and Complete end the conversation; this ends only what the
   * agent is doing, so the context worth keeping survives and the next instruction can be
   * typed into the same session. Both shipped drivers already implement the primitive
   * (`claude/sdk.ts` calls the vendor `query.interrupt()`, `codex/sdk.ts` issues
   * `turn/interrupt`) and both tolerate arriving a moment after the turn finished; this
   * method is the first caller above them that is not `stop()` or `clearContext()`.
   *
   * Two decisions here look like oversights and are not:
   *
   * NOT SERIALIZED. `send()` runs a per-session FIFO and this deliberately does not enter
   * it, reading `this.handles` directly the way `stop(id)` does. An interrupt queued behind
   * the turn it exists to cancel would be delivered after that turn ended, which is the
   * same as not delivering it.
   *
   * NO TURN BOOKKEEPING. `unfinishedTurns` and `sdk_sessions.turn_in_progress` look like
   * state an interrupt should clear, and clearing them here would be a double-count. They
   * are maintained by the event pump on `turn_done`, and both drivers emit `turn_done`
   * after an interrupt - Claude on the CLI's `result` message, Codex through
   * `turn/completed`. The reconciliation is theirs; touching it from here would leave the
   * counter negative-clamped at zero with a turn still outstanding, and restart recovery
   * reads exactly those two values.
   *
   * WHAT IT REPORTS is not whether the call succeeded. Both drivers accept an interrupt that
   * arrives after the turn already ended - Codex returns early with a comment saying a late
   * one must not error - so "the driver took it" says nothing about whether anything was
   * stopped. The distinction is not academic: everything the caller does NEXT is destructive
   * (it drops the session's queued messages) and must not happen on a stop that found
   * nothing. `unfinishedTurns` is the daemon's own answer to "is a turn outstanding", the
   * same value restart recovery is cut from, so it is the one to ask.
   *
   * Read BEFORE the driver call, deliberately. A turn can still finish inside the await, so
   * this is not a race that can be closed - only narrowed, from the seconds between a card
   * rendering `working` and an operator's keypress reaching the daemon, down to the length of
   * one RPC. Reading after would be strictly worse: it would report `idle` for every
   * interrupt that WORKED, since a successful one ends the turn.
   *
   * The driver is asked either way. It is idempotent, both adapters document tolerating it,
   * and doing so covers the opposite race - a turn that started in a gap our accounting has
   * not seen yet.
   *
   * Null means there is no live driver at all, which is a different fact and the caller's to
   * report as one.
   */
  async interrupt(id: string): Promise<SdkInterruptOutcome | null> {
    const handle = this.handles.get(id);
    if (!handle) return null;
    const running = (this.unfinishedTurns.get(id) ?? 0) > 0;
    await handle.interrupt();
    return running ? "interrupted" : "idle";
  }

  /**
   * Accept an operator stop without making the HTTP request wait for driver exit.
   *
   * `stop()` remains the draining primitive used by terminal handoff and daemon shutdown.
   * This method changes only who waits: it marks the card unavailable synchronously, starts
   * that same stop path, and lets the existing pump own `exited` and eviction. If asking the
   * handle to stop rejects before the handle disappears, put the card back rather than leave
   * a live driver permanently presented as stopping.
   */
  requestStop(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    const previous = this.registry.markSessionStopping(id);
    if (!previous) return false;
    const stopping = this.stop(id);
    // A repeated Complete sees the presentation written by the first one. That first caller
    // already owns failure restoration; attaching another handler with `stopping` as its
    // previous state would undo the correct restoration when the shared drain rejects.
    if (previous.state === "stopping") return true;
    void stopping.catch((err) => {
      console.error(`[sdk] accepted stop for ${id} failed:`, err);
      if (this.handles.get(id) !== handle) return;
      this.stopping.delete(id);
      this.registry.restoreSessionAfterStopFailure(id, previous);
    });
    return true;
  }

  /**
   * Stop a session's driver.
   *
   * Deliberately NOT queued behind pending sends: stopping is what a caller asks for when
   * it no longer wants them delivered. The handle then emits `exited`, and the pump turns
   * that into the ordinary eviction sequence - this method never removes a card itself,
   * because `session_remove` has exactly one owner (see `Registry.beginEviction`).
   *
   * Awaits the PUMP, not just the handle: a caller that stops a session in order to do
   * something else with its conversation - the terminal handoff is the one that matters -
   * has to know the harness has finished writing that conversation's file before it hands
   * the id to another process.
   */
  stop(id: string): Promise<void> {
    const existing = this.stopPromises.get(id);
    if (existing) return existing;
    const handle = this.handles.get(id);
    if (!handle) return Promise.resolve();
    this.stopping.add(id);
    const stopping = (async () => {
      await handle.stop();
      await this.pumps.get(id)?.catch(() => {});
    })();
    this.stopPromises.set(id, stopping);
    void stopping.then(
      () => {
        if (this.stopPromises.get(id) === stopping) this.stopPromises.delete(id);
      },
      () => {
        if (this.stopPromises.get(id) !== stopping) return;
        this.stopPromises.delete(id);
        // A rejected stop left this same handle live. Make it reachable again; an
        // interactive join restores the card presentation in its own catch handler.
        if (this.handles.get(id) === handle) this.stopping.delete(id);
      },
    );
    return stopping;
  }

  /**
   * Stop every driver, gracefully, because the daemon is going down.
   *
   * The graceful-drain half of the source plan's one accepted regression: an embedded
   * session's subprocess dies with us, so the least we can do is interrupt it, let it close
   * its session file, and record that we are the ones who ended it - `suspended`, which is
   * what `restore` picks back up. Bounded, because a shutdown that hangs on one wedged
   * driver is worse than one that leaves it to the OS.
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    this.shuttingDown = true;
    const ids = [...this.handles.keys()];
    if (ids.length === 0) return;
    const drained = Promise.allSettled(ids.map((id) => this.stop(id)));
    await Promise.race([drained, sleep(timeoutMs)]);
    // Whatever did not drain in time is still OUR session and still resumable: the row has
    // to say so before the process goes, because after that nothing will.
    for (const id of ids) {
      if (!this.handles.has(id)) continue;
      try {
        setSdkSessionStatus(id, "suspended");
      } catch (err) {
        console.error(`[sdk] could not mark ${id} suspended:`, err);
      }
    }
  }

  /**
   * Whether the agent this task was dispatched to is still there - or null if it was never
   * an embedded one.
   *
   * The SDK arm of the three-valued liveness contract `homeAlive` states, and the reason it
   * can be stricter: `homeAlive`'s `null` means "no installed terminal backend could tell
   * us", which is a question this supervisor never has to ask. Either we are holding the
   * handle, or the durable row says what became of it. Null here is not that uncertainty -
   * it means this task has no embedded session at all, so the caller should go on and ask
   * the terminal axis, which is the only other place an answer could come from.
   *
   * Answered from the ROW as well as the map because it is consulted during startup
   * reconciliation, which runs before `restore` has relaunched anything: a row that says it
   * was alive is a session this daemon is about to pick back up, and reading the empty
   * handle map at that moment would reclaim its worktree out from under it.
   */
  taskLiveness(taskId: string): boolean | null {
    const newest = this.newestRowForTask(taskId);
    if (!newest) return null;
    return this.handles.has(newest.id) || sdkSessionIsLive(newest);
  }

  /**
   * The embedded session id this task's agent is (or is about to be) driving, or null.
   *
   * Same row `taskLiveness` reads, and it exists because a caller sometimes needs to bind
   * to that session rather than merely know it is there. Startup reconciliation is the one:
   * a daemon that died between `start()` persisting the row and the dispatcher recording
   * `sessionId` left a `dispatching` task whose agent is real and about to be resumed, and
   * the id is the only thing that can finish that dispatch.
   *
   * Answers only for a LIVE row, so a task whose last embedded session ended is not handed
   * a dead id to bind itself to.
   */
  liveSessionForTask(taskId: string): string | null {
    const newest = this.newestRowForTask(taskId);
    if (!newest) return null;
    return this.handles.has(newest.id) || sdkSessionIsLive(newest) ? newest.id : null;
  }

  /**
   * The row that answers for a task. Newest wins: a task re-dispatched after a failure has
   * two rows, and only the last one is about it now.
   */
  private newestRowForTask(taskId: string): SdkSessionRow | null {
    const rows = listSdkSessions().filter((r) => r.taskId === taskId);
    return rows.length === 0 ? null : rows[rows.length - 1]!;
  }

  /**
   * Best-effort durable mirror of the driver's turn lifecycle.
   *
   * A write failure after delivery cannot change an already-acknowledged turn into a
   * rejection: the caller would reasonably retry text the harness already accepted.
   * Pre-delivery reservation is deliberately stricter and writes directly in `send`, before
   * the driver is invoked. Lifecycle events and rejected-send rollback use this best-effort
   * mirror, preferring an extra recovery prompt over silently losing accepted work.
   */
  private recordTurnInProgress(id: string, turnInProgress: boolean): void {
    try {
      setSdkSessionTurnInProgress(id, turnInProgress);
    } catch (err) {
      console.error(
        `[sdk] could not record turn state for ${id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private serialize<T>(id: string, op: (handle: SdkSessionHandle) => Promise<T>): Promise<T> {
    const handle = this.handles.get(id);
    const noLiveDriver = () => new Error(`no live driver for session ${id}`);
    if (!handle || this.stopping.has(id)) return Promise.reject(noLiveDriver());
    const prior = this.sends.get(id) ?? Promise.resolve();
    // `catch` on the chain, never on the returned promise: a failed delivery must not stop
    // the next one from being attempted, and must still reject for the caller that made it.
    const next = prior.then(() => {
      // Exit deletes the ownership maps but cannot cancel a chain that is already built, and
      // stop keeps the handle until the pump consumes `exited` or the stream ends. Identity
      // alone would let a queued turn land on the half of a terminal handoff being torn down.
      if (this.handles.get(id) !== handle || this.stopping.has(id)) throw noLiveDriver();
      return op(handle);
    });
    this.sends.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * Relaunch one persisted session, continuing the SAME conversation.
   *
   * `resume` is the harness-native id the driver reported when it bound, which is what
   * makes this a continuation rather than a new session wearing an old card: the note,
   * queue, goal and work episode are all keyed on it, and a fresh id would strand every one
   * of them. A row that never got that far has nothing to continue and is refused here.
   */
  private async resume(row: SdkSessionRow): Promise<void> {
    if (!row.agent) throw new Error("its harness is not one this build knows");
    const spec = sdkFor(row.agent);
    if (!spec) throw new Error(`${row.agent} has no embedded driver in this build`);
    if (!row.agentSessionId) {
      throw new Error("it never reported a session id, so there is nothing to continue");
    }
    const task = row.taskId ? this.registry.getTask(row.taskId) : null;
    let mcp: MissionMcpDescriptor | null = null;
    try {
      mcp = await (this.deps.missionMcpDescriptor ?? missionMcpDescriptor)();
    } catch (err) {
      console.error(
        `[sdk] could not resolve Mission MCP while resuming ${row.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    const handle = await spec.launch({
      cwd: row.cwd,
      // No prompt: this is a continuation, and re-sending the original intent would make the
      // agent start the task over on top of whatever it had already done.
      prompt: "",
      model: row.model,
      effort: row.effort,
      permissionMode: row.permissionMode,
      mcp,
      // Rebuilt from the task row rather than remembered on the session row, because the
      // task is where the repo set durably lives - and this grant can only be made at
      // launch, so a resumed multi-repo session that omitted it would come back able to
      // read its secondary worktrees and unable to write to them, which is the failure
      // nobody would attribute to a daemon restart.
      extraDirs: (task?.extraRepos ?? [])
        .map((entry) => entry.worktreePath)
        .filter((p): p is string => p !== null),
      resume: row.agentSessionId,
    });
    this.adopt({
      registration: {
        id: row.id,
        agent: row.agent,
        name: restoredName(row, task?.title ?? null),
        cwd: row.cwd,
        permissionMode: row.permissionMode,
        gitBranch: task?.branch ?? null,
        gitRoot: row.cwd,
        repoRoot: task?.repoRoot ?? null,
      },
      handle,
      durable: {
        taskId: row.taskId,
        model: row.model,
        effort: row.effort,
        agentSessionId: row.agentSessionId,
        turnInProgress: row.turnInProgress,
        acceptedTurns: 0,
      },
    });
    if (row.turnInProgress) {
      try {
        // Through the ordinary send path AFTER adoption: Codex can resume with an active
        // turn, and its handle must choose `turn/steer` rather than the launch-time seed's
        // unconditional `turn/start`. Claude's handle starts the new continuation turn.
        await this.send(row.id, { text: RESTART_CONTINUATION_PROMPT });
      } catch (err) {
        // The conversation itself DID resume, so do not send it through the unresumable
        // eviction path. Keep the durable bit set: another daemon restart may recover it,
        // and the live card still gives the operator an honest place to retry.
        console.error(
          `[sdk] could not continue interrupted turn for ${row.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Show a session that could not be resumed, then take it away again.
   *
   * The point is the `session_remove` at the end of it: two subscribers settle durable state
   * on that event and on nothing else, so a session that simply never came back would leave
   * its task `running` and its workflow binding held, with no card anywhere to explain it.
   * Registering a card for a few seconds is how the ordinary teardown gets to run.
   */
  private registerAndEvict(row: SdkSessionRow, why: string): void {
    try {
      setSdkSessionStatus(row.id, "failed");
      if (!row.agent) return;
      const task = row.taskId ? this.registry.getTask(row.taskId) : null;
      if (this.registry.sdkRegistrationRefusal(row.id)) return;
      this.registry.registerSdkSession({
        id: row.id,
        agent: row.agent,
        name: restoredName(row, task?.title ?? null),
        cwd: row.cwd,
        permissionMode: row.permissionMode,
        gitBranch: task?.branch ?? null,
        gitRoot: row.cwd,
        repoRoot: task?.repoRoot ?? null,
      });
      this.registry.applyDriverEvent(row.id, {
        kind: "exited",
        reason: `could not be resumed: ${why}`,
        resumable: false,
      });
    } catch (err) {
      console.error(`[sdk] could not surface the unresumable session ${row.id}:`, err);
    }
  }

  /**
   * Feed one handle's events into the registry until they stop.
   *
   * The whole loop is guarded because this runs detached: an adapter that throws mid-stream
   * must not take the daemon with it, and the session must still leave the dashboard.
   * Whatever ends the stream - a clean `exited`, an adapter throwing, or the iterator simply
   * finishing - converges on the same eviction, because a card left behind by a driver that
   * is gone is a card whose Send button lies.
   */
  private async pump(id: string, handle: SdkSessionHandle): Promise<void> {
    // The final write covers a stream that returns or throws without an `exited` event; the
    // event path writes earlier too, because a daemon dying between that event and the
    // stream ending must not leave a row claiming the session is still resumable.
    let outcome: SdkSessionStatus = "exited";
    try {
      for await (const evt of handle.events) {
        let deferIdle = false;
        if (evt.kind === "bound") {
          recordSdkSessionBinding(id, evt.agentSessionId, evt.modelId);
          if (evt.cleared) {
            this.unfinishedTurns.set(id, 0);
            this.recordTurnInProgress(id, false);
          }
        }
        if (evt.kind === "state" && evt.state === "working") {
          if ((this.unfinishedTurns.get(id) ?? 0) === 0 && !this.acceptingTurns.has(id)) {
            this.unfinishedTurns.set(id, 1);
          }
          this.recordTurnInProgress(id, true);
        }
        if (evt.kind === "turn_done" && !this.shuttingDown) {
          const remaining = Math.max(0, (this.unfinishedTurns.get(id) ?? 0) - 1);
          this.unfinishedTurns.set(id, remaining);
          this.recordTurnInProgress(id, remaining > 0);
          deferIdle = remaining > 0;
        }
        // Written when we LEARN it, not only when the stream closes: a driver reports its
        // exit and then ends, and a daemon that died between the two must not come back to a
        // row claiming this session is still running and resumable.
        if (evt.kind === "exited") setSdkSessionStatus(id, this.endStatus());
        if (!this.shuttingDown) {
          this.registry.applyDriverEvent(id, evt, { deferIdle });
        }
        if (evt.kind === "exited") break;
      }
    } catch (err) {
      console.error(`[sdk] event stream for ${id} failed:`, err);
      outcome = "failed";
    } finally {
      this.handles.delete(id);
      this.sends.delete(id);
      this.pumps.delete(id);
      this.unfinishedTurns.delete(id);
      this.acceptingTurns.delete(id);
      this.stopping.delete(id);
      try {
        setSdkSessionStatus(id, outcome === "failed" ? "failed" : this.endStatus());
      } catch (err) {
        console.error(`[sdk] final status write for ${id} failed:`, err);
      }
      if (!this.shuttingDown) {
        try {
          // Idempotent: an `exited` event already began the eviction, and this repeat is what
          // covers the streams that end without one.
          this.registry.applyDriverEvent(id, {
            kind: "exited",
            reason: "driver ended",
            resumable: false,
          });
        } catch (err) {
          console.error(`[sdk] final eviction for ${id} failed:`, err);
        }
      }
    }
  }

  /** What a driver ending means, which depends entirely on who ended it. */
  private endStatus(): SdkSessionStatus {
    return this.shuttingDown ? "suspended" : "exited";
  }
}

/**
 * What a restored card is called.
 *
 * An operator's own rename wins outright, and nothing else here is persisted. That split is
 * the point: it keeps the good property of deriving while fixing what deriving cannot do.
 *
 *  - DERIVED, for a card nobody has renamed: the task's title is the same source the dispatch
 *    named it from, so a task retitled since the launch - which is the ordinary case, because
 *    a dispatch refines its heuristic title with an async model call moments later - comes
 *    back under its current name instead of one a column froze at launch.
 *  - PERSISTED, once someone has typed a name: a rename that a restart reverted would not be
 *    a rename, and the derivation has no way to know it was overruled. `display_name` is
 *    written by nothing but `POST /api/sessions/:id/rename`, so its presence IS the fact that
 *    a human overruled the title.
 *
 * The checkout's directory is the fallback for a session whose task was deleted - never
 * empty, because a nameless card is one nobody can pick out of a rail.
 */
function restoredName(row: SdkSessionRow, taskTitle: string | null): string {
  return row.displayName ?? (taskTitle?.trim() || basename(row.cwd) || row.id);
}
