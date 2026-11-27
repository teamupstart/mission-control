// Work unit ids on the task record: which tasks share one, which get their own, how an older
// row gets its id, and that every operation uses the id that ends up stored. Driven through the
// real TaskManager and the in-process MCP routes; the dispatcher is the only stubbed boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Task } from "../src/shared/types.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import { tempDir } from "./temp-root.mjs";

const home = tempDir("mission-work-unit-tasks-home-");
const repos = tempDir("mission-work-unit-tasks-repos-");
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager, RESIDENT_LAUNCH_TASK_CREATE } = await import("./helpers/task-manager-fixture.ts");
const { TaskManagerGateway } = await import("../src/server/ensembles/member-launch.ts");
const { createFinalizeDeps } = await import("../src/server/ensembles/finalize-deps.ts");
const db = await import("../src/server/db.ts");
const { isWorkUnitId } = await import("../src/shared/work-unit.ts");
const { mintWorkUnitId } = await import("../src/server/work-unit.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

const repo = (() => {
  const dir = join(repos, "repo");
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
})();

type Manager = InstanceType<typeof TaskManager>;

/** A real TaskManager whose dispatcher records each launch and the stored row it would read. */
function fixture(registry = new Registry()) {
  const tasks = new TaskManager(registry);
  const launched: Array<{ id: string; storedWorkUnitId: string | null }> = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    dispatch: async (id: string) => {
      launched.push({ id, storedWorkUnitId: db.getTask(id)?.workUnitId ?? null });
    },
  };
  const app = buildApp({ registry, reviews: {} as ReviewManager, tasks, queues: {} as QueueManager });
  return { registry, tasks, launched, app };
}

function backlogTask(tasks: Manager, over: Partial<Parameters<Manager["create"]>[0]> = {}): Task {
  return tasks.create({
    repoRoot: repo,
    intent: "Deliver the change",
    title: `Task ${randomUUID().slice(0, 6)}`,
    kind: "ship",
    agent: "claude",
    workflowId: null,
    backlog: true,
    ...over,
  });
}

/** Bind `task` to a newly registered session, as a launch does, and return that session's id. */
function runOnSession(registry: InstanceType<typeof Registry>, task: Task): string {
  const sessionId = `sdk:${randomUUID()}`;
  registry.registerSdkSession({ id: sessionId, agent: "claude", name: task.title, cwd: repo });
  registry.upsertTask({ ...registry.getTask(task.id)!, status: "running", sessionId, updatedAt: Date.now() });
  return sessionId;
}

async function mcpCreate(
  app: ReturnType<typeof buildApp>,
  sessionId: string | null,
  body: Record<string, unknown> = {},
  path = "/mcp/v3/tasks",
): Promise<{ status: number; body: Task & { error?: string } }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      sessionId,
      cwd: repo,
      repoRoot: repo,
      title: `Filed ${randomUUID().slice(0, 6)}`,
      intent: "Implement one phase",
      ...(path === "/mcp/v3/tasks" ? { workflowId: null } : {}),
      ...body,
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function mcpPost(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A row as a build before the column wrote it: no work unit in memory or on disk. */
function olderTask(over: Partial<Parameters<Manager["create"]>[0]> = {}): Task {
  const { tasks } = fixture();
  const created = backlogTask(tasks, over);
  db.openDb().prepare(`UPDATE tasks SET work_unit_id = NULL WHERE id = ?`).run(created.id);
  return db.getTask(created.id)!;
}

test("a standalone task gets its own work unit, stored with the row", () => {
  const { tasks } = fixture();
  const a = backlogTask(tasks);
  const b = backlogTask(tasks);
  assert.ok(isWorkUnitId(a.workUnitId), String(a.workUnitId));
  assert.ok(isWorkUnitId(b.workUnitId));
  assert.notEqual(a.workUnitId, b.workUnitId);
  assert.equal(db.getTask(a.id)?.workUnitId, a.workUnitId);
});

test("a plan session's task joins the plan's work unit; a ship session's task does not", async () => {
  const { registry, tasks, app } = fixture();
  const plan = backlogTask(tasks, { kind: "plan" });
  const planSession = runOnSession(registry, plan);
  const phase = await mcpCreate(app, planSession);
  assert.equal(phase.status, 200, JSON.stringify(phase.body));
  assert.equal(phase.body.workUnitId, plan.workUnitId, "a phase task shares its plan's work unit");
  assert.equal(db.getTask(phase.body.id)?.workUnitId, plan.workUnitId);

  const ship = backlogTask(tasks);
  const shipSession = runOnSession(registry, ship);
  const filed = await mcpCreate(app, shipSession);
  assert.equal(filed.status, 200);
  assert.ok(isWorkUnitId(filed.body.workUnitId));
  assert.notEqual(filed.body.workUnitId, ship.workUnitId, "work a ship session files is its own");
  assert.notEqual(filed.body.workUnitId, plan.workUnitId);

  const inherited = await mcpCreate(app, shipSession, { workUnit: "inherit" });
  assert.equal(inherited.status, 200);
  assert.equal(inherited.body.workUnitId, ship.workUnitId, "\"inherit\" joins any task's work unit");

  const fresh = await mcpCreate(app, planSession, { workUnit: "new" });
  assert.equal(fresh.status, 200);
  assert.ok(isWorkUnitId(fresh.body.workUnitId));
  assert.notEqual(fresh.body.workUnitId, plan.workUnitId, "\"new\" from a plan session starts one");
});

test("every creation route accepts the choice, and none lets a body choose the id", async () => {
  const { registry, tasks, app } = fixture();
  const plan = backlogTask(tasks, { kind: "plan" });
  const planSession = runOnSession(registry, plan);
  for (const path of ["/mcp/tasks", "/mcp/v2/tasks", "/mcp/v3/tasks"]) {
    const joined = await mcpCreate(app, planSession, {}, path);
    assert.equal(joined.status, 200, `${path}: ${JSON.stringify(joined.body)}`);
    assert.equal(joined.body.workUnitId, plan.workUnitId, path);
    const fresh = await mcpCreate(app, planSession, { workUnit: "new" }, path);
    assert.equal(fresh.status, 200, path);
    assert.notEqual(fresh.body.workUnitId, plan.workUnitId, path);
  }
  const chosen = mintWorkUnitId();
  const strict = await mcpCreate(app, planSession, { workUnitId: chosen });
  assert.equal(strict.status, 400, "the strict route refuses the key outright");
  const loose = await mcpCreate(app, planSession, { workUnitId: chosen }, "/mcp/tasks");
  assert.equal(loose.status, 200);
  assert.equal(loose.body.workUnitId, plan.workUnitId, "the older route ignores it");
  assert.equal(db.listTasks().some((task) => task.workUnitId === chosen), false);
  const malformed = await mcpCreate(app, planSession, { workUnit: "parent" });
  assert.equal(malformed.status, 400);
});

test("\"inherit\" is refused only with no task to inherit from, and nothing is created", async () => {
  const { app } = fixture();
  const before = db.listTasks().length;
  const unresolved = await mcpCreate(app, "sdk:not-registered", { workUnit: "inherit" });
  assert.equal(unresolved.status, 409);
  assert.match(String(unresolved.body.error), /running a task/);
  assert.equal(db.listTasks().length, before, "a refused creation writes nothing");

  // Not an error without the ask: an unresolved caller gets a new work unit.
  const plain = await mcpCreate(app, "sdk:not-registered");
  assert.equal(plain.status, 200);
  assert.ok(isWorkUnitId(plain.body.workUnitId));
});

test("a plan created by a plan, and that plan's own phase task, all share one work unit", async () => {
  const { registry, tasks, app } = fixture();
  const root = backlogTask(tasks, { kind: "plan" });
  const rootSession = runOnSession(registry, root);
  const nested = await mcpCreate(app, rootSession, { kind: "plan" });
  assert.equal(nested.status, 200, JSON.stringify(nested.body));
  assert.equal(nested.body.workUnitId, root.workUnitId);
  const nestedSession = runOnSession(registry, registry.getTask(nested.body.id)!);
  const phase = await mcpCreate(app, nestedSession);
  assert.equal(phase.body.workUnitId, root.workUnitId);
});

test("inheriting from an older task gives that task its id first, then copies it", async () => {
  const older = olderTask({ kind: "ship" });
  assert.equal(older.workUnitId, null);
  // A fresh Registry rehydrates the row exactly as an upgraded daemon would.
  const { registry, app } = fixture(new Registry());
  assert.equal(registry.getTask(older.id)?.workUnitId, null);
  const session = runOnSession(registry, older);
  const child = await mcpCreate(app, session, { workUnit: "inherit" });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  assert.ok(isWorkUnitId(child.body.workUnitId));
  assert.equal(db.getTask(older.id)?.workUnitId, child.body.workUnitId, "the parent's id was saved");
  assert.equal(registry.getTask(older.id)?.workUnitId, child.body.workUnitId, "and shown");
});

test("a plan session whose older plan task has no id yet: the phase task still shares it", async () => {
  const older = olderTask({ kind: "plan" });
  const { registry, app } = fixture(new Registry());
  const session = runOnSession(registry, older);
  const phase = await mcpCreate(app, session);
  assert.equal(phase.status, 200);
  assert.ok(isWorkUnitId(phase.body.workUnitId));
  assert.equal(db.getTask(older.id)?.workUnitId, phase.body.workUnitId);
});

test("dispatch gives an older row its id and saves it before the launch reads the task", async () => {
  const older = olderTask();
  const { registry, tasks, launched } = fixture(new Registry());
  const outcome = await tasks.dispatch(older.id);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
  const stored = db.getTask(older.id)!.workUnitId;
  assert.ok(isWorkUnitId(stored));
  assert.deepEqual(launched, [{ id: older.id, storedWorkUnitId: stored }]);
  assert.equal(registry.getTask(older.id)?.workUnitId, stored);
  assert.equal(outcome.task?.workUnitId, stored);
});

test("assign gives an older row its id first, even when the assign is then refused", async () => {
  const older = olderTask();
  const { registry, tasks } = fixture(new Registry());
  const outcome = await tasks.assign(older.id, "no-such-session");
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /no such session/);
  const stored = db.getTask(older.id)!.workUnitId;
  assert.ok(isWorkUnitId(stored));
  assert.equal(registry.getTask(older.id)?.workUnitId, stored);
});

test("a task that already has an id keeps it through dispatch, requeue and every later write", async () => {
  const { registry, tasks } = fixture();
  const task = backlogTask(tasks);
  const id = task.workUnitId;
  await tasks.dispatch(task.id);
  assert.equal(db.getTask(task.id)?.workUnitId, id);
  // Failed before provisioning, then requeued: the same row, so the same work unit.
  registry.upsertTask({ ...registry.getTask(task.id)!, status: "failed", error: "boom", updatedAt: Date.now() });
  const requeued = await tasks.requeue(task.id);
  assert.equal(requeued.ok, true, requeued.error);
  assert.equal(registry.getTask(task.id)?.status, "backlog");
  assert.equal(db.getTask(task.id)?.workUnitId, id);
  // A stale copy that predates the id cannot erase it, in the database or on the board.
  registry.upsertTask({ ...registry.getTask(task.id)!, workUnitId: null, title: "renamed" });
  assert.equal(db.getTask(task.id)?.workUnitId, id);
  assert.equal(registry.getTask(task.id)?.workUnitId, id);
  assert.equal(registry.getTask(task.id)?.title, "renamed");
});

test("a recovered internal creation keeps the work unit it was first created with", () => {
  const { tasks } = fixture();
  const input = {
    repoRoot: repo, intent: "Member work", title: "Member", kind: "ship" as const,
    agent: "claude" as const, workflowId: null, backlog: true,
  };
  const taskId = randomUUID();
  const first = tasks.create(input, { id: taskId });
  const recovered = tasks.create(input, { id: taskId });
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.workUnitId, first.workUnitId);
  assert.equal(db.getTask(taskId)?.workUnitId, first.workUnitId);
});

test("a retro follow-up takes its source task's work unit", () => {
  const { tasks } = fixture();
  const source = backlogTask(tasks);
  const retro = tasks.createRetroFollowup({
    sourceTask: source,
    sourceEpisodeId: randomUUID(),
    sourceSessionId: "sdk:source",
    title: "Retro: source",
    intent: "Run the retrospective",
    agent: "claude",
  });
  assert.notEqual(retro.id, source.id);
  assert.equal(retro.workUnitId, source.workUnitId);
});

test("best-of-N members, a retry and the replacement share one work unit for the run", async () => {
  const { registry, tasks } = fixture();
  const gateway = new TaskManagerGateway(tasks, registry);
  const member = (taskId: string, workUnitFrom: string[]) => gateway.create({
    taskId, runId: "run-1", memberId: `m-${taskId}`, repoRoot: repo, intent: "Implement it",
    title: `Member ${taskId}`, agent: "claude", model: null, effort: null, workUnitFrom,
  });
  const [a, b, c, retry] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  // The engine names the run's other member tasks; one not created yet is skipped.
  member(a, [b, c]);
  member(b, [a, c]);
  member(c, [a, b]);
  member(retry, [a, b, c]);
  const first = db.getTask(a)!.workUnitId;
  assert.ok(isWorkUnitId(first), "the first member mints");
  for (const id of [b, c, retry]) assert.equal(db.getTask(id)?.workUnitId, first, id);

  const replacement = randomUUID();
  const deps = createFinalizeDeps({ registry, tasks, workflows: {} as never });
  const materialized = await deps.materializeReplacement({
    taskId: replacement, runId: "run-1", repoRoot: repo, title: "selected result", intent: "Continue",
    agent: "claude", model: null, effort: null, snapshotSha: "a".repeat(40), workUnitFrom: [b, a, c],
  });
  assert.ok(db.getTask(replacement), JSON.stringify(materialized));
  assert.equal(db.getTask(replacement)?.workUnitId, first);

  // A run whose members were all created before the column: the first named member is given
  // its id, and the newcomer copies it.
  const olderMember = olderTask();
  const later = randomUUID();
  member(later, [olderMember.id]);
  assert.ok(isWorkUnitId(db.getTask(olderMember.id)?.workUnitId));
  assert.equal(db.getTask(later)?.workUnitId, db.getTask(olderMember.id)?.workUnitId);
});

test("a resident run has no work unit, at creation and after a dispatch attempt", async () => {
  const { registry, tasks, app } = fixture();
  const taskId = randomUUID();
  const resident = tasks.create(
    { repoRoot: repo, intent: "Hold the role", title: "Resident", kind: "resident", agent: "claude", backlog: false },
    { id: taskId, resident: { runId: `run-${taskId}` } },
    RESIDENT_LAUNCH_TASK_CREATE,
  );
  assert.equal(resident.workUnitId, null);
  const refused = await tasks.dispatch(taskId);
  assert.equal(refused.ok, false);
  assert.equal(db.getTask(taskId)?.workUnitId, null);
  assert.equal(registry.getTask(taskId)?.workUnitId, null);

  // A task a resident's session files gets its own; asking to inherit from it is refused.
  const session = runOnSession(registry, resident);
  const filed = await mcpCreate(app, session);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.ok(isWorkUnitId(filed.body.workUnitId));
  const inherit = await mcpCreate(app, session, { workUnit: "inherit" });
  assert.equal(inherit.status, 409);
  assert.match(String(inherit.body.error), /resident run has no work unit/);
  // An automatic inheritor whose source has none by kind gets a new one rather than failing.
  const auto = tasks.create({
    repoRoot: repo, intent: "Follow up", title: "Follow up", kind: "ship", agent: "claude",
    workflowId: null, backlog: true,
  }, undefined, undefined, undefined, { inherit: [taskId] });
  assert.ok(isWorkUnitId(auto.workUnitId));
});

test("two operations initialize the same older task: both use the one id that was stored", async () => {
  // A child inheriting and a dispatch reach an older task together. The child's creation gives
  // it an id; the dispatch, holding a copy read before that, must launch with the stored id
  // and not mint its own.
  const older = olderTask();
  const { registry, tasks, launched } = fixture(new Registry());
  const stale = registry.getTask(older.id)!;
  assert.equal(stale.workUnitId, null);
  const child = tasks.create({
    repoRoot: repo, intent: "Child", title: "Child", kind: "ship", agent: "claude",
    workflowId: null, backlog: true,
  }, undefined, undefined, undefined, { inherit: [older.id] });
  const ensured = tasks.ensureWorkUnit(stale);
  assert.equal(ensured.workUnitId, child.workUnitId, "the stale copy reads the stored id back");
  await tasks.dispatch(older.id);
  assert.deepEqual(launched, [{ id: older.id, storedWorkUnitId: child.workUnitId }]);

  // The other order, with the database written by an operation this manager never saw - a
  // copy on the board still reading null. The assign uses the stored id, not one it minted.
  const second = olderTask();
  const raced = fixture(new Registry());
  const winner = mintWorkUnitId();
  assert.equal(db.claimTaskWorkUnitId(second.id, winner), winner);
  assert.equal(raced.registry.getTask(second.id)?.workUnitId, null, "the board copy is stale");
  await raced.tasks.assign(second.id, "no-such-session");
  assert.equal(raced.registry.getTask(second.id)?.workUnitId, winner);
  const inheritor = raced.tasks.create({
    repoRoot: repo, intent: "Late child", title: "Late child", kind: "ship", agent: "claude",
    workflowId: null, backlog: true,
  }, undefined, undefined, undefined, { inherit: [second.id] });
  assert.equal(inheritor.workUnitId, winner);
  assert.equal(db.getTask(second.id)?.workUnitId, winner);
});

test("a supplied id is used as given, and a malformed one is refused before anything is written", () => {
  const { tasks } = fixture();
  const supplied = mintWorkUnitId();
  const base = {
    repoRoot: repo, intent: "Handed off", title: "Handed off", kind: "ship" as const, agent: "claude" as const,
    workflowId: null, backlog: true,
  };
  const task = tasks.create(base, undefined, undefined, undefined, { supplied });
  assert.equal(task.workUnitId, supplied);
  const before = db.listTasks().length;
  assert.throws(() => tasks.create(base, undefined, undefined, undefined, { supplied: "wu_bad" }), TypeError);
  assert.equal(db.listTasks().length, before);
});

test("the task reads carry the id, and list filters to exactly one work unit", async () => {
  const { registry, tasks, app } = fixture();
  const plan = backlogTask(tasks, { kind: "plan" });
  const session = runOnSession(registry, plan);
  const phases = [await mcpCreate(app, session), await mcpCreate(app, session)];
  await mcpCreate(app, session, { workUnit: "new" });
  backlogTask(tasks);

  const got = await mcpPost(app, "/mcp/tasks/get", { taskId: phases[0]!.body.id });
  assert.equal(got.status, 200);
  assert.equal(got.body.workUnitId, plan.workUnitId);

  const listed = await mcpPost(app, "/mcp/tasks/list", { workUnitId: plan.workUnitId, limit: 100 });
  assert.equal(listed.status, 200);
  const ids = (listed.body.tasks as Task[]).map((task) => task.id).sort();
  assert.deepEqual(ids, [plan.id, ...phases.map((phase) => phase.body.id)].sort());
  for (const task of listed.body.tasks as Task[]) assert.equal(task.workUnitId, plan.workUnitId);

  // Paging keeps the filter: a cursor from this filter is refused under another.
  const page = await mcpPost(app, "/mcp/tasks/list", { workUnitId: plan.workUnitId, limit: 1 });
  assert.ok(page.body.nextCursor);
  const changed = await mcpPost(app, "/mcp/tasks/list", { workUnitId: mintWorkUnitId(), cursor: page.body.nextCursor });
  assert.equal(changed.status, 400);

  for (const bad of ["wu_lowercase", "not-an-id", plan.workUnitId!.toLowerCase(), ""]) {
    const refused = await mcpPost(app, "/mcp/tasks/list", { workUnitId: bad });
    assert.equal(refused.status, 400, bad);
  }

  const board = await app.request("/api/tasks", { headers: { host: "127.0.0.1:7317" } });
  const text = await board.text();
  assert.equal(board.status, 200, text);
  const all = JSON.parse(text) as Task[];
  assert.equal(all.find((task) => task.id === plan.id)?.workUnitId, plan.workUnitId, "GET /api/tasks returns it");
});

test("overlapping operations that both read an older task as null all use the first stored id", async () => {
  // One manager's read and claim run in a single synchronous step, so the overlap that can
  // actually happen is between copies read before either write: here, two managers over one
  // database, each holding the older task read as null. Each operation is started and held, so
  // both are in flight on a null copy; then they are released one at a time, in both orders.
  for (const order of ["dispatch first", "child first"] as const) {
    const older = olderTask();
    const a = fixture(new Registry());
    const b = fixture(new Registry());
    assert.equal(a.registry.getTask(older.id)?.workUnitId, null);
    assert.equal(b.registry.getTask(older.id)?.workUnitId, null);

    let releaseDispatch!: () => void;
    let releaseChild!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    // `dispatch` waits on any in-flight titling for the task before it reads it: hold it there.
    (a.tasks as unknown as { titling: Map<string, Promise<void>> }).titling.set(older.id, dispatchGate);
    const dispatching = a.tasks.dispatch(older.id);
    const inheriting = (async () => {
      await childGate;
      return b.tasks.create({
        repoRoot: repo, intent: "Child", title: "Child", kind: "ship", agent: "claude",
        workflowId: null, backlog: true,
      }, undefined, undefined, undefined, { inherit: [older.id] });
    })();
    // Both are in flight and neither has written.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(db.getTask(older.id)?.workUnitId, null, `${order}: nothing stored while both are held`);

    if (order === "dispatch first") { releaseDispatch(); await dispatching; releaseChild(); }
    else { releaseChild(); await inheriting; releaseDispatch(); }
    const [dispatched, child] = await Promise.all([dispatching, inheriting]);

    const stored = db.getTask(older.id)?.workUnitId;
    assert.ok(isWorkUnitId(stored), order);
    assert.equal(dispatched.ok, true, order);
    assert.deepEqual(a.launched, [{ id: older.id, storedWorkUnitId: stored }], `${order}: the launch read the stored id`);
    assert.equal(dispatched.task?.workUnitId, stored, `${order}: the dispatch used the stored id`);
    assert.equal(child.workUnitId, stored, `${order}: the child copied the stored id`);
    assert.equal(a.registry.getTask(older.id)?.workUnitId, stored, `${order}: board A shows it`);
    assert.equal(b.registry.getTask(older.id)?.workUnitId, stored, `${order}: board B shows it`);
  }
});
