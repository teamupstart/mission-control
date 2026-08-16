import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionQueue } from "../src/shared/types.ts";
import {
  drainCompletionClaim,
  promptedCompletionClaim,
  tryWorkflowCompletionClaim,
} from "../src/server/foreman/workflow-claim.ts";

const queue: SessionQueue = {
  noteKey: "note",
  cwd: "/repo",
  branch: "feature",
  wrapupAskedAt: null,
  wrapupAnswer: null,
  promptedGoal: null,
  promptedEvidence: null,
  promptedActivityAt: null,
  promptedConsumedGeneration: null,
  updatedAt: 42,
  items: [{
    id: "item",
    noteKey: "note",
    seq: 0,
    intent: "finish",
    state: "verified",
    round: 2,
    baseSha: "base",
    transcriptAnchor: 10,
    gaps: [],
    sendAttempts: 1,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: "done",
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: 1,
    updatedAt: 2,
    sentAt: 1,
    completedAt: 2,
  }],
};

test("drain and prompted markers are stable proof hashes and change with a re-armed episode", () => {
  const drain = drainCompletionClaim(queue, "head", 100);
  assert.deepEqual(drainCompletionClaim(queue, "head", 100), drain);
  assert.notEqual(
    drainCompletionClaim({ ...queue, updatedAt: queue.updatedAt + 1 }, "head", 100).marker,
    drain.marker,
  );
  const prompted = promptedCompletionClaim({
    noteKey: "note",
    workCycle: { logicalKey: "note", generation: 2 },
    intent: {
      objective: "repair",
      objectiveVersion: 2,
      promptRevision: 3,
      episodeKey: "intent:2:3",
    },
    headSha: "head",
    transcriptAnchor: 100,
    summary: "complete",
  });
  assert.equal(prompted.completionKind, "prompted");
  assert.deepEqual(prompted.expectedWorkCycle, { logicalKey: "note", generation: 2 });
  assert.equal(prompted.marker.length, 64);
  assert.deepEqual(prompted.expectedIntent, {
    objective: "repair",
    objectiveVersion: 2,
    promptRevision: 3,
    episodeKey: "intent:2:3",
  });
  assert.equal(drain.expectedIntent, null);
  assert.equal(drain.expectedWorkCycle, null);
  // A claim is a proof, not a request for a workflow. Pin the whole key set so no future
  // field can smuggle workflow identity back onto the wire and let the worker start a
  // second PR-producing path beside whatever is already bound.
  for (const claim of [drain, prompted]) {
    assert.deepEqual(Object.keys(claim).sort(), [
      "completionKind",
      "evidenceFingerprint",
      "expectedIntent",
      "expectedWorkCycle",
      "marker",
      "summary",
    ]);
  }
});

test("claimed suppresses, explicit false falls through, and HTTP failure is fail closed", async () => {
  const claim = drainCompletionClaim(queue, "head", 100);
  const claimed = await tryWorkflowCompletionClaim({
    async claimWorkflowCompletion() {
      return { claimed: true, runId: "run", submissionId: "sub", state: "started" };
    },
  }, "session", claim);
  assert.equal(claimed.kind, "claimed");

  const unclaimed = await tryWorkflowCompletionClaim({
    async claimWorkflowCompletion() {
      return { claimed: false, reason: "no_binding" };
    },
  }, "session", claim);
  assert.equal(unclaimed.kind, "unclaimed");

  const failed = await tryWorkflowCompletionClaim({
    async claimWorkflowCompletion() {
      throw new Error("daemon unavailable");
    },
  }, "session", claim);
  assert.deepEqual(failed, { kind: "failed", error: "daemon unavailable" });

  const malformed = await tryWorkflowCompletionClaim({
    async claimWorkflowCompletion() {
      return {} as never;
    },
  }, "session", claim);
  assert.equal(malformed.kind, "failed");
});

test("Foreman workflow claim code has no workflow SQLite or DB import", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/server/foreman/workflow-claim.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["'][^"']*(?:db|workflows\/store)\.ts["']/);
});
