import type { Session } from "@shared/types.ts";
import { kill, type ActionResult } from "../actions.ts";
import type { SdkSupervisor } from "./supervisor.ts";

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
