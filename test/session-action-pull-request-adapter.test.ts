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

// ---- a pull request this session adopted before the action was delivered ---------------------
//
// The Inspector poller fills branch, head and state, and it does not run while the Inspector is
// disabled. A session that finds its existing pull request and opens no duplicate must still
// complete, so an earlier adoption by the same session counts unless something KNOWN contradicts.

const earlier = (patch: Partial<SessionActionAdoptedPullRequest> = {}) =>
  pr({
    adoptedAt: 1,
    branch: null,
    observedHeadOid: null,
    observedState: null,
    observedAt: null,
    checkout: null,
    ...patch,
  });

test("an unobserved pull request adopted before delivery by the same session completes", () => {
  const decision = decide([earlier()]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  const details = (decision.warnings ?? []).map((w) => w.detail).join(" ");
  assert.match(details, /not available for comparison/);
  // No recorded checkout: the looser rule is stated rather than silent.
  assert.match(details, /no checkout was recorded/);
});

test("a recorded checkout that matches this one completes without the looseness note", () => {
  const decision = decide([earlier({ checkout: REPO })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  const details = (decision.warnings ?? []).map((w) => w.detail).join(" ");
  assert.doesNotMatch(details, /no checkout was recorded/);
});

test("a recorded checkout that differs from this one does not complete", () => {
  assert.deepEqual(decide([earlier({ checkout: "/somewhere/else" })]), {
    kind: "waiting",
    reason: "awaiting_pull_request",
  });
});

test("an earlier adoption by a different session does not complete", () => {
  assert.deepEqual(decide([earlier({ sessionId: "sess-2" })]), {
    kind: "waiting",
    reason: "awaiting_pull_request",
  });
  assert.deepEqual(decide([earlier({ sessionId: null })]), {
    kind: "waiting",
    reason: "awaiting_pull_request",
  });
});

test("an earlier adoption already observed as closed or merged does not complete", () => {
  for (const observedState of ["CLOSED", "MERGED"] as const) {
    assert.deepEqual(decide([earlier({ observedState })]), {
      kind: "waiting",
      reason: "awaiting_pull_request",
    });
  }
});

test("an earlier adoption on a different observed branch does not complete", () => {
  assert.deepEqual(decide([earlier({ branch: "other/branch" })]), {
    kind: "waiting",
    reason: "awaiting_pull_request",
  });
});

test("an earlier adoption must resolve to this checkout's repository", () => {
  // `repositoryRoot` here is the resolved repository identity, in the spelling of
  // `repository.repositoryId`. Equal completes; a different or unresolved one waits.
  assert.equal(decide([earlier({ repositoryRoot: REPO })]).kind, "complete");
  for (const repositoryRoot of ["/other-repo", null]) {
    assert.deepEqual(decide([earlier({ repositoryRoot })]), {
      kind: "waiting",
      reason: "awaiting_pull_request",
    });
  }
  // A linked worktree: the checkout's toplevel differs from the repository identity, and the
  // identity is still what is compared.
  assert.equal(
    decide([earlier()], {
      repository: { repositoryId: REPO, root: "/worktrees/s1", branch: BRANCH, headOid: HEAD, headCommittedAt: 4_000 },
    }).kind,
    "complete",
  );
});

test("several earlier adoptions resolve to the lowest-numbered one", () => {
  const decision = decide([
    earlier({ key: "owner/repo#9", number: 9, url: "https://github.com/owner/repo/pull/9" }),
    earlier({ key: "owner/repo#4", number: 4, url: "https://github.com/owner/repo/pull/4" }),
  ]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.equal(
    decision.continuationExpectation.kind === "pull_request"
      && decision.continuationExpectation.pullRequestNumber,
    4,
  );
});

const oldMerge = (patch: Partial<SessionActionAdoptedPullRequest> = {}) => pr({
  observedState: "MERGED", observedAt: 1, adoptedAt: 1, mergedContentTreeOid: TREE, ...patch,
});

for (const missing of ["review", "merged-tree"] as const) {
  test(`a PR merged during the action wait preserves earlier adoption with missing ${missing} proof`, () => {
    const decision = decide([oldMerge({ observedAt: 11,
      ...(missing === "merged-tree" ? { mergedContentTreeOid: null } : {}),
    })], missing === "review" ? { acceptedContentTreeOid: null } : {});
    assert.equal(decision.kind, "complete");
    if (decision.kind !== "complete") return;
    assert.ok(decision.warnings?.length);
    assert.equal("mergedContentTreeOid" in decision.continuationExpectation, false);
  });
}

test("a merge during the wait still needs the earlier adoption's repository identity", () => {
  assert.deepEqual(decide([oldMerge({ observedAt: 11, repositoryRoot: null })]),
    { kind: "waiting", reason: "awaiting_pull_request" });
});

test("an earlier merged publication covers the reviewed tree even with a packaging commit", () => {
  const decision = decide([oldMerge({ observedHeadOid: OTHER_HEAD })]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.match(decision.warnings?.[0]?.detail ?? "", /Already published.*pull\/7/);
  assert.deepEqual(SessionActionContinuationExpectationSchema.parse(decision.continuationExpectation),
    decision.continuationExpectation, "restart preserves historical publication proof");
});

for (const patch of [
  { mergedContentTreeOid: null }, { mergedContentTreeOid: OTHER_HEAD },
  { repositoryRoot: "/other" }, { branch: "other" },
]) test(`an earlier merge without matching publication waits: ${JSON.stringify(patch)}`, () => {
  assert.deepEqual(decide([oldMerge(patch)]), { kind: "waiting", reason: "awaiting_pull_request" });
});

test("a historical merge never accepts missing review proof", () => {
  const decision = decide([oldMerge()], { acceptedContentTreeOid: null, now: 60_003 });
  assert.equal(decision.kind, "blocked");
  if (decision.kind === "blocked") assert.match(decision.detail, /accepted content tree/);
});

for (const dirty of [false, true]) test(`historical publication rechecks continuation content, dirty=${dirty}`, () => {
  const context = { evidence: { contentTreeOid: TREE, workingTreeDirty: dirty } } as WorkflowContextSnapshot;
  const result = ADAPTER.validateCapture({ ...expectation, mergedContentTreeOid: TREE }, {
    context, capturedHeadOid: OTHER_HEAD, capturedCommitTreeOid: TREE,
  });
  assert.equal(result?.kind ?? null, dirty ? "blocked" : null);
});

test("historical publication blocks changed clean continuation content after satisfying the action", () => {
  const decision = decide([oldMerge()]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;

  // A later commit leaves the checkout clean but changes the content already published.
  const changedTree = "d".repeat(40);
  const context = {
    evidence: { contentTreeOid: changedTree, workingTreeDirty: false },
  } as WorkflowContextSnapshot;
  const result = ADAPTER.validateCapture(decision.continuationExpectation, {
    context, capturedHeadOid: OTHER_HEAD, capturedCommitTreeOid: changedTree,
  });
  assert.equal(result?.kind, "blocked");
  if (result?.kind !== "blocked") return;
  assert.equal(result.code, "published_content_changed");
});

test("historical publication reports missing continuation proof as capture failure, not changed content", () => {
  const decision = decide([oldMerge()]);
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  const context = { evidence: { contentTreeOid: null, workingTreeDirty: false } } as WorkflowContextSnapshot;
  const result = ADAPTER.validateCapture(decision.continuationExpectation, {
    context, capturedHeadOid: OTHER_HEAD, capturedCommitTreeOid: null,
  });
  assert.equal(result?.kind, "blocked");
  if (result?.kind !== "blocked") return;
  assert.equal(result.code, "capture_failed");
  assert.match(result.detail, /publication tree could not be read/);
});

test("a settled untouched detached repository completes without borrowing a sibling PR", () => {
  const unchangedRepository = { headOid: HEAD, treeOid: TREE, baseOid: HEAD, baseRef: "origin/main" };
  const decision = decide([pr({ repositoryRoot: "/sibling" })], {
    repository: { repositoryId: REPO, root: REPO, branch: null, headOid: HEAD, headCommittedAt: 1 },
    unchangedRepository,
  });
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.deepEqual(decision.continuationExpectation, { kind: "no_change", ...unchangedRepository });
  assert.equal(SessionActionContinuationExpectationSchema.safeParse(decision.continuationExpectation).success, true);
  const capture = { capturedHeadOid: HEAD, context: { evidence: {
    workingTreeDirty: false, contentTreeOid: TREE,
  } } as WorkflowContextSnapshot };
  assert.equal(ADAPTER.validateCapture(decision.continuationExpectation, capture), null);
  for (const changed of [
    { ...capture, capturedHeadOid: OTHER_HEAD },
    { ...capture, context: { evidence: { workingTreeDirty: true, contentTreeOid: TREE } } as WorkflowContextSnapshot },
    { ...capture, context: { evidence: { workingTreeDirty: false, contentTreeOid: OTHER_HEAD } } as WorkflowContextSnapshot },
  ]) assert.equal(ADAPTER.validateCapture(decision.continuationExpectation, changed)?.kind, "blocked");
});

test("no-change proof cannot discard accepted work or replace a same-repository adoption", () => {
  const unchangedRepository = { headOid: HEAD, treeOid: TREE, baseOid: HEAD, baseRef: "origin/main" };
  assert.equal(decide([], { unchangedRepository, acceptedContentTreeOid: OTHER_HEAD, now: 60_003 }).kind, "blocked");
  const adopted = decide([pr()], { unchangedRepository });
  assert.equal(adopted.kind === "complete" && adopted.continuationExpectation.kind, "pull_request");
});


test("an unrelated PR on another branch does not veto positive no-change proof", () => {
  const decision = decide([pr({ branch: "unrelated", sessionId: "other-session" })], {
    unchangedRepository: { headOid: HEAD, treeOid: TREE, baseOid: HEAD, baseRef: "origin/main" },
  });
  assert.equal(decision.kind === "complete" && decision.continuationExpectation.kind, "no_change");
});

for (const branch of [null, BRANCH]) {
  for (const [label, patch, detail] of [
    ["base", { unchangedRepositoryProblem: "The default base could not be resolved." }, /default base/],
    ["accepted tree", { acceptedContentTreeOid: null }, /accepted content tree/],
  ] as const) test(`missing ${label} proof on branch ${branch} blocks with a recoverable explanation`, () => {
    const context = { repository: { repositoryId: REPO, root: REPO, branch, headOid: HEAD, headCommittedAt: 1 },
      settledAt: 3, now: 60_003, ...patch };
    const decision = decide([], context);
    assert.equal(decision.kind, "blocked");
    if (decision.kind !== "blocked") return;
    assert.equal(decision.code, "expectation_unmet");
    assert.match(decision.detail, detail);
    assert.match(decision.detail, /resubmit/i);
    assert.equal(decide([pr()], context).kind, "complete", "durable adoption still wins");
  });
}

for (const [label, patch] of [
  ["accepted tree", { acceptedContentTreeOid: null }],
  ["repository read", { repository: null }],
  ["HEAD read", { repository: { repositoryId: REPO, root: REPO, branch: BRANCH, headOid: null, headCommittedAt: null } }],
  ["Git timeout", { unchangedRepositoryProblem: "Git timed out while reading publication proof." }],
  ["moving HEAD", { unchangedRepositoryProblem: "The checkout HEAD changed while reading publication proof." }],
  ["default base", { unchangedRepositoryProblem: "The default base could not be resolved." }],
] satisfies Array<[string, Partial<SessionActionAdapterContext>]>) {
  test(`transient ${label} proof retries before a bounded recoverable block`, () => {
    const context = { ...patch, settledAt: 5_000 };
    for (const now of [5_000, 64_999]) {
      assert.deepEqual(decide([], { ...context, now }), { kind: "waiting", reason: "awaiting_proof" });
      assert.equal(decide([pr()], { ...context, now }).kind, "complete", "late adoption wins during retry");
    }
    const expired = decide([], { ...context, now: 65_000 });
    assert.equal(expired.kind, "blocked");
    if (expired.kind !== "blocked") return;
    assert.equal(expired.code, "expectation_unmet");
    assert.match(expired.detail, /resubmit/i);
  });
}

test("missing accepted-tree proof retries then identifies the missing tree even with a Git error", () => {
  const context = { acceptedContentTreeOid: null, unchangedRepositoryProblem: "Git timed out" };
  assert.deepEqual(decide([], context), { kind: "waiting", reason: "awaiting_proof" });
  const decision = decide([], { ...context, now: 60_003 });
  assert.equal(decision.kind, "blocked");
  if (decision.kind !== "blocked") return;
  assert.match(decision.detail, /accepted content tree/);
});

test("no-change capture reports an unreadable publication tree as capture failure", () => {
  const result = ADAPTER.validateCapture({ kind: "no_change", headOid: HEAD, treeOid: TREE,
    baseOid: HEAD, baseRef: "origin/main" }, {
    capturedHeadOid: HEAD,
    context: { evidence: { contentTreeOid: null, workingTreeDirty: false } } as WorkflowContextSnapshot,
  });
  assert.equal(result?.kind, "blocked");
  if (result?.kind !== "blocked") return;
  assert.equal(result.code, "capture_failed");
  assert.match(result.detail, /publication tree could not be read/);
  assert.doesNotMatch(result.detail, /repository changed/);
});

test("known changed work on detached HEAD waits for a late adoption, beyond the proof-read retry window", () => {
  const context = { repository: { repositoryId: REPO, root: REPO, branch: null, headOid: HEAD, headCommittedAt: 1 },
    unchangedRepository: null };
  for (const now of [5_000, 120_000]) {
    assert.deepEqual(decide([], { ...context, now }), { kind: "waiting", reason: "awaiting_pull_request" });
  }
  assert.equal(decide([pr()], context).kind, "complete", "a detached publication is adopted after the turn settles");
});


test("no-change capture reports an unreadable HEAD as capture failure", () => {
  const result = ADAPTER.validateCapture({ kind: "no_change", headOid: HEAD, treeOid: TREE,
    baseOid: HEAD, baseRef: "origin/main" }, {
    capturedHeadOid: null,
    context: { evidence: { contentTreeOid: TREE, workingTreeDirty: false } } as WorkflowContextSnapshot,
  });
  assert.equal(result?.kind, "blocked");
  if (result?.kind !== "blocked") return;
  assert.equal(result.code, "capture_failed");
  assert.match(result.detail, /HEAD could not be read/);
  assert.doesNotMatch(result.detail, /repository changed/);
});


for (const mismatch of ["accepted tree", "captured HEAD"]) test(`clean checkout with mismatched ${mismatch} allows late adoption before expiry`, () => {
  const context = {
    unchangedRepository: { headOid: HEAD, treeOid: TREE, baseOid: HEAD, baseRef: "origin/main" },
    ...(mismatch === "accepted tree" ? { acceptedContentTreeOid: OTHER_HEAD } : { capturedHeadOid: OTHER_HEAD }),
    settledAt: 5_000,
  };
  for (const now of [5_000, 64_999]) {
    assert.deepEqual(decide([], { ...context, now }), { kind: "waiting", reason: "awaiting_proof" });
    assert.equal(decide([pr()], { ...context, now }).kind, "complete");
  }
  const expired = decide([], { ...context, now: 65_000 });
  assert.equal(expired.kind, "blocked");
  if (expired.kind !== "blocked") return;
  assert.equal(expired.code, "expectation_unmet");
  assert.match(expired.detail, /does not match the accepted or captured content/);
});
