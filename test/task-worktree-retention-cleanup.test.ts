import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";
import type { ActivityFingerprint } from "../src/server/git/worktree-activity.ts";
import { mkTask as baseTask, mkSession } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-retention-cleanup-"));
process.env.HARNESS_HOME = home;

const {
  getTaskWorktreeRetention,
  recordTaskWorktreeObservation,
  deleteTaskWorktreeRetention,
  listOrphanedTaskWorktreeRetentionIds,
  claimTaskWorktreeCleanup,
  completeTaskWorktreeCleanup,
  deferTaskWorktreeCleanup,
  releaseTaskWorktreeCleanupClaim,
  recoverAbandonedTaskWorktreeCleanups,
  taskAutomaticCleanupSummaries,
  settleTaskWithRetentionAdoption,
  listTasks,
  getTask,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { WorktreeTeardownError } = await import("../src/server/dispatcher.ts");
const {
  TaskWorktreeRetentionObserver,
  defaultRetentionCleanupDeps,
  taskResourceGeneration,
  RETENTION_WINDOW_MS,
  RETENTION_OBSERVE_INTERVAL_MS,
  RETENTION_RETRY_BASE_MS,
  RETENTION_RETRY_MAX_MS,
  nextRetryDelayMs,
} = await import("../src/server/task-worktree-retention.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_900_000_000_000;

let seq = 0;
const uid = (prefix: string): string => `${prefix}-${(seq += 1)}`;

const attached = (worktreePath: string | null, repoRoot = "/repo/attached") => ({
  repoRoot,
  worktreePath,
  branch: "b",
  provider: "git" as const,
  worktreeLeaseId: null,
  baseSha: null,
  prUrl: null,
  prState: null,
  mergedAt: null,
});

/**
 * A whole retention world: a real Registry, a real TaskManager with its teardown stubbed, the
 * real ledger, and a clock and probe the test drives.
 *
 * Deliberately not a mock of the service under test. Every claim, every guard and every ledger
 * transition below is the production code path; what is faked is only the two things a unit
 * test cannot have - a real checkout to hash, and a real provider to release.
 */
function world(options: {
  tasks: Task[];
  /** Digest per task id. Change it mid-flight to simulate somebody editing a checkout. */
  fingerprints?: Map<string, string | null>;
  teardown?: (task: Task) => Promise<void>;
  /**
   * Stand in for stopping the task's agent, for the fixtures that carry a `homeName`.
   * Quiescence reaches a real terminal backend otherwise, which no test here may depend on.
   */
  killSession?: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Sessions to register BEFORE `TaskManager` is built. Startup reconciliation runs during
   * construction, so a session seeded afterwards is not there for the reconcile that matters
   * and quiescence falls through to a real terminal backend.
   */
  sessions?: { id: string }[];
} ) {
  const registry = new Registry();
  // Every test in this file shares one SQLite home, and a Registry loads every
  // resource-holding terminal task on construction - so without this, one test's leftovers
  // are another test's due candidates and queue contention.
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const state = {
    now: NOW,
    fingerprints: options.fingerprints ?? new Map<string, string | null>(),
    teardowns: [] as string[],
    probes: 0,
  };
  for (const session of options.sessions ?? []) {
    (registry as unknown as { sessions: Map<string, unknown> }).sessions.set(
      session.id,
      mkSession({ id: session.id }),
    );
  }
  for (const task of options.tasks) {
    registry.upsertTask(task);
    if (!state.fingerprints.has(task.id)) state.fingerprints.set(task.id, `fp-${task.id}`);
  }
  const tasks = new TaskManager(
    registry,
    options.killSession ? ({ kill: options.killSession } as never) : undefined,
    // Nothing is alive, and nothing needs to be: every fixture here is already terminal, so
    // startup reconciliation settles them where they stand and touches no resource.
    { taskLiveness: () => null } as never,
    undefined,
    undefined,
    {
      teardown: async (task) => {
        state.teardowns.push((task as Task).id);
        if (options.teardown) await options.teardown(task as Task);
      },
    },
  );
  const probe = async (task: Task): Promise<ActivityFingerprint> => {
    state.probes += 1;
    const digest = state.fingerprints.get(task.id);
    return digest
      ? { kind: "known", digest }
      : { kind: "unknown", reason: "unreadable in this test" };
  };
  const observer = new TaskWorktreeRetentionObserver({
    listTasks: () => registry.listTasks(),
    reloadTask: getTask,
    probe,
    record: recordTaskWorktreeObservation,
    listOrphans: listOrphanedTaskWorktreeRetentionIds,
    deleteRow: deleteTaskWorktreeRetention,
    now: () => state.now,
    intervalMs: RETENTION_OBSERVE_INTERVAL_MS,
    retentionMs: RETENTION_WINDOW_MS,
    concurrency: 4,
    schedule: () => () => {},
    cleanup: {
      ...defaultRetentionCleanupDeps,
      reclaim: (request) => tasks.enqueueRetentionCleanup(request),
      refreshSummary: (taskId) => registry.refreshTaskAutomaticCleanup(taskId),
    },
  });
  return {
    registry,
    tasks,
    observer,
    state,
    /**
     * Wait for startup reconciliation to leave the shared cleanup queue.
     *
     * `TaskManager` enqueues a startup job per resource-holding task into the very queue
     * retention uses, and the queue is one-deep per task - so a cleanup asked for while a
     * task's startup job is still in flight is refused and retried on the next pass. That is
     * correct backpressure in production, where the first retention pass runs long after boot
     * settles, and it is only a test-timing artifact here.
     */
    async ready(): Promise<void> {
      for (let attempt = 0; attempt < 500 && tasks.pendingCleanupJobs > 0; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

/** Seed the clock, then jump past the deadline so the next pass finds the task due. */
async function ageToDue(w: ReturnType<typeof world>): Promise<void> {
  await w.ready();
  await w.observer.runPass();
  w.state.now = NOW + RETENTION_WINDOW_MS;
}

test("a quiet terminal task is reclaimed exactly at the 30-day boundary, not before", async () => {
  const id = uid("due");
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/a", provider: "treehouse", dispatchedAt: 1 })],
  });
  await w.ready();
  await w.observer.runPass();
  assert.equal(getTaskWorktreeRetention(id)?.cleanupDueAt, NOW + RETENTION_WINDOW_MS);

  // Day 29: still quiet, still not due, still standing.
  w.state.now = NOW + 29 * DAY;
  await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [], "a tree inside its window is never touched");
  assert.equal(w.registry.getTask(id)?.worktreePath, "/pool/a");

  // Day 30, to the millisecond.
  w.state.now = NOW + RETENTION_WINDOW_MS;
  const pass = await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [id]);
  assert.equal(pass.cleanups["reclaimed"], 1);
  assert.equal(w.registry.getTask(id)?.worktreePath, null, "the released tree left the row");
  assert.equal(w.registry.getTask(id)?.status, "done", "status and outcome are preserved");
  assert.equal(getTaskWorktreeRetention(id), null, "the clock is dropped with the tree");
});

test("every terminal status is eligible and no live status ever is", async () => {
  const ids = { done: uid("s"), failed: uid("s"), cancelled: uid("s") };
  const live = { running: uid("s"), dispatching: uid("s"), backlog: uid("s") };
  const w = world({
    tasks: [
      baseTask({ id: ids.done, status: "done", worktreePath: "/pool/d", dispatchedAt: 1 }),
      baseTask({ id: ids.failed, status: "failed", worktreePath: "/pool/f", dispatchedAt: 1 }),
      baseTask({ id: ids.cancelled, status: "cancelled", worktreePath: "/pool/c", dispatchedAt: 1 }),
      baseTask({ id: live.running, status: "running", worktreePath: "/pool/r", dispatchedAt: 1 }),
      baseTask({ id: live.backlog, status: "backlog", worktreePath: "/pool/b", dispatchedAt: 1 }),
    ],
  });
  await ageToDue(w);
  await w.observer.runPass();
  assert.deepEqual(
    [...w.state.teardowns].sort(),
    [ids.cancelled, ids.done, ids.failed].sort(),
  );
  assert.equal(w.registry.getTask(live.running)?.worktreePath, "/pool/r");
  assert.equal(w.registry.getTask(live.backlog)?.worktreePath, "/pool/b");
  assert.equal(getTaskWorktreeRetention(live.running), null, "a live task has no clock at all");
});

test("a change on day 29 buys a full new 30 days rather than a reprieve", async () => {
  const id = uid("reset");
  const w = world({
    tasks: [baseTask({ id, status: "failed", worktreePath: "/pool/edit", dispatchedAt: 1 })],
  });
  await w.ready();
  await w.observer.runPass();

  // Somebody commits in the checkout on day 29.
  w.state.now = NOW + 29 * DAY;
  w.state.fingerprints.set(id, "fp-after-a-local-commit");
  await w.observer.runPass();
  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.lastChangedAt, NOW + 29 * DAY);
  assert.equal(row.cleanupDueAt, NOW + 29 * DAY + RETENTION_WINDOW_MS);

  // The ORIGINAL deadline arrives and means nothing now.
  w.state.now = NOW + RETENTION_WINDOW_MS;
  await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, []);

  // And the new one still expires - unpushed local work is not a permanent exemption.
  w.state.now = NOW + 29 * DAY + RETENTION_WINDOW_MS;
  await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [id]);
});

test("an unreadable checkout is never mistaken for a quiet one", async () => {
  const id = uid("unknown");
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/unreadable", dispatchedAt: 1 })],
  });
  await ageToDue(w);
  w.state.fingerprints.set(id, null);
  const pass = await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [], "no digest, no claim, no deletion");
  assert.equal(pass.cleanups["reclaimed"], undefined);
  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.lastChangedAt, NOW, "the activity boundary did not move");
  assert.equal(row.cleanupDueAt, NOW + RETENTION_WINDOW_MS);
});

test("work that lands between the pass's probe and the teardown aborts the attempt", async () => {
  const id = uid("race");
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/race", dispatchedAt: 1 })],
  });
  await ageToDue(w);
  // The claim is taken against `fp-<id>`; the guards re-probe and find something else.
  let probes = 0;
  const observer = w.observer as unknown as { deps: { probe: (t: Task) => Promise<ActivityFingerprint> } };
  const original = observer.deps.probe;
  observer.deps.probe = async (task) => {
    probes += 1;
    // First probe (the pass's own observation) is the ledger's value; every later one is not.
    return probes === 1 ? original(task) : { kind: "known", digest: "fp-somebody-just-edited" };
  };
  const pass = await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [], "the guard stopped the teardown");
  assert.equal(pass.cleanups["activity-changed"], 1);
  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.cleanupState, "observing", "the claim was handed back, unpenalised");
  assert.equal(row.claimToken, null);
});

test("a provider refusal keeps every fact, backs off, and never buys a new window", async () => {
  const id = uid("refuse");
  const w = world({
    tasks: [baseTask({
      id,
      status: "failed",
      worktreePath: "/pool/refuse",
      provider: "treehouse",
      dispatchedAt: 1,
    })],
    teardown: async () => {
      throw new Error("the pool refused: /pool/refuse is busy");
    },
  });
  await ageToDue(w);
  const pass = await w.observer.runPass();
  assert.equal(pass.cleanups["failed"], 1);

  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.cleanupState, "retry");
  assert.equal(row.cleanupDueAt, NOW + RETENTION_WINDOW_MS, "the tree is still past due");
  assert.equal(row.lastChangedAt, NOW, "a failed cleanup is not user activity");
  assert.equal(row.retryAt, NOW + RETENTION_WINDOW_MS + RETENTION_RETRY_BASE_MS);
  assert.ok(row.lastError, "a bounded reason is recorded");
  assert.ok(!row.lastError?.includes("/pool/refuse"), "no path from a provider message is stored");

  // Its resources are all still there, so the operator's Clean up still reaches them.
  assert.equal(w.registry.getTask(id)?.worktreePath, "/pool/refuse");
  assert.equal(w.registry.getTask(id)?.provider, "treehouse");
  // And the task's own record is untouched by the maintenance failure.
  assert.equal(w.registry.getTask(id)?.status, "failed");

  // The retry does not run before its time.
  await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [id], "still exactly one attempt");
});

test("a partial multi-repository release clears what came back and retries the rest", async () => {
  const id = uid("partial");
  const w = world({
    tasks: [baseTask({
      id,
      status: "done",
      dispatchedAt: 1,
      repoRoot: "/repo/primary",
      worktreePath: "/pool/primary",
      provider: "git",
      extraRepos: [attached("/pool/attached")],
    })],
    teardown: async () => {
      // Exactly what `teardownWorktree` throws on a partial release: the primary came back,
      // the attached repository did not.
      throw new WorktreeTeardownError("could not release /pool/attached", ["/pool/primary"]);
    },
  });
  await ageToDue(w);
  await w.observer.runPass();

  const task = w.registry.getTask(id)!;
  assert.equal(task.worktreePath, null, "the released tree stopped being recorded");
  assert.equal(task.extraRepos[0]?.worktreePath, "/pool/attached", "the survivor keeps its record");

  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.cleanupState, "retry");
  assert.equal(
    row.cleanupDueAt,
    NOW + RETENTION_WINDOW_MS,
    "the survivor was already 30 days quiet and does not earn another month",
  );
  assert.equal(
    row.generation,
    taskResourceGeneration(task),
    "the row adopted the shrunken resource set instead of calling it a replacement",
  );
});

test("a teardown that frees the last tree but not the home stays retryable", async () => {
  const id = uid("home-retry");
  let attempts = 0;
  const w = world({
    // No `homeName` at construction: startup reconciliation asks a real terminal backend
    // whether a named home is alive, which no test here may wait on. It is attached below,
    // once that has settled and before the clock is seeded.
    tasks: [baseTask({
      id,
      status: "done",
      dispatchedAt: 1,
      repoRoot: "/repo/primary",
      worktreePath: "/pool/primary",
      provider: "git",
    })],
    // A teardown can fail while every PATH it named came back: a tree whose recorded path is
    // already null is released by definition and cannot be kept, so its failure reports no
    // survivor. What is left is the terminal home, and the release is not finished.
    teardown: async () => {
      attempts += 1;
      throw new WorktreeTeardownError("the terminal home would not stop", ["/pool/primary"]);
    },
    killSession: async () => ({ ok: true }),
    sessions: [{ id: "sess-1" }],
  });
  await w.ready();
  w.registry.upsertTask({
    ...w.registry.getTask(id)!,
    homeName: "mission-home-1",
    terminalResourceId: "term-1",
    sessionId: "sess-1",
  });

  await w.observer.runPass();
  w.state.now = NOW + RETENTION_WINDOW_MS;
  await w.observer.runPass();
  assert.equal(attempts, 1, "the deadline produced exactly one attempt");

  const partial = w.registry.getTask(id)!;
  assert.equal(partial.worktreePath, null, "the tree that came back stopped being recorded");
  // The durable terminal-home fact SURVIVES: the home is genuinely still there, so clearing
  // these would delete the only record of a live resource.
  assert.equal(partial.homeName, "mission-home-1", "the home it could not release is still named");
  assert.equal(partial.terminalResourceId, "term-1", "and the terminal it belongs to");

  // The record is still there and still retryable - neither completed for having no checkout
  // nor pruned as a row describing nothing.
  const row = getTaskWorktreeRetention(id);
  assert.ok(row, "the row survived the prune that drops rows describing nothing");
  assert.equal(row!.cleanupState, "retry", "and it is retryable rather than finished");
  assert.equal(
    row!.generation,
    taskResourceGeneration(partial),
    "it adopted what is still held, so a later attempt can claim it",
  );
  assert.equal(
    row!.cleanupDueAt,
    NOW + RETENTION_WINDOW_MS,
    "a failed release never buys the task another window",
  );

  // The retry does not run before its time...
  w.state.now = row!.retryAt! - 1;
  await w.observer.runPass();
  assert.equal(attempts, 1, "still exactly one attempt");

  // ...and genuinely fires once the backoff elapses, rather than sitting there forever.
  w.state.now = row!.retryAt!;
  await w.observer.runPass();
  assert.equal(attempts, 2, "the unfinished release was attempted again");
  assert.equal(w.registry.getTask(id)!.homeName, "mission-home-1", "still held, still recorded");
  assert.equal(getTaskWorktreeRetention(id)?.cleanupState, "retry", "and still retryable");
});

test("a re-dispatch during the attempt abandons it and starts a fresh window", async () => {
  const id = uid("redispatch");
  const original = baseTask({ id, status: "done", worktreePath: "/pool/old", dispatchedAt: 1 });
  const w = world({ tasks: [original] });
  await ageToDue(w);
  // Replace the resources in the window between the claim and the teardown guard.
  const observer = w.observer as unknown as { deps: { probe: (t: Task) => Promise<ActivityFingerprint> } };
  const probe = observer.deps.probe;
  let probes = 0;
  observer.deps.probe = async (task) => {
    probes += 1;
    if (probes === 2) {
      w.registry.upsertTask({ ...original, worktreePath: "/pool/new", dispatchedAt: 2 });
    }
    return probe(task);
  };
  const pass = await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [], "a replacement checkout is never torn down on an old claim");
  assert.equal(pass.cleanups["ownership-changed"], 1);
  assert.equal(w.registry.getTask(id)?.worktreePath, "/pool/new");

  // Ordinary observation reseeds the replacement with its own conservative full window.
  w.state.now = NOW + RETENTION_WINDOW_MS + DAY;
  await w.observer.runPass();
  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.lastChangedAt, NOW + RETENTION_WINDOW_MS + DAY);
  assert.equal(row.cleanupDueAt, NOW + RETENTION_WINDOW_MS + DAY + RETENTION_WINDOW_MS);
});

test("two simultaneous passes produce exactly one teardown", async () => {
  const id = uid("double");
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/double", dispatchedAt: 1 })],
  });
  await ageToDue(w);
  await Promise.all([w.observer.runPass(), w.observer.runPass()]);
  assert.deepEqual(w.state.teardowns, [id], "the ledger claim admitted one attempt");
});

test("a manual reclaim in flight refuses the automatic attempt rather than doubling it", async () => {
  const id = uid("manual");
  let releaseManual!: () => void;
  const manualMayFinish = new Promise<void>((resolve) => { releaseManual = resolve; });
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/manual", dispatchedAt: 1 })],
  });
  await ageToDue(w);
  // Hold the in-process reservation the way a slow manual Clean up does. The manual path uses
  // the real `teardownWorktree`, so this drives the RESERVATION rather than the teardown.
  const held = (w.tasks as unknown as {
    withCleanupReservation: <T>(id: string, conflict: T, fn: () => Promise<T>) => Promise<T>;
  }).withCleanupReservation(id, { ok: false }, async () => {
    await manualMayFinish;
    return { ok: true };
  });
  const pass = await w.observer.runPass();
  releaseManual();
  await held;
  assert.deepEqual(w.state.teardowns, [], "the reservation kept the automatic attempt out");
  assert.equal(pass.cleanups["ownership-changed"], 1);
  assert.equal(getTaskWorktreeRetention(id)?.cleanupState, "observing", "and it was unpenalised");
});

test("a claim abandoned by a dead daemon is reopened as a retry, not as a fresh window", async () => {
  const id = uid("abandoned");
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/abandoned", dispatchedAt: 1 })],
  });
  await w.ready();
  await w.observer.runPass();
  const row = getTaskWorktreeRetention(id)!;
  const claimed = claimTaskWorktreeCleanup({
    taskId: id,
    generation: row.generation,
    fingerprint: row.fingerprint,
    token: "token-from-a-daemon-that-died",
    now: NOW + RETENTION_WINDOW_MS,
  });
  assert.equal(claimed.claimed, true);

  const reopened = recoverAbandonedTaskWorktreeCleanups(NOW + RETENTION_WINDOW_MS + 1);
  assert.equal(reopened, 1);
  const after = getTaskWorktreeRetention(id)!;
  assert.equal(after.cleanupState, "retry");
  assert.equal(after.claimToken, null, "the dead daemon's token cannot finish anything");
  assert.equal(after.cleanupDueAt, row.cleanupDueAt, "the deadline survived the crash");
  assert.equal(after.lastChangedAt, row.lastChangedAt);

  // And the retry, once its backoff elapses, is an ordinary attempt.
  w.state.now = NOW + RETENTION_WINDOW_MS + RETENTION_RETRY_BASE_MS + 1;
  await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [id]);
});

test("a claim is refused without a fresh probe that still matches the ledger", () => {
  const id = uid("claim-guard");
  const task = baseTask({ id, status: "done", worktreePath: "/pool/guard", dispatchedAt: 1 });
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  registry.upsertTask(task);
  recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(task),
    fingerprint: "fp-guard",
    now: NOW,
    retentionMs: RETENTION_WINDOW_MS,
  });
  const generation = taskResourceGeneration(task);
  const due = NOW + RETENTION_WINDOW_MS;

  const stale = claimTaskWorktreeCleanup({
    taskId: id, generation, fingerprint: "fp-something-else", token: "t", now: due,
  });
  assert.deepEqual(stale, { claimed: false, refusal: "activity-changed" });

  const early = claimTaskWorktreeCleanup({
    taskId: id, generation, fingerprint: "fp-guard", token: "t", now: due - 1,
  });
  assert.deepEqual(early, { claimed: false, refusal: "not-due" });

  const wrongGeneration = claimTaskWorktreeCleanup({
    taskId: id, generation: "not-this-one", fingerprint: "fp-guard", token: "t", now: due,
  });
  assert.deepEqual(wrongGeneration, { claimed: false, refusal: "generation-moved" });

  const first = claimTaskWorktreeCleanup({
    taskId: id, generation, fingerprint: "fp-guard", token: "t1", now: due,
  });
  assert.equal(first.claimed, true);
  const second = claimTaskWorktreeCleanup({
    taskId: id, generation, fingerprint: "fp-guard", token: "t2", now: due,
  });
  assert.deepEqual(second, { claimed: false, refusal: "already-claimed" });

  // And only the holder's token can move it.
  assert.equal(releaseTaskWorktreeCleanupClaim(id, "t2", due), false);
  assert.equal(deferTaskWorktreeCleanup({
    taskId: id, token: "t2", now: due, retryAt: due + 1, error: "nope",
  }).deferred, false);
  assert.equal(completeTaskWorktreeCleanup(id, "t2").kind, "not-claimed");
  assert.equal(releaseTaskWorktreeCleanupClaim(id, "t1", due), true);
});

test("a row is never deleted while the task still records a checkout", () => {
  const id = uid("no-forget");
  const task = baseTask({ id, status: "done", worktreePath: "/pool/still-here", dispatchedAt: 1 });
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  registry.upsertTask(task);
  recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(task),
    fingerprint: "fp-keep",
    now: NOW,
    retentionMs: RETENTION_WINDOW_MS,
  });
  const claimed = claimTaskWorktreeCleanup({
    taskId: id,
    generation: taskResourceGeneration(task),
    fingerprint: "fp-keep",
    token: "tok",
    now: NOW + RETENTION_WINDOW_MS,
  });
  assert.equal(claimed.claimed, true);
  // Deleting here would hand the surviving tree a brand new 30 days - the one failure mode
  // where a cleanup bug makes the product forget instead of making it retry.
  assert.equal(completeTaskWorktreeCleanup(id, "tok").kind, "still-held");
  assert.ok(getTaskWorktreeRetention(id));
});

test("the browser summary carries a sentence and nothing internal", async () => {
  const id = uid("summary");
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/summary", dispatchedAt: 1 })],
    teardown: async () => { throw new Error("EACCES: permission denied, open '/pool/summary/.git'"); },
  });
  await ageToDue(w);
  await w.observer.runPass();

  const summary = taskAutomaticCleanupSummaries([id]).get(id)!;
  assert.equal(summary.state, "retrying");
  assert.equal(typeof summary.retryAt, "number");
  assert.ok(summary.detail && summary.detail.length < 200);
  assert.ok(!summary.detail?.includes("/pool/summary"), "no path crosses to a browser");
  const row = getTaskWorktreeRetention(id)!;
  assert.ok(!JSON.stringify(summary).includes(row.fingerprint), "no fingerprint crosses");
  assert.ok(!JSON.stringify(summary).includes(row.generation), "no generation crosses");

  // And it rides the ordinary whole-task event, which is what a dashboard already handles.
  const task = w.registry.getTask(id)!;
  assert.deepEqual(task.automaticCleanup, summary);

  assert.equal(getTaskWorktreeRetention(id)!.cleanupState, "retry");
});

test("a completed task's outcome and a failed task's reason are never overwritten", async () => {
  const done = uid("keeps-outcome");
  const failed = uid("keeps-error");
  const w = world({
    tasks: [
      baseTask({
        id: done,
        status: "done",
        outcome: "opened PR #123",
        outcomeUrl: "https://example.test/pr/123",
        worktreePath: "/pool/o1",
        dispatchedAt: 1,
      }),
      baseTask({
        id: failed,
        status: "failed",
        error: "the agent ran out of budget",
        worktreePath: "/pool/o2",
        dispatchedAt: 1,
      }),
    ],
    teardown: async () => { throw new Error("provider is down"); },
  });
  await ageToDue(w);
  await w.observer.runPass();
  assert.equal(w.registry.getTask(done)?.outcome, "opened PR #123");
  assert.equal(w.registry.getTask(done)?.error, null);
  assert.equal(w.registry.getTask(failed)?.error, "the agent ran out of budget");
  assert.equal(w.registry.getTask(failed)?.automaticCleanup?.state, "retrying");
});

test("same-repository cleanups are serialized while disjoint ones progress", async () => {
  const same = [uid("q"), uid("q"), uid("q")];
  const other = uid("q");
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((r) => { releaseFirst = r; });
  let disjointDone = false;
  const w = world({
    tasks: [
      ...same.map((id, index) => baseTask({
        id,
        status: "done",
        dispatchedAt: 1,
        repoRoot: "/repo/convoy",
        worktreePath: `/pool/convoy/${index}`,
      })),
      baseTask({
        id: other,
        status: "done",
        dispatchedAt: 1,
        repoRoot: "/repo/elsewhere",
        worktreePath: "/pool/elsewhere/0",
      }),
    ],
    teardown: async (task) => {
      if (task.repoRoot === "/repo/elsewhere") {
        disjointDone = true;
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      if (task.worktreePath === "/pool/convoy/0") await firstMayFinish;
      active -= 1;
    },
  });
  await ageToDue(w);
  const pass = w.observer.runPass();
  // The disjoint repository is not stuck behind the convoy.
  for (let i = 0; i < 200 && !disjointDone; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(disjointDone, true, "a disjoint repository progressed while one was blocked");
  releaseFirst();
  await pass;
  assert.equal(peak, 1, "one cleanup at a time per physical repository");
  assert.equal(w.state.teardowns.length, 4);
});

test("an attached-only survivor is still observed, still due, and still reclaimable", async () => {
  const id = uid("attached-only");
  const w = world({
    tasks: [baseTask({
      id,
      status: "failed",
      dispatchedAt: 1,
      repoRoot: "/repo/primary-released",
      worktreePath: null,
      provider: null,
      extraRepos: [attached("/pool/attached-only", "/repo/attached-only")],
    })],
  });
  await ageToDue(w);
  await w.observer.runPass();
  assert.deepEqual(w.state.teardowns, [id], "a task whose only tree is attached is reclaimed");
  assert.equal(w.registry.getTask(id)?.extraRepos[0]?.worktreePath, null);
});

test("restart settlement adopts the ledger generation without moving the deadline", async () => {
  const id = uid("restart-adopt");
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  // A task that ended while the daemon was UP - so retention has been observing it for days -
  // and whose bound session then died with the daemon. This is the shape the adoption exists
  // for: the settlement clears a session binding that IS part of the resource generation.
  const task = baseTask({
    id,
    status: "done",
    dispatchedAt: 1,
    worktreePath: "/pool/restart",
    provider: "treehouse",
    homeName: "restart-home",
    terminalResourceId: "restart-res",
    sessionId: "proc:dead",
  });
  registry.upsertTask(task);
  const seeded = recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(task),
    fingerprint: "fp-restart",
    now: NOW,
    retentionMs: RETENTION_WINDOW_MS,
  });
  assert.equal(seeded.outcome, "seeded");

  // The restart proves the session gone and settles the task. Its session binding is cleared,
  // which MOVES the resource generation - and without adoption the next observation would call
  // that a replacement and hand a checkout 29 days into its window a brand new 30.
  new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    { teardown: async () => { throw new Error("restart must not tear anything down"); } },
  );
  for (let i = 0; i < 200 && registry.getTask(id)?.sessionId !== null; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  const settled = registry.getTask(id)!;
  assert.equal(settled.status, "done", "a completed task keeps its status across a restart");
  assert.equal(settled.sessionId, null);
  assert.equal(settled.worktreePath, "/pool/restart");

  const row = getTaskWorktreeRetention(id)!;
  assert.equal(row.generation, taskResourceGeneration(settled), "the row adopted the settlement");
  assert.equal(row.lastChangedAt, NOW, "and did not move the activity boundary");
  assert.equal(row.cleanupDueAt, NOW + RETENTION_WINDOW_MS, "nor the deadline");
  assert.equal(row.fingerprint, "fp-restart");
});

test("a restart with no ledger row settles normally and gets the conservative full period", async () => {
  const id = uid("restart-no-row");
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  registry.upsertTask(baseTask({
    id,
    status: "running",
    dispatchedAt: 1,
    worktreePath: "/pool/no-row",
    provider: "treehouse",
    homeName: "no-row-home",
    sessionId: "proc:dead",
  }));
  new TaskManager(
    registry,
    undefined,
    { taskLiveness: () => false } as never,
    undefined,
    undefined,
    { teardown: async () => { throw new Error("restart must not tear anything down"); } },
  );
  for (let i = 0; i < 200 && registry.getTask(id)?.sessionId !== null; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(getTaskWorktreeRetention(id), null, "no row is invented from a settlement");
  assert.equal(registry.getTask(id)?.worktreePath, "/pool/no-row");
});

test("stopping mid-sweep abandons queued cleanups without penalising their claims", async () => {
  // Shutdown awaits the retention pass, because a probe still reading checkouts the allocator
  // is about to reconcile would report nonsense. That is only safe if a queue of due teardowns
  // behind one physical repository does not become the length of the quit.
  const ids = [uid("abandon"), uid("abandon"), uid("abandon")];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const w = world({
    tasks: ids.map((id, index) => baseTask({
      id,
      status: "done",
      dispatchedAt: 1,
      repoRoot: "/repo/abandon",
      worktreePath: `/pool/abandon/${index}`,
    })),
    teardown: async (task) => {
      if (task.worktreePath === "/pool/abandon/0") await firstMayFinish;
    },
  });
  await ageToDue(w);
  const pass = w.observer.runPass();
  // Let the first job get into teardown and the other two queue behind it.
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const stopping = w.observer.stop();
  releaseFirst();
  await stopping;
  await pass;

  assert.equal(w.state.teardowns.length, 1, "only the job already in teardown ran");
  for (const id of ids.slice(1)) {
    const row = getTaskWorktreeRetention(id);
    // Abandoned, not failed: the claim goes back untouched and the deadline it was working
    // toward is still there on the next boot.
    assert.equal(row?.cleanupState, "observing", `${id} was not penalised`);
    assert.equal(row?.claimToken, null);
    assert.equal(row?.cleanupDueAt, NOW + RETENTION_WINDOW_MS, `${id} kept its deadline`);
  }
});

test("a shrunken generation on a retrying row is adopted, not called a replacement", () => {
  // The backstop for the one case the claim cannot cover: a cleanup that failed AND left the
  // remaining trees unreadable, so nothing trustworthy could be adopted under the claim. The
  // next successful observation finds a generation that moved on a row already in `retry`.
  // Calling that an external replacement would hand a survivor that was already 30 days quiet
  // a brand new 30 - which is how a repeatedly-failing cleanup would become a permanent one.
  const id = uid("retry-adopt");
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const before = baseTask({
    id,
    status: "done",
    dispatchedAt: 1,
    worktreePath: "/pool/shrink-primary",
    extraRepos: [attached("/pool/shrink-attached")],
  });
  registry.upsertTask(before);
  recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(before),
    fingerprint: "fp-both-trees",
    now: NOW,
    retentionMs: RETENTION_WINDOW_MS,
  });
  const claimed = claimTaskWorktreeCleanup({
    taskId: id,
    generation: taskResourceGeneration(before),
    fingerprint: "fp-both-trees",
    token: "tok",
    now: NOW + RETENTION_WINDOW_MS,
  });
  assert.equal(claimed.claimed, true);
  deferTaskWorktreeCleanup({
    taskId: id,
    token: "tok",
    now: NOW + RETENTION_WINDOW_MS,
    retryAt: NOW + RETENTION_WINDOW_MS + RETENTION_RETRY_BASE_MS,
    error: "the tree could not be read after a partial release",
  });

  // The primary came back during that attempt; the attached tree did not.
  const after = { ...before, worktreePath: null, provider: null };
  registry.upsertTask(after);
  const observed = recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(after),
    fingerprint: "fp-attached-only",
    now: NOW + RETENTION_WINDOW_MS + DAY,
    retentionMs: RETENTION_WINDOW_MS,
  });
  assert.equal(observed.outcome, "retry-adopted");
  assert.equal(observed.row?.generation, taskResourceGeneration(after));
  assert.equal(observed.row?.fingerprint, "fp-attached-only");
  assert.equal(observed.row?.lastChangedAt, NOW, "the activity boundary did not move");
  assert.equal(observed.row?.cleanupDueAt, NOW + RETENTION_WINDOW_MS, "nor the deadline");

  // Genuinely new work still outranks the retry: a changed fingerprint on the SAME generation
  // clears the retry state outright and starts a whole new window.
  const worked = recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(after),
    fingerprint: "fp-somebody-came-back-to-it",
    now: NOW + RETENTION_WINDOW_MS + 2 * DAY,
    retentionMs: RETENTION_WINDOW_MS,
  });
  assert.equal(worked.outcome, "changed");
  assert.equal(worked.row?.cleanupState, "observing");
  assert.equal(worked.row?.retryAt, null);
  assert.equal(worked.row?.cleanupDueAt, NOW + RETENTION_WINDOW_MS + 2 * DAY + RETENTION_WINDOW_MS);
});

test("an ordinary row still treats a moved generation as a replacement", () => {
  // The counterpart to the adoption above: without a failed cleanup behind it, a generation
  // that moved describes resources nobody has observed, and those DO get the conservative
  // full window - that is the rollout rule, not a loophole.
  const id = uid("replaced");
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const before = baseTask({ id, status: "done", dispatchedAt: 1, worktreePath: "/pool/before" });
  registry.upsertTask(before);
  recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(before),
    fingerprint: "fp-before",
    now: NOW,
    retentionMs: RETENTION_WINDOW_MS,
  });
  const replaced = { ...before, worktreePath: "/pool/after", dispatchedAt: 2 };
  registry.upsertTask(replaced);
  const external = recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(replaced),
    fingerprint: "fp-after",
    now: NOW + DAY,
    retentionMs: RETENTION_WINDOW_MS,
  });
  assert.equal(external.outcome, "replaced");
  assert.equal(external.row?.lastChangedAt, NOW + DAY);
  assert.equal(external.row?.cleanupDueAt, NOW + DAY + RETENTION_WINDOW_MS);
});

test("a settlement whose task moved under it writes neither half", () => {
  const id = uid("cas");
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const task = baseTask({
    id,
    status: "done",
    dispatchedAt: 1,
    worktreePath: "/pool/cas",
    sessionId: "proc:gone",
  });
  registry.upsertTask(task);
  recordTaskWorktreeObservation({
    taskId: id,
    generation: taskResourceGeneration(task),
    fingerprint: "fp-cas",
    now: NOW,
    retentionMs: RETENTION_WINDOW_MS,
  });

  // A reschedule landed while the terminal probe was in flight: the frozen generation no
  // longer describes the task, so neither the task update nor the ledger adoption may apply.
  registry.upsertTask({ ...task, worktreePath: "/pool/cas-replacement", dispatchedAt: 2 });
  const refused = settleTaskWithRetentionAdoption({
    settled: { ...task, status: "failed", sessionId: null },
    expectedStatus: "done",
    expectedGeneration: taskResourceGeneration(task),
    now: NOW + 1,
  });
  assert.deepEqual(refused, { committed: false, adopted: false, displaced: [] });
  assert.equal(getTask(id)?.worktreePath, "/pool/cas-replacement", "the task was not rewritten");
  assert.equal(getTask(id)?.status, "done", "and not half-settled");
  assert.equal(getTaskWorktreeRetention(id)?.generation, taskResourceGeneration(task));
});

test("the summary projection survives a task list larger than SQLite's parameter ceiling", () => {
  // `listTasks` hands every task an install has ever filed to the projection at once. An
  // `IN (?, ?, …)` over that list would exceed SQLite's host-parameter limit and turn the
  // whole task list into an error - on the biggest, oldest installs first.
  const registry = new Registry();
  for (const stale of registry.listTasks()) registry.removeTask(stale.id);
  const ids: string[] = [];
  for (let index = 0; index < 1200; index += 1) {
    const id = `bulk-${index}`;
    ids.push(id);
    registry.upsertTask(baseTask({ id, status: "done", createdAt: index, updatedAt: index }));
  }
  assert.equal(taskAutomaticCleanupSummaries(ids).size, 0);
  assert.equal(listTasks().length >= 1200, true);
});

test("each successive failure waits twice as long, from the first one, capped at a day", () => {
  // The curve itself, stated as arithmetic. Every retry is another destructive attempt against
  // a provider that has already refused, so an interval that repeats before it doubles buys an
  // extra early one - which is exactly the shape a schedule derived from total overdue time
  // produced, and why the interval is measured between the row's own two endpoints instead.
  const HOUR = 60 * 60 * 1000;
  assert.equal(RETENTION_RETRY_BASE_MS, HOUR);

  // No prior retry: the first failure starts at the base.
  assert.equal(
    nextRetryDelayMs({ retryAt: null, lastAttemptAt: null }, RETENTION_RETRY_BASE_MS, RETENTION_RETRY_MAX_MS),
    HOUR,
  );

  // Then a true doubling, each step measured from the interval that just elapsed.
  let attemptAt = NOW;
  let retryAt: number | null = null;
  let lastAttemptAt: number | null = null;
  const granted: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    const delay = nextRetryDelayMs(
      { retryAt, lastAttemptAt },
      RETENTION_RETRY_BASE_MS,
      RETENTION_RETRY_MAX_MS,
    );
    granted.push(delay / HOUR);
    lastAttemptAt = attemptAt;
    retryAt = attemptAt + delay;
    attemptAt = retryAt;
  }
  assert.deepEqual(granted, [1, 2, 4, 8, 16, 24, 24, 24], "1h, 2h, 4h … capped at a day");

  // A daemon that came back late does not turn its own downtime into a backoff: recovery
  // resets both endpoints together, so the schedule restarts at the base.
  assert.equal(
    nextRetryDelayMs({ retryAt: NOW, lastAttemptAt: NOW }, RETENTION_RETRY_BASE_MS, RETENTION_RETRY_MAX_MS),
    HOUR,
  );
  // And a clock that moved backwards cannot produce a negative or zero wait.
  assert.equal(
    nextRetryDelayMs({ retryAt: NOW, lastAttemptAt: NOW + HOUR }, RETENTION_RETRY_BASE_MS, RETENTION_RETRY_MAX_MS),
    HOUR,
  );
});

test("a provider that keeps refusing is attempted on the doubling schedule, not sooner", async () => {
  // The same curve, driven through the real observer, the real claim and the real ledger, so
  // the row's endpoints are the ones production actually writes.
  const id = uid("backoff");
  const HOUR = 60 * 60 * 1000;
  const w = world({
    tasks: [baseTask({ id, status: "done", worktreePath: "/pool/backoff", dispatchedAt: 1 })],
    teardown: async () => { throw new Error("the provider is still refusing"); },
  });
  await ageToDue(w);

  const due = NOW + RETENTION_WINDOW_MS;
  const attempts: number[] = [];
  // Step the clock a minute at a time is far too slow; instead jump to each granted retry_at,
  // which is the earliest moment a pass could legitimately act.
  for (let round = 0; round < 4; round += 1) {
    const before = w.state.teardowns.length;
    await w.observer.runPass();
    assert.equal(w.state.teardowns.length, before + 1, `round ${round} attempted exactly once`);
    attempts.push(w.state.now);
    const row = getTaskWorktreeRetention(id)!;
    assert.equal(row.cleanupState, "retry");
    assert.equal(row.cleanupDueAt, due, "a failed cleanup never moves the deadline");
    // One minute before the granted retry, nothing may be attempted.
    w.state.now = row.retryAt! - 60_000;
    await w.observer.runPass();
    assert.equal(w.state.teardowns.length, before + 1, `round ${round} did not retry early`);
    w.state.now = row.retryAt!;
  }
  assert.deepEqual(
    attempts.map((at) => (at - due) / HOUR),
    [0, 1, 3, 7],
    "attempts at due, +1h, +3h, +7h - intervals of 1h, 2h, 4h",
  );
});
