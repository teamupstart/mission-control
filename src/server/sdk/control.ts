import type { Session } from "@shared/types.ts";
import { kill, type ActionResult } from "../actions.ts";
import type { SdkSupervisor } from "./supervisor.ts";

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
