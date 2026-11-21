import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision } from "../src/shared/types.ts";

// A merged pull request is the operator's own conclusion (`async-input`): it completes the task
// even with a request_input question open, and closes every outstanding one with the recorded
// reason `merged` before the session can be stopped, so none is left behind it unexplained.

const home = mkdtempSync(join(tmpdir(), "mission-async-input-merge-"));
process.env.HARNESS_HOME = home;
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { applyFeatureFlagIntent, featureEnabled } = await import("../src/server/feature-flags/index.ts");
const {
  openDb, createSnoozeInstructionPendingTurn, createPendingTurn, listPendingTurns,
  claimNextPendingTurn, markPendingTurnUncertain,
} = await import("../src/server/db.ts");
const { reserveSessionTransfer, updateSessionTransfer } = await import("../src/server/session-transfers/store.ts");
const { reviewToolResult } = await import("../src/shared/review-item.ts");

after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => { applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: false }); });

const PR = "https://github.com/example/repo/pull/91";
const decisions = (question: string): PlanDecision[] => [
  { id: "q", question, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] },
];

function fleet(id: string, closeFails = { times: 0 }, scout?: { ready: boolean }) {
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  // A scout completes only once its archive gate says its report is durable.
  const archives = scout && {
    ensureReady: async () => (scout.ready ? { ok: true as const } : { ok: false as const, problems: ["no report submitted yet"] }),
    settleBeforeCleanup: async () => ({ ok: true as const }),
  };
  const tasks = new TaskManager(registry, undefined, undefined, undefined, archives);
  const reviews = new ReviewManager(registry);
  // The daemon's wiring (`src/server/index.ts`), with the flag read per merge.
  tasks.useMergeQuestions({
    closure: (sessionId) => {
      const closure = reviews.mergeClosure(sessionId, featureEnabled("async-input"));
      return {
        persist: () => {
          if (closeFails.times > 0) { closeFails.times--; throw new Error("the review store refused the write"); }
          closure.persist();
        },
        publish: () => { closure.publish(); },
      };
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
  registry.upsertTask(baseTask({
    id: `task-${id}`, title: "Ship the thing", status: "running", sessionId: id, worktreePath: null,
    ...(scout ? { kind: "scout" as const } : {}),
  }));
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

function queuedSnooze(f: ReturnType<typeof fleet>, waitMode?: "message") {
  const review = f.reviews.create(f.id, "input", "Carry on?", "Carry on?", null, { snoozable: true, waitMode });
  if (!waitMode) f.reviews.detachWait(review.id, f.id);
  f.reviews.snooze(review.id, 60 * 60_000, { mode: "hold" });
  const noteKey = noteKeyFor(f.registry.getSession(f.id)!);
  const instruction = createSnoozeInstructionPendingTurn({
    reviewId: review.id, noteKey, text: "Do not do work that depends on this answer", now: Date.now(),
  });
  assert.ok(instruction);
  assert.equal(instruction.state, "queued");
  assert.equal(instruction.claimedAt, null);
  f.registry.refreshPendingTurns(noteKey);
  return { review, instruction: listPendingTurns(noteKey)[0]!, noteKey };
}

for (const [waitMode, flagOn] of [["message", true], ["message", false], [undefined, true]] as const) {
  test(`merge cancels an unclaimed ${waitMode ?? "call"} snooze instruction with async-input ${flagOn}`, async () => {
    setShippingConfig({ closeSessionAfterMerge: false });
    applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: flagOn });
    const f = fleet(`s-merge-snooze-${waitMode ?? "call"}-${flagOn}`);
    const { review, noteKey } = queuedSnooze(f, waitMode);
    const ordinary = createPendingTurn({ id: `ordinary:${review.id}`, noteKey, text: "An unrelated message", now: Date.now() });
    f.registry.refreshPendingTurns(noteKey);

    f.merge();
    await tick();
    assert.equal(f.registry.getTask(f.taskId)?.status, "done");
    assert.equal(f.registry.getReview(review.id)?.closedReason, "merged");
    assert.deepEqual(listPendingTurns(noteKey), [ordinary], "cancel only the closed question's instruction");
    assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, [ordinary], "publish the committed outbox change");
  });
}

for (const state of ["sending", "uncertain"] as const) {
  test(`merge preserves ${state} snooze instructions for reconciliation`, async () => {
    setShippingConfig({ closeSessionAfterMerge: false });
    applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
    const f = fleet(`s-merge-snooze-${state}`);
    const { review, noteKey } = queuedSnooze(f, "message");
    const claimed = claimNextPendingTurn(noteKey, Date.now())!;
    if (state === "uncertain") markPendingTurnUncertain(claimed.id, claimed.revision, "Not confirmed", Date.now());
    f.registry.refreshPendingTurns(noteKey);
    const before = listPendingTurns(noteKey);

    f.merge();
    await tick();
    assert.equal(f.registry.getTask(f.taskId)?.status, "done");
    assert.equal(f.registry.getReview(review.id)?.closedReason, "merged");
    assert.deepEqual(listPendingTurns(noteKey), before);
    assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, before);
  });
}

test("a failed snooze cancellation rolls back merge completion and question closure", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-snooze-delete-fails");
  const { review, instruction, noteKey } = queuedSnooze(f, "message");
  const db = openDb();
  db.exec(`CREATE TRIGGER refuse_merge_snooze_delete BEFORE DELETE ON pending_turns
    WHEN OLD.id = '${instruction.id}' BEGIN SELECT RAISE(ABORT, 'snooze deletion refused'); END`);
  try {
    f.merge();
    await tick();
    assert.equal(f.registry.getTask(f.taskId)?.status, "running");
    assert.equal(f.registry.getReview(review.id)?.status, "snoozed");
    const row = db.prepare("SELECT status, closed_reason FROM reviews WHERE id = ?").get(review.id);
    assert.deepEqual({ ...row }, { status: "snoozed", closed_reason: null });
    assert.deepEqual(listPendingTurns(noteKey), [instruction]);
    assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, [instruction]);
  } finally {
    db.exec("DROP TRIGGER refuse_merge_snooze_delete");
  }
  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(review.id)?.closedReason, "merged");
  assert.deepEqual(listPendingTurns(noteKey), []);
});

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
  const { review: parked, instruction, noteKey } = queuedSnooze(f);
  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(parked.id)?.status, "snoozed");
  assert.equal(f.registry.getReview(parked.id)?.closedReason, undefined);
  assert.deepEqual(listPendingTurns(noteKey), [instruction], "flag-off call-mode questions are outside the merge closure");
});

test("merge-driven completion reads no review hold: closing the questions is part of it, never a reason to wait", () => {
  const source = readFileSync(new URL("../src/server/tasks.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private settleIfEpisodeFinished(s: Session): void {");
  const end = source.indexOf("\n  }\n", start);
  const body = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(body, /outstandingReviews|pendingReviews|openQuestions|completionHeldByQuestion/);
  assert.match(body, /this\.mergeQuestions\?\.closure\(s\.id\)/);
  assert.match(body, /joinCompletion/);
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

test("with the flag on, a merge reaches an agent blocked inside a request_input call: the task completes and the call is closed together", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-blocked");
  f.hook("UserPromptSubmit");
  assert.equal(f.registry.getSession(f.id)?.state, "working");
  // An older MCP child, or a session no message can reach: the agent waits inside the call.
  const asked = f.reviews.create(f.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  const call = f.reviews.wait(asked.id, 60_000);
  assert.equal(f.reviews.blockedInRequestInputCall(f.id, true), true);

  f.merge();
  await tick();
  assert.equal(f.registry.getReview(asked.id)?.status, "orphaned");
  assert.equal(f.registry.getReview(asked.id)?.closedReason, "merged");
  const row = openDb().prepare("SELECT closed_reason FROM reviews WHERE id = ?").get(asked.id) as { closed_reason: string };
  assert.equal(row.closed_reason, "merged", "the reason is durable");
  const returned = await call;
  assert.ok(returned, "the agent's call returned");
  assert.match(reviewToolResult(returned).text, /pull request merged/);
  assert.equal(f.registry.getTask(f.taskId)?.status, "done", "completed in the same transaction as the closure");
  assert.deepEqual(f.registry.outstandingReviews(f.id), []);

  // The agent finishes the turn its call returned into; that is not new work, so the merged
  // task is not reopened by it.
  f.hook("UserPromptSubmit");
  f.hook("Stop");
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
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

test("a merge during a runtime transfer holds completion until the questions can be closed with the reason merged", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-transfer");
  const filed = f.reviews.create(f.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  const transfer = reserveSessionTransfer({ sourceSessionId: f.id, noteKey: f.id, taskId: null,
    facts: { agent: "claude", nativeId: f.id, sourceName: "Transfer", sourceRuntime: "sdk", sourceEpisodeId: null,
      cwd: `/repo/${f.id}`, repoRoot: null, taskIdentity: null, taskEpisodeId: null, bindings: [], leaseRoot: "/unused",
      leaseId: "unused", backend: null, home: null, sourceStopped: true, stopStarted: true, sourceProcess: null,
      launchAt: null, launchOutcome: "refused", canEnd: false } });

  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "a skipped close is not a completed merge");
  assert.equal(f.registry.getReview(filed.id)?.status, "pending");

  // The transfer resolves without moving the question; the next observation closes and completes.
  updateSessionTransfer(transfer, { state: "aborted" });
  f.hook("Stop");
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(filed.id)?.closedReason, "merged");
});

test("a merge seen between a call-mode ask and its first poll closes the question, and the first poll collects that", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-before-poll");
  f.hook("UserPromptSubmit");
  const asked = f.reviews.create(f.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  assert.equal(f.reviews.blockedInRequestInputCall(f.id, true), true, "the call owns the question before any poll attaches");

  f.merge();
  await tick();
  assert.equal(f.registry.getReview(asked.id)?.status, "orphaned");
  assert.equal(f.registry.getReview(asked.id)?.closedReason, "merged");
  const first = await f.reviews.wait(asked.id, 60_000);
  assert.match(reviewToolResult(first!).text, /pull request merged/, "the first poll returns at once with why");

  f.hook("Stop");
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
});

test("a merged scout whose report is not ready keeps its questions open, and closes them when it completes", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const scout = { ready: false };
  const f = fleet("s-merge-scout", { times: 0 }, scout);
  const filed = f.reviews.create(f.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });

  f.merge();
  await tick(); await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "running", "the archive check refused the completion");
  assert.equal(f.registry.getReview(filed.id)?.status, "pending", "so the question is still the operator's to answer");
  assert.equal(f.registry.getReview(filed.id)?.closedReason, undefined);

  // The report lands; the next observation completes the scout and closes the question with it.
  scout.ready = true;
  f.hook("Stop");
  await tick(); await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(filed.id)?.status, "orphaned");
  assert.equal(f.registry.getReview(filed.id)?.closedReason, "merged");
});

test("a task status write that fails rolls the question closure back with it", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-write-fails");
  const { review: filed, instruction, noteKey } = queuedSnooze(f, "message");
  const db = openDb();
  // The task's own completion write is refused after the question settles were written.
  for (const event of ["INSERT", "UPDATE"]) {
    db.exec(`CREATE TRIGGER refuse_done_${event.toLowerCase()} BEFORE ${event} ON tasks
      WHEN NEW.id = '${f.taskId}' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  }
  try {
    f.merge();
    await tick();
    assert.equal(f.registry.getTask(f.taskId)?.status, "running");
    assert.equal(f.registry.getReview(filed.id)?.status, "snoozed", "nothing was published");
    const row = db.prepare("SELECT status, closed_reason FROM reviews WHERE id = ?").get(filed.id) as { status: string; closed_reason: string | null };
    assert.deepEqual({ ...row }, { status: "snoozed", closed_reason: null }, "the settle rolled back with the failed write");
    assert.deepEqual(listPendingTurns(noteKey), [instruction], "instruction deletion rolls back with task completion");
    assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, [instruction]);
  } finally {
    db.exec("DROP TRIGGER refuse_done_insert; DROP TRIGGER refuse_done_update;");
  }

  // Once the write is accepted, the next observation completes the task and closes the question together.
  f.hook("Stop");
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.equal(f.registry.getReview(filed.id)?.closedReason, "merged");
  assert.deepEqual(listPendingTurns(noteKey), []);
  assert.deepEqual(f.registry.getSession(f.id)?.pendingTurns, []);
});

test("an older child polling a filed question after the merge is released at once by the closure its attach triggers", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-late-poll");
  f.hook("UserPromptSubmit");
  const filed = f.reviews.create(f.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  f.merge();
  await tick();
  assert.equal(f.registry.getReview(filed.id)?.status, "pending", "working past a filed question: nothing to close yet");

  // The older child's poll attaches the call, which makes the session blocked and triggers the
  // merge closure from inside the attach. The poll must hear it now, not at its timeout.
  const polled = await Promise.race([
    f.reviews.wait(filed.id, 60_000),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 2_000)),
  ]);
  assert.notEqual(polled, "timed out", "the waiter was registered before the closure released it");
  assert.equal((polled as { status: string }).status, "orphaned");
  assert.equal(f.registry.getReview(filed.id)?.closedReason, "merged");
});

test("a scout blocked in a call keeps its question open on merge, since its archive may still refuse", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-blocked-scout", { times: 0 }, { ready: false });
  f.hook("UserPromptSubmit");
  const asked = f.reviews.create(f.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  void f.reviews.wait(asked.id, 60_000);
  f.merge();
  await tick();
  assert.equal(f.registry.getReview(asked.id)?.status, "pending", "still the operator's to answer");
  assert.equal(f.registry.getTask(f.taskId)?.status, "running");
  f.reviews.resolve(asked.id, "dismiss", null, "human");
});

test("an agent blocked in a call whose task status write fails keeps its question open and its call waiting", async () => {
  setShippingConfig({ closeSessionAfterMerge: false });
  applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true });
  const f = fleet("s-merge-blocked-write-fails");
  f.hook("UserPromptSubmit");
  const asked = f.reviews.create(f.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  let returned = false;
  const call = f.reviews.wait(asked.id, 60_000).then((r) => { returned = true; return r; });
  const db = openDb();
  for (const event of ["INSERT", "UPDATE"]) {
    db.exec(`CREATE TRIGGER refuse_blocked_${event.toLowerCase()} BEFORE ${event} ON tasks
      WHEN NEW.id = '${f.taskId}' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
  }
  try {
    f.merge();
    await tick();
    assert.equal(f.registry.getTask(f.taskId)?.status, "running");
    assert.equal(f.registry.getReview(asked.id)?.status, "pending", "no closed question behind a running task");
    const row = db.prepare("SELECT status, closed_reason FROM reviews WHERE id = ?").get(asked.id) as { status: string; closed_reason: string | null };
    assert.deepEqual({ ...row }, { status: "pending", closed_reason: null });
    assert.equal(returned, false, "the call is still waiting, and still answerable");
  } finally {
    db.exec("DROP TRIGGER refuse_blocked_insert; DROP TRIGGER refuse_blocked_update;");
  }
  // The next observation of the merge completes and closes together, which returns the call.
  f.merge();
  await tick();
  assert.equal(f.registry.getTask(f.taskId)?.status, "done");
  assert.match(reviewToolResult((await call)!).text, /pull request merged/);
});
