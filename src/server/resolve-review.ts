import type { ResolveReview } from "@shared/protocol.ts";
import type { ReviewActor, ReviewItem, Session } from "@shared/types.ts";
import { approvesFinalBundle } from "@shared/managed-plans.ts";
import { assertStandingApprovalGrantable, grantStandingBundleApproval, isStandingFollowUp, STANDING_FOLLOW_UP_NOTE } from "./plans/publication.ts";
import { PlanStoreError } from "./plans/files.ts";
import type { Registry } from "./registry.ts";
import { ReviewResolutionError, type ReviewManager } from "./reviews.ts";
import type { ResidentInstructionChanges } from "./residents/instruction-changes.ts";

type Refusal = { error: string; status: 400 | 403 | 404 | 409 };
type Result = { kind: "committed"; review: ReviewItem } | ({ kind: "refused" | "missing" | "plan-failure" } & Refusal);

function planFailure(error: unknown): Result {
  return { kind: "plan-failure", error: error instanceof Error ? error.message : "Plan operation failed",
    status: error instanceof PlanStoreError ? error.status : 409 };
}

/** Clicks and voice deadlines share a single synchronous review transaction. */
export function createReviewResolver(registry: Registry, reviews: ReviewManager, residentInstructions: ResidentInstructionChanges | null,
  refuse: (session: Session, by: ReviewActor) => Refusal | null) {
  return (id: string, resolution: ResolveReview, by: ReviewActor): Result => {
    // The fourth Foreman-marked write, and the one the phase plan left as a judgment call
    // on whether its session could be resolved cheaply. It can: a review record names its
    // `sessionId`, so this is two map lookups and no I/O.
    //
    // Refused only on a POSITIVE answer - the session is here and uninvited. A review
    // whose session has been evicted resolves normally: there is no pane left to type
    // into, so this stops being a typing act and becomes the bookkeeping that settles a
    // dangling row, and refusing it would strand the review instead of protecting anyone.
    const owner = registry.getReview(id)?.sessionId;
    const session = owner && registry.getSession(owner);
    const refusal = session ? refuse(session, by) : null;
    if (refusal) {
      return { kind: "refused", error: refusal.error, status: refusal.status };
    }
    // "Approve all future bundles for this task" is the operator's standing grant. Checked
    // before resolving, so a grant that cannot be kept leaves the question open to retry.
    // Only an answer that approves this bundle grants it: "Needs revision" with the box ticked
    // must not approve the next one.
    const grant = resolution.action === "answer" && resolution.approveFutureBundles === true
      && approvesFinalBundle(resolution.selections);
    if (grant) {
      if (by !== "human") return { kind: "refused", error: "Only the operator can approve future plan bundles", status: 403 };
      if (registry.getReview(id)?.status !== "pending") return { kind: "refused", error: "This review is already settled", status: 409 };
      try {
        assertStandingApprovalGrantable(id);
      } catch (error) { return planFailure(error); }
    }
    // A resident's proposed instruction changes: only a person's answer applies them, and the
    // write commits with the answer. Refused before anything settles when the answer is not
    // the operator's, so the question stays open for them.
    const instructionChange = residentInstructions?.resolution(
      id,
      resolution.action,
      by,
      resolution.selections ?? null,
    ) ?? null;
    if (instructionChange && "refusal" in instructionChange) {
      return { kind: "refused", error: instructionChange.refusal.error, status: instructionChange.refusal.status };
    }
    if (grant && instructionChange) {
      return { kind: "refused", error: "A plan bundle grant cannot answer a resident instruction proposal", status: 409 };
    }
    try {
      // An answer to the questions left beside an auto-approved bundle tells the agent the
      // bundle is already approved, because this form no longer asked about it.
      // Every answer gets the note, including one sent with selections and no response text.
      const response = resolution.action === "answer" && isStandingFollowUp(id)
        ? [STANDING_FOLLOW_UP_NOTE, resolution.response].filter(Boolean).join("\n\n")
        : resolution.response;
      const updated = reviews.resolve(
        id,
        resolution.action,
        response,
        by,
        resolution.selections,
        // Committed with the answer, so a failed grant leaves the review pending to retry.
        grant
          ? () => grantStandingBundleApproval(id)
          : instructionChange?.persist,
      );
      if (!updated) return { kind: "missing", error: "no such review", status: 404 };
      instructionChange?.publish();
      return { kind: "committed", review: updated };
    } catch (error) {
      if (error instanceof ReviewResolutionError) return { kind: "refused", error: error.message, status: 400 };
      if (error instanceof PlanStoreError) return planFailure(error);
      throw error;
    }
  };
}
