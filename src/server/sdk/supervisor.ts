import type { ThinkingLevel } from "@shared/types.ts";
import type { Registry, SdkSessionRegistration } from "../registry.ts";
import type { SdkSessionHandle, SdkTurn, SessionRequestAnswer } from "../harness/types.ts";
import {
  listSdkSessions,
  recordSdkSessionBinding,
  sdkSessionIsLive,
  setSdkSessionStatus,
  upsertSdkSession,
  type SdkSessionStatus,
} from "./store.ts";

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
 *
 * Phase 1 of `docs/plans/agent-sdk-sessions/plan.md` is the seam only: no harness declares
 * an `sdk` driver yet (`sdkFor` is null for all three), so nothing calls `adopt` in a
 * shipped build and `restore` has nothing to resume. What IS live here is the shape every
 * later phase builds on - handle ownership, per-session send serialization, the event pump,
 * and restore running before the first discovery sweep.
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

  constructor(private readonly registry: Registry) {}

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
   * With no driver declared by any harness there is nothing to relaunch, and for the same
   * reason no row can exist at all - nothing can have started one. The sweep below is
   * therefore defensive, and it FAILS a live-looking row rather than leaving it: a row
   * nobody can resume is a task that would otherwise stay `running` for ever with no
   * session to settle it. Phase 2 replaces the body with a relaunch through the harness's
   * `SdkSpec.launch({ resume })` and registers the session as `starting`; a resume that
   * fails still lands here, because a session marked exited and evicted through the normal
   * path is what lets `TaskManager.reconcileTasksBoundTo` settle its task visibly.
   */
  async restore(): Promise<void> {
    const now = Date.now();
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
      console.warn(`[sdk] no driver can resume ${row.id} (${row.agent ?? row.status}); failing it`);
      setSdkSessionStatus(row.id, "failed", now);
    }
  }

  /**
   * Take ownership of a launched handle: put the card on the dashboard, then pump.
   *
   * Registration comes first so the session exists before any event about it can arrive -
   * `applyDriverEvent` refuses an id it does not know, and an ordering that let the first
   * `bound` race the registration would drop the identity that makes the read path work.
   */
  adopt(input: {
    registration: SdkSessionRegistration;
    handle: SdkSessionHandle;
    /**
     * What only the ROW needs: the facts a resume has to be cut from, which the dashboard
     * has no question to ask of. Kept apart from the registration rather than folded into
     * it, so nothing durable is inferred from what a card happens to render.
     */
    durable: { taskId: string | null; model: string | null; effort: ThinkingLevel | null };
  }): void {
    const { registration, handle, durable } = input;
    const session = this.registry.registerSdkSession(registration);
    upsertSdkSession({
      id: session.id,
      agent: session.agent,
      agentSessionId: session.agentSessionId,
      cwd: session.cwd ?? registration.cwd,
      taskId: durable.taskId,
      model: durable.model,
      effort: durable.effort,
      permissionMode: session.permissionMode,
      status: "starting",
    });
    this.handles.set(session.id, handle);
    this.pumps.set(session.id, this.pump(session.id, handle));
  }

  /** The live handle for a session, or null when nothing is driving it. */
  handleFor(id: string): SdkSessionHandle | null {
    return this.handles.get(id) ?? null;
  }

  /**
   * Deliver a turn, serialized behind whatever this session is already being sent.
   *
   * Rejects when there is no handle rather than resolving: "delivered to nobody" is the
   * shape of failure the acked send exists to remove, so it must not be reintroduced here.
   */
  send(id: string, turn: SdkTurn): Promise<void> {
    return this.serialize(id, (handle) => handle.send(turn));
  }

  /** Resolve a pending request. Serialized with sends - it is input to the same turn. */
  answer(id: string, requestId: string, answer: SessionRequestAnswer): Promise<void> {
    return this.serialize(id, (handle) => handle.answer(requestId, answer));
  }

  /**
   * Stop a session's driver.
   *
   * Deliberately NOT queued behind pending sends: stopping is what a caller asks for when
   * it no longer wants them delivered. The handle then emits `exited`, and the pump turns
   * that into the ordinary eviction sequence - this method never removes a card itself,
   * because `session_remove` has exactly one owner (see `Registry.beginEviction`).
   */
  async stop(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return;
    await handle.stop();
  }

  /** Stop every driver - a daemon shutdown, so the harnesses can close their sessions. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.handles.keys()].map((id) => this.stop(id)));
  }

  private serialize(id: string, op: (handle: SdkSessionHandle) => Promise<void>): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return Promise.reject(new Error(`no live driver for session ${id}`));
    const prior = this.sends.get(id) ?? Promise.resolve();
    // `catch` on the chain, never on the returned promise: a failed delivery must not stop
    // the next one from being attempted, and must still reject for the caller that made it.
    const next = prior.then(() => op(handle));
    this.sends.set(
      id,
      next.catch(() => {}),
    );
    return next;
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
    // Decided here and written ONCE, in the finally, rather than on the `exited` event: a
    // stream can end without one (an adapter that returns, or throws), and a row left saying
    // `running` for a session that is gone is exactly what the next restart has to guess
    // about. The only distinction that matters durably is whether it ended or broke.
    let outcome: SdkSessionStatus = "exited";
    try {
      for await (const evt of handle.events) {
        if (evt.kind === "bound") recordSdkSessionBinding(id, evt.agentSessionId);
        // Written when we LEARN it, not only when the stream closes: a driver reports its
        // exit and then ends, and a daemon that died between the two must not come back to a
        // row claiming this session is still running and resumable.
        if (evt.kind === "exited") setSdkSessionStatus(id, "exited");
        this.registry.applyDriverEvent(id, evt);
      }
    } catch (err) {
      console.error(`[sdk] event stream for ${id} failed:`, err);
      outcome = "failed";
    } finally {
      this.handles.delete(id);
      this.sends.delete(id);
      this.pumps.delete(id);
      setSdkSessionStatus(id, outcome);
      // Idempotent: an `exited` event already began the eviction, and this repeat is what
      // covers the streams that end without one.
      this.registry.applyDriverEvent(id, {
        kind: "exited",
        reason: "driver ended",
        resumable: false,
      });
    }
  }
}
