import assert from "node:assert/strict";
import test from "node:test";
import { sessionActionAdapter } from "../src/server/workflows/session-action-adapters.ts";
import type {
  SessionActionAdapterContext,
  SessionActionAdoptedPullRequest,
} from "../src/server/workflows/session-action-adapters.ts";
import { FULL_SHA } from "../src/server/workflows/commit-id.ts";
import { SessionActionContinuationExpectationSchema } from "@shared/protocol.ts";
import type {
  SessionActionContinuationExpectation,
  SessionActionSnapshot,
  WorkflowContextSnapshot,
} from "@shared/workflow.ts";

// What the `pull_request` completion adapter will and will not accept as proof that the work a
// workflow just reviewed is on an open pull request.
//
// Durable adoption is the completion boundary. Provider comparison metadata may arrive later;
// missing values and disagreements remain visible as warnings while downstream stages still run.

const ADAPTER = sessionActionAdapter("pull_request");
const REPO = "/repo";
const BRANCH = "feature/x";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const SESSION = "sess-1";

const pr = (
  patch: Partial<SessionActionAdoptedPullRequest> = {},
): SessionActionAdoptedPullRequest => ({
  key: "owner/repo#7",
  url: "https://github.com/owner/repo/pull/7",
  number: 7,
  repositoryRoot: REPO,
  branch: BRANCH,
  observedHeadOid: HEAD,
  observedState: "OPEN",
  observedAt: 1_000,
  // Adopted by the bound session, after the packet landed: the default row is one this turn
  // produced, so a test that moves it off-branch reproduces the stray case rather than the
  // unattributable one.
  sessionId: SESSION,
  adoptedAt: 20,
  ...patch,
});

const decide = (
  adopted: SessionActionAdoptedPullRequest[],
  patch: Partial<SessionActionAdapterContext> = {},
) =>
  ADAPTER.decide({
    snapshot: {} as SessionActionSnapshot,
    session: { id: SESSION } as never,
    anchorTranscriptBytes: 10,
    deliveredAt: 10,
    pickedUpAt: 2,
    settledAt: 3,
    now: 5_000,
    repository: { repositoryId: REPO, root: REPO, branch: BRANCH, headOid: HEAD, headCommittedAt: 4_000 },
    adoptedPullRequests: adopted,
    capturedHeadOid: null,
    acceptedContentTreeOid: TREE,
    ...patch,
  });

// ---- the one case that completes -----------------------------------------------------------

test("an open adopted pull request at the local head completes, with its provenance", () => {
  const decision = decide([pr()]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.deepEqual(decision.continuationExpectation, {
    kind: "pull_request",
    pullRequestKey: "owner/repo#7",
    pullRequestUrl: "https://github.com/owner/repo/pull/7",
    pullRequestNumber: 7,
    repositoryRoot: REPO,
    branch: BRANCH,
    expectedHeadOid: HEAD,
    acceptedContentTreeOid: TREE,
    observedAt: 1_000,
  });
});

test("a pull request opened before this action, already at the head, completes once", () => {
  // The idempotent case the plan asks for by name: the branch already had an open pull
  // request at this commit when the action ran, and the right answer is to adopt it rather
  // than to demand a second one be opened.
  const decision = decide([pr({ observedAt: 1 })]);
  assert.equal(decision.kind, "complete");
});

test("two matching open pull requests resolve to the same one every time", () => {
  // Deterministic rather than first-seen: the ledger's row order is not a contract, and an
  // action whose recorded provenance changed between two sweeps would make its own audit
  // trail unreadable.
  const low = pr({ key: "owner/repo#4", number: 4, url: "https://github.com/owner/repo/pull/4" });
  const high = pr({ key: "owner/repo#9", number: 9, url: "https://github.com/owner/repo/pull/9" });
  for (const adopted of [[low, high], [high, low]]) {
    const decision = decide(adopted);
    assert.equal(decision.kind, "complete");
    if (decision.kind !== "complete") return;
    assert.equal(
      decision.continuationExpectation.kind === "pull_request"
        && decision.continuationExpectation.pullRequestNumber,
      4,
    );
  }
});

// ---- everything that waits -------------------------------------------------------------------

test("no adopted pull request at all waits for one", () => {
  const decision = decide([]);
  assert.deepEqual(decision, { kind: "waiting", reason: "awaiting_pull_request" });
});

test("a pull request THIS TURN opened on another branch completes with a warning", () => {
  // The state an operator most needs told apart from "no pull request yet": the turn finished
  // and put its pull request on a branch this action is not about. A stacked branch, or one
  // that was never switched, can carry this exact commit - so matching on the commit alone
  // would have let it satisfy the action, and reporting it as "awaiting" would have left
  // somebody watching for a pull request that already existed where they were not looking.
  const decision = decide([pr({ branch: "other-branch" })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /different branch|not the checked branch/);
});

test("a pull request THIS TURN opened in another repository completes with a warning", () => {
  // Reported separately from the branch case because the remedy differs: the work is in the
  // wrong project rather than off the wrong head, and a branch comparison across two
  // repositories would be meaningless anyway.
  const decision = decide([pr({ repositoryRoot: "/somewhere/else" })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /different repository/);
});

test("the repository mismatch warning is selected ahead of a branch mismatch beside it", () => {
  const decision = decide([
    pr({ key: "owner/repo#8", number: 8, branch: "other-branch" }),
    pr({ key: "owner/other#1", number: 1, repositoryRoot: "/somewhere/else" }),
  ]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /different repository/);
});

test("a stray pull request nobody can attribute is never reported as this session's mistake", () => {
  // Two ways a row fails attribution, and both must fall back to the honest "nothing yet"
  // rather than accusing an operator's session of opening something it did not.
  //
  // A null session link is a pull request that outlived the session that opened it. An
  // adoption OLDER than this action's delivery is the same session's earlier work - still on
  // the branch it belonged to, and no evidence at all about this turn.
  assert.deepEqual(
    decide([pr({ branch: "other-branch", sessionId: null })]),
    { kind: "waiting", reason: "awaiting_pull_request" },
  );
  assert.deepEqual(
    decide([pr({ branch: "other-branch", sessionId: "some-other-session" })]),
    { kind: "waiting", reason: "awaiting_pull_request" },
  );
  assert.deepEqual(
    decide([pr({ branch: "other-branch", adoptedAt: 9 })]),
    { kind: "waiting", reason: "awaiting_pull_request" },
  );
});

test("a correct pull request on this branch always wins over a stray beside it", () => {
  // A turn that opened a stray first and the right one second must complete, not sit reporting
  // the stray. The mismatch arms are reached only when nothing is on this branch at all.
  const decision = decide([pr({ key: "owner/other#1", number: 1, repositoryRoot: "/elsewhere" }), pr()]);
  assert.equal(decision.kind, "complete");
});

test("an open pull request on this branch at an older head completes with a ref warning", () => {
  const decision = decide([pr({ observedHeadOid: OTHER_HEAD })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /pushed ref/);
});

test("an adopted pull request the poller has never looked at completes with a warning", () => {
  // Durable adoption is the publication boundary. A row written the instant `gh pr create`
  // returned has no head, branch, or provider state yet, but those fields are comparison
  // diagnostics rather than prerequisites for continuing the workflow.
  const decision = decide([pr({
    observedHeadOid: null,
    observedState: null,
    observedAt: null,
    branch: null,
  })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /branch, pushed ref, pull-request state/);
});

test("a linked worktree and its main checkout are ONE repository", () => {
  // The bug a browser spec found, pinned here as the cheap version. Mission Control dispatches
  // agents into linked worktrees, so the bound checkout's toplevel is a per-session path while
  // the pull request it opens is adopted against the repository that worktree was cut from.
  // Comparing toplevels made those two different repositories for every dispatched session -
  // the ordinary case - so the action could never complete, and once mismatch states existed it
  // would have blamed the operator for it.
  //
  // `repositoryId` is git's common directory, which is the same string for a main checkout and
  // all of its linked worktrees, and it is what both sides are normalised to.
  const decision = decide([pr({ repositoryRoot: "/main/.git" })], {
    repository: {
      repositoryId: "/main/.git",
      root: "/worktrees/abc",
      branch: BRANCH,
      headOid: HEAD,
      headCommittedAt: 4_000,
    },
  });
  assert.equal(decision.kind, "complete", "a worktree's pull request must be its repository's");
  // And the identity is what the provenance records, so a reader can tell which repository was
  // proven rather than which directory happened to be checked out.
  if (decision.kind !== "complete") return;
  assert.equal(
    decision.continuationExpectation.kind === "pull_request"
      && decision.continuationExpectation.repositoryRoot,
    "/main/.git",
  );
});

test("an unpolled pull request completes from adoption with unknown metadata warnings", () => {
  // The distinction the mismatch arms turn on, stated on its own because it is the one that
  // false-accuses if it is got wrong. A row adopted seconds ago by this very turn has a null
  // branch and a null repository root because the poller has not reached it - which is the
  // ORDINARY case, not a mistake. Only a known value that DIFFERS is a mismatch.
  const unknown = decide([
    pr({
      branch: null,
      repositoryRoot: null,
      observedHeadOid: null,
      observedState: null,
      observedAt: null,
    }),
  ]);
  assert.equal(unknown.kind, "complete");
  if (unknown.kind !== "complete") return;
  assert.match(unknown.warnings?.[0]?.detail ?? "", /repository, branch, pushed ref, pull-request state/);
  assert.deepEqual(unknown.continuationExpectation, {
    kind: "pull_request",
    pullRequestKey: "owner/repo#7",
    pullRequestUrl: "https://github.com/owner/repo/pull/7",
    pullRequestNumber: 7,
    repositoryRoot: null,
    branch: null,
    expectedHeadOid: null,
    acceptedContentTreeOid: TREE,
    observedAt: 20,
  });
  // And a row whose repository is known and correct but whose branch is not yet observed is
  // still just unobserved.
  const partlyObserved = decide([pr({ branch: null, observedHeadOid: null, observedState: null })]);
  assert.equal(partlyObserved.kind, "complete");
  if (partlyObserved.kind !== "complete") return;
  assert.match(partlyObserved.warnings?.[0]?.detail ?? "", /branch, pushed ref, pull-request state/);
});

test("an adopted pull request completes when the checkout cannot be read", () => {
  const decision = decide([pr()], { repository: null });
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /repository or branch could not be read/);
});

test("an adopted pull request completes from a detached checkout", () => {
  const decision = decide([pr()], {
    repository: { repositoryId: REPO, root: REPO, branch: null, headOid: HEAD, headCommittedAt: 4_000 },
  });
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /repository or branch could not be read/);
});

test("an adopted pull request completes when the checked ref cannot be read", () => {
  const decision = decide([pr()], {
    repository: { repositoryId: REPO, root: REPO, branch: BRANCH, headOid: null, headCommittedAt: null },
  });
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /checked ref could not be read/);
});

// ---- closed or merged after opening -------------------------------------------------------------

test("a closed pull request at the reviewed commit completes with a warning", () => {
  const decision = decide([pr({ observedState: "CLOSED" })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /closed/);
});

test("a merged pull request at the reviewed commit warns that it is merged", () => {
  const decision = decide([pr({ observedState: "MERGED" })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /merged/);
});

test("an open pull request wins over a closed one at the same commit", () => {
  const decision = decide([pr({ key: "owner/repo#1", number: 1, observedState: "CLOSED" }), pr()]);
  assert.equal(decision.kind, "complete");
});

// ---- the head a capture already fixed ----------------------------------------------------------

test("a captured head, not the moving local head, is what a re-check proves", () => {
  // The convergence rule. HEAD moved between the proof and the capture, so the child segment
  // holds `OTHER_HEAD` and can never hold anything else. Re-deciding against whatever the
  // checkout has since moved to would set an expectation the child cannot satisfy, and the
  // action would wait forever while the head kept moving.
  const decision = decide(
    [pr({ observedHeadOid: OTHER_HEAD })],
    {
      capturedHeadOid: OTHER_HEAD,
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: BRANCH,
        headOid: HEAD,
        headCommittedAt: 4_000,
      },
    },
  );
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.equal(
    decision.continuationExpectation.kind === "pull_request"
      && decision.continuationExpectation.expectedHeadOid,
    OTHER_HEAD,
  );
});

test("a captured head the pull request has not reached completes with a ref warning", () => {
  const decision = decide([pr()], { capturedHeadOid: OTHER_HEAD });
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /pushed ref/);
});

// ---- what the capture is held to ----------------------------------------------------------------

const expectation: SessionActionContinuationExpectation = {
  kind: "pull_request",
  pullRequestKey: "owner/repo#7",
  pullRequestUrl: "https://github.com/owner/repo/pull/7",
  pullRequestNumber: 7,
  repositoryRoot: REPO,
  branch: BRANCH,
  expectedHeadOid: HEAD,
  acceptedContentTreeOid: TREE,
  observedAt: 1_000,
};

test("a capture at the proven commit satisfies the expectation", () => {
  assert.equal(
    ADAPTER.validateCapture(expectation, {
      context: {} as WorkflowContextSnapshot,
      capturedHeadOid: HEAD,
      capturedCommitTreeOid: TREE,
    }),
    null,
  );
});

test("a packaging commit may change commit identity while preserving reviewed content", () => {
  const packagingHead = "d".repeat(40);
  const packagingExpectation = { ...expectation, expectedHeadOid: packagingHead };
  assert.equal(
    ADAPTER.validateCapture(packagingExpectation, {
      context: {} as WorkflowContextSnapshot,
      capturedHeadOid: packagingHead,
      capturedCommitTreeOid: TREE,
    }),
    null,
  );
});

test("published content that differs from the reviewed tree is an advisory warning", () => {
  const validation = ADAPTER.validateCapture(expectation, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: HEAD,
    capturedCommitTreeOid: "d".repeat(40),
  });
  assert.equal(validation?.kind, "warning");
  if (!validation || validation.kind !== "warning") return;
  assert.equal(validation.warning.code, "pull_request_review_mismatch");
  assert.match(validation.warning.detail, /workflow continued/);
});

test("missing historical accepted-tree proof is an advisory warning", () => {
  const validation = ADAPTER.validateCapture(
    { ...expectation, acceptedContentTreeOid: null },
    {
      context: {} as WorkflowContextSnapshot,
      capturedHeadOid: HEAD,
      capturedCommitTreeOid: TREE,
    },
  );
  assert.equal(validation?.kind, "warning");
  if (!validation || validation.kind !== "warning") return;
  assert.match(validation.warning.detail, /no content-tree proof/);
});

test("a failure to resolve the published tree warns without stopping the graph", () => {
  const validation = ADAPTER.validateCapture(expectation, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: HEAD,
    capturedCommitTreeOid: null,
  });
  assert.equal(validation?.kind, "warning");
  if (!validation || validation.kind !== "warning") return;
  assert.match(validation.warning.detail, /could not be compared/);
});

test("a capture at any other commit warns in the sentence a reader needs", () => {
  const problem = ADAPTER.validateCapture(expectation, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: OTHER_HEAD,
    capturedCommitTreeOid: TREE,
  });
  assert.ok(problem);
  assert.equal(problem?.kind, "warning");
  if (!problem || problem.kind !== "warning") return;
  assert.match(problem.warning.detail, /bbbbbbbbbbbb/);
  assert.match(problem.warning.detail, /aaaaaaaaaaaa/);
});

test("a capture whose commit could not be identified warns and continues", () => {
  // Null is "we could not name the commit", and reading it as "close enough" is exactly the
  // prefix comparison this feature refuses to make.
  const problem = ADAPTER.validateCapture(expectation, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: null,
    capturedCommitTreeOid: null,
  });
  assert.ok(problem);
  assert.equal(problem?.kind, "warning");
  if (!problem || problem.kind !== "warning") return;
  assert.match(problem.warning.detail, /could not be identified/);
});

test("a pull request action refuses an expectation that is not its own", () => {
  // Defends the seam a restart reads: an attempt whose stored expectation says `none` has not
  // been through this adapter's proof, and sealing it would advance the graph on nothing.
  const problem = ADAPTER.validateCapture({ kind: "none" }, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: HEAD,
    capturedCommitTreeOid: TREE,
  });
  assert.ok(problem);
});

// ---- one rule for what a full commit id is ------------------------------------------------

test("the persisted expectation and the resolver agree on what a full commit id is", () => {
  // These two are the producer and the schema it feeds, and they drifted: the resolver and the
  // repository head reader accepted 40 hex while the schema accepted 40 or 64. A repository
  // using git's SHA-256 object format reports 64-character ids everywhere, so on one of those
  // the head read as null and a captured head was refused as "not a commit id" - the action
  // waited for proof it could never accept, even with GitHub naming the exact commit.
  //
  // Stated twice on purpose: the schema is browser-safe shared code and the resolver is
  // server-only. This is what stops the two spellings drifting again.
  const cases = [
    ["a".repeat(40), true],
    ["a".repeat(64), true],
    ["a".repeat(39), false],
    ["a".repeat(41), false],
    ["a".repeat(63), false],
    ["a".repeat(65), false],
    ["A".repeat(40), false],
    ["z".repeat(40), false],
    ["", false],
  ] as const;
  for (const [value, accepted] of cases) {
    assert.equal(
      FULL_SHA.test(value),
      accepted,
      `the resolver disagrees about ${value.length} chars`,
    );
    assert.equal(
      SessionActionContinuationExpectationSchema.safeParse({
        kind: "pull_request",
        pullRequestKey: "owner/repo#7",
        pullRequestUrl: "https://github.com/owner/repo/pull/7",
        pullRequestNumber: 7,
        repositoryRoot: REPO,
        branch: BRANCH,
        expectedHeadOid: value,
        acceptedContentTreeOid: TREE,
        observedAt: 1,
      }).success,
      accepted,
      `the persisted schema disagrees about ${value.length} chars`,
    );
  }
});
