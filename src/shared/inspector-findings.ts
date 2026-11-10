// Reading GitHub Inspector findings: whether each one reached GitHub, and the one order
// every reader lists them in.
//
// Browser-safe, and the only place either answer is derived. The findings route, Foreman's
// relay, the workflow `inspector_feedback` packet and the dashboard's findings table all
// call these functions rather than restating them, so a new state fails the build in every
// consumer instead of reading differently in one of them.

import { INSPECTOR_LIMITS } from "./inspector.ts";
import {
  INSPECTOR_LEGACY_POSTED,
  type InspectorComment,
  type InspectorLegacyPosted,
  type InspectorSeverity,
} from "./types.ts";

export function isInspectorLegacyPosted(value: unknown): value is InspectorLegacyPosted {
  return (INSPECTOR_LEGACY_POSTED as readonly unknown[]).includes(value);
}

/**
 * Whether a finding reached GitHub.
 *
 * - `posted`: confirmed on GitHub, now or before it was resolved.
 * - `posting`: written to the ledger ahead of a POST whose outcome is not yet known.
 * - `not-posted`: never published, so the finding's text exists only in Mission Control.
 * - `refused`: a draft GitHub refused `INSPECTOR_LIMITS.maxPostRefusals` times. It is no
 *   longer offered, and like `not-posted` it exists only in Mission Control. It stays
 *   unresolved, so it still blocks Shipping and Foreman still relays it.
 * - `unknown`: recorded before posting was tracked, and nothing on the row proves either way.
 */
export type FindingPublicationState = "posted" | "posting" | "not-posted" | "refused" | "unknown";

export interface FindingPublication {
  state: FindingPublicationState;
  /** This finding's GitHub comment, or for `earlierPost`, the earlier version's. */
  url: string | null;
  /** When the post was confirmed. For `earlierPost`, when the earlier version was. */
  postedAt: number | null;
  /** A drafted row whose earlier version was posted, and is not posted again yet. */
  earlierPost: boolean;
  /**
   * Validation refusals GitHub pinned on this draft. Zero for every row that is not a draft:
   * a refusal is about offering a draft, and says nothing once the row is posted or resolved.
   */
  refusals: number;
  /** GitHub's reason for the newest counted refusal, from the first one on. Null with none. */
  reason: string | null;
}

export type FindingPublicationInput =
  & Pick<InspectorComment, "status" | "postedAt" | "githubUrl" | "legacyPosted">
  & Partial<Pick<InspectorComment, "postRefusals" | "lastPostError">>;

/**
 * Derive a finding's publication state from its row. First match wins:
 *
 * 1. `posting` reads `posting`.
 * 2. `drafted` reads `refused` at `INSPECTOR_LIMITS.maxPostRefusals` refusals, and
 *    `not-posted` below it. Either way it carries `refusals` and GitHub's `reason` from the
 *    first counted refusal, so the reason shows straight away and not only at the cap.
 *    `earlierPost` is set when the row was posted before, by `postedAt` or by
 *    `legacyPosted = posted`, and `url` is then that earlier comment.
 * 3. `open` reads `posted`.
 * 4. `resolved` reads `posted` when it was posted, `unknown` when the backfill could not
 *    tell, and `not-posted` otherwise.
 *
 * A row whose `postedAt` is ABSENT (as against null) comes from a snapshot taken before
 * the field existed. Where the answer depends on that field, it reads `unknown` rather
 * than claiming the finding was never posted. An absent `postRefusals` reads as zero.
 */
export function findingPublication(row: FindingPublicationInput): FindingPublication {
  const postedAt = typeof row.postedAt === "number" ? row.postedAt : null;
  const url = typeof row.githubUrl === "string" && row.githubUrl ? row.githubUrl : null;
  const postedBefore = postedAt !== null || row.legacyPosted === "posted";
  const untracked = row.postedAt === undefined && row.legacyPosted === undefined;
  const plain = { url: null, postedAt: null, earlierPost: false, refusals: 0, reason: null };
  switch (row.status) {
    case "posting":
      return { state: "posting", ...plain };
    case "drafted": {
      const refusals = draftRefusals(row.postRefusals);
      const reason = refusals > 0 && typeof row.lastPostError === "string" && row.lastPostError
        ? row.lastPostError
        : null;
      const state = refusals >= INSPECTOR_LIMITS.maxPostRefusals ? "refused" : "not-posted";
      return postedBefore
        ? { state, url, postedAt, earlierPost: true, refusals, reason }
        : { state, url: null, postedAt: null, earlierPost: false, refusals, reason };
    }
    case "open":
      return { state: "posted", ...plain, url, postedAt };
    case "resolved":
      if (postedBefore) return { state: "posted", ...plain, url, postedAt };
      if (row.legacyPosted === "unknown" || untracked) return { state: "unknown", ...plain };
      return { state: "not-posted", ...plain };
    default:
      return { state: "unknown", ...plain };
  }
}

function draftRefusals(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** "1 time", "3 times": how often GitHub refused a draft, in the words every reader uses. */
export function refusalTimes(refusals: number): string {
  return `${refusals} time${refusals === 1 ? "" : "s"}`;
}

const SEVERITY_ORDER: Record<InspectorSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** Severity first, then path, line (a body-only finding last) and fingerprint. */
export function compareInspectorFindings(
  a: Pick<InspectorComment, "severity" | "path" | "line" | "fingerprint">,
  b: Pick<InspectorComment, "severity" | "path" | "line" | "fingerprint">,
): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (a.path ?? "").localeCompare(b.path ?? "")
    || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
    || a.fingerprint.localeCompare(b.fingerprint);
}

/** Every finding on a pull request: unresolved first, then in `compareInspectorFindings` order. */
export function orderInspectorFindings<T extends InspectorComment>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) =>
    Number(a.status === "resolved") - Number(b.status === "resolved")
    || compareInspectorFindings(a, b));
}
