import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask as baseTask, mkMuxHandle } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Task } from "../src/shared/types.ts";

// What is at stake: a task row that says `running` long after its agent is gone.
//
// A `running` task used to be reconciled ONLY when the daemon restarted
// (`TaskManager.reconcileOnStartup`). While it was up, nothing noticed a bound session
// disappearing - so the (k) kill, a closed terminal and an agent that exited by itself all
// left a row claiming to be executing, holding a worktree and a terminal home that nothing
// would ever reclaim. Observed on a live install: seven `running` rows with dead sessions,
// three of them still holding worktrees on disk. The Foreman had already had to defend
// against them (`inFlightTasks` re-reads the session list precisely because such a row
// "is a row nothing will ever move"), which treated the symptom and left the cause.
//
// Worse, the restart path could not catch all of them either: it only reconciles a task
// that still holds a worktree or a home, so an ASSIGNED task - dropped onto an agent the
// operator started, so it never had resources of ours - stayed `running` forever, across
// every restart.
//
// The rule these pin: when a bound session is gone for good, the task says so, and it says
// so WITHOUT discarding anything. Resources are kept and surfaced for the operator's
// existing, confirmed Clean up - the same policy `complete` states ("Mark done must not
// silently discard unpushed work").

const home = mkdtempSync(join(tmpdir(), "mission-task-orphan-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const mkTask = (over: Partial<Task> = {}): Task => baseTask(over);

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid-1",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/wt/task-1",
    gitBranch: "harness/task-1",
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** A registry holding `tasks`, with a TaskManager wired to it (which is what subscribes). */
function wired(tasks: Task[]): InstanceType<typeof Registry> {
  const r = new Registry();
  for (const t of tasks) r.upsertTask(t);
  new TaskManager(r);
  return r;
}

test("a killed session's running task is failed, and keeps its worktree", () => {
  const r = wired([
    mkTask({
      id: "k-1",
      status: "running",
      sessionId: "sid-1",
      worktreePath: "/wt/task-1",
      branch: "harness/task-1",
      provider: "git",
      homeName: "Add a dark mode toggle",
      terminalResourceId: "res-1",
    }),
  ]);

  r.emit("event", { type: "session_remove", id: "sid-1" });

  const t = r.getTask("k-1")!;
  assert.equal(t.status, "failed");
  assert.match(t.error ?? "", /session ended/i);
  // Kept, every one of them: the checkout may hold uncommitted work, and the home may
  // still be standing. Reclaiming here would discard both without anyone confirming it -
  // the operator's Clean up is what does that, and it can only offer to while these
  // survive.
  assert.equal(t.worktreePath, "/wt/task-1");
  assert.equal(t.branch, "harness/task-1");
  assert.equal(t.homeName, "Add a dark mode toggle");
  assert.equal(t.terminalResourceId, "res-1");
  // The error names the leftover, so the row reads as something to act on rather than
  // as a bare failure.
  assert.match(t.error ?? "", /clean up/i);
  // The binding is dead - a synthetic id carries the pid and start time, so it can never
  // name a process again.
  assert.equal(t.sessionId, null);
});

test("a resource-less assigned task is failed cleanly - nothing to clean up", () => {
  const r = wired([mkTask({ id: "a-1", status: "running", sessionId: "sid-1" })]);

  r.emit("event", { type: "session_remove", id: "sid-1" });

  const t = r.getTask("a-1")!;
  assert.equal(t.status, "failed");
  // No worktree of ours was ever cut for an assigned task, so the sentence must not send
  // the operator looking for one.
  assert.doesNotMatch(t.error ?? "", /clean up/i);
});

test("the real eviction path drives it - a session that stops being discovered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = wired([
    mkTask({ id: "e-1", status: "running", sessionId: "sid-1", worktreePath: "/wt/task-1" }),
  ]);

  r.applyDiscovery([mkDiscovered()]);
  assert.equal(r.getTask("e-1")!.status, "running", "still discovered, still running");

  // The agent is gone from the process table. It is marked exited immediately, but the
  // task must NOT move yet: `exited` is provisional, and one hiccuping sweep must not
  // fail a live task.
  r.applyDiscovery([]);
  assert.equal(r.getTask("e-1")!.status, "running", "still inside the exit linger");

  // Past the linger, the session is evicted for good - and that is the signal.
  t.mock.timers.tick(10_000);
  assert.equal(r.getTask("e-1")!.status, "failed");
});

test("a session that comes back inside the linger keeps its task running", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = wired([mkTask({ id: "b-1", status: "running", sessionId: "sid-1" })]);

  r.applyDiscovery([mkDiscovered()]);
  r.applyDiscovery([]);
  r.applyDiscovery([mkDiscovered()]);
  t.mock.timers.tick(10_000);

  assert.equal(r.getTask("b-1")!.status, "running", "the sweep was a hiccup, not an exit");
});

test("a task bound to a session the first sweep never found is reconciled", () => {
  // The restart case, and the one `reconcileOnStartup` cannot reach: no worktree and no
  // home, so it is not resource-holding, so it was skipped - forever, on every restart.
  const r = new Registry();
  r.upsertTask(mkTask({ id: "r-1", status: "running", sessionId: "sid-gone" }));
  new TaskManager(r);

  // Sessions are rebuilt from the process table, so nothing is bound until the first
  // COMPLETED sweep says what is out there.
  assert.equal(r.getTask("r-1")!.status, "running", "no sweep has happened yet");
  r.applyDiscovery([mkDiscovered({ syntheticId: "sid-other" })]);

  assert.equal(r.getTask("r-1")!.status, "failed");
});

test("the first sweep leaves a task whose agent is still there alone", () => {
  const r = new Registry();
  r.upsertTask(mkTask({ id: "l-1", status: "running", sessionId: "sid-1" }));
  new TaskManager(r);

  // Same tty, same pid, same start time - a live agent gets the same synthetic id after a
  // restart, which is exactly why the sweep can be trusted to answer this.
  r.applyDiscovery([mkDiscovered({ syntheticId: "sid-1" })]);

  assert.equal(r.getTask("l-1")!.status, "running");
});

test("a task that already reached a terminal state is never rewritten", () => {
  const r = wired([
    mkTask({ id: "d-1", status: "done", sessionId: "sid-1", outcome: "opened PR #12" }),
    mkTask({ id: "c-1", status: "cancelled", sessionId: "sid-1" }),
    mkTask({ id: "f-1", status: "failed", sessionId: "sid-1", error: "the real reason" }),
  ]);

  r.emit("event", { type: "session_remove", id: "sid-1" });

  // A done task keeps its outcome, and a failed one keeps the reason it actually failed
  // for. The agent going away afterwards is not news about any of them.
  assert.equal(r.getTask("d-1")!.status, "done");
  assert.equal(r.getTask("d-1")!.outcome, "opened PR #12");
  assert.equal(r.getTask("c-1")!.status, "cancelled");
  assert.equal(r.getTask("f-1")!.error, "the real reason");
});

test("another session's departure moves nothing", () => {
  const r = wired([mkTask({ id: "o-1", status: "running", sessionId: "sid-1" })]);

  r.emit("event", { type: "session_remove", id: "sid-2" });

  assert.equal(r.getTask("o-1")!.status, "running");
});

test("startup settles sessionless running ship and scout tasks after observation and retains resources", () => {
  const r = new Registry();
  for (const kind of ["ship", "scout"] as const) {
    r.upsertTask(mkTask({ id: `null-${kind}`, kind, agent: "codex", status: "running", sessionId: null,
      worktreePath: `/wt/null-${kind}`, branch: `work/${kind}`, provider: "git" }));
  }
  new TaskManager(r);
  assert.equal(r.getTask("null-ship")!.status, "running", "absence before observation is not evidence");
  r.applyDiscovery([]);
  for (const kind of ["ship", "scout"] as const) {
    const task = r.getTask(`null-${kind}`)!;
    assert.equal(task.status, "failed");
    assert.match(task.error!, /session ended with no outcome recorded/);
    assert.equal(task.worktreePath, `/wt/null-${kind}`);
    assert.equal(task.branch, `work/${kind}`);
    assert.equal(task.provider, "git");
  }
});

test("startup preserves a sessionless task when discovery rebinds its live agent", () => {
  const r = wired([mkTask({ id: "null-live", status: "running", sessionId: null, worktreePath: "/wt/task-1" })]);
  r.applyDiscovery([mkDiscovered()]);
  assert.equal(r.getTask("null-live")!.status, "running");
  assert.equal(r.getTask("null-live")!.sessionId, "sid-1");
});

test("startup leaves provider-owned and restoring SDK tasks without session pointers running", () => {
  const r = new Registry();
  r.upsertTask(mkTask({ id: "null-pipeline", kind: "pipeline", status: "running", sessionId: null }));
  r.upsertTask(mkTask({ id: "null-sdk", status: "running", sessionId: null }));
  const supervisor = { taskLiveness: (id: string) => id === "null-sdk" ? true : null } as
    unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  new TaskManager(r, undefined, supervisor);
  // A new launch can start while the first discovery sweep is still in flight.
  r.upsertTask(mkTask({ id: "null-launch", status: "dispatching", sessionId: null }));
  r.applyDiscovery([]);
  assert.equal(r.getTask("null-launch")!.status, "dispatching");
  assert.equal(r.getTask("null-pipeline")!.status, "running");
  assert.equal(r.getTask("null-sdk")!.status, "running");
});

test("startup leaves a sessionless task reserved by a durable handoff running", async () => {
  const { reserveSessionTransfer } = await import("../src/server/session-transfers/store.ts");
  const r = new Registry();
  r.upsertTask(mkTask({ id: "null-transfer", status: "running", sessionId: null }));
  reserveSessionTransfer({ sourceSessionId: "transfer-source", noteKey: "transfer-note", taskId: "null-transfer",
    facts: { agent: "codex", nativeId: "conversation", sourceName: "Continue work", sourceRuntime: "sdk",
      sourceEpisodeId: null, cwd: "/checkout", repoRoot: "/repo", taskIdentity: null, taskEpisodeId: null,
      bindings: [], leaseRoot: "/private/managed-resumes", leaseId: "lease", backend: null, home: null,
      sourceStopped: false, stopStarted: false, sourceProcess: null, launchAt: null,
      launchOutcome: "not_started", canEnd: false } });
  new TaskManager(r);
  r.applyDiscovery([]);
  assert.equal(r.getTask("null-transfer")!.status, "running");
});


test("startup null-binding recovery does not settle work created or rebound during restore", () => {
  const r = new Registry();
  r.upsertTask(mkTask({ id: "startup-rebound", status: "running", sessionId: null }));
  new TaskManager(r);
  r.upsertTask(mkTask({ id: "fresh-running", status: "running", sessionId: null }));
  // A binding can move during restore, before the first observation callback. Its
  // now-null pointer is not evidence that this daemon inherited a stranded attempt.
  r.upsertTask({ ...r.getTask("startup-rebound")!, sessionId: "restoring-session" });
  r.upsertTask({ ...r.getTask("startup-rebound")!, sessionId: null });
  r.applyDiscovery([]);
  assert.equal(r.getTask("fresh-running")!.status, "running");
  assert.equal(r.getTask("startup-rebound")!.status, "running");
});
