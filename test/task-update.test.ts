import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-retriage-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Retriage - changing a task's priority or labels after it exists.
 *
 * Shares `TaskManager.update` with the dispatch-modal edit path, and the two halves of
 * that method are governed differently: rewriting repo/intent/title/kind/agent is
 * refused once a task leaves the backlog (its branch and tmux session are already cut
 * from the title), while priority and labels are annotation and stay editable forever.
 * Which half a patch touches is decided by `isAnnotationOnlyUpdate`, on KEYS - so a
 * caller that spreads `repoRoot: undefined` into the patch silently loses the exemption.
 *
 * What is at stake is the difference between an ABSENT field and a NULL one. A PATCH
 * body carries only what the caller wants changed, so `{labels: [...]}` must leave the
 * priority alone while `{priority: null}` must clear it. Written the obvious way
 * (`patch.priority ?? task.priority`) those two collapse into one, and clearing a
 * priority becomes silently impossible - the control in the backlog column would snap
 * back to its old value with nothing failing to say why.
 *
 * The other half is scope: this route annotates, it never provisions. That is what
 * makes retriaging a RUNNING task safe, and why there is no status guard here even
 * though its neighbours (assign, cancel, remove) are almost entirely guards.
 */

function setup() {
  const r = new Registry();
  const tasks = new TaskManager(r);
  return { r, tasks };
}

test("a labels-only patch leaves the priority alone", async () => {
  const { r, tasks } = setup();
  r.upsertTask(mkTask({ id: "t1", priority: "high" }));
  const out = await tasks.update("t1", { labels: ["infra"] });
  assert.equal(out.task?.priority, "high", "an omitted key means leave it, not clear it");
  assert.deepEqual(out.task?.labels, ["infra"]);
});

test("a priority-only patch leaves the labels alone", async () => {
  const { r, tasks } = setup();
  r.upsertTask(mkTask({ id: "t1", labels: ["infra", "flaky"] }));
  const out = await tasks.update("t1", { priority: "blocker" });
  assert.deepEqual(out.task?.labels, ["infra", "flaky"]);
  assert.equal(out.task?.priority, "blocker");
});

test("an explicit null clears the priority back to unset", async () => {
  // The case the `?? task.priority` shorthand would break: the backlog column's
  // "no priority" option sends exactly this, and it has to stick.
  const { r, tasks } = setup();
  r.upsertTask(mkTask({ id: "t1", priority: "low" }));
  assert.equal((await tasks.update("t1", { priority: null })).task?.priority, null);
  assert.equal(r.getTask("t1")?.priority, null, "and it has to persist, not just be returned");
});

test("retriage works on a task in any status, because it provisions nothing", async () => {
  // Unlike assign/cancel/remove, there is nothing here to conflict with: priority and
  // labels are annotation, and no branch or tmux session is cut from either. This is the
  // exemption from the backlog-only guard that the edit path relies on.
  const { r, tasks } = setup();
  for (const status of ["backlog", "dispatching", "running", "done", "failed", "cancelled"] as const) {
    r.upsertTask(mkTask({ id: status, status }));
    const out = await tasks.update(status, { priority: "med" });
    assert.equal(out.ok, true, status);
    assert.equal(out.task?.priority, "med", status);
  }
});

test("REWRITING a dispatched task is still refused - the exemption is annotation-only", async () => {
  // The guard the retriage exemption must not have widened: repo/intent/title/kind/agent
  // are cut into a branch and a tmux session at dispatch and cannot be edited after.
  const { r, tasks } = setup();
  r.upsertTask(mkTask({ id: "t1", status: "running" }));
  const out = await tasks.update("t1", { intent: "something else entirely" });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /not in the backlog/);
});

test("a mixed patch on a dispatched task is refused whole, not half-applied", async () => {
  // Priority rides along with a provisioning field, so the whole patch is a rewrite.
  const { r, tasks } = setup();
  r.upsertTask(mkTask({ id: "t1", status: "running", priority: "low" }));
  const out = await tasks.update("t1", { intent: "new", priority: "blocker" });
  assert.equal(out.ok, false);
  assert.equal(r.getTask("t1")?.priority, "low", "nothing may land from a refused patch");
});

test("an after-work workflow is frozen once the task has a session", async () => {
  const { r, tasks } = setup();
  r.upsertTask(mkTask({
    id: "t1",
    status: "running",
    sessionId: "session-1",
    workflowId: "workflow-a",
  }));

  for (const workflowId of ["workflow-b", null]) {
    const out = await tasks.update("t1", { workflowId });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /cannot change once the task has a session/);
    assert.equal(r.getTask("t1")?.workflowId, "workflow-a");
  }
});

test("retriage touches nothing but the triage fields and updatedAt", async () => {
  const { r, tasks } = setup();
  const before = mkTask({
    id: "t1",
    status: "running",
    worktreePath: "/wt/t1",
    branch: "harness/t1",
    homeName: "t1",
    sessionId: "s1",
  });
  r.upsertTask(before);
  const after_ = (await tasks.update("t1", { priority: "high", labels: ["a"] })).task!;
  const { priority: _p, labels: _l, updatedAt: _u, ...restAfter } = after_;
  const { priority: _p2, labels: _l2, updatedAt: _u2, ...restBefore } = before;
  assert.deepEqual(restAfter, restBefore, "a retriage must not disturb the worktree/session record");
});

test("retriaging a task that does not exist reports nothing rather than creating one", async () => {
  const { tasks } = setup();
  const out = await tasks.update("nope", { priority: "high" });
  assert.equal(out.ok, false);
  assert.equal(out.task, undefined);
});

test("changing a backlog task onto Pi required tools is refused, but annotation and recovery remain possible", async () => {
  const { r, tasks } = setup();
  r.upsertTask(mkTask({ id: "mission-kind", agent: "pi", kind: "ship", status: "backlog" }));
  const kindChange = await tasks.update("mission-kind", { kind: "scout" });
  assert.equal(kindChange.ok, false);
  assert.match(kindChange.error!, /integration for Pi is not installed/);
  assert.equal(r.getTask("mission-kind")!.kind, "ship");

  r.upsertTask(mkTask({ id: "mission-agent", agent: "claude", kind: "scout", status: "backlog" }));
  const agentChange = await tasks.update("mission-agent", { agent: "pi" });
  assert.equal(agentChange.ok, false);
  assert.match(agentChange.error!, /integration for Pi is not installed/);
  assert.equal(r.getTask("mission-agent")!.agent, "claude");

  r.upsertTask(mkTask({ id: "mission-old", agent: "pi", kind: "scout", status: "backlog" }));
  assert.equal((await tasks.update("mission-old", { priority: "high" })).ok, true);
  assert.equal((await tasks.update("mission-old", { agent: "claude" })).ok, true);
});

test("backlog edits reject Pi workflow-required tools using the resulting task", async () => {
  const { r, tasks } = setup();
  tasks.registerWorkflowEvidenceEligibility((task) =>
    task.kind === "ship" && task.workflowId === "requires-evidence",
  );
  r.upsertTask(mkTask({ id: "workflow-on-pi", agent: "pi", kind: "ship", status: "backlog", workflowId: null }));
  const workflowChange = await tasks.update("workflow-on-pi", { workflowId: "requires-evidence" });
  assert.equal(workflowChange.ok, false);
  assert.match(workflowChange.error!, /integration for Pi is not installed/);
  assert.equal(r.getTask("workflow-on-pi")!.workflowId, null);

  r.upsertTask(mkTask({ id: "agent-with-workflow", agent: "claude", kind: "ship", status: "backlog", workflowId: "requires-evidence" }));
  const agentChange = await tasks.update("agent-with-workflow", { agent: "pi" });
  assert.equal(agentChange.ok, false);
  assert.match(agentChange.error!, /integration for Pi is not installed/);
  assert.equal(r.getTask("agent-with-workflow")!.agent, "claude");

  r.upsertTask(mkTask({ id: "kind-with-workflow", agent: "pi", kind: "scout", status: "backlog", workflowId: "requires-evidence" }));
  const kindChange = await tasks.update("kind-with-workflow", { kind: "ship" });
  assert.equal(kindChange.ok, false);
  assert.equal(r.getTask("kind-with-workflow")!.kind, "scout");
});

test("clearing or replacing workflow tool requirements still permits recovery and annotation", async () => {
  const { r, tasks } = setup();
  tasks.registerWorkflowEvidenceEligibility((task) => task.workflowId === "requires-evidence");
  r.upsertTask(mkTask({ id: "old-pi-workflow", agent: "pi", kind: "ship", status: "backlog", workflowId: "requires-evidence" }));
  assert.equal((await tasks.update("old-pi-workflow", { priority: "high" })).ok, true);
  assert.equal((await tasks.update("old-pi-workflow", { workflowId: "no-evidence" })).ok, true);
  assert.equal(r.getTask("old-pi-workflow")!.workflowId, "no-evidence");

  r.upsertTask(mkTask({ id: "remove-on-switch", agent: "claude", kind: "ship", status: "backlog", workflowId: "requires-evidence" }));
  assert.equal((await tasks.update("remove-on-switch", { agent: "pi", workflowId: null })).ok, true);
  assert.equal(r.getTask("remove-on-switch")!.agent, "pi");
  assert.equal(r.getTask("remove-on-switch")!.workflowId, null);
});
