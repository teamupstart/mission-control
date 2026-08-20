import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";
import type { ActivityFingerprint } from "../src/server/git/worktree-activity.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-retention-observer-"));
process.env.HARNESS_HOME = home;
const { upsertTask, getTaskWorktreeRetention, listTaskWorktreeRetention, recordTaskWorktreeObservation, deleteTaskWorktreeRetention, listOrphanedTaskWorktreeRetentionIds, getTask } =
  await import("../src/server/db.ts");
const {
  TaskWorktreeRetentionObserver,
  taskResourceGeneration,
  isRetentionCandidate,
  RETENTION_WINDOW_MS,
  RETENTION_OBSERVE_INTERVAL_MS,
} = await import("../src/server/task-worktree-retention.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const mkT = (over: Partial<Task> = {}): Task =>
  baseTask({ status: "done", worktreePath: "/wt/a", dispatchedAt: 1, ...over });

const attached = (worktreePath: string | null) => ({
  repoRoot: "/other",
  worktreePath,
  branch: "b",
  provider: "git" as const,
  worktreeLeaseId: null,
  baseSha: null,
  prUrl: null,
  prState: null,
  mergedAt: null,
});

/** A harness whose clock, task set and probe answers are all under the test's control. */
function harness(options: {
  tasks: Task[];
  probe?: (task: Task) => Promise<ActivityFingerprint>;
  concurrency?: number;
} = { tasks: [] }) {
  const state = {
    now: NOW,
    tasks: options.tasks,
    fingerprints: new Map<string, string>(),
    probes: [] as string[],
    inFlight: 0,
    peakInFlight: 0,
    scheduled: [] as Array<{ fn: () => void; ms: number }>,
  };
  for (const task of options.tasks) {
    upsertTask(task);
    state.fingerprints.set(task.id, `fp-${task.id}`);
  }
  const observer = new TaskWorktreeRetentionObserver({
    listTasks: () => state.tasks,
    reloadTask: getTask,
    probe: options.probe
      ?? (async (task) => {
        state.probes.push(task.id);
        state.inFlight += 1;
        state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        state.inFlight -= 1;
        const digest = state.fingerprints.get(task.id);
        return digest
          ? { kind: "known", digest }
          : { kind: "unknown", reason: "unreadable in this test" };
      }),
    record: recordTaskWorktreeObservation,
    listOrphans: listOrphanedTaskWorktreeRetentionIds,
    deleteRow: deleteTaskWorktreeRetention,
    now: () => state.now,
    intervalMs: RETENTION_OBSERVE_INTERVAL_MS,
    retentionMs: RETENTION_WINDOW_MS,
    concurrency: options.concurrency ?? 4,
    schedule: (fn, ms) => {
      state.scheduled.push({ fn, ms });
      return () => {};
    },
  });
  return { observer, state };
}

test("the first pass seeds a full window for every terminal task holding a tree", async () => {
  const { observer } = harness({
    tasks: [
      mkT({ id: "o-done", status: "done" }),
      mkT({ id: "o-failed", status: "failed" }),
      mkT({ id: "o-cancelled", status: "cancelled" }),
    ],
  });
  const result = await observer.runPass();
  assert.equal(result.observed, 3);
  assert.equal(result.outcomes["seeded"], 3);
  for (const id of ["o-done", "o-failed", "o-cancelled"]) {
    const row = getTaskWorktreeRetention(id);
    assert.equal(row?.lastChangedAt, NOW, `${id} started its window at the first observation`);
    assert.equal(row?.cleanupDueAt, NOW + RETENTION_WINDOW_MS);
  }
  // No claim state is reachable from a pass. This is the zero-cleanup boundary, checked after
  // the observer has actually run rather than only in the store's own tests.
  for (const row of listTaskWorktreeRetention()) assert.equal(row.cleanupState, "observing");
});

test("running, dispatching and backlog tasks are never candidates", async () => {
  const live = [
    mkT({ id: "o-running", status: "running" }),
    mkT({ id: "o-dispatching", status: "dispatching" }),
    mkT({ id: "o-backlog", status: "backlog" }),
  ];
  for (const task of live) assert.equal(isRetentionCandidate(task), false);
  const { observer } = harness({ tasks: live });
  const result = await observer.runPass();
  assert.equal(result.observed, 0);
  for (const task of live) assert.equal(getTaskWorktreeRetention(task.id), null);
});

test("a terminal task with no tree left is not a candidate, tree or home", async () => {
  assert.equal(isRetentionCandidate(mkT({ id: "x", worktreePath: null })), false);
  // A terminal HOME is a resource, but it is not a checkout - there is no Git state to observe,
  // so the retention clock has nothing to run on.
  assert.equal(
    isRetentionCandidate(mkT({ id: "x", worktreePath: null, homeName: "home-x" })),
    false,
  );
  assert.equal(
    isRetentionCandidate(mkT({ id: "x", worktreePath: null, extraRepos: [attached("/wt/b")] })),
    true,
    "an attached-only survivor of a partial teardown still has a tree to observe",
  );
});

test("an unchanged tree keeps its boundary; a changed one resets it", async () => {
  const { observer, state } = harness({ tasks: [mkT({ id: "o-clock" })] });
  await observer.runPass();
  const seeded = getTaskWorktreeRetention("o-clock");

  state.now = NOW + 10 * DAY;
  await observer.runPass();
  assert.equal(getTaskWorktreeRetention("o-clock")?.cleanupDueAt, seeded?.cleanupDueAt);

  const day29 = NOW + 29 * DAY;
  state.now = day29;
  state.fingerprints.set("o-clock", "fp-edited");
  await observer.runPass();
  assert.equal(getTaskWorktreeRetention("o-clock")?.lastChangedAt, day29);
  assert.equal(getTaskWorktreeRetention("o-clock")?.cleanupDueAt, day29 + RETENTION_WINDOW_MS);
});

test("an unreadable tree never ages and never fabricates a boundary", async () => {
  const { observer, state } = harness({ tasks: [mkT({ id: "o-unknown" })] });
  // Unknown BEFORE anything was ever observed: no row may appear at all.
  state.fingerprints.delete("o-unknown");
  await observer.runPass();
  assert.equal(getTaskWorktreeRetention("o-unknown"), null);

  // Now a real observation, then an unknown one on top of it.
  state.fingerprints.set("o-unknown", "fp-real");
  await observer.runPass();
  const seeded = getTaskWorktreeRetention("o-unknown");
  state.now = NOW + 20 * DAY;
  state.fingerprints.delete("o-unknown");
  await observer.runPass();
  const after = getTaskWorktreeRetention("o-unknown");
  assert.equal(after?.cleanupDueAt, seeded?.cleanupDueAt, "an unknown read is not quiet");
  assert.equal(after?.observedAt, seeded?.observedAt);
  assert.ok(after?.lastError, "but it is recorded, so a stuck probe is diagnosable");
});

test("a probe that throws is an unknown read, not a crashed pass", async () => {
  const { observer } = harness({
    tasks: [mkT({ id: "o-throws" })],
    probe: async () => {
      throw new Error("git exploded");
    },
  });
  const result = await observer.runPass();
  assert.equal(result.observed, 1);
  assert.equal(getTaskWorktreeRetention("o-throws"), null);
});

test("a re-dispatch during the probe abandons the observation instead of retargeting it", async () => {
  // The race the generation exists for: the pass hashes the OLD tree, and while it is doing so
  // the task is re-dispatched onto a new one. Writing that fingerprint would hand a brand new
  // checkout an age it never lived - which, one phase from now, is a deletion.
  const task = mkT({ id: "o-race", worktreePath: "/wt/old", dispatchedAt: 1 });
  const { observer } = harness({
    tasks: [task],
    probe: async () => {
      upsertTask({ ...task, worktreePath: "/wt/new", dispatchedAt: 2 });
      return { kind: "known", digest: "fp-old-tree" };
    },
  });
  await observer.runPass();
  assert.equal(getTaskWorktreeRetention("o-race"), null, "no row was written for the stale read");

  // The next pass, reading the replacement, seeds it normally and from now.
  const fresh = { ...task, worktreePath: "/wt/new", dispatchedAt: 2 };
  const second = harness({ tasks: [fresh] });
  await second.observer.runPass();
  const row = getTaskWorktreeRetention("o-race");
  assert.equal(row?.generation, taskResourceGeneration(fresh));
  assert.equal(row?.lastChangedAt, NOW);
});

test("a re-dispatch between the observer's check and the write is refused by the writer", async () => {
  // The narrower race: the observer re-read the task and the generation still matched, and the
  // task was replaced before the ledger write landed. The observer's own check cannot see that
  // - so the writer re-derives the generation inside its own transaction and refuses. This
  // drives the REAL `recordTaskWorktreeObservation`, with the re-dispatch injected in the only
  // window that exists between the two.
  const task = mkT({ id: "o-write-race", worktreePath: "/wt/before", dispatchedAt: 1 });
  upsertTask(task);
  // Swap the task out at the last possible moment, exactly as a re-dispatch would.
  const raced = new TaskWorktreeRetentionObserver({
    listTasks: () => [task],
    reloadTask: getTask,
    probe: async () => ({ kind: "known", digest: "fp-old-tree" }),
    record: (input) => {
      upsertTask({ ...task, worktreePath: "/wt/after", dispatchedAt: 2 });
      return recordTaskWorktreeObservation(input);
    },
    listOrphans: listOrphanedTaskWorktreeRetentionIds,
    deleteRow: deleteTaskWorktreeRetention,
    now: () => NOW,
    intervalMs: RETENTION_OBSERVE_INTERVAL_MS,
    retentionMs: RETENTION_WINDOW_MS,
    concurrency: 1,
    schedule: () => () => {},
  });
  const result = await raced.runPass();
  assert.equal(result.outcomes["generation-moved"], 1, "the write was refused, not applied");
  assert.equal(
    getTaskWorktreeRetention("o-write-race"),
    null,
    "no clock was seeded for a tree the task no longer owns",
  );
});

test("the generation moves for every cleanup-relevant fact and for none of the bookkeeping", () => {
  const base = mkT({
    id: "o-gen",
    worktreePath: "/wt/a",
    provider: "mission",
    worktreeLeaseId: "lease-1",
    homeName: "home-1",
    terminalResourceId: "res-1",
    sessionId: "sess-1",
    extraRepos: [attached("/wt/b")],
  });
  const g = taskResourceGeneration(base);
  const moves: Array<[string, Partial<Task>]> = [
    ["a re-dispatch", { dispatchedAt: 99 }],
    ["a replaced primary path", { worktreePath: "/wt/other" }],
    ["a replaced native lease", { worktreeLeaseId: "lease-2" }],
    ["a changed provider", { provider: "git" }],
    ["a released terminal home", { homeName: null }],
    ["a cleared terminal resource", { terminalResourceId: null }],
    ["a cleared session binding", { sessionId: null }],
    ["a partially released attached tree", { extraRepos: [attached(null)] }],
    ["a second repository attached", { extraRepos: [attached("/wt/b"), attached("/wt/c")] }],
  ];
  for (const [what, over] of moves) {
    assert.notEqual(taskResourceGeneration(mkT({ ...base, ...over })), g, `${what} is a new generation`);
  }
  const stays: Array<[string, Partial<Task>]> = [
    ["a title edit", { title: "renamed" }],
    ["an outcome recorded", { outcome: "shipped", outcomeUrl: "https://example.test/pr/1" }],
    ["pull request polling", { updatedAt: 999_999 }],
    ["a label change", { labels: ["urgent"] }],
    ["a status change within terminal states", { status: "failed" }],
  ];
  for (const [what, over] of stays) {
    assert.equal(taskResourceGeneration(mkT({ ...base, ...over })), g, `${what} is not new work`);
  }
});

test("rows for tasks that stopped qualifying are pruned", async () => {
  const task = mkT({ id: "o-prune" });
  const { observer, state } = harness({ tasks: [task] });
  await observer.runPass();
  assert.ok(getTaskWorktreeRetention("o-prune"));

  // Rescheduled back into the backlog: no longer terminal, so its clock is dropped. A later
  // re-dispatch is a new generation and gets a full fresh window rather than resuming this one.
  upsertTask({ ...task, status: "backlog" });
  state.tasks = [];
  const result = await observer.runPass();
  assert.equal(result.pruned, 1);
  assert.equal(getTaskWorktreeRetention("o-prune"), null);
});

test("the deadline survives a restart - a fresh observer resumes the same boundary", async () => {
  const task = mkT({ id: "o-restart" });
  const first = harness({ tasks: [task] });
  await first.observer.runPass();
  const seeded = getTaskWorktreeRetention("o-restart");

  // A completely new observer, as a restarted daemon builds. The ledger, not memory, is the
  // clock: an unchanged tree observed 20 days later still expires on the original day 30.
  const second = harness({ tasks: [task] });
  second.state.now = NOW + 20 * DAY;
  await second.observer.runPass();
  const after = getTaskWorktreeRetention("o-restart");
  assert.equal(after?.cleanupDueAt, seeded?.cleanupDueAt);
  assert.equal(after?.lastChangedAt, seeded?.lastChangedAt);
  assert.equal(after?.observedAt, NOW + 20 * DAY);
});

test("probes are bounded and passes never overlap", async () => {
  const tasks = Array.from({ length: 12 }, (_, i) => mkT({ id: `o-many-${i}` }));
  const { observer, state } = harness({ tasks, concurrency: 3 });
  await observer.runPass();
  assert.equal(state.peakInFlight <= 3, true, `peak concurrency was ${state.peakInFlight}`);
  assert.equal(state.probes.length, 12, "every candidate was still observed");

  // Overlap: `start()` runs one pass and only schedules the next from its COMPLETION, so at no
  // point are two passes hashing the same trees. The successor appearing on the schedule is
  // therefore also the signal that the first pass finished.
  state.probes.length = 0;
  observer.start();
  while (state.scheduled.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(state.probes.length, 12, "exactly one pass ran");
  assert.equal(state.scheduled.length, 1, "the successor is scheduled, never stacked");
  assert.equal(state.scheduled[0]?.ms, RETENTION_OBSERVE_INTERVAL_MS);
  await observer.stop();
});

test("stop() ends the pass and start() after it is inert", async () => {
  const { observer, state } = harness({ tasks: [mkT({ id: "o-stop" })] });
  await observer.stop();
  observer.start();
  assert.equal(state.probes.length, 0, "a stopped observer does not begin observing");
});

test("the observer has no destructive capability, by construction and by import", () => {
  // The Phase 1 invariant, pinned at the source. A cleanup path reaching this module - by
  // import, by dependency, or by a helpfully added convenience - is the one change this phase
  // must not ship, and it would not otherwise fail any behavioural test here.
  const source = readFileSync(
    new URL("../src/server/task-worktree-retention.ts", import.meta.url),
    "utf8",
  );
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "reclaim",
    "teardownWorktree",
    "TaskManager",
    "WorktreeManager",
    "worktree remove",
    "releaseLease",
    "rmSync",
    "stopTerminal",
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `the observer must not reference ${forbidden} - Phase 1 reclaims nothing`,
    );
  }
  // And the interval is its own, so quietening native pool maintenance cannot freeze the clock.
  assert.ok(!code.includes("WORKTREE_SWEEP_MS"));
  assert.ok(RETENTION_OBSERVE_INTERVAL_MS < RETENTION_WINDOW_MS / 10);
});
