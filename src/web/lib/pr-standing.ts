// Where an adopted pull request STANDS, in the two vocabularies the app reads it in.
//
// These folds were exports of `ShippingSettingsPanel.tsx` until a second surface needed
// them, which is the moment a helper stops belonging to the panel that happened to want it
// first: the Ship log is not a settings panel, and a page importing a settings panel to
// learn what "merged" means would have made the panel a dependency of every future ledger
// reader. Moved rather than copied - two answers to "did this land" is the failure this
// file exists to prevent.
//
// Two vocabularies, deliberately, and neither is a rename of the other:
//
//  - `MergeBucket` is the FIVE-way YOLO-mode reading (merged / soaking / blocked / waiting /
//    closed). It answers "why has the auto-merger not landed this", which is a question only
//    the Shipping panel asks, and its distinctions exist to keep a self-clearing wait from
//    being reported as a fault.
//  - `PrStanding` is the THREE-way reading (merged / open / gone). It answers "did this
//    ship", which is the only question a cross-repo ledger asks, and it is folded FROM
//    `mergeBucket` rather than derived beside it - see `prStanding`.
//
// Browser-safe and React-free, like everything else in `lib/`: the folds, the page and the
// tests all read the same functions.

import type { InspectorInspection, InspectorPr } from "@shared/types.ts";
import { MERGE_BLOCK_LABEL } from "@shared/shipping.ts";
import type { MergeBlock } from "@shared/shipping.ts";

/**
 * Where one adopted PR stands with YOLO mode, in one phrase.
 *
 * A stored `mergeBlock` that is not a known code is the message `gh` gave when it refused
 * the merge - branch protection, a required check we cannot see - so it is shown verbatim
 * rather than dropped. That message is the only account the operator gets of a rule this
 * app cannot read.
 */
export function mergeStatus(row: InspectorInspection): string {
  if (row.mergedAt !== null) return "merged";
  if (row.state === "closed") return "closed";
  if (!row.mergeBlock) return "not looked at yet";
  return MERGE_BLOCK_LABEL[row.mergeBlock as MergeBlock] ?? row.mergeBlock;
}

/**
 * Which pile a row is in, for the count strip and the filter it doubles as.
 *
 * `soaking` is split out of `blocked` because it is the one block that clears itself: a
 * strip that folded the two together would say "3 blocked" about a queue in which nothing
 * is wrong, which is precisely the reading that gets the safety valve turned down to zero.
 */
export type MergeBucket = "merged" | "soaking" | "blocked" | "waiting" | "closed";

export function mergeBucket(row: InspectorInspection): MergeBucket {
  if (row.mergedAt !== null) return "merged";
  if (row.state === "closed") return "closed";
  if (!row.mergeBlock) return "waiting";
  return row.mergeBlock === "soaking" ? "soaking" : "blocked";
}

/** The strip's tallies. Derived from `mergeBucket`, so a tile's count and the rows it
 *  filters to are the same question asked once. */
export function mergeTallies(rows: readonly InspectorInspection[]): Record<MergeBucket, number> {
  const t: Record<MergeBucket, number> = {
    merged: 0,
    soaking: 0,
    blocked: 0,
    waiting: 0,
    closed: 0,
  };
  for (const row of rows) t[mergeBucket(row)] += 1;
  return t;
}

/**
 * Did it ship, is it still going, or did it end without shipping - the three-way reading.
 *
 * `gone` rather than "closed", because the row it describes is one nobody will ever act on
 * again and "closed" is a word this app already spends on a SESSION that exited normally.
 */
export const PR_STANDINGS = ["merged", "open", "gone"] as const;
export type PrStanding = (typeof PR_STANDINGS)[number];

export const PR_STANDING_LABELS: Record<PrStanding, string> = {
  merged: "merged",
  open: "open",
  gone: "gone",
};

/**
 * The coarse standing, folded from `mergeBucket` rather than computed beside it.
 *
 * This is the load-bearing line of the file. Written independently - `mergedAt !== null ||
 * observedState === "MERGED"`, and so on - it would be a FOURTH vocabulary that agrees with
 * the other one only until someone edits one of them, and the symptom would be a ledger
 * whose repository rail and whose rows disagree about the same pull request. Folded, the
 * two readings cannot come apart: every bucket is mapped here exactly once, and a bucket
 * added to `MergeBucket` fails to compile until it says which of the three it is.
 *
 * `observedState` is consulted only for the one thing the buckets cannot see. `mergedAt` is
 * written by YOLO MODE - it means "the fleet landed this unattended" - so a pull request a
 * HUMAN merged has `mergedAt: null` and `state: "closed"`, which buckets as `closed` and
 * would read as `gone`. On a ledger about what shipped, that is the wrong answer about
 * exactly the rows an operator most wants counted, so the poll's own observation wins where
 * it says `MERGED`. Null (never polled) leaves the bucket's reading standing.
 */
export function prStanding(row: InspectorInspection): PrStanding {
  if (row.observedState === "MERGED") return "merged";
  switch (mergeBucket(row)) {
    case "merged":
      return "merged";
    case "closed":
      return "gone";
    case "soaking":
    case "blocked":
    case "waiting":
      return "open";
  }
}

/** The three-way tallies, over any set of rows - the whole week, or one repository's slice. */
export function standingTallies(
  rows: readonly InspectorInspection[],
): Record<PrStanding, number> {
  const tally: Record<PrStanding, number> = { merged: 0, open: 0, gone: 0 };
  for (const row of rows) tally[prStanding(row)] += 1;
  return tally;
}

/**
 * What a row is CALLED: the pull request's title, or the branch it was opened from.
 *
 * The fallback is not cosmetic. `title` is written by the Inspector's poll and is null
 * between adoption and the first observation - and permanently for a row adopted by a build
 * older than the column, since the tick retires merged and closed rows and never looks
 * again. An empty string in that slot would render a row with no name at all, so the branch
 * name stands in: it is what the operator typed, and it is on the ledger from the first
 * poll for the same reason.
 *
 * Both null is reachable (adopted seconds ago, never polled), and the pull request's own
 * number is the last thing that is always true about it.
 */
export function prLabel(row: Pick<InspectorPr, "title" | "headRefName" | "number">): string {
  return row.title ?? row.headRefName ?? `#${row.number}`;
}
