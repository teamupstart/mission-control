import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where work ARRIVES in the backlog: the bottom, always, however it was filed.
 *
 * "Nothing that files itself gets to jump the queue you arranged" is half of what manual
 * ordering promises, and it is the half a single forgetful caller could break. It is
 * enforced in ONE place - `TaskManager.create` allocates the rank whenever the task lands
 * in the backlog - precisely because there are six producers and none of them should have
 * to know the rule: a task-source sweep (`task-sources/ingest.ts`), a recurring mission
 * (`schedules/manager.ts`), a retro follow-up (`retro.ts`), an ensemble member
 * (`ensembles/member-launch.ts`, `finalize-deps.ts`), an agent's own `POST /mcp/tasks`, and
 * the operator's own Dispatch form.
 *
 * So the tests below drive `create` with the SHAPES those producers use rather than each
 * producer, which is the claim that actually holds: whatever filed it, if it lands in the
 * backlog it lands at the bottom.
 *
 * The other half is re-entry. A task coming BACK - a reschedule, a restart-recovered
 * dispatch - keeps the rank it already had, so it reappears where it was rather than at the
 * bottom of a queue it never left. A task that never had one is appended, because an
 * unranked row would otherwise sit below everything filed after it.
 *
 * HARNESS_HOME is set before importing anything that resolves it - `openDb` refuses the
 * real state dir under the test runner.
 */

const home = mkdtempSync(join(tmpdir(), "mission-backlog-arrival-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { openDb } = await import("../src/server/db.ts");
const { RANK_STEP } = await import("../src/server/backlog-rank.ts");
const { backlogTasks } = await import("../src/shared/session.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

interface Harness {
  registry: InstanceType<typeof Registry>;
  tasks: InstanceType<typeof TaskManager>;
  order: () => string[];
}

/** A fresh registry over a wiped database, seeded with `titles` in that order. */
function setup(titles: string[] = []): Harness {
  openDb().prepare(`DELETE FROM tasks`).run();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  titles.forEach((title, i) => {
    registry.upsertTask(
      mkTask({
        id: title,
        title,
        status: "backlog",
        backlogRank: (i + 1) * RANK_STEP,
        createdAt: 1000 + i,
      }),
    );
  });
  return {
    registry,
    tasks,
    order: () => backlogTasks(registry.listTasks()).map((t) => t.title),
  };
}

/** The create input every automatic filer builds, differing only in provenance. */
const filed = (title: string, over: Record<string, unknown> = {}) => ({
  repoRoot: "/repo",
  intent: `do ${title}`,
  title,
  kind: "ship" as const,
  agent: "claude" as const,
  backlog: true,
  ...over,
});

test("a filed task arrives at the BOTTOM, below everything the operator arranged", () => {
  const h = setup(["first", "second"]);
  h.tasks.create(filed("swept"));
  assert.deepEqual(h.order(), ["first", "second", "swept"]);
  // Below the current maximum by a full step, so there is room to move something between
  // it and the card above without renumbering the column.
  const swept = h.registry.listTasks().find((t) => t.title === "swept")!;
  assert.equal(swept.backlogRank, 3 * RANK_STEP);
});

test("a swept P0 lands at the bottom too - the accepted cost, stated as a test", () => {
  // The one behaviour this feature deliberately gave up. A GitHub label or a Jira priority
  // still MAPS onto `Task.priority`, and that mapping no longer lifts the task in the
  // column: it colours the card and it filters, and a human moves it if it matters.
  //
  // Accepted rather than mitigated, and argued in docs/plans/backlog-manual-order/plan.md:
  // an order a cron loop can rearrange is not an order you set.
  const h = setup(["quiet-work"]);
  h.tasks.create(filed("urgent-sweep", { priority: "blocker" }));
  assert.deepEqual(h.order(), ["quiet-work", "urgent-sweep"]);
});

test("several filings keep their arrival order, each below the last", () => {
  const h = setup([]);
  for (const title of ["one", "two", "three"]) h.tasks.create(filed(title));
  assert.deepEqual(h.order(), ["one", "two", "three"]);
});

test("a task dispatched straight out carries NO rank - the column is not a queue it is in", () => {
  // Rank is meaningful only while `status === 'backlog'`. Inventing one for a row that
  // never sits there would put a number in the column that describes nothing.
  const h = setup(["waiting"]);
  const direct = h.tasks.create(filed("straight-out", { backlog: false }));
  assert.notEqual(direct.status, "backlog");
  assert.equal(direct.backlogRank, null);
});

test("a task forced to the backlog by an unmet dependency is ranked like any other", () => {
  // `create` backlogs a task whose prerequisite is unmet even when the caller asked to
  // dispatch. That is still an arrival in the backlog, so it still needs a place in it.
  const h = setup(["blocker-task"]);
  const dependent = h.tasks.create(
    filed("dependent", {
      backlog: false,
      dependencies: [{ type: "task", taskId: "blocker-task" }],
    }),
  );
  assert.equal(dependent.status, "backlog");
  assert.equal(typeof dependent.backlogRank, "number");
  assert.deepEqual(h.order(), ["blocker-task", "dependent"]);
});

test("a rescheduled task keeps its place rather than falling to the bottom", async () => {
  // A recovered attempt reappears where it was. Re-filing it at the bottom would quietly
  // demote work the operator had deliberately put near the top, on the strength of a
  // failure they are already dealing with.
  const h = setup(["top", "middle", "bottom"]);
  const middle = h.registry.getTask("middle")!;
  const rank = middle.backlogRank;
  h.registry.upsertTask({ ...middle, status: "cancelled", completedAt: 1, dispatchedAt: 1 });

  const r = await h.tasks.reschedule("middle");
  assert.equal(r.ok, true, r.error);
  assert.equal(h.registry.getTask("middle")!.backlogRank, rank, "the rank is untouched");
  assert.deepEqual(h.order(), ["top", "middle", "bottom"]);
});

test("a task re-entering the backlog with NO rank is appended rather than left unranked", () => {
  // The row a dispatch-and-fail produces: it never sat in the backlog, so it has no rank,
  // and an unranked row would push every task filed after it above itself.
  const h = setup(["already-here"]);
  h.registry.upsertTask(
    mkTask({ id: "never-queued", title: "never-queued", status: "cancelled", backlogRank: null }),
  );
  return h.tasks.reschedule("never-queued").then((r) => {
    assert.equal(r.ok, true, r.error);
    const back = h.registry.getTask("never-queued")!;
    assert.equal(typeof back.backlogRank, "number", "it must not re-enter unranked");
    assert.deepEqual(h.order(), ["already-here", "never-queued"]);
  });
});

test("an unranked row already sitting there does not demote what is filed after it", () => {
  // The whole reason `create` repairs before it reads the maximum. Without that, the new
  // task gets a finite rank, finite sorts above unranked, and it lands SECOND to last.
  const h = setup(["ranked"]);
  openDb()
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at, enabled)
       VALUES ('legacy', 'legacy', 'x', 'ship', 'claude', '/repo', 'backlog', 5, 5, 1)`,
    )
    .run();
  const reloaded = new Registry();
  const manager = new TaskManager(reloaded);
  assert.equal(reloaded.getTask("legacy")!.backlogRank, null, "the fixture is genuinely unranked");

  manager.create(filed("filed-after"));
  const order = backlogTasks(reloaded.listTasks()).map((t) => t.title);
  assert.ok(
    order.indexOf("filed-after") > order.indexOf("legacy"),
    `a task filed after an unranked row must sort below it, got ${order.join(", ")}`,
  );
  // And the repair healed rather than tolerated - and told the registry, so no dashboard is
  // left drawing a column the database no longer agrees with.
  assert.equal(reloaded.getTask("legacy")!.backlogRank !== null, true);
});
