import type { Session } from "@shared/types.ts";
import { foremanAutomationAuthorized } from "../harness/index.ts";

/**
 * Whether Foreman may triage this session's current needs-you episode.
 *
 * Launch-scoped hooks are the proof that an operator-started session opted into automation.
 */
export function foremanTriageAuthorized(
  session: Session,
  _sessions: readonly Session[] = [session],
): boolean {
  return foremanAutomationAuthorized(session);
}
