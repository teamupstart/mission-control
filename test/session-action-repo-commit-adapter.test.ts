import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  SessionActionCompletionDecision,
  SessionActionSnapshot,
} from "../src/shared/workflow.ts";
import {
  sessionActionAdapter,
  sessionActionCapabilities,
  type SessionActionAdapterContext,
} from "../src/server/workflows/session-action-adapters.ts";

// The `repo_commit` proof. The generic observer has already proven the packet was sent, read,
// and followed by a settled turn; every case below is about the one thing it cannot prove -
// that the turn left a commit behind.

const ADAPTER = sessionActionAdapter("repo_commit");
const REPO = "/repo/.git";
const HEAD = "a".repeat(40);
const PICKED_UP = 1_000_000;

function decide(patch: Partial<SessionActionAdapterContext> = {}): SessionActionCompletionDecision {
  return ADAPTER.decide({
    snapshot: {} as SessionActionSnapshot,
    session: { id: "s1" } as never,
    anchorTranscriptBytes: 10,
    deliveredAt: PICKED_UP - 60_000,
    pickedUpAt: PICKED_UP,
    settledAt: PICKED_UP + 30_000,
    now: PICKED_UP + 30_000,
    repository: {
      repositoryId: REPO,
      root: REPO,
      branch: "feature",
      headOid: HEAD,
      headCommittedAt: PICKED_UP + 10_000,
    },
    adoptedPullRequests: [],
    capturedHeadOid: null,
    ...patch,
  });
}

test("a commit made after the session read the packet completes the action", () => {
  assert.deepEqual(decide(), {
    kind: "complete",
    continuationExpectation: { kind: "none" },
  });
});

test("a checkout that could not be read is a wait, never an answer", () => {
  assert.deepEqual(decide({ repository: null }), { kind: "waiting", reason: "awaiting_proof" });
});

test("an unborn branch has no commit to prove", () => {
  assert.deepEqual(
    decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: "feature",
        headOid: null,
        headCommittedAt: null,
      },
    }),
    { kind: "waiting", reason: "awaiting_proof" },
  );
});

test("a head whose commit time could not be read proves nothing", () => {
  assert.deepEqual(
    decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: "feature",
        headOid: HEAD,
        headCommittedAt: null,
      },
    }),
    { kind: "waiting", reason: "awaiting_proof" },
  );
});

/**
 * The case the whole adapter exists for, and the one `session_turn` gets wrong.
 *
 * A retrospective that proposed three memories, was approved, and then wrote no files settles
 * a perfectly ordinary turn over a checkout whose HEAD is the commit that was already there.
 */
test("a settled turn over an unchanged checkout does NOT complete", () => {
  assert.deepEqual(
    decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: "feature",
        headOid: HEAD,
        headCommittedAt: PICKED_UP - 3_600_000,
      },
    }),
    { kind: "waiting", reason: "awaiting_proof" },
  );
});

/**
 * Pickup, not delivery, is the baseline.
 *
 * A packet can sit unread for minutes while the session finishes something else, and a commit
 * made in that window belongs to that other work. Anchoring on delivery would adopt it.
 */
test("a commit made between delivery and pickup belongs to the earlier work", () => {
  assert.deepEqual(
    decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: "feature",
        headOid: HEAD,
        headCommittedAt: PICKED_UP - 30_000,
      },
    }),
    { kind: "waiting", reason: "awaiting_proof" },
  );
});

/**
 * Committer time is truncated to the second, so a commit in the same second as pickup can
 * report as up to a second earlier than it was. That rounding is absorbed deliberately, and it
 * cannot manufacture a pass: pickup is already PROVEN to be after the packet was read.
 */
test("second-resolution committer time is absorbed, not read as an earlier commit", () => {
  assert.equal(
    decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: "feature",
        headOid: HEAD,
        headCommittedAt: PICKED_UP - 900,
      },
    }).kind,
    "complete",
  );
});

test("a detached HEAD still proves a commit - there is no branch to match", () => {
  assert.equal(
    decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: null,
        headOid: HEAD,
        headCommittedAt: PICKED_UP + 5_000,
      },
    }).kind,
    "complete",
  );
});

test("the adapter never blocks - the session is still there to make the commit", () => {
  for (const headCommittedAt of [null, PICKED_UP - 1, PICKED_UP + 1]) {
    const decision = decide({
      repository: {
        repositoryId: REPO,
        root: REPO,
        branch: "feature",
        headOid: HEAD,
        headCommittedAt,
      },
    });
    assert.notEqual(decision.kind, "blocked");
  }
  assert.notEqual(decide({ repository: null }).kind, "blocked");
});

test("any snapshot is deliverable: the proof is about the checkout", () => {
  assert.equal(ADAPTER.validateSnapshot({} as SessionActionSnapshot), null);
});

test("the continuation capture is unconstrained, exactly as a session turn's is", () => {
  assert.equal(ADAPTER.validateCapture({ kind: "none" }, {
    context: {} as never,
    capturedHeadOid: HEAD,
  }), null);
  const wrong = ADAPTER.validateCapture({
    kind: "pull_request",
    pullRequestKey: "o/r#1",
    pullRequestUrl: "https://example.test/1",
    pullRequestNumber: 1,
    repositoryRoot: REPO,
    branch: "feature",
    expectedHeadOid: HEAD,
    observedAt: 1,
  }, { context: {} as never, capturedHeadOid: HEAD });
  assert.ok(wrong, "a pull request expectation is not this adapter's");
});

test("the build offers repo_commit to the graph validator and the browser", () => {
  const offered = sessionActionCapabilities().find((c) => c.kind === "repo_commit");
  assert.ok(offered);
  assert.equal(offered.available, true);
  assert.equal(offered.unavailableReason, null);
  assert.ok(offered.label.length > 0);
});
