import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backlogTasks,
  dispatchPhase,
  finishedTasks,
  provisioningTasks,
} from "../src/shared/session.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: a dispatched task used to be drawn NOWHERE between the moment its row was
 * inserted and the moment its session was discovered - several seconds, most of it a headless
 * model call naming the card, and far longer on a cold worktree slot that has to run the
 * repository's setup command first. `backlogTasks` had already stopped matching it, and every
 * other surface on the fleet page reads `session.task`, which is still null. The operator read
 * that silence as a dropped dispatch.
 *
 * `provisioningTasks` is the projection that closes it, and the two ways it could go wrong are
 * both invisible to a typecheck. If it matched on `status` alone it would keep listing a task
 * whose session has already landed, and the board would draw that task twice - once as a
 * placeholder and once as the real card. If it disagreed with `backlogTasks` about who owns a
 * row, a task would appear in two columns at once. These pin both, plus the ordering.
 */

test("provisioning is dispatched-but-sessionless, and never overlaps the other projections", () => {
  const provisioning = mkTask({ id: "p", status: "dispatching", sessionId: null });
  // The same status, but the binding has landed - the real card owns it now.
  const bound = mkTask({ id: "b", status: "dispatching", sessionId: "s1" });
  const backlog = mkTask({ id: "k", status: "backlog", sessionId: null });
  const running = mkTask({ id: "r", status: "running", sessionId: "s2" });
  const done = mkTask({ id: "d", status: "done", sessionId: null });
  const all = [provisioning, bound, backlog, running, done];

  assert.deepEqual(provisioningTasks(all).map((t) => t.id), ["p"]);

  // The load-bearing claim: no task is ever claimed by two projections at once, so nothing
  // the operator is looking at can be drawn twice.
  const ids = [backlogTasks(all), provisioningTasks(all), finishedTasks(all)]
    .flatMap((list) => list.map((t) => t.id));
  assert.equal(new Set(ids).size, ids.length, "a task may belong to at most one projection");
});

test("a burst dispatched together lists in the order it was sent", () => {
  // Oldest first, unlike `finishedTasks`: these are still arriving, and a list that reordered
  // itself as each one landed would be unreadable for exactly the seconds it is on screen.
  const tasks = [
    mkTask({ id: "third", status: "dispatching", sessionId: null, createdAt: 300 }),
    mkTask({ id: "first", status: "dispatching", sessionId: null, createdAt: 100 }),
    mkTask({ id: "second", status: "dispatching", sessionId: null, createdAt: 200 }),
  ];
  assert.deepEqual(provisioningTasks(tasks).map((t) => t.id), ["first", "second", "third"]);
});

test("a task leaves the placeholder projection the moment its session binds", () => {
  // The handover, which is what keeps the placeholder from outliving its replacement: the
  // very event that gives the fleet a real card is the one that empties this list.
  const task = mkTask({ id: "t", status: "dispatching", sessionId: null });
  assert.equal(provisioningTasks([task]).length, 1);
  assert.equal(provisioningTasks([{ ...task, sessionId: "s1" }]).length, 0);
});

test("the phase is read off the fields the dispatcher has already written", () => {
  const base = { status: "dispatching" as const, sessionId: null };
  assert.equal(
    dispatchPhase(mkTask({ ...base, worktreePath: null, homeName: null, terminalResourceId: null })),
    "prepare",
  );
  assert.equal(
    dispatchPhase(mkTask({ ...base, worktreePath: "/wt/a", homeName: null, terminalResourceId: null })),
    "launch",
  );
  assert.equal(
    dispatchPhase(mkTask({ ...base, worktreePath: "/wt/a", homeName: "a-1", terminalResourceId: null })),
    "discover",
  );
  assert.equal(
    dispatchPhase(mkTask({ ...base, worktreePath: "/wt/a", homeName: "a-1", terminalResourceId: "%1" })),
    "handover",
  );
});

test("each field only advances the phase once the ones before it have landed", () => {
  assert.equal(
    dispatchPhase(mkTask({
      status: "dispatching",
      sessionId: null,
      worktreePath: null,
      homeName: "a-1",
      terminalResourceId: "%1",
    })),
    "prepare",
  );
});

test("an embedded dispatch reports the two phases it has, and never a stalled count", () => {
  const sdk = mkTask({
    status: "dispatching",
    sessionId: null,
    worktreePath: "/wt/a",
    homeName: null,
    terminalResourceId: null,
  });
  assert.equal(dispatchPhase(sdk), "launch");
  assert.equal(provisioningTasks([{ ...sdk, sessionId: "s1", status: "running" }]).length, 0);
});
