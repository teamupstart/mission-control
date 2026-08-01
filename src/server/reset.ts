import type { ResetResult, Session } from "@shared/types.ts";
import { resetToOrigin, withPaneLockWait, type DriverClear, type PaneLockToken } from "./actions.ts";
import { forgetFixLog } from "./nomistakes-fixes.ts";
import type { Registry } from "./registry.ts";
import { noteKeyFor } from "./registry.ts";

/**
 * The one thing a reset needs from the SDK supervisor - structural, so a test satisfies it
 * with an object literal and this module never imports the supervisor.
 */
export interface SdkClearer {
  clearContext(id: string): Promise<boolean>;
}

/**
 * The supervisor as a `DriverClear`, or undefined when this build has no supervisor.
 *
 * One adapter, at the boundary, because all three reset callers need the identical lambda
 * and a fourth would otherwise write its own - which is how one of them ends up passing the
 * session's `id` where another passes its `agentSessionId` and an embedded reset silently
 * clears nothing.
 */
export function driverClearFor(sdk: SdkClearer | undefined): DriverClear | undefined {
  return sdk ? (session: Session) => sdk.clearContext(session.id) : undefined;
}

/**
 * A reset as the PRODUCT means it: the git operation plus every piece of session-scoped
 * state that described the work it just discarded.
 *
 * Extracted the moment a second caller appeared. `resetToOrigin` (actions.ts) is the git
 * half and knows nothing of the registry; the other half used to live inline in the
 * `POST /api/sessions/:id/reset` handler, which was fine while the button was the only
 * way to reset. `TaskManager.assign` now resets too, and a second hand-written copy of
 * this cleanup is exactly the drift AGENTS.md's Reset section is about: the failure mode
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
  reset?: (
    session: Session,
    clear: boolean,
    lockOwner?: PaneLockToken,
    driverClear?: DriverClear,
  ) => Promise<ResetResult>,
  /**
   * How to clear an EMBEDDED session's context - see `DriverClear`.
   *
   * Threaded rather than imported because this module is the reset's POLICY and the
   * supervisor is a live subsystem: a test drives the whole cleanup with a fake, exactly as
   * `reset` above already lets it drive the git half. Absent, an embedded session's clear
   * reports `cleared: false` - honest for a build with no supervisor, and the same answer
   * that path gave before this parameter existed.
   */
  driverClear?: DriverClear,
): Promise<ResetResult> {
  // Sampled BEFORE the reset: the fetch inside can take ~30s, and the poller may swap
  // or clear the run in that window.
  const showing = session.nomistakes;

  registry.beginSessionReset(session.id);
  try {
    return await withPaneLockWait(session, async (lockOwner) => {
      const r = reset
        ? await reset(session, clear, lockOwner, driverClear)
        : await resetToOrigin(session, clear, undefined, lockOwner, driverClear);

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
      let workIdentityReady = false;
      if (r.ok) {
        // A successful git reset and a successful context reset are separate claims.
        // If `/clear` is still sitting in the composer, the old agent episode is still
        // active and remains the only episode allowed to own its task and dependencies.
        // Rotating here would detach that work before the command actually runs.
        const episode = !clear || r.cleared
          ? registry.resetWorkEpisode(session.id, {
              awaitingAgentRebind: clear,
              previousAgentSessionId: session.agentSessionId,
              at: r.clearIssuedAt ?? Date.now(),
            })
          : null;
        workIdentityReady = Boolean(
          episode &&
          (!episode.awaitingAgentRebind ||
            (clear && r.cleared &&
              await registry.waitForWorkEpisodeReady(session.id, episode.episodeId, 5000)))
        );
        registry.clearObservedSessionEffort(session.id);
        registry.clearPendingTurns(noteKeyFor(session));
        registry.clearQueue(noteKeyFor(session));
        registry.clearWorkflowState(noteKeyFor(session));
      }

      return { ...r, workIdentityReady };
    });
  } finally {
    registry.endSessionReset(session.id);
  }
}
