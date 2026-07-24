import { ENSEMBLE_DRIVER_KEYS, knownDriverKey, type EnsembleDriverKey } from "@shared/ensemble.ts";
import { comparativeReviewDriver } from "./comparative.ts";
import type { ReviewDriver } from "./types.ts";

export type {
  ReviewDriver,
  ReviewDriverContext,
  ReviewExecution,
  ReviewMaterial,
  ReviewOutcome,
  ReviewPersist,
  ReviewRuntime,
  ReviewSubject,
} from "./types.ts";

/**
 * Every review driver this build can execute, keyed by the exact `driverKey` a compiled plan
 * names. The engine dispatches a review stage by looking its `driverKey` up here - never by
 * asking what strategy the run is - which is the whole reason a review is a versioned driver and
 * not a branch in the engine.
 *
 * `Record<EnsembleDriverKey, ReviewDriver | null>` is the enforcement: a driver key appended to
 * the shared tuple does not compile until it says whether a review implementation exists for it or
 * `null`. Non-review driver keys (member waves, decisions, finalization) are `null` here because
 * they are executed by the engine's own stage machinery, not by a review driver. `null` is a
 * first-class answer, exactly as it is for every capability registry - a review stage whose driver
 * is `null` is one this build cannot run as a review, and the engine leaves it parked rather than
 * pretending to have judged it.
 */
export const REVIEW_DRIVERS: Record<EnsembleDriverKey, ReviewDriver | null> = {
  "member_wave@1": null,
  "artifact_barrier@1": null,
  "comparative_review@1": comparativeReviewDriver,
  "human_decision@1": null,
  "select_one_finalize@1": null,
};

/** The review driver for a persisted driver key, or null when this build cannot run it as a review. */
export function reviewDriverFor(driverKey: string): ReviewDriver | null {
  const known = knownDriverKey(driverKey);
  return known ? REVIEW_DRIVERS[known] : null;
}

/** Every driver key with a review implementation, for completeness assertions and tests. */
export const REVIEW_DRIVER_KEYS: EnsembleDriverKey[] = ENSEMBLE_DRIVER_KEYS.filter(
  (key) => REVIEW_DRIVERS[key] !== null,
);
