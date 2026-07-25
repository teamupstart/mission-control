import {
  ENSEMBLE_DRIVER_KEYS,
  knownDriverKey,
  type EnsembleArtifact,
  type EnsembleAttempt,
  type EnsembleDriverKey,
  type EnsembleFinalizationPolicy,
  type EnsembleMember,
  type EnsembleOutcome,
} from "@shared/ensemble.ts";

/**
 * The versioned FINALIZER registry.
 *
 * A finalizer is pure: given the applied decision outcome and the run's durable members and
 * artifacts, it returns a bounded generic PLAN - which one member is the exact winner, and which
 * members are losers to reap. It is handed no database, Task, terminal, or Workflow authority and
 * cannot perform an effect; the engine validates the plan and performs every destructive step
 * itself, in the order and with the idempotency the recovery contract requires. That split is the
 * whole point: a strategy that finalizes to one selected result reuses `select_one_finalize@…`
 * with no new engine branch, and the dangerous operations stay in one owner.
 *
 * The engine dispatches to it by the compiled plan's `driverKey`, never by asking whether a run is
 * Best-of-N.
 */

export type FinalizePlan =
  | {
      kind: "select_one";
      winnerMemberId: string;
      winnerArtifactId: string;
      /** Every non-winner member - the engine decides per-member how to reap by current status. */
      loserMemberIds: string[];
    }
  | { kind: "no_consensus"; artifactIds: string[]; reason: string }
  | {
      /**
       * Terminate keeping everything: no winner, no loser, nothing reaped and no ref touched. The
       * engine settles each member's agent through the ordinary Task cancellation a completed run
       * performs - "non-destructive" is a claim about work, not about leaving processes running.
       */
      kind: "retained";
      memberIds: string[];
      artifactIds: string[];
    };

export interface FinalizeContext {
  /** The APPLIED decision outcome the manager persisted before finalization began. */
  outcome: EnsembleOutcome;
  finalization: EnsembleFinalizationPolicy;
  members: EnsembleMember[];
  artifacts: EnsembleArtifact[];
  attempts: EnsembleAttempt[];
}

export type FinalizeResult =
  | { ok: true; plan: FinalizePlan }
  | { ok: false; detail: string };

/** A versioned finalizer, registered by the exact `driverKey` a compiled plan may name. */
export interface Finalizer {
  driverKey: EnsembleDriverKey;
  plan(context: FinalizeContext): FinalizeResult;
}

/** Whether an artifact is a ready commit produced by a given member (via any of its attempts). */
function memberOwnsReadyCommit(
  context: FinalizeContext,
  memberId: string,
  artifactId: string,
): boolean {
  const artifact = context.artifacts.find((a) => a.id === artifactId);
  if (!artifact || artifact.status !== "ready" || artifact.kind !== "commit" || artifact.attemptId === null) {
    return false;
  }
  const attempt = context.attempts.find((a) => a.id === artifact.attemptId);
  return attempt !== undefined && attempt.memberId === memberId;
}

export const selectOneFinalizer: Finalizer = {
  driverKey: "select_one_finalize@1",
  plan(context) {
    if (context.outcome.kind === "no_consensus") {
      return { ok: true, plan: { kind: "no_consensus", artifactIds: [...context.outcome.artifactIds], reason: context.outcome.reason } };
    }
    if (context.outcome.kind !== "selected") {
      return { ok: false, detail: `select_one finalization cannot execute a ${context.outcome.kind} outcome` };
    }
    const winnerMemberId = context.outcome.memberIds[0] ?? null;
    const winnerArtifactId = context.outcome.artifactIds[0] ?? null;
    if (winnerMemberId === null || winnerArtifactId === null) {
      return { ok: false, detail: "the selected outcome names no winning member and artifact" };
    }
    // Re-validate the winner against durable state, not against the decision alone: a decision
    // records an intent, and an artifact invalidated since (its private ref no longer resolving)
    // must stop finalization here rather than reap losers around a winner that is gone.
    if (!memberOwnsReadyCommit(context, winnerMemberId, winnerArtifactId)) {
      return { ok: false, detail: `the selected artifact ${winnerArtifactId} is no longer a ready commit of member ${winnerMemberId}` };
    }
    const loserMemberIds = context.members.filter((m) => m.id !== winnerMemberId).map((m) => m.id);
    return { ok: true, plan: { kind: "select_one", winnerMemberId, winnerArtifactId, loserMemberIds } };
  },
};

/**
 * `retain_all_finalize@1`: terminate with every artifact kept and nothing promoted.
 *
 * The whole finalizer, because there is nothing to plan: no ref is verified, no checkout is reset,
 * no worktree is reaped. It refuses any outcome but `retained` rather than treating an unexpected
 * one as "keep everything anyway" - a `selected` outcome arriving here would mean a plan whose
 * decision and finalization disagree about what the run was for, and silently retaining a winner
 * the operator confirmed would leave them with a promotion that never happened.
 */
export const retainAllFinalizer: Finalizer = {
  driverKey: "retain_all_finalize@1",
  plan(context) {
    if (context.outcome.kind !== "retained") {
      return { ok: false, detail: `retain_all finalization cannot execute a ${context.outcome.kind} outcome` };
    }
    return {
      ok: true,
      plan: {
        kind: "retained",
        memberIds: [...context.outcome.memberIds],
        artifactIds: [...context.outcome.artifactIds],
      },
    };
  },
};

/**
 * Every finalizer this build can execute, keyed by the exact `driverKey` a compiled plan names.
 * `Record<EnsembleDriverKey, …>` is the enforcement: a new driver key does not compile until it
 * says whether a finalizer exists or `null`. Non-finalize keys are `null`.
 */
export const FINALIZERS: Record<EnsembleDriverKey, Finalizer | null> = {
  "member_wave@1": null,
  "artifact_barrier@1": null,
  "comparative_review@1": null,
  "human_decision@1": null,
  "select_one_finalize@1": selectOneFinalizer,
  "consensus_review@1": null,
  "divergence_decision@1": null,
  "retain_all_finalize@1": retainAllFinalizer,
};

/** The finalizer for a persisted driver key, or null when this build cannot run it. */
export function finalizerFor(driverKey: string): Finalizer | null {
  const known = knownDriverKey(driverKey);
  return known ? FINALIZERS[known] : null;
}

/** Every driver key with a finalizer implementation, for completeness assertions and tests. */
export const FINALIZER_DRIVER_KEYS: EnsembleDriverKey[] = ENSEMBLE_DRIVER_KEYS.filter(
  (key) => FINALIZERS[key] !== null,
);
