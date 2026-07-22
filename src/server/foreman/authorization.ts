import type { Session } from "@shared/types.ts";
import { gateParked } from "@shared/session.ts";
import { foremanAutomationAuthorized } from "../harness/index.ts";

/**
 * Whether Foreman may triage this session's current needs-you episode.
 *
 * Ordinary prompts keep the harness hook boundary: launch-scoped hooks are the proof
 * that an operator-started session opted into automation. A parked no-mistakes gate is
 * different evidence. The daemon independently polls the run, attributes it to this
 * session, and knows that every session driving the same run has stopped. That makes the
 * gate safe to review even when the child itself never reported a hook.
 *
 * This exception is deliberately triage-only. Work-queue sends and prompted wrap-ups
 * continue to call `foremanAutomationAuthorized` directly, so a parked gate cannot turn
 * a hookless session into a generally automated one.
 */
export function foremanTriageAuthorized(
  session: Session,
  sessions: readonly Session[] = [session],
): boolean {
  return foremanAutomationAuthorized(session) || gateParked(session, sessions);
}
