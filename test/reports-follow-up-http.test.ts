import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportItem } from "../src/shared/reports.ts";
import type { Session, Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import { seedGitRepo } from "./helpers/git-fixture.ts";
import { mkSession, mkTask, mkTaskSummary } from "./helpers/session-fixture.ts";

// `POST /api/reports/:id/follow-up`: Start a follow-up task, for a report whose agent is gone.
//
// What is at stake is the one guarantee a two-step route can break: a report has at most one
// follow-up task, however often the route is called and however its dispatch went. The task is
// created once, in the repository stored on the report (the session has been evicted, so nothing
// else knows it), and its id is recorded on the report with the task row. It is dispatched as a
// second step; only a dispatch that succeeds marks the report read, with `readBy` "follow-up". A
// failed dispatch leaves the report unread and naming its task, so Retry dispatches that task. The
// old session is never resumed: the follow-up is a new task.

const home = mkdtempSync(join(tmpdir(), "mission-reports-follow-up-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReportManager } = await import("../src/server/reports.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { openDb } = await import("../src/server/db.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));
flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
// A follow-up is filed like any dispatched task, so it takes the operator's after-work Workflow
// for its kind. These tests are about the task and its dispatch, so they configure none; the last
// test puts one back to show the default is honored.
const NO_WORKFLOWS = { kindWorkflowDefaults: { ship: null, bugfix: null, scout: null, document: null } };
setWorkflowPolicy(NO_WORKFLOWS);

let serial = 0;

function mkRepo(): string {
  const repo = join(home, `repo-${++serial}`);
  seedGitRepo(repo, { branch: "main", files: { "f.txt": "x\n" }, message: "first" });
  return realpathSync(repo);
}

function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const dispatched: string[] = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    dispatch: async (id: string) => {
      dispatched.push(id);
    },
  };
  // A switch for the dispatch step's answer, so a failed dispatch can be staged and then cleared.
  let failDispatch: string | null = null;
  const realDispatch = tasks.dispatch.bind(tasks);
  tasks.dispatch = (async (id, options) => (failDispatch ? { ok: false, error: failDispatch } : realDispatch(id, options))) as typeof tasks.dispatch;
  const reports = new ReportManager(registry);
  after(() => reports.stop());
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
    reports,
  });
  const followUp = async (id: string, text?: string, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/reports/${id}/follow-up`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...headers },
      body: JSON.stringify(text === undefined ? {} : { text }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** A follow-up whose body is exactly `raw`, which need not be JSON. */
  const followUpRaw = async (id: string, raw: string) => {
    const res = await app.request(`/api/reports/${id}/follow-up`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: raw,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  // Every test files its report in a repository of its own, so its follow-ups are the tasks there.
  let repoUnderTest: string | null = null;
  const followUpTasks = () => registry.listTasks().filter((task) => task.repoRoot === repoUnderTest && task.title.startsWith("Follow up:"));
  return {
    registry, tasks, reports, dispatched, followUp, followUpRaw, followUpTasks,
    inRepo: (repo: string) => { repoUnderTest = repo; return repo; },
    failDispatches: (error: string | null) => { failDispatch = error; },
  };
}

/**
 * A report posted by a session that is not in the registry: it has been evicted, so the only
 * record of its repository is the report's own.
 */
async function postFromGoneSession(
  f: ReturnType<typeof setup>,
  over: Partial<Session> = {},
  title = "Flaky test traced",
): Promise<ReportItem> {
  serial += 1;
  const gone = mkSession({ id: `gone-${serial}`, runtime: "sdk", terminals: [], task: null, ...over });
  assert.equal(f.registry.getSession(gone.id), undefined);
  return await f.reports.post(gone, { title, body: "It races the clock in the retry loop." });
}

test("a follow-up after the session was evicted is a new task in the stored repository, and clears the report", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  // The report's own task is still known: the follow-up keeps its harness and kind.
  f.registry.upsertTask(mkTask({ id: `orig-${serial}`, kind: "bugfix", agent: "claude", repoRoot: repo, status: "done" }));
  const report = await postFromGoneSession(f, { repoRoot: repo, task: mkTaskSummary({ id: `orig-${serial}` }) });
  assert.equal(report.repository, repo);

  const started = await f.followUp(report.id, "Fix the race and open a PR.");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const task = f.registry.getTask(String(started.body.taskId))!;
  assert.equal(task.repoRoot, repo);
  assert.equal(task.kind, "bugfix");
  assert.equal(task.agent, "claude");
  assert.equal(task.title, "Follow up: Flaky test traced");
  assert.ok(task.intent.startsWith("Fix the race and open a PR.\n"));
  assert.match(task.intent, /It races the clock in the retry loop\./);
  assert.deepEqual(f.dispatched, [task.id]);

  const read = started.body.report as ReportItem;
  assert.equal(read.readBy, "follow-up");
  assert.equal(read.followUpTaskId, task.id);
  assert.equal(f.reports.get(report.id)!.followUpTaskId, task.id);
  // Never the old session: nothing in the registry names it.
  assert.equal(f.registry.getSession(report.sessionId), undefined);

  // Called again, it creates nothing and dispatches nothing.
  const again = await f.followUp(report.id, "And again");
  assert.equal(again.status, 200);
  assert.equal(again.body.taskId, task.id);
  assert.equal(f.followUpTasks().length, 1);
  assert.deepEqual(f.dispatched, [task.id]);
});

test("a dispatch that fails leaves one task, the report unread and naming it; Retry dispatches that task", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  f.failDispatches("the fleet is paused");

  const failed = await f.followUp(report.id, "Look into it");
  assert.equal(failed.status, 409);
  assert.equal(failed.body.error, "the fleet is paused");
  const taskId = String(failed.body.taskId);
  assert.ok(f.registry.getTask(taskId), "the task was created");
  const unread = f.reports.get(report.id)!;
  assert.equal(unread.readAt, null);
  assert.equal(unread.followUpTaskId, taskId);
  assert.equal(f.followUpTasks().length, 1);

  // A retry that fails again still creates nothing.
  assert.equal((await f.followUp(report.id)).status, 409);
  assert.equal(f.followUpTasks().length, 1);

  f.failDispatches(null);
  const retried = await f.followUp(report.id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.taskId, taskId, "the same task");
  assert.deepEqual(f.dispatched, [taskId]);
  assert.equal(f.followUpTasks().length, 1, "no second task");
  assert.equal(f.reports.get(report.id)!.readBy, "follow-up");
});

test("two follow-ups at the same moment create one task", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  const [a, b] = await Promise.all([f.followUp(report.id, "one"), f.followUp(report.id, "two")]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.taskId, b.body.taskId);
  assert.equal(f.followUpTasks().length, 1);
  assert.equal(f.dispatched.length, 1);
});

test("a report that stored no repository is refused, and so is a resident's", async () => {
  const f = setup();
  const report = await postFromGoneSession(f, { repoRoot: null });
  assert.equal(report.repository, null);
  const refused = await f.followUp(report.id, "Go");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /no repository/);
  assert.equal(f.reports.get(report.id)!.readAt, null);
  assert.equal(f.followUpTasks().length, 0);

  const repo = f.inRepo(mkRepo());
  f.registry.upsertResidentRun({
    id: "run-steve", profileId: "steve", taskId: "t-steve",
    settings: { identity: { name: "Steve" }, board: { colorId: "violet" } },
  } as unknown as Parameters<typeof f.registry.upsertResidentRun>[0]);
  const resident = await postFromGoneSession(f, { repoRoot: repo, task: mkTaskSummary({ id: "t-steve" }) });
  assert.equal(resident.author.residentProfileId, "steve");
  const residentRefused = await f.followUp(resident.id, "Go");
  assert.equal(residentRefused.status, 409);
  assert.match(String(residentRefused.body.error), /Residents drawer/);
  assert.equal(f.followUpTasks().length, 0);

  assert.equal((await f.followUp("r-999999", "Go")).status, 404);
});

test("a live session cannot start a follow-up task: it is replied to, and nothing is created", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  serial += 1;
  const live = f.registry.registerSdkSession({
    id: `sdk:follow-up-live:${serial}`, agent: "claude", name: "still running", cwd: repo, repoRoot: repo,
    agentSessionId: `agent:follow-up-live:${serial}`,
  });
  const report = await f.reports.post(live, { title: "Still working on it", body: "Halfway there." });
  assert.equal(report.repository, repo);
  const refused = await f.followUp(report.id, "Start over in a new session");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /still running: reply to it instead/);
  assert.equal(refused.body.taskId, null);
  assert.equal(f.followUpTasks().length, 0, "no task created");
  assert.deepEqual(f.dispatched, [], "nothing dispatched");
  const unread = f.reports.get(report.id)!;
  assert.equal(unread.readAt, null);
  assert.equal(unread.followUpTaskId, null);
});

test("a running session that cannot take a message is not followed up either: it has not ended", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  serial += 1;
  // A discovered terminal session with no pane: still running, but nothing can be written to it.
  const id = `s-unreachable-${serial}`;
  f.registry.applyDiscovery([{
    syntheticId: id, agent: "claude", name: "paneless", nameSource: "process", cwd: repo, gitBranch: "b",
    pid: 1, tty: "ttys099", terminals: [], startedAt: 0,
  } as unknown as DiscoveredSession]);
  const running = f.registry.getSession(id)!;
  assert.notEqual(running.state, "exited");
  const report = await f.reports.post({ ...running, repoRoot: repo }, { title: "Paneless report", body: "Still going." });
  assert.equal(f.reports.replyTargetFor(report).kind, "unreachable");
  const refused = await f.followUp(report.id, "Start over");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /still running but cannot take a message/);
  assert.equal(f.followUpTasks().length, 0, "no task created");
  assert.deepEqual(f.dispatched, []);
  assert.equal(f.reports.get(report.id)!.readAt, null);
});

/** The launch failure the dispatcher records when a dispatched task never got a session. */
function launchFailed(task: Task, at: number, over: Partial<NonNullable<Task["launchFailure"]>> = {}, status: Task["status"] = "failed"): Task {
  return {
    ...task, status, sessionId: null,
    launchFailure: { at, phase: "launch", dismissedAt: null, reportTaskId: null, residentProfileId: null, sessionKept: false, ...over },
  };
}

test("a follow-up whose background launch fails comes back to read with Retry, which relaunches the same task", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  const started = await f.followUp(report.id, "Fix it");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const taskId = String(started.body.taskId);
  const clearedAt = f.reports.get(report.id)!.readAt!;
  // When that first launch failed. Reopening compares no times, so any stamp will do; a fixed one
  // well before the retry keeps this attempt's record distinct from the next attempt's.
  const firstFailureAt = clearedAt - 1_000;
  assert.equal(f.reports.get(report.id)!.readBy, "follow-up");

  // The dispatcher's background launch fails with no session: the report is waiting again, and
  // still names its task, which is what the card's Retry reads.
  f.registry.upsertTask(launchFailed(f.registry.getTask(taskId)!, firstFailureAt));
  const reopened = f.reports.get(report.id)!;
  assert.equal(reopened.readAt, null);
  assert.equal(reopened.readBy, null);
  assert.equal(reopened.followUpTaskId, taskId);
  assert.equal(f.registry.reportsToRead().some((r) => r.id === report.id), true, "back in to read");

  // Retry relaunches that task, creates no second one, and clears the report again.
  const retried = await f.followUp(report.id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.taskId, taskId);
  assert.deepEqual(f.dispatched, [taskId, taskId]);
  assert.equal(f.followUpTasks().length, 1);
  const cleared = f.reports.get(report.id)!;
  assert.equal(cleared.readBy, "follow-up");

  // The record the task carried when it was retried belongs to the earlier attempt, and the
  // stubbed dispatcher never clears it: seen again, it does not reopen the report.
  f.registry.upsertTask(launchFailed(f.registry.getTask(taskId)!, firstFailureAt));
  assert.equal(f.reports.get(report.id)!.readBy, "follow-up", "the earlier attempt's record is stale");
  // This attempt's own failure does, even stamped in the very millisecond the report was cleared.
  f.registry.upsertTask(launchFailed(f.registry.getTask(taskId)!, cleared.readAt!));
  assert.equal(f.reports.get(report.id)!.readAt, null, "a same-millisecond failure still reopens it");
  assert.equal(f.reports.get(report.id)!.followUpTaskId, taskId);
});

test("a launch that fails before the report is stamped still leaves it waiting with Retry", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  // The background launch fails while the dispatch call is still returning: the task event
  // arrives before the report is stamped read, when there is nothing to reopen yet.
  const accepting = f.tasks.dispatch.bind(f.tasks);
  let failNow = true;
  f.tasks.dispatch = (async (id, options) => {
    const result = await accepting(id, options);
    if (failNow) {
      failNow = false;
      assert.equal(f.reports.get(report.id)!.readAt, null, "not stamped yet");
      f.registry.upsertTask(launchFailed(f.registry.getTask(id)!, Date.now()));
    }
    return result;
  }) as typeof f.tasks.dispatch;
  const started = await f.followUp(report.id, "Go");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const taskId = String(started.body.taskId);
  const waiting = f.reports.get(report.id)!;
  assert.equal(waiting.readAt, null, "no session started, so it is still to read");
  assert.equal(waiting.readBy, null);
  assert.equal(waiting.followUpTaskId, taskId, "and still names its task, so the card shows Retry");
  assert.equal((started.body.report as ReportItem).readAt, null, "the route answers with the report as it stands");

  // Retry relaunches the same task, and this time nothing fails.
  const retried = await f.followUp(report.id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.taskId, taskId);
  assert.equal(f.followUpTasks().length, 1);
  assert.equal(f.reports.get(report.id)!.readBy, "follow-up");
});

test("a launch that kept its session does not reopen the report; one returned to the backlog does", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const kept = await postFromGoneSession(f, { repoRoot: repo }, "Kept launch");
  const keptStart = await f.followUp(kept.id, "Go");
  const keptTask = String(keptStart.body.taskId);
  f.registry.upsertTask(launchFailed(f.registry.getTask(keptTask)!, f.reports.get(kept.id)!.readAt! + 1, { sessionKept: true }));
  assert.equal(f.reports.get(kept.id)!.readBy, "follow-up", "an agent may be working: no Retry");

  const returned = await postFromGoneSession(f, { repoRoot: repo }, "Returned launch");
  const returnedStart = await f.followUp(returned.id, "Go");
  const returnedTask = String(returnedStart.body.taskId);
  f.registry.upsertTask(launchFailed(f.registry.getTask(returnedTask)!, f.reports.get(returned.id)!.readAt! + 1, {}, "backlog"));
  assert.equal(f.reports.get(returned.id)!.readAt, null, "back in the backlog with no session: Retry");
  const retried = await f.followUp(returned.id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.taskId, returnedTask);
});

test("a launch failure recorded while the daemon was down reopens the report at the next start", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  const started = await f.followUp(report.id, "Go");
  const taskId = String(started.body.taskId);
  const clearedAt = f.reports.get(report.id)!.readAt!;
  // The manager is down when the failure lands.
  f.reports.stop();
  f.registry.upsertTask(launchFailed(f.registry.getTask(taskId)!, clearedAt + 1));
  assert.equal(f.reports.get(report.id)!.readBy, "follow-up");
  const restarted = new ReportManager(f.registry);
  after(() => restarted.stop());
  assert.equal(restarted.get(report.id)!.readAt, null);
  assert.equal(restarted.get(report.id)!.followUpTaskId, taskId);
});

test("a body that is not JSON is refused, and starts no task with empty instructions", async () => {
  const f = setup();
  const report = await postFromGoneSession(f, { repoRoot: f.inRepo(mkRepo()) });
  const garbled = await f.followUpRaw(report.id, "{not json");
  assert.equal(garbled.status, 400);
  assert.equal(garbled.body.error, "the request body is not valid JSON");
  assert.equal(f.followUpTasks().length, 0);
  assert.equal(f.reports.get(report.id)!.followUpTaskId, null);
  // An absent body still reads as {}, which is how a wordless call reaches the route.
  const empty = await f.followUpRaw(report.id, "");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(f.followUpTasks().length, 1);
});

test("a follow-up whose report stamp rolls back leaves no task in the registry and launches nothing", async () => {
  const f = setup();
  const report = await postFromGoneSession(f, { repoRoot: f.inRepo(mkRepo()) });
  // Another follow-up is recorded on the report while this one's task row is being written, so
  // the stamp beside it finds the report already taken and the transaction rolls back.
  const creating = f.tasks.create.bind(f.tasks);
  f.tasks.create = ((...args: Parameters<typeof f.tasks.create>) => {
    openDb().prepare("UPDATE reports SET follow_up_task_id = 'elsewhere' WHERE id = ?").run(report.id);
    return creating(...args);
  }) as typeof f.tasks.create;
  const events: string[] = [];
  f.registry.subscribe((event) => { if (event.type === "task_upsert" || event.type === "task_remove") events.push(event.type); });
  const refused = await f.followUp(report.id, "Fix it");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /already started/);
  assert.equal(f.followUpTasks().length, 0, "the published task was removed again");
  assert.deepEqual(events, ["task_upsert", "task_remove"], "every window is told it is gone");
  assert.deepEqual(f.dispatched, [], "nothing launched");
});

test("only the operator starts a follow-up", async () => {
  const f = setup();
  const report = await postFromGoneSession(f, { repoRoot: f.inRepo(mkRepo()) });
  const refused = await f.followUp(report.id, "Go", { "x-mission-operation-actor": "agent" });
  assert.equal(refused.status, 403);
  assert.equal(f.followUpTasks().length, 0);
});

test("Retry after the recorded task was deleted asks for instructions again, and never files a task without them", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  f.failDispatches("not now");
  const failed = await f.followUp(report.id, "Split the shards across runners");
  const first = String(failed.body.taskId);
  f.failDispatches(null);
  f.registry.removeTask(first);

  // Retry carries no words: nothing is filed, the stale id is forgotten, and the card goes back
  // to the instructions box (no followUpTaskId), with the report still waiting.
  const retried = await f.followUp(report.id);
  assert.equal(retried.status, 409);
  assert.match(String(retried.body.error), /was deleted\. Write what the follow-up should do/);
  assert.equal(retried.body.taskId, null);
  assert.equal(f.followUpTasks().length, 0, "no task was filed without the operator's words");
  const waiting = f.reports.get(report.id)!;
  assert.equal(waiting.followUpTaskId, null);
  assert.equal(waiting.readAt, null);

  // Started again with words, it files exactly one new task, carrying them.
  const restarted = await f.followUp(report.id, "Split the shards across runners");
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.notEqual(restarted.body.taskId, first);
  assert.equal(f.followUpTasks().length, 1);
  assert.ok(f.registry.getTask(String(restarted.body.taskId))!.intent.startsWith("Split the shards across runners"));
  assert.equal(f.reports.get(report.id)!.followUpTaskId, restarted.body.taskId);
});

test("an unexpected failure while dispatching answers JSON with the task it created, so the card can offer Retry", async () => {
  const f = setup();
  const repo = f.inRepo(mkRepo());
  const report = await postFromGoneSession(f, { repoRoot: repo });
  const dispatching = f.tasks.dispatch.bind(f.tasks);
  f.tasks.dispatch = (async () => { throw new Error("the dispatcher fell over"); }) as typeof f.tasks.dispatch;
  const broken = await f.followUp(report.id, "Fix it");
  assert.equal(broken.status, 500);
  assert.match(String(broken.body.error), /could not be started: the dispatcher fell over/);
  const taskId = String(broken.body.taskId);
  assert.ok(f.registry.getTask(taskId), "the task was created before the throw");
  assert.equal((broken.body.report as ReportItem).followUpTaskId, taskId, "the report as it stands, naming its task");
  assert.equal(f.reports.get(report.id)!.readAt, null);

  // Retry relaunches that task once dispatch works again.
  f.tasks.dispatch = dispatching;
  const retried = await f.followUp(report.id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.taskId, taskId);
  assert.equal(f.followUpTasks().length, 1);
});

test("a follow-up takes the operator's Workflow default for its kind, as a dispatched task does", async () => {
  const f = setup();
  const report = await postFromGoneSession(f, { repoRoot: f.inRepo(mkRepo()) });
  // Ship's built-in default is back; this app was built without a Workflow manager to arm it.
  setWorkflowPolicy({});
  try {
    const refused = await f.followUp(report.id, "Go");
    assert.equal(refused.status, 503);
    assert.match(String(refused.body.error), /Workflow manager unavailable/);
  } finally {
    setWorkflowPolicy(NO_WORKFLOWS);
  }
  // Nothing was created, so nothing is recorded and the report is still waiting.
  assert.equal(f.followUpTasks().length, 0);
  assert.equal(f.reports.get(report.id)!.followUpTaskId, null);
  assert.equal(f.reports.get(report.id)!.readAt, null);
});
