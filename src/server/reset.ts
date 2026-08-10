import type { ResetResult, Session } from "@shared/types.ts";
import { resetToOrigin, withPaneLockWait, type DriverClear, type PaneLockToken } from "./actions.ts";
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
 * The pending-turn manager's reset boundary, kept structural for the same reason as
 * `SdkClearer`: reset policy owns the sequencing without importing the live manager.
 */
export interface PendingTurnResetBoundary {
  /** Stop and settle a claimed delivery. IDs returned here may already have crossed a
   * runtime boundary, so successful reset cleanup must retain them as uncertain. */
  invalidateForReset(id: string): Promise<readonly string[]>;
  /** Re-arm safe queued work after the registry's reset marker has been removed. */
  finishReset(id: string): void;
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
  pendingTurns?: PendingTurnResetBoundary,
): Promise<ResetResult> {
  const pendingTurnKey = noteKeyFor(session);
  registry.beginSessionReset(session.id);
  try {
    // Marking the registry comes first, so every SDK acceptance and terminal write guard
    // refuses immediately. Then wait for a delivery that already owned the row to settle:
    // clearing SQLite first would let that detached promise reach the agent afterwards.
    const preservePendingTurnIds = pendingTurns
      ? await pendingTurns.invalidateForReset(session.id)
      : [];
    return await withPaneLockWait(session, async (lockOwner) => {
      const r = reset
        ? await reset(session, clear, lockOwner, driverClear)
        : await resetToOrigin(session, clear, undefined, lockOwner, driverClear);

      // The reset discarded the task these queued items were authored for, so discard every
      // safely queued row. A claimed row whose handoff may have crossed stays `uncertain`:
      // deleting it would hide a message that the reset could not prove was refused.
      // This is the deliberate "start over", the one case that overrides the re-attach
      // affordance a bare /clear leans on. Clear both the pre-reset key and a live rebound
      // key because an SDK delivery can publish its conversation identity while invalidation
      // is waiting for that same handoff to settle.
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
        registry.clearPendingTurns(pendingTurnKey, preservePendingTurnIds);
        const currentSession = registry.getSession(session.id);
        const currentPendingTurnKey = currentSession ? noteKeyFor(currentSession) : pendingTurnKey;
        if (currentPendingTurnKey !== pendingTurnKey) {
          registry.clearPendingTurns(currentPendingTurnKey, preservePendingTurnIds);
        }
        // The Foreman invite MOVES to the post-reset key rather than being cleared with
        // the work above: the reset discards the conversation, and an invite belongs to
        // the pane, not the conversation. Usually a no-op - a rebind that already landed
        // carried the invite through the registry's own rotation move - but a rotation
        // this call observes that the registry's sites did not would otherwise strand it.
        registry.moveForemanInviteKey(pendingTurnKey, currentPendingTurnKey);
        registry.clearQueue(noteKeyFor(session));
        registry.clearWorkflowState(noteKeyFor(session));
      }

      return { ...r, workIdentityReady };
    });
  } finally {
    registry.endSessionReset(session.id);
    pendingTurns?.finishReset(session.id);
  }
}
