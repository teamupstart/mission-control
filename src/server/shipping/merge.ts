import { getInspectorPr, updateInspectorPr } from "../db.ts";
import { mergePr } from "../inspector/github.ts";
import { mergeVerdict } from "@shared/shipping.ts";
import type { PrSnapshot } from "../inspector/github.ts";
import type { InspectorComment, InspectorPr } from "@shared/types.ts";
import { getShippingConfig } from "./config.ts";

// YOLO mode's one action: land a pull request that the Inspector reviewed clean, CI
// passed, and nobody objected to inside the soak window.
//
// It rides the INSPECTOR'S tick rather than owning a poller, and that is a design
// decision worth defending where someone might undo it. The set of PRs it may act on is
// exactly the set the Inspector adopted - the ones we can prove Mission Control opened -
// and the evidence it weighs (findings, reviewed head) is the Inspector's own ledger. A
// second poller would need the same adoption rule, the same `gh` snapshot and the same
// ledger read, and the first time the two drifted the answer would be a merge.
//
// The consequence, stated plainly because it is load-bearing: with the Inspector switched
// off nothing is reviewed, so nothing is ever `reviewedSha === headSha`, so nothing
// merges. YOLO mode is not a way to merge unreviewed pull requests.

/** Findings the Inspector is currently carrying, by the same rule the panel counts them. */
function openFindings(rows: Map<string, InspectorComment>): number {
  let n = 0;
  for (const c of rows.values()) if (c.status !== "resolved") n += 1;
  return n;
}

/**
 * Record why this PR is not merging, when that answer has CHANGED.
 *
 * The comparison is the point: this runs for every open PR on every sweep, and an
 * unconditional write would be a row rewrite per PR per 90 seconds forever on the one
 * synchronous handle that also serves hook ingest and SSE. The panel wants the current
 * answer, not a log of every time it was re-derived.
 */
function recordBlock(pr: InspectorPr, block: string | null, now: number): void {
  const current = getInspectorPr(pr.key);
  if (!current || current.mergeBlock === block) return;
  updateInspectorPr(pr.key, { mergeBlock: block }, now);
}

/**
 * Merge this pull request if every gate says so. Returns true when it merged.
 *
 * Failures do NOT go through `noteFailure`: the Inspector's backoff exists to stop paying
 * for repeated model runs, and a refused merge costs one `gh api` call. Backing the PR
 * off for it would suspend the reviewing too - so a branch-protection rule this feature
 * cannot satisfy would silently stop the review the operator did ask for. The refusal is
 * recorded where it belongs instead, as this PR's merge block, and the next sweep tries
 * again; the situation it describes (protection satisfied, a required review given) is
 * one that changes without anything on our side changing.
 */
export async function maybeMerge(
  pr: InspectorPr,
  dir: string,
  s: PrSnapshot,
  rows: Map<string, InspectorComment>,
  now: number,
): Promise<boolean> {
  const cfg = getShippingConfig();
  const verdict = mergeVerdict({
    cfg,
    cwd: pr.cwd,
    repoRoot: pr.repoRoot,
    pr: {
      state: s.state,
      isDraft: s.isDraft,
      headSha: s.headSha,
      createdAt: s.createdAt,
      mergeable: s.mergeable,
      reviewDecision: s.reviewDecision,
      checks: s.checks,
      unresolvedThreads: s.threads.filter((t) => !t.isResolved).length,
    },
    reviewedSha: pr.headSha,
    rounds: pr.round,
    openFindings: openFindings(rows),
    now,
  });

  if (!verdict.merge) {
    recordBlock(pr, verdict.block, now);
    return false;
  }

  const res = await mergePr(dir, pr.owner, pr.repo, pr.number, s.headSha, cfg.method);
  if (!res.ok) {
    // The message rather than a code, because the interesting refusals are the ones this
    // process cannot see coming - a branch protection rule, a required check we are not
    // told about - and a code would flatten every one of them into "it didn't work".
    recordBlock(pr, (res.error ?? "the merge was refused").slice(0, 300), now);
    return false;
  }

  // Merged. The row retires here rather than waiting for the next sweep to notice the
  // state flip, so nothing re-evaluates a PR that no longer exists to merge. `mergedAt`
  // is what distinguishes this from the same row closed because a HUMAN merged it - the
  // one fact the ledger could not otherwise recover.
  updateInspectorPr(
    pr.key,
    { state: "closed", mergedAt: now, mergeBlock: null, lastError: null, nextAttemptAt: null },
    now,
  );
  return true;
}
