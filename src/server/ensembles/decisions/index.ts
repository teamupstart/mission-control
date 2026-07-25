import {
  ENSEMBLE_DRIVER_KEYS,
  knownDriverKey,
  type EnsembleDecisionPolicy,
  type EnsembleDriverKey,
  type EnsembleJson,
  type EnsembleOutcome,
  type EnsembleSelectOneSelection,
} from "@shared/ensemble.ts";
import { EnsembleSelectOneSelectionSchema } from "@shared/protocol.ts";

/**
 * The versioned DECISION driver registry.
 *
 * A decision driver is the one place a human's proposed outcome is checked against what the
 * compiled plan actually offers - the eligible artifact set and the decision policy - and turned
 * into a durable `EnsembleOutcome` intent. Its authority is deliberately tiny: it VALIDATES and
 * NORMALISES, and it cannot record a decision, move the run, or touch a Task, a ref or a Workflow.
 * The engine dispatches to it by the compiled plan's `driverKey`, never by asking whether a run
 * is Best-of-N, which is the whole reason a decision is a versioned driver and not an engine
 * branch - a second strategy that decides between eligible artifacts reuses `select_one@…` with
 * no engine change.
 *
 * The invariant this driver enforces is the product-safety one: a model output is never an actor
 * here. The recommendation is advisory; only a human `selected` (or an explicit `no_consensus`)
 * over an ELIGIBLE artifact becomes an outcome, and an ineligible or malformed selection is a
 * refusal, never a nearest match.
 */

/** What one decision is being made against - the eligible artifacts and how to build an outcome. */
export interface DecisionContext {
  policy: EnsembleDecisionPolicy;
  /** Ready artifact ids of the policy's eligible kind, in stable order. */
  eligibleArtifactIds: string[];
  /** The member that produced a given eligible artifact, for building the outcome. */
  memberForArtifact(artifactId: string): string | null;
}

export type DecisionRefusal =
  | "invalid_selection"
  | "ineligible_artifact"
  | "insufficient_eligible"
  | "unknown_member";

export type DecisionResult =
  | { ok: true; selection: EnsembleSelectOneSelection; outcome: EnsembleOutcome }
  | { ok: false; reason: DecisionRefusal; detail: string };

/** A versioned decision driver, registered by the exact `driverKey` a compiled plan may name. */
export interface DecisionDriver {
  driverKey: EnsembleDriverKey;
  validate(selection: EnsembleJson, context: DecisionContext): DecisionResult;
}

/**
 * `select_one` / `human_decision@1`: choose exactly one eligible artifact, or declare no consensus.
 *
 * Cancelling is a different authority entirely (`cancel`), never a decision - a decision that
 * reaps loser worktrees must be a deliberate pick, and folding "give up and destroy" into the same
 * shape as "this one wins" is exactly the accident the split rules out. `no_consensus` retains
 * every artifact and is non-destructive.
 */
export const selectOneDecisionDriver: DecisionDriver = {
  driverKey: "human_decision@1",
  validate(selection, context) {
    const parsed = EnsembleSelectOneSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_selection", detail: parsed.error.issues[0]?.message ?? "invalid selection" };
    }
    if (context.eligibleArtifactIds.length < context.policy.minEligibleSubjects) {
      return {
        ok: false,
        reason: "insufficient_eligible",
        detail: `a decision needs at least ${context.policy.minEligibleSubjects} eligible artifacts, and ${context.eligibleArtifactIds.length} remain`,
      };
    }
    if (parsed.data.kind === "no_consensus") {
      return {
        ok: true,
        selection: parsed.data,
        outcome: { kind: "no_consensus", artifactIds: [...context.eligibleArtifactIds], reason: parsed.data.reason },
      };
    }
    // `selected`: the chosen artifact must be one of the eligible set - not merely a ready
    // artifact of the run, and never the recommendation by default. A guessed or stale id is a
    // refusal, so a decision cannot promote something the review never judged.
    const artifactId = parsed.data.artifactId;
    if (!context.eligibleArtifactIds.includes(artifactId)) {
      return { ok: false, reason: "ineligible_artifact", detail: `artifact ${artifactId} is not an eligible result` };
    }
    const memberId = context.memberForArtifact(artifactId);
    if (memberId === null) {
      return { ok: false, reason: "unknown_member", detail: `artifact ${artifactId} has no owning member` };
    }
    return {
      ok: true,
      selection: parsed.data,
      outcome: { kind: "selected", memberIds: [memberId], artifactIds: [artifactId], materializedTaskId: null },
    };
  },
};

/**
 * Every decision driver this build can execute, keyed by the exact `driverKey` a compiled plan
 * names. `Record<EnsembleDriverKey, …>` is the enforcement: a driver key appended to the shared
 * tuple does not compile until it says whether a decision implementation exists or `null`. The
 * non-decision keys are `null` because their stages are driven by other machinery.
 */
export const DECISION_DRIVERS: Record<EnsembleDriverKey, DecisionDriver | null> = {
  "member_wave@1": null,
  "artifact_barrier@1": null,
  "comparative_review@1": null,
  "human_decision@1": selectOneDecisionDriver,
  "select_one_finalize@1": null,
};

/** The decision driver for a persisted driver key, or null when this build cannot run it. */
export function decisionDriverFor(driverKey: string): DecisionDriver | null {
  const known = knownDriverKey(driverKey);
  return known ? DECISION_DRIVERS[known] : null;
}

/** Every driver key with a decision implementation, for completeness assertions and tests. */
export const DECISION_DRIVER_KEYS: EnsembleDriverKey[] = ENSEMBLE_DRIVER_KEYS.filter(
  (key) => DECISION_DRIVERS[key] !== null,
);
