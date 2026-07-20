import type { ResetResult, Session } from "@shared/types.ts";
import { resetToOrigin } from "./actions.ts";
import { forgetFixLog } from "./nomistakes-fixes.ts";
import type { Registry } from "./registry.ts";
import { noteKeyFor } from "./registry.ts";

/**
 * A reset as the PRODUCT means it: the git operation plus every piece of session-scoped
 * state that described the work it just discarded.
 *
 * Extracted the moment a second caller appeared. `resetToOrigin` (actions.ts) is the git
 * half and knows nothing of the registry; the other half used to live inline in the
 * `POST /api/sessions/:id/reset` handler, which was fine while the button was the only
 * way to reset. `TaskManager.assign` now resets too, and a second hand-written copy of
 * this cleanup is exactly the drift CLAUDE.md's Reset section is about: the failure mode
 * is not a crash, it is a work queue full of items authored for a branch that no longer
 * exists, on a checkout that has already moved on.
 *
 * Every clear is conditional on `r.ok` for one reason: a failed reset discarded nothing,
 * so the state still describes the tree. Retiring it then would erase the record of work
 * that is still sitting there.
 */
export async function resetSession(
  registry: Registry,
  session: Session,
  clear: boolean,
): Promise<ResetResult> {
  // Sampled BEFORE the reset: the fetch inside can take ~30s, and the poller may swap
  // or clear the run in that window.
  const showing = session.nomistakes;

  const r = await resetToOrigin(session, clear);

  // Retired against the checkout it wiped (root + the branch that was standing in it),
  // not this session, so it holds for a sibling sharing the checkout and across a
  // restart.
  if (r.ok && showing) registry.dismissNomistakes(showing, r.root, session.gitBranch);
  // The fix log needs no dismissal - the reset destroyed the commits it is read from, so
  // it is empty by construction. But drop the cached read: it is keyed on HEAD, and the
  // reset moved HEAD, so a stale entry could still be served.
  if (r.ok && session.cwd) {
    forgetFixLog(session.cwd);
    registry.clearNomistakesFixes(session.id);
  }
  // The reset discarded the task these queued items were authored for - the branch is
  // gone and (with `clear`) the agent's context is wiped - so clear the whole batch.
  // This is the deliberate "start over", the one case that overrides the re-attach
  // affordance a bare /clear leans on. Keyed on the PRE-reset session, whose note key
  // still names the queue: a /clear only rotates that key once the agent processes it,
  // which is after this returns.
  if (r.ok) registry.clearQueue(noteKeyFor(session));

  return r;
}
