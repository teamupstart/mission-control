import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { WorkflowManager } from "../src/server/workflows/manager.ts";
import type { Task } from "../src/shared/types.ts";

/**
 * `POST /api/tasks/bulk-update` and `POST /api/tasks/bulk-delete` - the board's bulk edit.
 *
 * The contract under test is that a bulk edit is ONE decision: every selected task takes the
 * change or none does, and a refusal names the task that caused it. Driven through
 * `buildApp` because the status codes and the refusal wording are what the dialog renders.
 *
 * HARNESS_HOME is set before importing anything that resolves it - `openDb` refuses the
 * real state dir under the test runner, and a hoisted import would defeat this preamble.
 */

const home = mkdtempSync(join(tmpdir(), "mission-backlog-bulk-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openDb } = await import("../src/server/db.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

/**
 * The one method of the workflow manager the bulk route asks: whether a workflow may be
 * chosen. `published` is the only selectable one, as if every other id were a draft.
 */
const workflowStub = {
  workflowSelectionBlock: (workflowId: string) =>
    workflowId === "published" ? null : { message: "Choose a workflow with a published version" },
} as unknown as WorkflowManager;

function setup(
  seed: Array<Partial<Task> & { id: string }>,
  { workflows }: { workflows?: WorkflowManager } = {},
) {
  openDb().prepare(`DELETE FROM tasks`).run();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  seed.forEach((t, i) =>
    registry.upsertTask(mkTask({ title: t.id, status: "backlog", createdAt: 1000 + i, ...t })),
  );
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
    ...(workflows ? { workflows } : {}),
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return {
    registry,
    tasks,
    get: (id: string) => registry.getTask(id)!,
    update: (body: unknown) => post("/api/tasks/bulk-update", body),
    remove: (taskIds: string[]) => post("/api/tasks/bulk-delete", { taskIds }),
  };
}

test("sets one value on every selected task and leaves unselected tasks alone", async () => {
  const h = setup([
    { id: "a", priority: "med" },
    { id: "b", priority: null },
    { id: "c", priority: "low" },
  ]);
  const res = await h.update({ taskIds: ["a", "b"], set: { priority: "blocker", enabled: false } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; tasks: Task[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.tasks.map((t) => t.id), ["a", "b"]);
  assert.equal(h.get("a").priority, "blocker");
  assert.equal(h.get("b").priority, "blocker");
  assert.equal(h.get("a").enabled, false);
  assert.equal(h.get("b").enabled, false);
  assert.equal(h.get("c").priority, "low");
  assert.equal(h.get("c").enabled, true);
});

test("null clears a field back to unset across the selection", async () => {
  const h = setup([
    { id: "a", priority: "high", effort: "high" },
    { id: "b", priority: "low", effort: null },
  ]);
  const res = await h.update({ taskIds: ["a", "b"], set: { priority: null, effort: null } });
  assert.equal(res.status, 200);
  assert.equal(h.get("a").priority, null);
  assert.equal(h.get("b").priority, null);
  assert.equal(h.get("a").effort, null);
});

/**
 * Every scalar field the bulk edit offers, each applied on its own: written to every selected
 * task, and the unselected task left exactly as it was. One case per field, so a field the
 * route or `bulkTaskPatch` stopped forwarding fails by name.
 */
const SCALAR_CASES: Array<{
  field: "kind" | "agent" | "model" | "effort" | "workflowId";
  seed: Partial<Task>;
  set: Record<string, unknown>;
  expect: Partial<Task>;
}> = [
  { field: "kind", seed: { kind: "ship" }, set: { kind: "bugfix" }, expect: { kind: "bugfix" } },
  { field: "agent", seed: { agent: "claude" }, set: { agent: "codex" }, expect: { agent: "codex" } },
  {
    field: "model",
    seed: { agent: "claude", model: null },
    set: { model: "claude-opus-4-8" },
    expect: { model: "claude-opus-4-8" },
  },
  {
    field: "effort",
    seed: { agent: "claude", effort: null },
    set: { effort: "high" },
    expect: { effort: "high" },
  },
  {
    field: "workflowId",
    seed: { workflowId: null },
    set: { workflowId: "published" },
    expect: { workflowId: "published" },
  },
];

for (const c of SCALAR_CASES) {
  test(`bulk ${c.field} is written to every selected task and to no other`, async () => {
    const h = setup(
      [
        { id: "a", ...c.seed },
        { id: "b", ...c.seed },
        { id: "untouched", ...c.seed },
      ],
      { workflows: workflowStub },
    );
    const before = h.get("untouched");
    const res = await h.update({ taskIds: ["a", "b"], set: c.set });
    assert.equal(res.status, 200, await res.clone().text());
    for (const id of ["a", "b"]) {
      for (const [key, value] of Object.entries(c.expect)) {
        assert.deepEqual(h.get(id)[key as keyof Task], value, `${id}.${key}`);
      }
    }
    assert.deepEqual(h.get("untouched"), before);
  });
}

test("an agent set on its own resets each moved task's model and effort to the defaults", async () => {
  const h = setup([
    { id: "a", agent: "claude", model: "claude-opus-4-8", effort: "max" },
    { id: "b", agent: "claude", model: "claude-sonnet-5", effort: "high" },
  ]);
  const res = await h.update({ taskIds: ["a", "b"], set: { agent: "codex" } });
  assert.equal(res.status, 200);
  for (const id of ["a", "b"]) {
    assert.equal(h.get(id).agent, "codex");
    assert.equal(h.get(id).model, null, `${id} model follows the new harness default`);
    assert.equal(h.get(id).effort, null, `${id} effort follows the new harness default`);
  }
});

test("agent, model and effort set together land together", async () => {
  const h = setup([
    { id: "a", agent: "claude" },
    { id: "b", agent: "pi" },
  ]);
  const res = await h.update({
    taskIds: ["a", "b"],
    set: { agent: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
  });
  assert.equal(res.status, 200);
  for (const id of ["a", "b"]) {
    assert.equal(h.get(id).agent, "codex");
    assert.equal(h.get(id).model, "gpt-5.6-sol");
    assert.equal(h.get(id).effort, "xhigh");
  }
});

test("After work: None clears it, and an unpublished workflow refuses the whole edit", async () => {
  const h = setup(
    [
      { id: "a", workflowId: "published" },
      { id: "b", workflowId: "published" },
    ],
    { workflows: workflowStub },
  );
  const refused = await h.update({ taskIds: ["a", "b"], set: { workflowId: "draft-only" } });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /published version/);
  assert.equal(h.get("a").workflowId, "published");

  const cleared = await h.update({ taskIds: ["a", "b"], set: { workflowId: null } });
  assert.equal(cleared.status, 200);
  assert.equal(h.get("a").workflowId, null);
  assert.equal(h.get("b").workflowId, null);
});

test("choosing a workflow with no workflow manager answers 503 and writes nothing", async () => {
  const h = setup([{ id: "a", workflowId: null }]);
  const res = await h.update({ taskIds: ["a"], set: { workflowId: "published" } });
  assert.equal(res.status, 503);
  assert.equal(h.get("a").workflowId, null);
});

test("labels are added and removed per task, keeping each task's other labels", async () => {
  const h = setup([
    { id: "a", labels: ["sources", "jira"] },
    { id: "b", labels: ["docs"] },
  ]);
  const res = await h.update({
    taskIds: ["a", "b"],
    labels: { add: ["q4"], remove: ["JIRA"] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(h.get("a").labels, ["sources", "q4"]);
  assert.deepEqual(h.get("b").labels, ["docs", "q4"]);
});

test("dependencies are added and removed per task", async () => {
  const h = setup([
    { id: "prereq" },
    { id: "old" },
    { id: "a" },
    { id: "b" },
  ]);
  // Give `a` an existing edge first, through the ordinary single edit.
  const seeded = await h.update({
    taskIds: ["a"],
    dependencies: { add: [{ type: "task", taskId: "old" }] },
  });
  assert.equal(seeded.status, 200);
  assert.deepEqual(h.get("a").dependencies.map((d) => d.type === "task" && d.taskId), ["old"]);

  const res = await h.update({
    taskIds: ["a", "b"],
    dependencies: {
      add: [{ type: "task", taskId: "prereq" }],
      remove: [{ type: "task", taskId: "old" }],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(h.get("a").dependencies.map((d) => d.type === "task" && d.taskId), ["prereq"]);
  assert.deepEqual(h.get("b").dependencies.map((d) => d.type === "task" && d.taskId), ["prereq"]);
});

test("a selected task cannot be made a prerequisite of the selection", async () => {
  const h = setup([{ id: "a" }, { id: "b" }]);
  const res = await h.update({
    taskIds: ["a", "b"],
    dependencies: { add: [{ type: "task", taskId: "b" }] },
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /selected task cannot also be a prerequisite/);
  assert.deepEqual(h.get("a").dependencies, []);
});

test("one refused task refuses the whole edit, names that task, and writes nothing", async () => {
  const h = setup([
    { id: "claude-task", title: "Fix the reconnect test", agent: "claude", priority: "low" },
    { id: "codex-task", title: "Add a retry budget", agent: "codex", priority: "low" },
  ]);
  // `max` is a Claude effort level and not a Codex one, so the second task refuses it.
  const res = await h.update({
    taskIds: ["claude-task", "codex-task"],
    set: { priority: "high", effort: "max" },
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; taskId: string };
  assert.equal(body.taskId, "codex-task");
  assert.match(body.error, /^"Add a retry budget": reasoning effort max is not supported by codex/);
  // Neither row moved, including the one that would have accepted the change.
  assert.equal(h.get("claude-task").priority, "low");
  assert.equal(h.get("claude-task").effort, null);
  assert.equal(h.get("codex-task").priority, "low");
});

test("a write made while the edit was being checked refuses it, even in the same millisecond", async () => {
  const h = setup([
    { id: "a", title: "Written meanwhile", priority: null, labels: [], updatedAt: 5000 },
    { id: "b", priority: null, updatedAt: 5000 },
  ]);
  // Hold `b` in titling, the first await `prepareUpdate` takes, so the bulk edit prepares `a`
  // and then waits. That wait is the window a concurrent write lands in.
  let release!: () => void;
  const titling = (h.tasks as unknown as { titling: Map<string, Promise<void>> }).titling;
  titling.set("b", new Promise<void>((resolve) => (release = resolve)));
  const pending = h.update({ taskIds: ["a", "b"], set: { priority: "high" } });
  await new Promise((resolve) => setImmediate(resolve));

  // A concurrent edit to `a` stamped with the SAME millisecond the bulk edit read. A guard
  // on `updatedAt` alone cannot tell the two rows apart.
  h.registry.upsertTask({ ...h.get("a"), labels: ["concurrent"], updatedAt: 5000 });
  titling.delete("b");
  release();

  const res = await pending;
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; taskId: string };
  assert.equal(body.taskId, "a");
  assert.match(body.error, /"Written meanwhile" changed while this edit was being checked/);
  // The concurrent write survives, and nothing of the bulk edit landed on either task.
  assert.deepEqual(h.get("a").labels, ["concurrent"]);
  assert.equal(h.get("a").priority, null);
  assert.equal(h.get("b").priority, null);
});

test("a list edit is built from the row titling leaves behind, so it keeps what titling wrote", async () => {
  const h = setup([{ id: "a", labels: [], updatedAt: 5000 }]);
  // Titling is in flight for `a` when the bulk edit arrives, and it rewrites the row when it
  // lands. Here that rewrite also adds a label, standing in for any write in that window.
  let release!: () => void;
  const titling = (h.tasks as unknown as { titling: Map<string, Promise<void>> }).titling;
  titling.set("a", new Promise<void>((resolve) => (release = resolve)));
  const pending = h.update({ taskIds: ["a"], labels: { add: ["q4"] } });
  await new Promise((resolve) => setImmediate(resolve));

  h.registry.upsertTask({ ...h.get("a"), labels: ["concurrent"], updatedAt: 5000 });
  titling.delete("a");
  release();

  const res = await pending;
  assert.equal(res.status, 200, await res.clone().text());
  // The bulk label joins the concurrent one instead of replacing the list it replaced.
  assert.deepEqual(h.get("a").labels, ["concurrent", "q4"]);
});

test("a task that has left the backlog refuses the whole edit", async () => {
  const h = setup([
    { id: "a", priority: null },
    { id: "b", title: "Already running", status: "running", priority: null },
  ]);
  const res = await h.update({ taskIds: ["a", "b"], set: { priority: "high" } });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /"Already running" is running/);
  assert.equal(h.get("a").priority, null);
});

test("an unknown task answers 404 and an empty change answers 400", async () => {
  const h = setup([{ id: "a" }]);
  assert.equal((await h.update({ taskIds: ["a", "gone"], set: { priority: "high" } })).status, 404);
  assert.equal(h.get("a").priority, null);
  assert.equal((await h.update({ taskIds: ["a"], set: {} })).status, 400);
  assert.equal((await h.update({ taskIds: ["a", "a"], set: { enabled: false } })).status, 400);
});

test("labels past the cap refuse instead of being dropped silently", async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`);
  const h = setup([{ id: "full", title: "Heavily tagged", labels: twelve }, { id: "b" }]);
  const res = await h.update({ taskIds: ["full", "b"], labels: { add: ["one-more"] } });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /"Heavily tagged" would carry more than 12 labels/);
  assert.deepEqual(h.get("b").labels, []);
});

test("bulk delete removes every selected backlog task", async () => {
  const h = setup([{ id: "a" }, { id: "b" }, { id: "keep" }]);
  const res = await h.remove(["a", "b"]);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; removed: string[] };
  assert.deepEqual(body.removed, ["a", "b"]);
  assert.equal(h.registry.getTask("a"), undefined);
  assert.equal(h.registry.getTask("b"), undefined);
  assert.ok(h.registry.getTask("keep"));
});

test("bulk delete checks the whole selection before removing any of it", async () => {
  const h = setup([
    { id: "a" },
    { id: "b", title: "Still running", status: "running" },
  ]);
  const res = await h.remove(["a", "b"]);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /"Still running" is running/);
  assert.ok(h.registry.getTask("a"), "the backlog task survives a refused selection");
});
