import { repoAllowlisted } from "./allowlist.ts";
import type { InspectorPosture } from "./inspector.ts";
import type { ShippingConfig } from "./protocol.ts";

// YOLO mode: the one rule that decides whether a pull request merges itself.
//
// It lives here, beside `allowlist.ts` and `cost.ts`, for the reason every shared
// predicate in this app lives here: the daemon acts on it and the settings panel explains
// it, and those two must not be able to disagree about what "ready" means. A panel that
// says "waiting on CI" while the daemon is merging is worse than no panel.
//
// The function is PURE. Everything it needs - the PR's state, its checks, how long it has
// been open, how many findings the Inspector has open on it - is passed in, so the whole
// gate is testable without a network, a repo, or a clock. See `shipping-merge.test.ts`.

/** What CI says about the head commit. `none` is "no checks reported", not "passing". */
export type ChecksState = "passing" | "failing" | "pending" | "none";

/** GitHub's own answer to "can this be merged", straight off the PR. */
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** GitHub's review verdict. Null when nobody has reviewed and nobody is required to. */
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

/**
 * Why a pull request did not merge itself, in one word.
 *
 * Recorded on the ledger row and shown in the panel, because the failure mode of an
 * auto-merger is not that it merges the wrong thing - it is that it merges nothing and
 * never says why, and the operator concludes the feature is broken and turns it off.
 * Every gate below names itself here.
 */
export type MergeBlock =
  | "off"
  | "not-allowlisted"
  | "inspector-off"
  | "inspector-dry-run"
  | "inspector-not-allowlisted"
  | "review-unpublished"
  | "not-open"
  | "draft"
  | "workflow-gate-pending"
  | "not-reviewed"
  | "findings"
  | "threads"
  | "changes-requested"
  | "review-required"
  | "checks-failing"
  | "checks-pending"
  | "no-checks"
  | "conflicting"
  | "mergeability-unknown"
  | "soaking";

/**
 * One sentence per gate, for the panel.
 *
 * A `mergeBlock` that is NOT a key here is a message `gh` gave us when it refused the
 * merge itself (branch protection, a rule we cannot see from the outside), so readers
 * fall back to the stored string rather than dropping it.
 */
export const MERGE_BLOCK_LABEL: Record<MergeBlock, string> = {
  off: "YOLO mode is off",
  "not-allowlisted": "this repo is not on the auto-merge list",
  "inspector-off": "the Inspector is switched off, so nothing is reviewing this",
  "inspector-dry-run": "the Inspector is in dry run, so its review was never published",
  "inspector-not-allowlisted":
    "this repo is not on the Inspector's list, so its review was never published",
  "review-unpublished":
    "this push was reviewed without live publishing; the Inspector must review it again live",
  "not-open": "the pull request is closed",
  draft: "still a draft",
  "workflow-gate-pending": "an active workflow still owns the Inspector final gate",
  "not-reviewed": "the Inspector has not reviewed this push yet",
  findings: "the Inspector has open findings",
  threads: "there are unresolved review threads",
  "changes-requested": "somebody requested changes",
  "review-required": "a review is required and has not been given",
  "checks-failing": "CI is failing",
  "checks-pending": "CI is still running",
  "no-checks": "no CI checks reported on this commit",
  conflicting: "the branch conflicts with its base",
  "mergeability-unknown": "GitHub has not worked out whether it merges cleanly",
  soaking: "waiting out the soak window",
};

/** Everything the decision reads. Deliberately plain data - no snapshots, no rows. */
export interface MergeInput {
  cfg: ShippingConfig;
  /** Where the PR was opened from, for the allowlist. Same pair the Inspector matches on. */
  cwd: string | null;
  repoRoot: string | null;
  /** Live state, as GitHub reports it right now. */
  pr: {
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
    headSha: string;
    /** When the PR was opened, epoch ms. Null when GitHub's timestamp did not parse. */
    createdAt: number | null;
    mergeable: MergeableState;
    reviewDecision: ReviewDecision;
    checks: ChecksState;
    /** Any review thread on the PR that nobody has resolved - ours or a colleague's. */
    unresolvedThreads: number;
  };
  /**
   * What the Inspector could actually do about this PR - see `inspectorPosture`.
   *
   * Passed in rather than derived from an `InspectorConfig` here because this predicate
   * stays pure data-in: the posture already folds a path-allowlist match against THIS
   * checkout, which is a question about the PR, not about the config.
   */
  inspector: InspectorPosture;
  /** The head the Inspector last completed a review of, and the posture that produced it. */
  reviewedSha: string | null;
  reviewPosture: InspectorPosture | null;
  /** How many completed review rounds it has run. */
  rounds: number;
  /** Findings the Inspector is currently carrying: posted, previewed, or mid-post. */
  openFindings: number;
  /** Pure veto from the workflow subsystem. It can never make a merge eligible. */
  workflowGatePending: boolean;
  now: number;
}

export interface MergeVerdict {
  merge: boolean;
  /** Null only when `merge` is true. */
  block: MergeBlock | null;
  /** Milliseconds of soak left. Zero unless `block` is `soaking`. */
  waitMs: number;
}

const ready: MergeVerdict = { merge: true, block: null, waitMs: 0 };

function blocked(block: MergeBlock, waitMs = 0): MergeVerdict {
  return { merge: false, block, waitMs };
}

/**
 * May this pull request merge itself, right now?
 *
 * Every gate is a veto and they are ANDed, so the order below only decides which reason
 * gets reported - and it is ordered to report the most useful one. The soak is checked
 * LAST on purpose: "green, clean, soaking for another 4 minutes" is the sentence an
 * operator wants, and it is only true once everything else has passed.
 *
 * Two gates deserve their reasoning written down, because both are places a future
 * change would loosen the feature without meaning to:
 *
 * - **`no-checks` blocks.** The setting says "merge what passes CI", and a commit with no
 *   checks has not passed CI - it has never been asked. Treating silence as success would
 *   turn YOLO mode in a repo with no workflow (or one whose workflow failed to trigger)
 *   into "merge everything the moment it is reviewed", which is the one behaviour nobody
 *   would knowingly switch on.
 * - **`threads` counts everyone's threads, not just ours.** The spec is "no open comments
 *   by the Inspector", and `findings` is that gate. This one is separate and stricter:
 *   merging over a colleague's unanswered question is not a thing an automation gets to
 *   do, whoever raised it.
 * - **The Inspector's posture is a gate, not a precondition someone else checks.** A
 *   review that was never published is not a review this may act on, and `not-reviewed`
 *   cannot see the difference: `reviewRound` advances the reviewed head in dry run
 *   exactly as it does live. Whoever calls this may not be the worker - the two
 *   `inspector-*` blocks below are also the backstop against the second poller that
 *   `shipping/merge.ts` warns about - so the veto lives with the decision.
 */
export function mergeVerdict(input: MergeInput): MergeVerdict {
  const { cfg, pr } = input;
  if (!cfg.autoMerge) return blocked("off");
  if (!repoAllowlisted(input.cwd, input.repoRoot, cfg.repoAllowlist)) {
    return blocked("not-allowlisted");
  }

  // Before any fact about the PR, because none of them mean anything if the review
  // behind them was never real. Grouped with the two consent gates above: all three are
  // answers about how the operator configured this, and each names the switch to flip.
  switch (input.inspector) {
    case "off":
      return blocked("inspector-off");
    case "dry-run":
      return blocked("inspector-dry-run");
    case "not-allowlisted":
      return blocked("inspector-not-allowlisted");
    case "live":
      break;
  }

  if (pr.state !== "OPEN") return blocked("not-open");
  if (pr.isDraft) return blocked("draft");
  if (input.workflowGatePending) return blocked("workflow-gate-pending");

  // The review has to be of THIS push. `rounds` alone would let a PR that was reviewed
  // clean three force-pushes ago merge whatever is on the branch now.
  if (input.rounds < 1 || !pr.headSha || input.reviewedSha !== pr.headSha) {
    return blocked("not-reviewed");
  }
  // Current live consent cannot retroactively publish a review completed while the
  // Inspector was dry-run or the repo was untrusted. The worker will run this head again
  // under live posture; until that succeeds, the stored review cannot authorize a merge.
  if (input.reviewPosture !== "live") return blocked("review-unpublished");
  if (input.openFindings > 0) return blocked("findings");
  if (pr.unresolvedThreads > 0) return blocked("threads");

  if (pr.reviewDecision === "CHANGES_REQUESTED") return blocked("changes-requested");
  if (pr.reviewDecision === "REVIEW_REQUIRED") return blocked("review-required");

  switch (pr.checks) {
    case "failing":
      return blocked("checks-failing");
    case "pending":
      return blocked("checks-pending");
    case "none":
      return blocked("no-checks");
    case "passing":
      break;
  }

  if (pr.mergeable === "CONFLICTING") return blocked("conflicting");
  // UNKNOWN is GitHub still computing it, which it does lazily after a push. Refusing to
  // act on it costs a poll interval; acting on it means merging without ever having been
  // told the merge is clean.
  if (pr.mergeable !== "MERGEABLE") return blocked("mergeability-unknown");

  // A PR whose creation time we cannot read has no measurable soak, so it never satisfies
  // one. Failing closed here rather than treating "unknown" as "long enough" keeps the
  // soak from being skippable by a parse failure.
  if (pr.createdAt === null) return blocked("soaking", cfg.soakMinutes * 60_000);
  const soakEndsAt = pr.createdAt + cfg.soakMinutes * 60_000;
  if (input.now < soakEndsAt) return blocked("soaking", soakEndsAt - input.now);

  return ready;
}
