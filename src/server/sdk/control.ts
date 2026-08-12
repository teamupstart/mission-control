import type { Session } from "@shared/types.ts";
import { kill, type ActionResult } from "../actions.ts";
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

/** What an interrupt did, beyond succeeding: how much queued work went with it. */
export interface InterruptResult extends ActionResult {
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
): Promise<InterruptResult> {
  const stopped = session.runtime === "sdk"
    ? await interruptDriver(session, supervisor)
    : await interruptPane(session);
  if (!stopped.ok) return stopped;
  // Only once the stop landed. A refused interrupt has changed nothing about what the agent
  // is doing, and dropping the queue behind it would discard work that is still going to be
  // wanted - the operator asked for one act, and it either happened or it did not.
  return { ...stopped, droppedQueued: pendingTurns?.dropQueued(session.id) ?? 0 };
}

/** The embedded arm: the driver's own interrupt primitive, through its supervisor. */
async function interruptDriver(
  session: Session,
  supervisor: SdkSupervisor | undefined,
): Promise<ActionResult> {
  if (!supervisor) return { ok: false, error: "this build has no session supervisor" };
  try {
    return (await supervisor.interrupt(session.id))
      ? { ok: true }
      : { ok: false, error: "this session has no live embedded driver" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The pane arm, which Phase 2 implements by writing `Escape` into the bound terminal.
 *
 * Written as a refusal rather than left out, so the fan-out has both arms from the start and
 * the next phase has exactly one function body to replace - the route, the result shape and
 * the queue drop above it do not move. Unreachable today: no harness declares the terminal
 * runtime interruptible, so `interruptUnsupportedWhy` refuses at the route first. It is here
 * for the caller that forgets to ask.
 */
async function interruptPane(session: Session): Promise<ActionResult> {
  return {
    ok: false,
    error: `Mission Control cannot yet write an interrupt into a ${session.runtime} session's pane.`,
  };
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
