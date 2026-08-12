import type { Session } from "@shared/types.ts";
import { agentActive } from "@shared/session.ts";
import {
  defaultPaneDeps,
  interruptPaneSession,
  kill,
  type ActionResult,
  type PaneDeps,
} from "../actions.ts";
import type { SdkSupervisor } from "./supervisor.ts";

/**
 * The durable outbox, narrowed to the one thing an interrupt does to it.
 *
 * A structural type rather than the class, so this module keeps its existing dependencies
 * and a unit test can hand in a counter instead of standing up a manager over a database.
 */
export interface PendingTurnQueueDrop {
  dropQueued(sessionId: string): number;
}

/** What an interrupt did, beyond succeeding. */
export interface InterruptResult extends ActionResult {
  /**
   * Whether there was actually a turn to stop.
   *
   * `ok` says the request was serviced; this says it found something. They come apart in one
   * ordinary case: the turn ends on its own in the window between the operator's keypress and
   * the request reaching the daemon. The card is still drawing `working` at that moment - it
   * is a frame behind - so the control is live and the request is legitimate, and yet nothing
   * was stopped. The browser needs to be told, because it is otherwise about to report a stop
   * that did not happen and a queue that is still going to be delivered.
   */
  stoppedTurn?: boolean;
  /** Queued turns dropped, so the caller can say what else stopped. */
  droppedQueued?: number;
}

/**
 * Accept an interactive stop.
 *
 * Terminal teardown already returns as soon as its process/group signal lands. An SDK stop
 * has a separate, potentially multi-second event-stream drain, so the interactive route
 * acknowledges once the supervisor has made the session unavailable and started its normal
 * blocking `stop()` path in the background.
 */
export async function requestSessionStop(
  session: Session,
  supervisor: SdkSupervisor | undefined,
  stopTerminal: typeof kill = kill,
): Promise<ActionResult> {
  if (session.runtime !== "sdk") return stopTerminal(session);
  if (!supervisor) return { ok: false, error: "this build has no session supervisor" };
  return supervisor.requestStop(session.id)
    ? { ok: true }
    : { ok: false, error: "this session has no live embedded driver" };
}

/**
 * Stop what this session is doing right now, over whichever runtime is driving it.
 *
 * The third helper of the shape `injectPromptForRuntime` and `requestSessionStop` already
 * have, and it exists for the reason they do: there is exactly ONE place that turns "the
 * operator wants this stopped" into a per-runtime mechanism, so no caller can reach the
 * wrong one. It is also the whole gesture rather than half of it - the queue drop is here,
 * not at the route, because a stop that leaves the outbox armed restarts the work it just
 * stopped, and a second caller must not be able to get one without the other.
 *
 * The caller is expected to have refused an unsupported harness/runtime pair already
 * (`interruptUnsupportedWhy`); this refuses again rather than assuming, because the arms
 * below are the mechanisms and neither of them is "nothing happens quietly".
 */
export async function interruptSession(
  session: Session,
  supervisor: SdkSupervisor | undefined,
  pendingTurns?: PendingTurnQueueDrop,
  paneDeps?: PaneDeps,
): Promise<InterruptResult> {
  const stopped = session.runtime === "sdk"
    ? await interruptDriver(session, supervisor)
    : await interruptPane(session, paneDeps);
  // Gated on a turn having GENUINELY been in flight, not merely on the request succeeding.
  //
  // Two failures this closes, and the second is the one that is easy to miss. A refused
  // interrupt has changed nothing about what the agent is doing, so dropping the queue behind
  // it would discard work still going to be wanted. And a request that arrived a moment after
  // the turn ended on its own is ALSO not a stop: the driver accepts it happily, but nothing
  // was cancelled, so the queued messages behind it are about to be delivered normally - by
  // the outbox's own idle drain, within `DEFAULT_IDLE_SETTLE_MS` - rather than being work
  // anybody asked to restart. Deleting durable rows on the strength of a stop that did not
  // happen is data loss, and reporting "Stopped, and dropped 1 queued message" for it is a
  // lie the operator would act on.
  if (!stopped.ok || !stopped.stoppedTurn) return stopped;
  return { ...stopped, droppedQueued: pendingTurns?.dropQueued(session.id) ?? 0 };
}

/** The embedded arm: the driver's own interrupt primitive, through its supervisor. */
async function interruptDriver(
  session: Session,
  supervisor: SdkSupervisor | undefined,
): Promise<InterruptResult> {
  if (!supervisor) return { ok: false, error: "this build has no session supervisor" };
  try {
    const outcome = await supervisor.interrupt(session.id);
    if (outcome === null) {
      return { ok: false, error: "this session has no live embedded driver" };
    }
    // `idle` is a success. The request was serviced and the driver was asked; there was
    // simply nothing left to stop, which is not the operator's mistake and not a failure of
    // this call. It is reported rather than swallowed so the browser can say what actually
    // happened instead of claiming a stop.
    return { ok: true, stoppedTurn: outcome === "interrupted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The pane arm: one Escape into the bound terminal, which is what all three TUIs read as
 * "stop this turn".
 *
 * `stoppedTurn` is the honest half, and it is answered the same way the driver arm answers
 * it - by reporting what was FOUND rather than what was asked for. A pane cannot be asked
 * whether the keystroke landed (`actions.ts` returns as soon as the bytes are written, and
 * no TUI acknowledges), so the evidence available is the daemon's own reading of the
 * session, through the very predicate that decided to offer the control. That keeps the
 * queue drop gated on a turn genuinely having been in flight, which is what stops an
 * interrupt arriving just after a turn ended from deleting durable outbox rows that were
 * about to be delivered normally.
 *
 * It is weaker evidence than the SDK arm's, and deliberately not dressed up as more: a
 * terminal session's state is re-derived from its transcript on a poll tick rather than
 * maintained by an event pump, so the window between "the turn ended" and "we know" is a
 * tick rather than an RPC. The consequence of being wrong is bounded and in the safe
 * direction - a queue that survives an interrupt is delivered, which the operator can see
 * and undo, while a queue dropped in error is gone.
 */
async function interruptPane(
  session: Session,
  paneDeps: PaneDeps = defaultPaneDeps,
): Promise<InterruptResult> {
  const wasWorking = agentActive(session);
  const sent = await interruptPaneSession(session, paneDeps);
  return sent.ok ? { ...sent, stoppedTurn: wasWorking } : sent;
}

export async function stopSession(
  session: Session,
  supervisor: SdkSupervisor | undefined,
  stopTerminal: typeof kill = kill,
): Promise<ActionResult> {
  if (session.runtime !== "sdk") return stopTerminal(session);
  if (!supervisor) return { ok: false, error: "this build has no session supervisor" };
  if (!supervisor.handleFor(session.id)) {
    return { ok: false, error: "this session has no live embedded driver" };
  }
  try {
    await supervisor.stop(session.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
