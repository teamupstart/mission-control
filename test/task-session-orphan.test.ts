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
const { TaskManager } = await import("../src/server/tasks.ts");

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
