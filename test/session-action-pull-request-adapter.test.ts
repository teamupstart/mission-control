import assert from "node:assert/strict";
import test from "node:test";
import { sessionActionAdapter } from "../src/server/workflows/session-action-adapters.ts";
import type {
  SessionActionAdapterContext,
  SessionActionAdoptedPullRequest,
} from "../src/server/workflows/session-action-adapters.ts";
import type {
  SessionActionContinuationExpectation,
  SessionActionSnapshot,
  WorkflowContextSnapshot,
} from "@shared/workflow.ts";

// What the `pull_request` completion adapter will and will not accept as proof that the work a
// workflow just reviewed is on an open pull request.
//
// Every case here is a way the wrong answer is available and cheap: a pull request exists on
// some other branch, one exists on this branch at an older commit, one exists at this commit
// and is closed, the ledger has not been polled yet. The adapter's whole job is to keep
// preferring "waiting" over "complete" through all of them, because completing hands the
// downstream stages evidence and tells the Inspector there is something to review.

const ADAPTER = sessionActionAdapter("pull_request");
const REPO = "/repo";
const BRANCH = "feature/x";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
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
    repository: { root: REPO, branch: BRANCH, headOid: HEAD },
    adoptedPullRequests: adopted,
    capturedHeadOid: null,
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

test("a pull request THIS TURN opened on another branch says so, and is not mistaken for none", () => {
  // The state an operator most needs told apart from "no pull request yet": the turn finished
  // and put its pull request on a branch this action is not about. A stacked branch, or one
  // that was never switched, can carry this exact commit - so matching on the commit alone
  // would have let it satisfy the action, and reporting it as "awaiting" would have left
  // somebody watching for a pull request that already existed where they were not looking.
  const decision = decide([pr({ branch: "other-branch" })]);
  assert.deepEqual(decision, { kind: "waiting", reason: "pull_request_wrong_branch" });
});

test("a pull request THIS TURN opened in another repository says which mistake it was", () => {
  // Reported separately from the branch case because the remedy differs: the work is in the
  // wrong project rather than off the wrong head, and a branch comparison across two
  // repositories would be meaningless anyway.
  const decision = decide([pr({ repositoryRoot: "/somewhere/else" })]);
  assert.deepEqual(decision, { kind: "waiting", reason: "pull_request_wrong_repository" });
});

test("the repository mismatch is reported ahead of a branch mismatch beside it", () => {
  const decision = decide([
    pr({ key: "owner/repo#8", number: 8, branch: "other-branch" }),
    pr({ key: "owner/other#1", number: 1, repositoryRoot: "/somewhere/else" }),
  ]);
  assert.deepEqual(decision, { kind: "waiting", reason: "pull_request_wrong_repository" });
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

test("an open pull request on this branch at an older head waits for the push", () => {
  const decision = decide([pr({ observedHeadOid: OTHER_HEAD })]);
  assert.deepEqual(decision, { kind: "waiting", reason: "awaiting_pushed_head" });
});

test("an adopted pull request the poller has never looked at waits", () => {
  // Adoption is not observation. A row written the instant `gh pr create` returned has no
  // head, no branch and no state, and reading any of those as a match would complete the
  // action on the strength of the pull request merely existing.
  const decision = decide([pr({
    observedHeadOid: null,
    observedState: null,
    observedAt: null,
    branch: null,
  })]);
  assert.deepEqual(decision, { kind: "waiting", reason: "awaiting_pull_request" });
});

test("an unpolled pull request is UNKNOWN, never reported as being on the wrong branch", () => {
  // The distinction the mismatch arms turn on, stated on its own because it is the one that
  // false-accuses if it is got wrong. A row adopted seconds ago by this very turn has a null
  // branch and a null repository root because the poller has not reached it - which is the
  // ORDINARY case, not a mistake. Only a known value that DIFFERS is a mismatch.
  assert.deepEqual(
    decide([pr({ branch: null, repositoryRoot: null, observedHeadOid: null, observedState: null })]),
    { kind: "waiting", reason: "awaiting_pull_request" },
  );
  // And a row whose repository is known and correct but whose branch is not yet observed is
  // still just unobserved.
  assert.deepEqual(
    decide([pr({ branch: null, observedHeadOid: null, observedState: null })]),
    { kind: "waiting", reason: "awaiting_pull_request" },
  );
});

test("a repository that could not be read waits rather than deciding anything", () => {
  // A reaped worktree is not evidence about a pull request.
  assert.deepEqual(decide([pr()], { repository: null }), {
    kind: "waiting",
    reason: "awaiting_proof",
  });
});

test("a detached HEAD has no branch to match a pull request against", () => {
  assert.deepEqual(
    decide([pr()], { repository: { root: REPO, branch: null, headOid: HEAD } }),
    { kind: "waiting", reason: "awaiting_proof" },
  );
});

test("an unborn branch has no commit to prove", () => {
  assert.deepEqual(
    decide([pr()], { repository: { root: REPO, branch: BRANCH, headOid: null } }),
    { kind: "waiting", reason: "awaiting_proof" },
  );
});

// ---- the one case that blocks -----------------------------------------------------------------

test("a closed pull request at the reviewed commit blocks for a human", () => {
  // The one durable contradiction: no amount of waiting reopens it, and completing would
  // hand the Inspector a pull request nobody can review.
  const decision = decide([pr({ observedState: "CLOSED" })]);
  assert.equal(decision.kind, "blocked");
  if (decision.kind !== "blocked") return;
  assert.equal(decision.code, "pull_request_closed");
  assert.match(decision.detail, /closed/);
  assert.match(decision.detail, /pull\/7/);
});

test("a merged pull request at the reviewed commit says merged, not closed", () => {
  const decision = decide([pr({ observedState: "MERGED" })]);
  assert.equal(decision.kind, "blocked");
  if (decision.kind !== "blocked") return;
  assert.match(decision.detail, /already merged/);
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
    { capturedHeadOid: OTHER_HEAD, repository: { root: REPO, branch: BRANCH, headOid: HEAD } },
  );
  assert.equal(decision.kind, "complete");
  if (decision.kind !== "complete") return;
  assert.equal(
    decision.continuationExpectation.kind === "pull_request"
      && decision.continuationExpectation.expectedHeadOid,
    OTHER_HEAD,
  );
});

test("a captured head the pull request has not reached still waits", () => {
  const decision = decide([pr()], { capturedHeadOid: OTHER_HEAD });
  assert.deepEqual(decision, { kind: "waiting", reason: "awaiting_pushed_head" });
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
  observedAt: 1_000,
};

test("a capture at the proven commit satisfies the expectation", () => {
  assert.equal(
    ADAPTER.validateCapture(expectation, {
      context: {} as WorkflowContextSnapshot,
      capturedHeadOid: HEAD,
    }),
    null,
  );
});

test("a capture at any other commit is refused, in the sentence a reader needs", () => {
  const problem = ADAPTER.validateCapture(expectation, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: OTHER_HEAD,
  });
  assert.ok(problem);
  assert.match(problem, /bbbbbbbbbbbb/);
  assert.match(problem, /aaaaaaaaaaaa/);
});

test("a capture whose commit could not be identified is refused, never assumed", () => {
  // Null is "we could not name the commit", and reading it as "close enough" is exactly the
  // prefix comparison this feature refuses to make.
  const problem = ADAPTER.validateCapture(expectation, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: null,
  });
  assert.ok(problem);
  assert.match(problem, /could not be identified/);
});

test("a pull request action refuses an expectation that is not its own", () => {
  // Defends the seam a restart reads: an attempt whose stored expectation says `none` has not
  // been through this adapter's proof, and sealing it would advance the graph on nothing.
  const problem = ADAPTER.validateCapture({ kind: "none" }, {
    context: {} as WorkflowContextSnapshot,
    capturedHeadOid: HEAD,
  });
  assert.ok(problem);
});
