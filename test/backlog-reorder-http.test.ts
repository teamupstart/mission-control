import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

/**
 * `POST /api/tasks/:id/reorder` - the one route that writes a backlog rank, and therefore
 * the only way the operator's order ever changes by hand.
 *
 * What is at stake is that a reorder is a claim about a list the browser last SAW, and the
 * daemon's list has moved on since - a card dispatched, a sweep filed three more. So the
 * body names an ANCHOR rather than an index, and every way the world can have changed
 * underneath it answers with a status the operator can act on rather than a silent no-op:
 * 404 means "that card is gone, stop drawing it" and 409 means "it moved on, re-read".
 * A control that quietly sprang back would look broken rather than late.
 *
 * Driven through `buildApp` rather than by calling `TaskManager.reorder` directly, because
 * the status codes ARE the contract phase 2's drag work consumes, and they live in the
 * route.
 *
 * HARNESS_HOME is set before importing anything that resolves it - `openDb` refuses the
 * real state dir under the test runner, and a hoisted import would defeat this preamble.
 */

const home = mkdtempSync(join(tmpdir(), "mission-backlog-reorder-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openDb } = await import("../src/server/db.ts");
const { RANK_STEP } = await import("../src/server/backlog-rank.ts");
const { backlogTasks } = await import("../src/shared/session.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

interface Harness {
  registry: InstanceType<typeof Registry>;
  tasks: InstanceType<typeof TaskManager>;
  reorder: (id: string, body: unknown) => Promise<Response>;
  order: () => string[];
}

/**
 * A fresh registry over the shared database, seeded with `ids` in that order.
 *
 * The rows are written straight through the registry rather than through
 * `TaskManager.create`, so the ranks under test are the ones this fixture names and the
 * test is not also asserting what `create` allocates (which `backlog-rank.test.ts` owns).
 */
function setup(ids: string[]): Harness {
  // Cleared BEFORE the registry is built, because a `Registry` rehydrates from SQLite on
  // construction - `backlogTasks` reads the whole backlog, so a previous test's rows would
  // otherwise sit in the middle of this one's order.
  openDb().prepare(`DELETE FROM tasks`).run();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  ids.forEach((id, i) => {
    registry.upsertTask(
      mkTask({
        id,
        title: id,
        status: "backlog",
        backlogRank: (i + 1) * RANK_STEP,
        createdAt: 1000 + i,
      }),
    );
  });
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  return {
    registry,
    tasks,
    reorder: async (id, body) =>
      app.request(`/api/tasks/${encodeURIComponent(id)}/reorder`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(body),
      }),
    // Read through the SHARED comparator, not through a second sort here: what this test
    // asserts has to be what the board and the scheduler would draw.
    order: () => backlogTasks(registry.listTasks()).map((t) => t.title),
  };
}

test("a 200 returns the moved task, with its new rank on it", async () => {
  const h = setup(["a", "b", "c"]);
  const res = await h.reorder("c", { position: "top" });
  assert.equal(res.status, 200);
  const moved = (await res.json()) as { id: string; backlogRank: number | null };
  assert.equal(moved.id, "c");
  assert.ok(typeof moved.backlogRank === "number");
  // The reply carries the new rank, so a caller reads it off the response instead of
  // racing its own `task_upsert`.
  assert.equal(h.registry.getTask("c")!.backlogRank, moved.backlogRank);
  assert.deepEqual(h.order(), ["c", "a", "b"]);
});

test("top, bottom, before and after each land where they say", async () => {
  const h = setup(["a", "b", "c", "d"]);
  assert.equal((await h.reorder("d", { position: "top" })).status, 200);
  assert.deepEqual(h.order(), ["d", "a", "b", "c"]);

  assert.equal((await h.reorder("d", { position: "bottom" })).status, 200);
  assert.deepEqual(h.order(), ["a", "b", "c", "d"]);

  // `before` is what "move up" sends: the anchor is the card the operator can SEE above.
  assert.equal(
    (await h.reorder("c", { position: "before", anchorTaskId: "b" })).status,
    200,
  );
  assert.deepEqual(h.order(), ["a", "c", "b", "d"]);

  assert.equal(
    (await h.reorder("a", { position: "after", anchorTaskId: "b" })).status,
    200,
  );
  assert.deepEqual(h.order(), ["c", "b", "a", "d"]);
});

test("404 for a task that is gone, and for an anchor that is gone", async () => {
  const h = setup(["a", "b"]);
  const missing = await h.reorder("no-such-task", { position: "top" });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, "no such task");

  const badAnchor = await h.reorder("a", { position: "before", anchorTaskId: "ghost" });
  assert.equal(badAnchor.status, 404);
  assert.match(((await badAnchor.json()) as { error: string }).error, /anchor/);
  assert.deepEqual(h.order(), ["a", "b"], "a refused move changes nothing");
});

test("409 when the card dispatched between the click and the request", async () => {
  const h = setup(["a", "b"]);
  const live = h.registry.getTask("a")!;
  h.registry.upsertTask({ ...live, status: "running" });
  const res = await h.reorder("a", { position: "bottom" });
  assert.equal(res.status, 409);
  // The sentence names the state, because "it is already running" is a thing the operator
  // can see on the board and reconcile with what they just clicked.
  assert.match(((await res.json()) as { error: string }).error, /running/);
});

test("409 when the ANCHOR left the backlog, rather than placing beside a ghost", async () => {
  const h = setup(["a", "b"]);
  const anchor = h.registry.getTask("b")!;
  h.registry.upsertTask({ ...anchor, status: "done" });
  const res = await h.reorder("a", { position: "after", anchorTaskId: "b" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /anchor/);
});

test("409 for a self-anchor - a card cannot be moved relative to itself", async () => {
  const h = setup(["a", "b"]);
  const res = await h.reorder("a", { position: "before", anchorTaskId: "a" });
  assert.equal(res.status, 409);
  assert.deepEqual(h.order(), ["a", "b"]);
});

test("400 for a body the schema refuses - a before with no anchor names nothing", async () => {
  const h = setup(["a", "b"]);
  // Rejected by the discriminated union at the boundary rather than by a hand-written
  // check in the route, which is why the union exists rather than an optional field.
  assert.equal((await h.reorder("a", { position: "before" })).status, 400);
  assert.equal((await h.reorder("a", { position: "sideways" })).status, 400);
  assert.equal((await h.reorder("a", {})).status, 400);
  assert.deepEqual(h.order(), ["a", "b"]);
});

test("a rank is never accepted on a create or an update - one route, or none", async () => {
  // Keeping rank off `UpdateTaskSchema` is what keeps `isAnnotationOnlyUpdate` - which
  // counts patch KEYS - from ever having to learn about it, and what makes "the order
  // changed" a single auditable route rather than a field anyone can write.
  const { UpdateTaskSchema, DispatchSchema } = await import("../src/shared/protocol.ts");
  const update = UpdateTaskSchema.safeParse({ backlogRank: 99 } as never);
  assert.equal(update.success, false, "an update naming only a rank is an empty patch");
  const dispatch = DispatchSchema.safeParse({
    repoRoot: "/repo",
    intent: "do the thing",
    backlogRank: 99,
  } as never);
  // Whether it strips or refuses, what must not happen is the value reaching the task.
  if (dispatch.success) {
    assert.equal((dispatch.data as Record<string, unknown>).backlogRank, undefined);
  }
});

test("the placement survives a reopen - the order is on disk, not in memory", async () => {
  const h = setup(["a", "b", "c"]);
  assert.equal((await h.reorder("c", { position: "top" })).status, 200);
  assert.deepEqual(h.order(), ["c", "a", "b"]);

  // A second Registry over the same database is what a daemon restart produces: it
  // rehydrates from SQLite and nothing carries over from the first one.
  const rehydrated = new Registry();
  assert.deepEqual(
    backlogTasks(rehydrated.listTasks()).map((t) => t.title),
    ["c", "a", "b"],
  );
});

test("a reorder is one row and one event, until a collision makes it every row", async () => {
  // The bargain sparse integers exist for: the common move writes ONE row and publishes ONE
  // `task_upsert`, and the full rewrite is paid only when there is no integer left between
  // two neighbours. A scheme that renumbered on every move would push one event per backlog
  // item to every connected dashboard on every drag.
  const h = setup(["a", "b", "c"]);
  const before = new Map(
    h.registry.listTasks().map((t) => [t.id, t.backlogRank] as const),
  );
  assert.equal(
    (await h.reorder("c", { position: "before", anchorTaskId: "b" })).status,
    200,
  );
  const changed = h.registry
    .listTasks()
    .filter((t) => t.backlogRank !== before.get(t.id));
  assert.deepEqual(changed.map((t) => t.id), ["c"], "only the moved row was rewritten");

  // Now wedge the two neighbours together so there is no midpoint, and the same move has
  // to renormalize. It still lands where it was asked to.
  openDb()
    .prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`)
    .run(RANK_STEP + 1, "c");
  const reloaded = new Registry();
  const app2 = buildApp({
    registry: reloaded,
    reviews: {} as unknown as ReviewManager,
    tasks: new TaskManager(reloaded),
    queues: {} as unknown as QueueManager,
  });
  const res = await app2.request(`/api/tasks/a/reorder`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ position: "after", anchorTaskId: "c" }),
  });
  assert.equal(res.status, 200);
  const order = backlogTasks(reloaded.listTasks()).map((t) => t.title);
  assert.equal(order.indexOf("a"), order.indexOf("c") + 1, "it landed directly after the anchor");
  // Every rank is a safe integer afterwards, whatever the repair had to do.
  for (const task of backlogTasks(reloaded.listTasks())) {
    assert.ok(Number.isSafeInteger(task.backlogRank), `${task.title} has an unusable rank`);
  }
});

/**
 * A reorder that cannot COMMIT must leave no trace - not in SQLite, and not on the wire.
 *
 * The bug this pins: the row write used to go through `registry.upsertTask`, which
 * persists AND broadcasts in one call, with `COMMIT` as the next statement. A `task_upsert`
 * cannot be recalled, so a COMMIT that threw rolled the row back underneath dashboards
 * that had already drawn the card in its new place - and left the registry's in-memory copy
 * disagreeing with the database, where a later persistence could make the phantom move
 * durable. That node:sqlite is synchronous rules out an interleaving, which is a different
 * hazard and never protected against this one.
 *
 * COMMIT is broken deliberately rather than waited for, because the real triggers - a full
 * disk, a busy database - are not reproducible on demand and the ordering is what matters.
 */
test("a reorder whose COMMIT fails publishes nothing and changes nothing", async () => {
  const h = setup(["a", "b", "c"]);
  const before = h.order();
  const rankBefore = h.registry.getTask("c")!.backlogRank;

  const seen: string[] = [];
  const unsubscribe = h.registry.subscribe((e) => {
    if (e.type === "task_upsert") seen.push(e.task.id);
  });

  const d = openDb();
  const realExec = d.exec.bind(d);
  (d as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (sql.trim().toUpperCase() === "COMMIT") throw new Error("disk full");
    return realExec(sql);
  };

  try {
    const res = await h.reorder("c", { position: "top" });
    // However the route surfaces it, what matters is that it did not report success.
    assert.notEqual(res.status, 200);
  } finally {
    (d as unknown as { exec: (sql: string) => void }).exec = realExec;
    unsubscribe();
  }

  assert.deepEqual(seen, [], "a rolled-back move must never reach a dashboard");
  assert.equal(h.registry.getTask("c")!.backlogRank, rankBefore);
  assert.deepEqual(h.order(), before);
  // The durable row is the one that decides; a fresh registry re-reads it from SQLite.
  const durable = openDb()
    .prepare(`SELECT backlog_rank AS rank FROM tasks WHERE id = ?`)
    .get("c") as { rank: number | null } | undefined;
  assert.equal(durable?.rank, rankBefore);
});
