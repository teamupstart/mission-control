import type { Session } from "@shared/types.ts";
import { foremanAutomationAuthorized } from "../harness/index.ts";

/**
 * Whether Foreman may triage this session's current needs-you episode.
 *
 * TWO INDEPENDENT QUESTIONS, and the bug this predicate used to carry was collapsing them
 * into one. `foremanAutomationAuthorized` answers CAPABILITY - can we observe and drive
 * this session's lifecycle at all - and hooks are its evidence. This function adds
 * CONSENT: was Foreman ever invited into this particular session. Hooks cannot answer
 * that, because Claude installs them machine-wide: every personal Claude chat on the
 * machine reported a hook and so passed the old check, which is how Foreman came to type
 * "create a PR" into conversations nobody had asked it to join. `Session.foremanInvite`
 * is the answer instead - non-null for the sessions Mission Control created (`"sdk"`,
 * `"dispatch"`) and the ones a human invited (`"operator"`), null for everything merely
 * discovered.
 *
 * The invite check lands HERE rather than in `foremanAutomationAuthorized` on purpose.
 * That predicate is a capability claim mirrored browser-side by `workQueueBlockedReason`
 * and pinned in agreement by `test/queue-apply-sdk.test.ts`; teaching the capability
 * mirror about invite policy would make a fleet-wide harness fact depend on per-session
 * consent. This wrapper, by contrast, has exactly four callers - the `tickTargets`
 * needs-you half, `decideQueueTick`, `processSession`, and `countNeedsYou` (the
 * dashboard's queue-depth badge, which must stay in lockstep with the worker or it counts
 * sessions the worker will never process) - and they are precisely the set that has to
 * move together.
 *
 * NOT the whole of the policy: this covers triage. The other selection sites gate
 * themselves, because each answers a different question about the same invite -
 * `tickTargets`' rest half (hookless sessions with open work must stay reachable, so it
 * cannot share this call site), `decideReviewFollowup`, and `agentIsFree`, which requires
 * more than non-null (see its own comment: an operator invite is help with current work,
 * never consent to a new task).
 */
export function foremanTriageAuthorized(
  session: Session,
  _sessions: readonly Session[] = [session],
): boolean {
  if (session.foremanInvite === null) return false;
  return foremanAutomationAuthorized(session);
}
