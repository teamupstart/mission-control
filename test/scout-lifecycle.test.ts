import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import {
  ARCHIVE_PRIMARY_REPORT_PATH,
} from "../src/shared/archives.ts";
import {
  SCOUT_REPORT_PATH_SHAPE,
} from "../src/shared/scouts.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import { validReportHtml } from "./helpers/archive-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { TaskArchiveGate } from "../src/server/tasks.ts";
import type { ArchiveSubject } from "../src/server/archives/task-gateway.ts";

/**
 * Where the archive meets the task lifecycle.
 *
 * The invariant under test is one sentence: a scout's evidence must be durable before
 * anything that could destroy it happens, and nothing that destroys it may run without
 * asking first. That splits into two obligations with opposite failure modes -
 *
 *  - completion must WAIT (a `done` scout with no archive is a lost answer that reads as a
 *    delivered one), and
 *  - cleanup must ASK (a reclaimed worktree takes an unarchived report with it, silently).
 *
 * Both are exercised through the real `TaskManager` against a real archive manager writing
 * real bundles into a real library, because every interesting failure here is an ordering
 * failure between two subsystems and a stubbed one proves only that the stub was called.
 */

const home = mkdtempSync(join(tmpdir(), "mission-scout-lifecycle-"));
process.env.MISSION_HOME = home;
process.env.HARNESS_HOME = home;
// These tests fake agent shutdown and exercise real archive/worktree cleanup. Do not let an
// optional operator Herdr installation turn that boundary into a live server dependency.
process.env.HERDR_BIN = join(home, "missing-herdr");

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager, ScoutArchiveNotReadyError, TaskStatusConflictError } = await import("../src/server/tasks.ts");
const { ArchiveManager } = await import("../src/server/archives/manager.ts");
const { RegistryArchiveTaskGateway } = await import("../src/server/archives/task-gateway.ts");
const { collectScoutPromptTrail } = await import("../src/server/scouts/prompt-collector.ts");
const { ArchiveCaptureStore, clearArchiveCaptureJobs } = await import("../src/server/archives/capture-store.ts");
const { clearArchiveTables } = await import("../src/server/archives/store.ts");
const { openDb } = await import("../src/server/db.ts");

const db = openDb();
after(() => {
  delete process.env.HERDR_BIN;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  clearArchiveCaptureJobs(db);
  clearArchiveTables(db);
});

let seq = 0;

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A real git worktree cut from a real repository.
 *
 * Real on both counts on purpose: containment and ignore rules are filesystem facts, and
 * `reclaim` really does run `git worktree remove --force` - which is exactly the destruction
 * the archive guard exists to get in front of, and which refuses to run against a main
 * working tree. A fake path would make the cleanup tests assert nothing about cleanup.
 */
function makeWorktree(files: Record<string, string> = {}): { repoRoot: string; worktreePath: string } {
  const n = ++seq;
  const repoRoot = mkdirp(join(home, `repo-${n}`));
  const git = (...args: string[]): void => {
    execFileSync("git", args, {
      cwd: repoRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    });
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const worktreePath = join(home, `worktree-${n}`);
  git("worktree", "add", "-q", "-b", `harness/scout-${n}`, worktreePath);
  for (const [relative, contents] of Object.entries(files)) {
    mkdirp(join(worktreePath, relative.split("/").slice(0, -1).join("/") || "."));
    writeFileSync(join(worktreePath, relative), contents);
  }
  return { repoRoot, worktreePath };
}

interface Harness {
  registry: InstanceType<typeof Registry>;
  tasks: InstanceType<typeof TaskManager>;
  scouts: InstanceType<typeof ArchiveManager>;
  library: string;
}

function harness(options: {
  afterSubmissionAttribution?: (subject: ArchiveSubject) => Promise<void>;
  promptCollector?: typeof collectScoutPromptTrail;
} = {}): Harness {
  const registry = new Registry();
  const library = mkdirp(join(home, `library-${++seq}`));
  const { promptCollector, ...managerOptions } = options;
  const scouts = new ArchiveManager({
    root: library,
    tasks: new RegistryArchiveTaskGateway(registry, promptCollector),
    intervalMs: null,
    watch: false,
    log: () => {},
    ...managerOptions,
  });
  registry.onSessionExit((session) => scouts.reserveOnExit(session));
  const tasks = new TaskManager(registry, undefined, undefined, undefined, scouts);
  return { registry, tasks, scouts, library };
}

function mkScout(over: Partial<Task> = {}): Task {
  return baseTask({
    id: `scout-${++seq}`,
    kind: "scout",
    title: "Why did resume lose permissions?",
    intent: "Find out why a resumed agent lost repository permissions.",
    status: "running",
    ...over,
  });
}

/**
 * A live session standing in the task's checkout.
 *
 * Registered once per checkout, because the signed authority is accepted only while its task is
 * bound to one live session in that exact checkout.
 */
const sessions = new Map<string, Session>();
function bindSession(h: Harness, task: Task, cwd: string): Session {
  const existing = sessions.get(cwd);
  const session: Session =
    existing ??
    ({
      ...({} as Session),
      id: `sess-${++seq}`,
      agent: "claude",
      runtime: "terminal",
      origin: "dispatch",
      name: "agent",
      state: "idle",
      terminals: [],
      cwd,
      repoRoot: cwd,
      instrumented: true,
      pendingReviews: 0,
      meta: null,
    } as Session);
  sessions.set(cwd, session);
  (h.registry as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
  h.registry.upsertTask({ ...task, sessionId: session.id });
  return session;
}

async function submit(
  h: Harness,
  task: Task,
  cwd: string,
  body: { reportPath: string; summary?: string; supporting?: Array<{ repoSlot: string; path: string }> },
) {
  // The route verifies a signed checkout credential before it reaches this manager; the
  // gateway then confirms that authority still names this task's live session and checkout.
  bindSession(h, task, cwd);
  return h.scouts.submit({
    authority: { taskId: task.id, cwd },
    submission: {
      reportPath: body.reportPath,
      summary: body.summary ?? "Resume rebuilt the session without replaying the grant.",
      tags: [],
      supporting: body.supporting ?? [],
    },
  });
}

function pauseCompletionGate(delegate: TaskArchiveGate): {
  gate: TaskArchiveGate;
  entered: Promise<void>;
  release: () => void;
} {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    gate: {
      ensureReady: async (taskId) => {
        entered();
        await paused;
        return delegate.ensureReady(taskId);
      },
      settleBeforeCleanup: (taskId) => delegate.settleBeforeCleanup(taskId),
    },
    entered: waiting,
    release,
  };
}

function discoveredSession(id: string, cwd: string, repoRoot: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd,
    gitBranch: "harness/scout-episode",
    gitRoot: repoRoot,
    repoRoot,
    pid: ++seq,
    tty: null,
    terminals: [],
    startedAt: 0,
  };
}

function beginEpisode(
  h: Harness,
  task: Task,
  cwd: string,
  repoRoot: string,
  sessionId: string,
  agentSessionId: string,
): string {
  h.registry.applyDiscovery([discoveredSession(sessionId, cwd, repoRoot)]);
  h.registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd,
    transcriptPath: null,
    env: {},
  });
  h.registry.upsertTask({ ...task, status: "running", sessionId });
  h.registry.bindTaskToWorkEpisode(task.id, sessionId);
  return h.registry.workEpisodeForTask(task.id)!.episodeId;
}

// ---------------------------------------------------------------------------
// Completion waits for the archive
// ---------------------------------------------------------------------------

test("a scout cannot be marked done before it has submitted a report", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree();
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);

  await assert.rejects(
    () => h.tasks.complete(task.id, "found it"),
    (error: unknown) => {
      assert.ok(error instanceof ScoutArchiveNotReadyError);
      assert.match(error.message, new RegExp(escape(SCOUT_REPORT_PATH_SHAPE)));
      assert.match(error.message, /submit_scout_artifacts/);
      return true;
    },
  );
  // Nonterminal, with everything it holds intact, so the agent can still fix it.
  const after = h.registry.getTask(task.id)!;
  assert.equal(after.status, "running");
  assert.equal(after.worktreePath, cwd);
  assert.equal(after.outcome, null);
});

test("a scout can be marked done after explicitly confirming the missing report", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree();
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);

  const done = await h.tasks.complete(
    task.id,
    "closed without a report",
    undefined,
    false,
    false,
    true,
  );

  assert.equal(done?.status, "done");
  assert.equal(done?.outcome, "closed without a report");
  assert.equal(done?.worktreePath, cwd, "completion still does not reclaim the checkout");
  assert.equal(
    h.scouts.captureJobsForTask(task.id).length,
    0,
    "confirmation does not invent an archive",
  );
});

test("a scout becomes done once its archive is published and verified", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);

  const submitted = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));

  const done = await h.tasks.complete(task.id, "resume never replayed the grant");
  assert.equal(done?.status, "done");
  assert.equal(h.registry.getTask(task.id)?.outcome, "resume never replayed the grant");

  // And the archive is readable through the Phase 1 API. Indexing is deliberately NOT part of
  // readiness - the bundle is durable before the row exists - so the pass is awaited here
  // rather than assumed to have happened.
  await h.scouts.reconcileNow();
  const page = h.scouts.list({
    q: null, producer: null, repo: null, agent: null, kind: null, status: null,
    from: null, to: null, cursor: null, limit: 10,
  });
  assert.equal(page.archives.length, 1);
  assert.equal(page.archives[0]!.status, "ready");
  assert.equal(page.archives[0]!.title, "agent");
});

test("completion rebuilds a deleted bundle instead of trusting its cached ready row", async () => {
  const h = harness();
  const report = validReportHtml();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": report,
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  assert.equal(
    (await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" })).ok,
    true,
  );
  await h.scouts.reconcileNow();
  const job = h.scouts.captureJobsForTask(task.id)[0]!;
  const attempts = job.attempts;
  rmSync(join(h.library, job.producerId, job.archiveId), { recursive: true, force: true });

  assert.equal((await h.tasks.complete(task.id, "found it"))?.status, "done");
  assert.ok(h.scouts.captureJobsForTask(task.id)[0]!.attempts > attempts);
  assert.equal(
    readFileSync(join(h.library, job.producerId, job.archiveId, ARCHIVE_PRIMARY_REPORT_PATH), "utf8"),
    report,
  );
});

test("completion refuses a corrupt bundle even when its cached index row is ready", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  assert.equal(
    (await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" })).ok,
    true,
  );
  await h.scouts.reconcileNow();
  const job = h.scouts.captureJobsForTask(task.id)[0]!;
  writeFileSync(
    join(h.library, job.producerId, job.archiveId, ARCHIVE_PRIMARY_REPORT_PATH),
    "tampered after indexing",
  );

  await assert.rejects(
    () => h.tasks.complete(task.id, "found it"),
    (error: unknown) => {
      assert.ok(error instanceof ScoutArchiveNotReadyError);
      assert.match(error.message, /archive already exists/);
      return true;
    },
  );
  assert.equal(h.registry.getTask(task.id)?.status, "running");
});

test("an invalid report leaves the task and its checkout available for a correction", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": "<!doctype html><html><body><script>go()</script></body></html>",
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);

  const refused = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(refused.ok, false);

  await assert.rejects(() => h.tasks.complete(task.id, "found it"), ScoutArchiveNotReadyError);
  assert.equal(h.registry.getTask(task.id)?.status, "running");

  // The scout fixes the page and resubmits against the SAME operation, which supersedes the
  // failed staging rather than opening a second archive.
  writeFileSync(join(cwd, "docs/reports/resume/report.html"), validReportHtml());
  const fixed = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal((await h.tasks.complete(task.id, "found it"))?.status, "done");
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 1, "one episode, one archive");
});

test("a ship task's completion is untouched by any of this", async () => {
  const h = harness();
  const task = baseTask({ id: `ship-${++seq}`, kind: "ship", status: "running" });
  h.registry.upsertTask(task);
  const done = await h.tasks.complete(task.id, "shipped", "https://example/pr/1", true);
  assert.equal(done?.status, "done");
  assert.equal(done?.outcomeUrl, "https://example/pr/1");
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 0, "no archive work at all");
});

test("two completion signals for one scout publish exactly one archive", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });

  const [a, b] = await Promise.all([
    h.tasks.complete(task.id, "first"),
    h.tasks.complete(task.id, "second"),
  ]);
  assert.equal(a?.status, "done");
  assert.equal(b?.status, "done");
  const jobs = h.scouts.captureJobsForTask(task.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.status, "published");
});

test("completion cannot overwrite a cancellation that finishes during archive verification", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  assert.equal(
    (await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" })).ok,
    true,
  );

  const pause = pauseCompletionGate(h.scouts);
  const racingTasks = new TaskManager(h.registry, undefined, undefined, undefined, pause.gate);
  const completion = racingTasks.complete(task.id, "found it");
  await pause.entered;
  assert.equal((await racingTasks.cancel(task.id)).ok, true);
  pause.release();

  await assert.rejects(completion, TaskStatusConflictError);
  assert.equal(h.registry.getTask(task.id)?.status, "cancelled");
  assert.equal(h.registry.getTask(task.id)?.worktreePath, null);
});

test("completion cannot restore resources released by a concurrent reclaim", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  assert.equal(
    (await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" })).ok,
    true,
  );

  const pause = pauseCompletionGate(h.scouts);
  const racingTasks = new TaskManager(h.registry, undefined, undefined, undefined, pause.gate);
  const completion = racingTasks.complete(task.id, "found it");
  await pause.entered;
  assert.equal((await racingTasks.reclaim(task.id)).ok, true);
  pause.release();

  await assert.rejects(completion, TaskStatusConflictError);
  assert.equal(h.registry.getTask(task.id)?.status, "running");
  assert.equal(h.registry.getTask(task.id)?.worktreePath, null);
});

test("a rescheduled scout cannot complete from its superseded episode's archive", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  const sessionId = `episode-session-${++seq}`;
  const oldEpisode = beginEpisode(h, task, cwd, repoRoot, sessionId, `episode-old-${seq}`);
  const oldSubmission = await h.scouts.submit({
    authority: { taskId: task.id, cwd },
    submission: {
      reportPath: "docs/reports/resume/report.html",
      summary: "the first attempt's answer",
      tags: [],
      supporting: [],
    },
  });
  assert.equal(oldSubmission.ok, true, JSON.stringify(oldSubmission));

  const current = h.registry.getTask(task.id)!;
  h.registry.upsertTask({ ...current, status: "cancelled" });
  h.registry.upsertTask({ ...current, status: "backlog", sessionId: null });
  const newEpisode = beginEpisode(
    h,
    h.registry.getTask(task.id)!,
    cwd,
    repoRoot,
    sessionId,
    `episode-new-${seq}`,
  );
  assert.notEqual(newEpisode, oldEpisode);

  await assert.rejects(() => h.tasks.complete(task.id, "found it"), ScoutArchiveNotReadyError);
  assert.equal(h.registry.getTask(task.id)?.status, "running");

  const newSubmission = await h.scouts.submit({
    authority: { taskId: task.id, cwd },
    submission: {
      reportPath: "docs/reports/resume/report.html",
      summary: "the current attempt's answer",
      tags: [],
      supporting: [],
    },
  });
  assert.equal(newSubmission.ok, true, JSON.stringify(newSubmission));
  assert.equal((await h.tasks.complete(task.id, "found it"))?.status, "done");
  assert.deepEqual(
    h.scouts.captureJobsForTask(task.id).map((job) => job.episodeId).sort(),
    [newEpisode, oldEpisode].sort(),
  );
});

// ---------------------------------------------------------------------------
// Cleanup asks first
// ---------------------------------------------------------------------------

test("reclaiming an unarchived scout publishes what it wrote before the tree goes", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
    "docs/reports/resume/evidence.csv": "a,b\n",
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null, status: "failed" });
  h.registry.upsertTask(task);

  const reclaimed = await h.tasks.reclaim(task.id);
  assert.equal(reclaimed.ok, true, reclaimed.error);
  const jobs = h.scouts.captureJobsForTask(task.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.status, "published");
  assert.equal(jobs[0]!.captureStatus, "complete", "the report it had written was recovered");
});

test("cancelling a scout that wrote nothing publishes an honest partial, never a claim", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "notes.md": "I thought about it" });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);

  await h.tasks.cancel(task.id);
  const jobs = h.scouts.captureJobsForTask(task.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.captureStatus, "partial");
  await h.scouts.reconcileNow();
  const page = h.scouts.list({
    q: null, producer: null, repo: null, agent: null, kind: null, status: null,
    from: null, to: null, cursor: null, limit: 10,
  });
  assert.equal(page.archives[0]!.status, "partial", "never presented as complete");
  assert.ok(page.archives[0]!.missingCount > 0);
});

test("cancelling a launched scout stops it before recovery scans the checkout", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree();
  const task = mkScout({
    worktreePath: cwd,
    repoRoot,
    provider: "git",
    branch: null,
    homeName: `launched-scout-${++seq}`,
  });
  h.registry.upsertTask(task);
  bindSession(h, task, cwd);
  let stopped = false;
  const controlled = new TaskManager(
    h.registry,
    {
      resetWouldDestroyWork: async () => null,
      kill: async () => {
        stopped = true;
        mkdirp(join(cwd, "docs/reports/resume"));
        writeFileSync(join(cwd, "docs/reports/resume/report.html"), validReportHtml());
        return { ok: true };
      },
    },
    undefined,
    undefined,
    h.scouts,
  );

  const cancelled = await controlled.cancel(task.id);
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(stopped, true);
  const job = h.scouts.captureJobsForTask(task.id)[0]!;
  assert.equal(job.status, "published");
  assert.equal(job.captureStatus, "complete", "capture ran after the stop wrote its final bytes");
});

test("terminal scout cleanup stops the agent before recovery scans the checkout", async () => {
  for (const action of ["reclaim", "reschedule", "remove"] as const) {
    const h = harness();
    const { repoRoot, worktreePath: cwd } = makeWorktree();
    const task = mkScout({
      worktreePath: cwd,
      repoRoot,
      provider: "git",
      branch: null,
      status: "failed",
      homeName: `${action}-launched-scout-${++seq}`,
    });
    h.registry.upsertTask(task);
    bindSession(h, task, cwd);
    let stopped = false;
    const controlled = new TaskManager(
      h.registry,
      {
        resetWouldDestroyWork: async () => null,
        kill: async () => {
          stopped = true;
          mkdirp(join(cwd, "docs/reports/resume"));
          writeFileSync(join(cwd, "docs/reports/resume/report.html"), validReportHtml());
          return { ok: true };
        },
      },
      undefined,
      undefined,
      h.scouts,
    );

    const result = await controlled[action](task.id);
    assert.equal(result.ok, true, `${action}: ${result.error ?? "cleanup failed"}`);
    assert.equal(stopped, true, `${action} must quiesce the launched agent`);
    const job = h.scouts.captureJobsForTask(task.id)[0]!;
    assert.equal(job.status, "published");
    assert.equal(job.captureStatus, "complete", `${action} captured bytes written at the stop boundary`);
  }
});

test("a capture failure refuses the cleanup and keeps the resources tracked", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null, status: "failed" });
  h.registry.upsertTask(task);
  // The one failure a retry can actually clear: the rename into the library.
  const failing = new ArchiveManager({
    root: h.library,
    tasks: new RegistryArchiveTaskGateway(h.registry),
    intervalMs: null,
    watch: false,
    log: () => {},
    rename: () => Promise.reject(new Error("the disk went away")),
  });
  const guarded = new TaskManager(h.registry, undefined, undefined, undefined, failing);

  const refused = await guarded.reclaim(task.id);
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /could not be published/);
  assert.match(refused.error ?? "", /the disk went away/);
  // The tree is still there and still recorded, so the operator can retry rather than
  // discovering afterwards that the report went with it.
  assert.equal(h.registry.getTask(task.id)?.worktreePath, cwd);
});

test("cleanup reserves the current episode when only a superseded episode was published", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  const sessionId = `cleanup-episode-session-${++seq}`;
  const oldEpisode = beginEpisode(h, task, cwd, repoRoot, sessionId, `cleanup-old-${seq}`);
  assert.equal(
    (await h.scouts.submit({
      authority: { taskId: task.id, cwd },
      submission: {
        reportPath: "docs/reports/resume/report.html",
        summary: "the superseded answer",
        tags: [],
        supporting: [],
      },
    })).ok,
    true,
  );

  const current = h.registry.getTask(task.id)!;
  h.registry.upsertTask({ ...current, status: "backlog", sessionId: null });
  const newEpisode = beginEpisode(
    h,
    h.registry.getTask(task.id)!,
    cwd,
    repoRoot,
    sessionId,
    `cleanup-new-${seq}`,
  );
  assert.notEqual(newEpisode, oldEpisode);

  assert.deepEqual(await h.scouts.settleBeforeCleanup(task.id), { ok: true });
  const jobs = h.scouts.captureJobsForTask(task.id);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((job) => job.episodeId === newEpisode)?.status, "published");
});

test("cleanup rebuilds a deleted current archive before releasing the checkout", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  assert.equal(
    (await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" })).ok,
    true,
  );
  const job = h.scouts.captureJobsForTask(task.id)[0]!;
  const attempts = job.attempts;
  rmSync(join(h.library, job.producerId, job.archiveId), { recursive: true, force: true });
  const current = h.registry.getTask(task.id)!;
  h.registry.upsertTask({ ...current, status: "failed" });

  const reclaimed = await h.tasks.reclaim(task.id);
  assert.equal(reclaimed.ok, true, reclaimed.error);
  const rebuilt = h.scouts.captureJobsForTask(task.id)[0]!;
  assert.ok(rebuilt.attempts > attempts, "the published ledger row was re-verified");
  await h.scouts.reconcileNow();
  assert.equal(
    h.scouts.list({
      q: null,
      producer: null,
      repo: null,
      agent: null,
      kind: null,
      status: null,
      from: null,
      to: null,
      cursor: null,
      limit: 10,
    }).archives[0]?.status,
    "ready",
  );
});

test("cleanup refuses a corrupt current archive and keeps the source checkout", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  assert.equal(
    (await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" })).ok,
    true,
  );
  const job = h.scouts.captureJobsForTask(task.id)[0]!;
  writeFileSync(
    join(h.library, job.producerId, job.archiveId, ARCHIVE_PRIMARY_REPORT_PATH),
    "tampered after publication",
  );
  const current = h.registry.getTask(task.id)!;
  h.registry.upsertTask({ ...current, status: "failed" });

  const reclaimed = await h.tasks.reclaim(task.id);
  assert.equal(reclaimed.ok, false);
  assert.match(reclaimed.error ?? "", /archive already exists/);
  assert.equal(h.registry.getTask(task.id)?.worktreePath, cwd);
});

test("removing a task never removes its archive", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  await h.tasks.complete(task.id, "found it");
  await h.scouts.reconcileNow();

  const removed = await h.tasks.remove(task.id);
  assert.equal(removed.ok, true, removed.error);
  assert.equal(h.registry.getTask(task.id), undefined);

  await h.scouts.reconcileNow();
  const page = h.scouts.list({
    q: null, producer: null, repo: null, agent: null, kind: null, status: null,
    from: null, to: null, cursor: null, limit: 10,
  });
  assert.equal(page.archives.length, 1, "the answer outlives the card that asked for it");
  assert.equal(page.archives[0]!.status, "ready");
});

test("a ship task's cleanup does no archive work at all", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = baseTask({ id: `ship-${++seq}`, kind: "ship", status: "failed", worktreePath: cwd, repoRoot: cwd });
  h.registry.upsertTask(task);
  assert.equal((await h.tasks.reclaim(task.id)).ok, true);
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 0);
});

// ---------------------------------------------------------------------------
// Unexpected exit
// ---------------------------------------------------------------------------

test("an exiting scout reserves its capture while its sources can still be derived", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  const session = bindSession(h, task, cwd);

  // Exactly what `beginEviction` does: emit with the session still addressable.
  h.registry.emit("session_exit", session);

  const jobs = h.scouts.captureJobsForTask(task.id);
  assert.equal(jobs.length, 1, "reserved synchronously, inside the listener");
  assert.equal(jobs[0]!.repos[0]!.root, cwd, "with server-derived source locators");
  assert.equal(jobs[0]!.submission, null, "and nothing the agent claimed");

  // The capture itself runs in the background, so it must be settled before asserting.
  await h.scouts.settleBeforeCleanup(task.id);
  const settled = h.scouts.captureJobsForTask(task.id)[0]!;
  assert.equal(settled.status, "published");
  assert.equal(settled.captureStatus, "complete");
});

test("an exit after a successful submission does not archive a second time", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  await h.tasks.complete(task.id, "found it");

  const session = bindSession(h, task, cwd);
  h.registry.emit("session_exit", session);
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 1, "the ordinary end of a scout");
});

test("exit recovery waits for a submission that already proved its session", async () => {
  let attributed!: () => void;
  let release!: () => void;
  const attributionReached = new Promise<void>((resolve) => {
    attributed = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    afterSubmissionAttribution: async () => {
      attributed();
      await paused;
    },
  });
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  const session = bindSession(h, task, cwd);

  const submitted = h.scouts.submit({
    authority: { taskId: task.id, cwd },
    submission: {
      reportPath: "docs/reports/resume/report.html",
      summary: "the completed answer",
      tags: [],
      supporting: [],
    },
  });
  await attributionReached;
  h.registry.emit("session_exit", session);

  const reserved = h.scouts.captureJobsForTask(task.id)[0]!;
  assert.equal(reserved.status, "reserved", "exit reserves synchronously but does not publish");
  assert.equal(reserved.submission, null, "the request is still paused before its durable record");

  release();
  const result = await submitted;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await h.scouts.settleBeforeCleanup(task.id), { ok: true });
  const published = h.scouts.captureJobsForTask(task.id)[0]!;
  assert.equal(published.status, "published");
  assert.equal(published.captureStatus, "complete");
  assert.equal(published.submission?.summary, "the completed answer");
});

test("a rescheduled scout exit reserves its current episode despite an older archive", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({
    "docs/reports/resume/report.html": validReportHtml(),
  });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  const sessionId = `exit-episode-session-${++seq}`;
  const oldEpisode = beginEpisode(h, task, cwd, repoRoot, sessionId, `exit-old-${seq}`);
  assert.equal(
    (await h.scouts.submit({
      authority: { taskId: task.id, cwd },
      submission: {
        reportPath: "docs/reports/resume/report.html",
        summary: "the superseded answer",
        tags: [],
        supporting: [],
      },
    })).ok,
    true,
  );

  const current = h.registry.getTask(task.id)!;
  h.registry.upsertTask({ ...current, status: "backlog", sessionId: null });
  const newEpisode = beginEpisode(
    h,
    h.registry.getTask(task.id)!,
    cwd,
    repoRoot,
    sessionId,
    `exit-new-${seq}`,
  );
  assert.notEqual(newEpisode, oldEpisode);

  h.registry.emit("session_exit", h.registry.getSession(sessionId)!);
  const jobs = h.scouts.captureJobsForTask(task.id);
  assert.equal(jobs.length, 2, "the current episode was reserved synchronously");
  assert.ok(jobs.some((job) => job.episodeId === newEpisode));
  assert.deepEqual(await h.scouts.settleBeforeCleanup(task.id), { ok: true });
  assert.equal(
    h.scouts.captureJobsForTask(task.id).find((job) => job.episodeId === newEpisode)?.status,
    "published",
  );
});

test("a session exit reserves nothing for a ship task", () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree();
  const task = baseTask({ id: `ship-${++seq}`, kind: "ship", status: "running", worktreePath: cwd, repoRoot: cwd });
  h.registry.upsertTask(task);
  h.registry.emit("session_exit", bindSession(h, task, cwd));
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 0);
});

// ---------------------------------------------------------------------------
// Attribution: the caller names nothing
// ---------------------------------------------------------------------------

test("a submission from a session running no scout is refused", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = baseTask({ id: `ship-${++seq}`, kind: "ship", status: "running", worktreePath: cwd, repoRoot: cwd });
  h.registry.upsertTask(task);
  const result = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal("status" in result ? result.status : null, 409);
  assert.match(result.problems.join(" "), /not a scout/);
});

test("a signed task authority is refused when its checkout does not match the live session", async () => {
  const h = harness();
  const first = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const second = makeWorktree();
  const task = mkScout({
    worktreePath: first.worktreePath,
    repoRoot: first.repoRoot,
    provider: "git",
    branch: null,
  });
  h.registry.upsertTask(task);
  bindSession(h, task, first.worktreePath);

  const result = await h.scouts.submit({
    authority: { taskId: task.id, cwd: second.worktreePath },
    submission: {
      reportPath: "docs/reports/resume/report.html",
      summary: "s",
      tags: [],
      supporting: [],
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal("status" in result ? result.status : null, 404);
  assert.match(result.problems.join(" "), /does not match this task's live session and checkout/);
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 0);
});

test("a submission with no live session is refused rather than attributed by guess", async () => {
  const h = harness();
  const task = mkScout({ sessionId: null });
  h.registry.upsertTask(task);
  const result = await h.scouts.submit({
    authority: { taskId: task.id, cwd: "/nowhere" },
    submission: { reportPath: "docs/reports/x/report.html", summary: "s", tags: [], supporting: [] },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal("status" in result ? result.status : null, 404);
});

test("a scout that already finished can no longer be archived against, and says why", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null, status: "done" });
  h.registry.upsertTask(task);
  const result = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal("status" in result ? result.status : null, 409);
  assert.match(result.problems.join(" "), /this scout is done/);
});

test("a replayed submission returns the same archive without recollecting its prompts", async () => {
  let promptCollections = 0;
  const h = harness({
    promptCollector: (...args) => {
      promptCollections += 1;
      return collectScoutPromptTrail(...args);
    },
  });
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);

  const first = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(promptCollections, 1, "the new reservation freezes its prompt trail once");
  await h.scouts.ensureReady(task.id);
  assert.equal(promptCollections, 1, "the completion gate only reads the frozen job");
  const second = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.replayed, true);
  assert.deepEqual(second.archive?.key, first.archive?.key);
  assert.equal(h.scouts.captureJobsForTask(task.id).length, 1);
  assert.equal(promptCollections, 1, "a replay does not walk the transcript again");
  assert.deepEqual(await h.scouts.settleBeforeCleanup(task.id), { ok: true });
  assert.equal(promptCollections, 1, "settling a published job does not walk the transcript");
});

test("the daemon derives the archive's identity - a submission carries none of it", async () => {
  const h = harness();
  const { repoRoot, worktreePath: cwd } = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const task = mkScout({ worktreePath: cwd, repoRoot, provider: "git", branch: null });
  h.registry.upsertTask(task);
  const result = await submit(h, task, cwd, { reportPath: "docs/reports/resume/report.html" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const job = h.scouts.captureJobsForTask(task.id)[0]!;
  assert.equal(job.producerId, h.scouts.producer.id, "this machine's namespace, not a claim");
  assert.match(job.archiveId, /^[0-9a-f-]{36}$/, "generated, never supplied");
  assert.equal(result.archive?.relativePath, `${job.producerId}/${job.archiveId}`);
  // And the portable record carries no local identity at all.
  await h.scouts.reconcileNow();
  const detail = h.scouts.detail(result.archive!.key);
  assert.ok(detail);
  const asText = JSON.stringify(detail);
  assert.ok(!asText.includes(task.id), "no task id reaches the portable record");
  assert.ok(!asText.includes(cwd), "and no absolute checkout path either");
});

// ---------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------

test("restart recovery waits only for a live scout with no durable submission", async () => {
  const h = harness();
  const store = new ArchiveCaptureStore(db);
  const gateway = new RegistryArchiveTaskGateway(h.registry);
  const reserve = (task: Task, cwd: string, live: boolean) => {
    h.registry.upsertTask(task);
    if (live) bindSession(h, task, cwd);
    const subject = gateway.subjectForTask(task.id, "scout");
    assert.ok(subject);
    return store.reserve({ ...subject, kind: "scout", producerId: h.scouts.producer.id });
  };

  // A scout still running: the daemon died between reserving and recording a submission, and
  // publishing a partial now would burn the archive id it is about to submit against.
  const pendingTree = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const pending = mkScout({
    worktreePath: pendingTree.worktreePath,
    repoRoot: pendingTree.repoRoot,
    status: "running",
  });
  const pendingJob = reserve(pending, pendingTree.worktreePath, true);

  // A crash after recordSubmission has durable inputs. Both a fresh submitted row and a
  // retryable failure must resume even though their scout tasks still expect an agent.
  const recoverable = [];
  for (const status of ["submitted", "failed"] as const) {
    const tree = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
    const task = mkScout({ worktreePath: tree.worktreePath, repoRoot: tree.repoRoot, status: "running" });
    const job = reserve(task, tree.worktreePath, true);
    const submitted = store.recordSubmission(job.operationKey, {
      reportPath: "docs/reports/resume/report.html",
      summary: `durable ${status} submission`,
      tags: [],
      supporting: [],
    })!;
    if (status === "failed") store.markFailed(submitted.operationKey, "daemon stopped during capture");
    recoverable.push({ task, operationKey: submitted.operationKey });
  }

  // A scout whose task is terminal: its agent is not coming back, so it is resumed.
  const goneTree = makeWorktree({ "docs/reports/resume/report.html": validReportHtml() });
  const gone = mkScout({ worktreePath: goneTree.worktreePath, repoRoot: goneTree.repoRoot, status: "failed" });
  const goneJob = reserve(gone, goneTree.worktreePath, false);

  await h.scouts.recoverJobs();
  assert.equal(store.get(pendingJob.operationKey)!.status, "reserved", "the live unsubmitted job waits");
  for (const item of recoverable) {
    const recovered = store.get(item.operationKey)!;
    assert.equal(recovered.status, "published", `${item.task.id} resumes its durable submission`);
    assert.equal(recovered.captureStatus, "complete");
  }
  assert.equal(store.get(goneJob.operationKey)!.status, "published", "the terminal reservation recovers");
});

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
