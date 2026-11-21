import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { ReviewItem } from "../src/shared/types.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision } from "../src/shared/types.ts";

// A merged pull request is the operator's own conclusion (`async-input`): it completes the task
// even with a request_input question open, and closes every outstanding one with the recorded
// reason `merged` before the session can be stopped, so none is left behind it unexplained.

const home = mkdtempSync(join(tmpdir(), "mission-async-input-merge-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { applyFeatureFlagIntent, featureEnabled } = await import("../src/server/feature-flags/index.ts");
const { openDb } = await import("../src/server/db.ts");
const { reviewToolResult } = await import("../src/shared/review-item.ts");

after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => { applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: false }); });

const PR = "https://github.com/example/repo/pull/91";
const decisions = (question: string): PlanDecision[] => [
  { id: "q", question, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] },
];

function fleet(id: string, closeFails = { times: 0 }) {
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const tasks = new TaskManager(registry);
  const reviews = new ReviewManager(registry);
  // The daemon's wiring (`src/server/index.ts`), with the flag read per merge.
  tasks.useMergeQuestions({
    close: (sessionId) => {
      if (closeFails.times > 0) { closeFails.times--; throw new Error("the review store refused the write"); }
      reviews.closeQuestionsForMerge(sessionId, featureEnabled("async-input"));
    },
    blockedInCall: (sessionId) => reviews.blockedInRequestInputCall(sessionId, featureEnabled("async-input")),
  });
  const cwd = `/repo/${id}`;
  const d: DiscoveredSession = {
    syntheticId: id, agent: "claude", name: `agent-${id}`, nameSource: "process", cwd,
    gitBranch: "feat/work", gitRoot: "/repo", repoRoot: "/repo", pid: 100, tty: null, terminals: [], startedAt: 0,
  };
  registry.applyDiscovery([d]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: `${id}-episode`, cwd, transcriptPath: null, env: {} });
  registry.upsertTask(baseTask({ id: `task-${id}`, title: "Ship the thing", status: "running", sessionId: id, worktreePath: null }));
  registry.bindTaskToWorkEpisode(`task-${id}`, id);
  const merge = () => {
    const episode = registry.workEpisodeForSession(id)!;
    registry.reconcilePrs(new Map([[id, {
      url: PR, number: 91, state: "merged", checks: "passing", branch: "feat/work",
      agentSessionId: `${id}-episode`, episodeId: episode.episodeId, createdAt: episode.startedAt,
      mergedAt: Date.now(), headSha: "head", worktreeHeadSha: "head",
    }]]), new Set());
  };
  const hook = (event: "Stop" | "UserPromptSubmit") => registry.applyHook({
    agent: "claude", event, sessionId: `${id}-episode`, cwd, transcriptPath: null, env: {},
    ...(event === "UserPromptSubmit" ? { prompt: "carry on" } : {}),
  });
  return { registry, reviews, id, taskId: `task-${id}`, merge, hook };
}

test("a merge completes the task past open questions and closes each with the reason merged", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-open");
  const filed = f.reviews.create(f.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  const parked = f.reviews.create(f.id, "input", "Parked?", "Parked?", decisions("Parked?"), { snoozable: true });
  f.reviews.snooze(parked.id, 60 * 60_000);
  assert.equal(f.registry.getSession(f.id)?.state, "idle");

  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "the open question did not hold the merge");
  for (const id of [filed.id, parked.id]) {
    assert.equal(f.registry.getReview(id)?.status, "orphaned");
    assert.equal(f.registry.getReview(id)?.closedReason, "merged");
  }
  assert.deepEqual(f.registry.outstandingReviews(f.id), [], "nothing is left outstanding behind the merge");
  assert.equal(f.registry.getSession(f.id)?.openQuestions, 0, "it leaves the inbox at once");
});

test("with the flag off a merge records no reason on a snoozed call-mode question, as today", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-merge-off");
  const parked = f.reviews.create(f.id, "input", "Parked?", "Parked?", decisions("Parked?"), { snoozable: true });
  f.reviews.snooze(parked.id, 60 * 60_000);
  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(parked.id)?.status, "snoozed");
  assert.equal(f.registry.getReview(parked.id)?.closedReason, undefined);
});

test("merge-driven completion reads no review hold: closing the questions is part of it, never a reason to wait", () => {
  const source = readFileSync(new URL("../src/server/tasks.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private settleIfEpisodeFinished(s: Session): void {");
  const end = source.indexOf("\n  }\n", start);
  const body = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(body, /outstandingReviews|pendingReviews|openQuestions|completionHeldByQuestion/);
  assert.match(body, /this\.mergeQuestions\?\.close\(s\.id\)/);
});

test("a closure that fails leaves the task running with every question open, and the next observation completes it", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const failing = { times: Number.POSITIVE_INFINITY };
  const f = fleet("s-merge-close-fails", failing);
  const filed = f.reviews.create(f.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });

  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "no finished task with a question still open");
  assert.equal(f.registry.getReview(filed.id)?.status, "pending");

  // Once the store accepts the write, the next observation retries the whole settle, closure first.
  failing.times = 0;
  f.hook("Stop");
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(filed.id)?.closedReason, "merged");
});

test("a merge closes every question in one transaction: a write that fails part way closes none", () => {
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-atomic");
  const first = f.reviews.create(f.id, "input", "First?", "First?", decisions("First?"), { snoozable: true, waitMode: "message" });
  const second = f.reviews.create(f.id, "input", "Second?", "Second?", decisions("Second?"), { snoozable: true, waitMode: "message" });
  const db = openDb();
  db.exec(`CREATE TRIGGER refuse_second BEFORE UPDATE ON reviews WHEN NEW.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  try {
    assert.throws(() => f.reviews.closeQuestionsForMerge(f.id, true), /refused/);
  } finally {
    db.exec("DROP TRIGGER refuse_second");
  }
  const stored = db.prepare("SELECT id, status, closed_reason FROM reviews WHERE id IN (?, ?) ORDER BY created_at").all(first.id, second.id);
  assert.deepEqual(stored.map((r) => [r.status, r.closed_reason]), [["pending", null], ["pending", null]], "the first write rolled back with the second");
  assert.equal(f.registry.getReview(first.id)?.status, "pending", "nothing was published either");
  assert.equal(f.reviews.closeQuestionsForMerge(f.id, true).length, 2, "and a retry closes both");
});

test("with the flag on, a merge reaches an agent blocked inside a request_input call: the call is closed, then the idle turn completes the task", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-blocked");
  f.hook("UserPromptSubmit");
  assert.equal(f.registry.getSession(f.id)?.state, "working");
  // An older MCP child, or a session no message can reach: the agent waits inside the call.
  const asked = f.reviews.create(f.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  let returned: ReviewItem | null = null;
  void f.reviews.wait(asked.id, 60_000).then((r) => { returned = r; });
  assert.equal(f.reviews.blockedInRequestInputCall(f.id, true), true);

  f.merge();
  await tick();
  assert.equal(f.registry.getReview(asked.id)?.status, "orphaned");
  assert.equal(f.registry.getReview(asked.id)?.closedReason, "merged");
  const row = openDb().prepare("SELECT closed_reason FROM reviews WHERE id = ?").get(asked.id) as { closed_reason: string };
  assert.equal(row.closed_reason, "merged", "the reason is durable");
  assert.ok(returned, "the agent's call returned");
  assert.match(reviewToolResult(returned!).text, /pull request merged/);
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "still mid-turn: not concluded until the agent stops");

  // The call returned and the agent ends its turn: the ordinary idle settle completes the task.
  f.hook("Stop");
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.deepEqual(f.registry.outstandingReviews(f.id), []);
});

test("with the flag off, an agent blocked inside a request_input call keeps today's behavior on merge", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("s-merge-blocked-off");
  f.hook("UserPromptSubmit");
  const asked = f.reviews.create(f.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  void f.reviews.wait(asked.id, 60_000);
  f.merge();
  await tick();
  assert.equal(f.registry.getReview(asked.id)?.status, "pending");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  f.reviews.resolve(asked.id, "dismiss", null, "human");
});
