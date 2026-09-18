import test from "node:test";
import assert from "node:assert/strict";
import { ForemanHealthTracker, ForemanHealthPublisher } from "../src/server/foreman/health.ts";
import {
  ForemanHealthReportSchema, FOREMAN_HEALTH_MAX_ISSUES, FOREMAN_HEALTH_MAX_SESSIONS,
  foremanErrorText,
} from "../src/shared/foreman-health.ts";

const review = { operation: "review" as const, runner: "codex" as const, model: "test-model" };

test("hundreds of repeated failures become one issue with bounded session context", () => {
  const tracker = new ForemanHealthTracker();
  for (let i = 0; i < 200; i++) {
    tracker.failure({ ...review, session: { id: `s-${i}`, name: `Session ${i}` } },
      `Usage limit reached. request_id=req_${i}`, i + 1);
  }
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.issues.length, 1);
  assert.equal(snapshot.issues[0]!.count, 200);
  assert.equal(snapshot.issues[0]!.firstSeenAt, 1);
  assert.equal(snapshot.issues[0]!.lastSeenAt, 200);
  assert.equal(snapshot.issues[0]!.sessions.length, FOREMAN_HEALTH_MAX_SESSIONS);
  assert.equal(snapshot.issues[0]!.sessionsTruncated, true);
  assert.ok(ForemanHealthReportSchema.safeParse({ workerId: "leader", health: snapshot }).success);
});

test("different failures remain distinct; unrelated success cannot clear another role or model", () => {
  const tracker = new ForemanHealthTracker();
  tracker.failure(review, "Usage limit reached");
  tracker.failure(review, "Invalid response");
  tracker.failure({ ...review, operation: "verify" }, "Usage limit reached");
  tracker.success({ ...review, model: "different-model" });
  assert.equal(tracker.snapshot().issues.length, 3);
  tracker.success(review);
  assert.deepEqual(tracker.snapshot().issues.map((i) => i.operation), ["verify"]);
});

test("selecting a new model retires the replaced model's diagnostics without clearing other roles", () => {
  const tracker = new ForemanHealthTracker();
  tracker.failure(review, "Usage limit reached");
  tracker.failure({ ...review, operation: "triage" }, "Usage limit reached");
  tracker.useModel("review", "codex", "test-model");
  assert.equal(tracker.snapshot().issues.length, 2);
  tracker.useModel("review", "codex", "replacement-model");
  assert.deepEqual(tracker.snapshot().issues.map((i) => i.operation), ["triage"]);
});

test("errors are bounded, redacted, and rendered as received without guessing a quota cause", () => {
  const error = foremanErrorText('HTTP 429 Authorization: Bearer abc.def api_key="sensitive" sk-secret ghp_secret https://user:pass@example.com ' + "x".repeat(1000));
  assert.ok(error.startsWith("HTTP 429"));
  assert.ok(error.length <= 600);
  for (const secret of ["abc.def", "sensitive", "sk-secret", "ghp_secret", "user:pass"]) {
    assert.ok(!error.includes(secret), secret);
  }
  const tracker = new ForemanHealthTracker();
  for (let i = 0; i < 100; i++) tracker.failure(review, `Failure ${i}`);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.issues.length, FOREMAN_HEALTH_MAX_ISSUES);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.issues[0]!.error, "Failure 99");
  snapshot.issues.length = 0;
  assert.equal(tracker.snapshot().issues.length, FOREMAN_HEALTH_MAX_ISSUES, "snapshots do not alias mutable state");
});

test("observation preserves returned failures, throws, and successful results", async () => {
  const tracker = new ForemanHealthTracker();
  const result = { kind: "failed", reason: "out of tokens" };
  assert.equal(await tracker.observe(review, async () => result), result);
  const error = new Error("transport refused");
  await assert.rejects(tracker.observe(review, async () => { throw error; }), (err) => err === error);
  assert.equal(tracker.snapshot().issues.length, 2);
  assert.equal(await tracker.observe(review, async () => "success"), "success");
  assert.equal(tracker.snapshot().issues.length, 0);
});

test("a local fallback cannot establish model recovery but its failures are still observed", async () => {
  const tracker = new ForemanHealthTracker();
  const backlog = { ...review, operation: "backlog" as const };
  const options = { recoverOnSuccess: false };
  tracker.failure(backlog, "Usage limit reached");
  await tracker.observe(backlog, async () => ({ kind: "ok" }), options);
  assert.equal(tracker.snapshot().issues.length, 1, "local success is not a successful model call");
  await tracker.observe(backlog, async () => ({ kind: "failed", reason: "Usage limit reached" }), options);
  assert.equal(tracker.snapshot().issues[0]!.count, 2, "suppressing recovery must not suppress failures");
  await assert.rejects(tracker.observe(backlog, async () => { throw new Error("transport refused"); }, options));
  assert.equal(tracker.snapshot().issues.length, 2, "thrown failures remain visible too");
  await tracker.observe(backlog, async () => ({ kind: "ok" }));
  assert.equal(tracker.snapshot().issues.length, 0, "actual model success still establishes recovery");
});

test("publisher coalesces, retries failed delivery, and republishes after daemon restart", async () => {
  const tracker = new ForemanHealthTracker();
  const sent: number[] = [];
  let refuse = true;
  const publisher = new ForemanHealthPublisher(tracker, async (snapshot) => {
    if (refuse) throw new Error("daemon offline");
    sent.push(snapshot.revision);
    if (sent.length === 1) tracker.failure(review, "usage limit");
  });
  await publisher.flush();
  refuse = false;
  await Promise.all([publisher.flush(), publisher.flush()]);
  assert.deepEqual(sent, [0, 1]);
  await publisher.flush();
  assert.deepEqual(sent, [0, 1]);
  await publisher.flush(true);
  assert.deepEqual(sent, [0, 1, 1]);
});

test("wire validation rejects unbounded or contradictory health reports", () => {
  const tracker = new ForemanHealthTracker();
  tracker.failure(review, "failure", 100);
  const health = tracker.snapshot();
  const parse = (value: unknown) => ForemanHealthReportSchema.safeParse({ workerId: "leader", health: value }).success;
  assert.equal(parse({ ...health, issues: [...health.issues, ...health.issues] }), false);
  assert.equal(parse({ ...health, issues: [{ ...health.issues[0], lastSeenAt: 99 }] }), false);
  assert.equal(parse({ ...health, issues: Array(13).fill(health.issues[0]) }), false);
});
