import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBacklogTick } from "../src/server/foreman/backlog-machine.ts";
import type { BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import {
  PLANNABLE_LIMIT,
  blockersFor,
  declaredBlockers,
  nextUpTaskId,
  plannableBacklog,
  planStale,
  readyBacklog,
} from "../src/shared/backlog.ts";
import type { BacklogPlan, Task } from "../src/shared/types.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";

/**
 * What a disabled backlog item costs the autopilot, and what it must NOT cost.
 *
 * The toggle only means something if exactly one list decides scheduling, so the
 * property worth pinning is not "the flag is read" but "the flag is read in the ONE
 * place both start-work paths go through". `readyBacklog` feeds the fresh-worktree
 * launch and the assign-to-an-idle-agent shortcut alike; a second gate bolted onto one
 * of them is how a parked task gets typed into somebody's pane anyway, with the board
 * still showing it held.
 *
 * The costs it must not have are the quiet ones. A park that made the plan stale would
 * spend a model call every time somebody triaged a row, and would make un-parking free
 * while parking was expensive - precisely backwards, since un-parking is the edit that
 * changes the ordering. A park that left the item in the plannable head would spend
 * budget describing work that is not going to happen.
 *
 * And the one thing it must keep costing: a disabled item still blocks whatever depends
 * on it, in its own words. "After X" promises a queue that is moving.
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

// ---- what a park must NOT cost -------------------------------------------------------

test("parking an item does not make the plan stale", () => {
  // Coverage is asked over the plannable head, and a disabled item is not in it. If it
  // were, every triage click would burn a backlog read - on the one edit that says this
  // work is NOT happening.
  const off = mkTask({ enabled: false });
  const on = mkTask();
  assert.equal(planStale([off, on], mkPlan([[on.id, []]])), false);
});

test("un-parking an item DOES make the plan stale - that is the edit that changed the order", () => {
  const parked = mkTask({ enabled: false });
  const on = mkTask();
  const plan = mkPlan([[on.id, []]]);
  assert.equal(planStale([parked, on], plan), false);
  assert.equal(planStale([{ ...parked, enabled: true }, on], plan), true);
});

test("a disabled item is not sent to the planner, and does not eat the plannable budget", () => {
  const parked = Array.from({ length: 5 }, () => mkTask({ enabled: false }));
  const live = Array.from({ length: 3 }, () => mkTask());
  const plannable = plannableBacklog([...parked, ...live]);
  assert.deepEqual(plannable.map((t) => t.id), live.map((t) => t.id));

  // The cap applies to what is left after the park, so a long parked tail cannot push
  // schedulable work past the limit and out of the dependency read entirely.
  const many = [
    ...Array.from({ length: 10 }, () => mkTask({ enabled: false })),
    ...Array.from({ length: PLANNABLE_LIMIT }, () => mkTask()),
  ];
  assert.equal(plannableBacklog(many).length, PLANNABLE_LIMIT);
  assert.ok(plannableBacklog(many).every((t) => t.enabled));
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
  // The stale-plan branch short-circuits everything, so an item that stayed plannable
  // while disabled would put the machine in a permanent `plan` loop: replan, still not
  // covered by anything that matters, replan again.
  const parked = mkTask({ enabled: false });
  const on = mkTask();
  const a = decide([parked, on], mkPlan([[on.id, []]]));
  assert.notEqual(a.kind, "plan");
});
