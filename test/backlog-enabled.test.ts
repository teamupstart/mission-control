import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBacklogTick } from "../src/server/foreman/backlog-machine.ts";
import type { BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import { sanitizePlan } from "../src/server/foreman/backlog-plan.ts";
import {
  blockersFor,
  declaredBlockers,
  nextUpTaskId,
  plannableBacklog,
  readyBacklog,
} from "../src/shared/backlog.ts";
import type { BacklogPlan, Task } from "../src/shared/types.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

/**
 * What a disabled backlog item costs the autopilot.
 *
 * The toggle only means something if exactly one list decides scheduling, so the
 * property worth pinning is not "the flag is read" but "the flag is read in the ONE
 * place both start-work paths go through". `readyBacklog` feeds the fresh-worktree
 * launch and the assign-to-an-idle-agent shortcut alike; a second gate bolted onto one
 * of them is how a parked task gets typed into somebody's pane anyway, with the board
 * still showing it held.
 *
 * Parked items DO stay in planner input, and the test below is the reason. Filtering
 * them out looks like a saving and is a silent correctness bug: `sanitizePlan` drops
 * any edge whose target it was not shown, so a parked prerequisite's inferred edges
 * vanish on the next replan and its dependents go ready. That filter was written twice
 * during this feature's review and reverted twice; the test is what makes the third
 * attempt fail loudly instead of quietly.
 */

const NOW = 1_000_000;

const CFG: BacklogConfig = {
  enabled: true,
  maxSessions: 3,
  allowlist: ["/repo"],
  mayActLive: true,
  settleMs: 10_000,
  respectOpenPrs: true,
  planExhausted: false,
};

let seq = 0;
/** A backlog item with a distinct id and arrival order, over the shared task fixture. */
function mkTask(over: Partial<Task> = {}): Task {
  const n = ++seq;
  return baseTask({ id: `t${n}`, title: `Task ${n}`, createdAt: 1000 + n, updatedAt: 1000 + n, ...over });
}

function mkPlan(entries: Array<[string, string[]]>): BacklogPlan {
  return {
    entries: entries.map(([taskId, dependsOn]) => ({ taskId, dependsOn, reason: null })),
    note: null,
    generatedAt: NOW,
  };
}

const decide = (tasks: Task[], plan: BacklogPlan | null = null, cfg: BacklogConfig = CFG) =>
  decideBacklogTick({ tasks, sessions: [], plan, cfg, now: NOW });

// ---- the one list the scheduler decides from -----------------------------------------

test("a disabled item is not ready, however clear its dependencies are", () => {
  const off = mkTask({ enabled: false });
  const on = mkTask();
  assert.deepEqual(
    readyBacklog([off, on], mkPlan([[off.id, []], [on.id, []]])).map((t) => t.id),
    [on.id],
  );
});

test("a disabled item is skipped for 'next up' even when the plan puts it first", () => {
  // The marker answers "which item is at the front of the queue", so it has to skip the
  // same items the machine will - a card marked next-up that autopilot never takes is
  // the exact lie the shared predicates exist to prevent.
  const off = mkTask({ enabled: false });
  const on = mkTask();
  assert.equal(nextUpTaskId([off, on], mkPlan([[off.id, []], [on.id, []]])), on.id);
});

test("a backlog launch error is skipped for ready and next up until a manual retry", () => {
  const retry = mkTask({ error: "git fetch origin failed: Permission denied (publickey)" });
  const on = mkTask();
  const plan = mkPlan([[retry.id, []], [on.id, []]]);

  assert.deepEqual(readyBacklog([retry, on], plan).map((task) => task.id), [on.id]);
  assert.equal(nextUpTaskId([retry, on], plan), on.id);
  assert.deepEqual(
    readyBacklog([{ ...retry, error: null }, on], plan).map((task) => task.id),
    [retry.id, on.id],
    "entering a manual dispatch clears the gate and restores ordinary ordering",
  );
});

test("disabling the whole backlog leaves nothing ready, and no plan makes it ready", () => {
  const tasks = [mkTask({ enabled: false }), mkTask({ enabled: false })];
  assert.deepEqual(readyBacklog(tasks, mkPlan(tasks.map((t) => [t.id, []]))), []);
  assert.equal(nextUpTaskId(tasks, null), null);
});

test("re-enabling puts it back in line, in the order the plan already gave", () => {
  const first = mkTask({ enabled: false });
  const second = mkTask();
  const plan = mkPlan([[first.id, []], [second.id, []]]);
  assert.deepEqual(readyBacklog([first, second], plan).map((t) => t.id), [second.id]);
  assert.deepEqual(
    readyBacklog([{ ...first, enabled: true }, second], plan).map((t) => t.id),
    [first.id, second.id],
  );
});

// ---- what a park costs the planner ---------------------------------------------------

test("an inferred edge onto a parked prerequisite SURVIVES a replan", () => {
  // The whole reason `plannableBacklog` does not read the toggle. Withhold the parked
  // task from the planner's input and `sanitizePlan`'s `if (!known.has(dep)) continue`
  // deletes the edge - so `dependent` becomes ready and launches on a base nobody laid.
  // Declared edges survive that; Foreman's inferred graph is what silently loses.
  const parked = mkTask({ enabled: false });
  const dependent = mkTask();
  const tasks = [parked, dependent];

  const input = plannableBacklog(tasks);
  assert.ok(
    input.some((task) => task.id === parked.id),
    "a parked task stays in planner input, or its inferred edges cannot survive",
  );

  const plan = sanitizePlan(
    {
      tasks: [
        { id: parked.id, dependsOn: [] },
        { id: dependent.id, dependsOn: [parked.id] },
      ],
    },
    input,
  );
  const entry = plan.entries.find((e) => e.taskId === dependent.id);
  assert.deepEqual(entry?.dependsOn, [parked.id], "the edge must still name the parked task");

  // And the point of keeping it: the dependent stays blocked rather than going ready.
  const stored: BacklogPlan = {
    entries: plan.entries.map((e) => ({ ...e, reason: e.reason ?? null })),
    note: plan.note ?? null,
    generatedAt: NOW,
  };
  assert.deepEqual(readyBacklog(tasks, stored), []);
  assert.deepEqual(blockersFor(dependent, stored, tasks).map((b) => b.state), ["disabled"]);
});

// ---- a disabled item still blocks what depends on it ---------------------------------

test("a disabled prerequisite blocks, and says 'disabled' rather than 'waiting'", () => {
  // Both halves matter. It has to keep blocking - starting the follow-up on a base
  // nobody is going to lay is the failure `stopped` exists for - and it has to say which
  // kind of stuck this is, because the fix is one click on a switch the operator set.
  const base = mkTask({ enabled: false });
  const next = mkTask();
  const plan = mkPlan([[base.id, []], [next.id, [base.id]]]);
  const blockers = blockersFor(next, plan, [base, next]);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]!.state, "disabled");
  assert.equal(blockers[0]!.taskId, base.id);
});

test("an operator-declared edge onto a disabled task reports it the same way", () => {
  const base = mkTask({ enabled: false });
  const next = mkTask({
    dependencies: [
      {
        type: "task",
        taskId: base.id,
        title: base.title,
        sessionId: null,
        episodeId: null,
        agentSessionId: null,
        branch: null,
        prUrl: null,
        selectedAt: 1,
        satisfiedAt: null,
      },
    ],
  });
  const blockers = declaredBlockers(next, [base, next]);
  assert.deepEqual(blockers.map((b) => b.state), ["disabled"]);
  // Enabling it drops it back to the ordinary "wait your turn" reading.
  assert.deepEqual(declaredBlockers(next, [{ ...base, enabled: true }, next]).map((b) => b.state), [
    "waiting",
  ]);
});

test("a prerequisite that already LAUNCHED is not 'disabled', whatever its flag says", () => {
  // `enabled` gates scheduling, and a running task has nothing left to schedule - so a
  // human-launched parked task must report as work in progress, not as work held back.
  const base = mkTask({ enabled: false, status: "running" });
  const next = mkTask();
  const blockers = blockersFor(next, mkPlan([[next.id, [base.id]]]), [base, next]);
  assert.deepEqual(blockers.map((b) => b.state), ["waiting"]);
});

test("a cancelled prerequisite still reads as stopped, disabled or not", () => {
  const base = mkTask({ enabled: false, status: "cancelled" });
  const next = mkTask();
  const blockers = blockersFor(next, mkPlan([[next.id, [base.id]]]), [base, next]);
  assert.deepEqual(blockers.map((b) => b.state), ["stopped"]);
});

// ---- the scheduler's refusal ---------------------------------------------------------

test("an all-disabled backlog is refused as disabled, not as blocked", () => {
  // The silence is identical either way, and the fixes are not. Blaming a dependency
  // graph sends the operator looking for a prerequisite that does not exist, past the
  // switch they themselves turned off.
  const tasks = [mkTask({ enabled: false }), mkTask({ enabled: false })];
  const a = decide(tasks, mkPlan(tasks.map((t) => [t.id, []])));
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /disabled/);
  assert.doesNotMatch(a.kind === "none" ? a.why : "", /waiting on another task/);
});

test("a mixed backlog counts the two separately", () => {
  const gone = mkTask({ status: "cancelled" });
  const blocked = mkTask();
  const parked = mkTask({ enabled: false });
  const a = decide(
    [gone, blocked, parked],
    mkPlan([[gone.id, []], [blocked.id, [gone.id]], [parked.id, []]]),
  );
  assert.equal(a.kind, "none");
  const why = a.kind === "none" ? a.why : "";
  assert.match(why, /1 blocked/);
  assert.match(why, /1 disabled/);
});

test("a disabled item never becomes the thing that is launched", () => {
  const parked = mkTask({ enabled: false });
  const on = mkTask();
  const a = decide([parked, on], mkPlan([[parked.id, []], [on.id, []]]));
  assert.equal(a.kind === "dispatch" && a.task.id, on.id);
});

test("a parked backlog does not replan on every tick", () => {
  const parked = mkTask({ enabled: false });
  const on = mkTask();
  const a = decide([parked, on], mkPlan([[parked.id, []], [on.id, []]]));
  assert.notEqual(a.kind, "plan");
});
