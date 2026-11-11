import type { InspectorInspection } from "../../src/shared/types.ts";

/** An open ledger row the Inspector adopted from a hook, with one drafted finding. */
export function mkInspection(over: Partial<InspectorInspection> = {}): InspectorInspection {
  return {
    key: "owner/repo#7",
    url: "https://github.com/owner/repo/pull/7",
    owner: "owner",
    repo: "repo",
    number: 7,
    repoRoot: "/work/alpha",
    cwd: "/work/alpha",
    sessionId: "s1",
    source: "hook",
    state: "open",
    headSha: "head-7",
    reviewPosture: "dry-run",
    round: 3,
    lastReviewedAt: 1_000,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: "head-7",
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: "head-7",
    observedState: "OPEN",
    observedAt: 1_000,
    headRefName: "feat/x",
    title: "Fix the handler",
    adoptedAt: 500,
    updatedAt: 1_000,
    openFindings: 1,
    postedOpenFindings: 0,
    resolvedFindings: 0,
    ...over,
  };
}
