// F4: check-in lists what waits on the person, what runs, and what finished since the last check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-checkins-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-home-dispatch-checkins-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { closeDb } = await import("../src/server/db.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { buildCheckin, handleCheckin, resetCheckinsForTest } = await import("../src/server/home-dispatch/checkins.ts");
const { DISPATCH_FEATURE_DISABLED, InboxItemSchema } = await import("../src/shared/home-dispatch.ts");

const FLAG = "headless-mode" as const;

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});
beforeEach(() => resetCheckinsForTest());
afterEach(() => flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false }));

type State = "waiting" | "ready" | "running" | "queued" | "shelved" | "failed";
const item = (taskId: string, state: State, changedAt: number) =>
  InboxItemSchema.parse({ taskId, title: taskId, kind: "ship", state, changedAt });

const ITEMS = [
  item("w-old", "waiting", 10),
  item("w-new", "waiting", 30),
  item("run", "running", 20),
  item("done-old", "ready", 5),
  item("done-new", "ready", 40),
  item("bad-new", "failed", 50),
  item("q1", "queued", 1),
  item("q2", "queued", 2),
  item("s1", "shelved", 3),
];

test("F4 checkin lists: waiting, running and finished, newest first, queued and shelved as counts", () => {
  const all = buildCheckin(ITEMS, null);
  assert.deepEqual(all.waiting.map((i) => i.taskId), ["w-new", "w-old"]);
  assert.deepEqual(all.running.map((i) => i.taskId), ["run"]);
  assert.deepEqual(all.finished.map((i) => i.taskId), ["bad-new", "done-new", "done-old"], "a first check-in lists every finished task");
  assert.deepEqual([all.queued, all.shelved], [2, 1]);
});

test("F4 checkin lists: finished means ready or failed since the last check-in", () => {
  const since = buildCheckin(ITEMS, 40);
  assert.deepEqual(since.finished.map((i) => i.taskId), ["bad-new"], "only changes after the last check, and not the exact moment of it");
  assert.deepEqual(since.waiting.map((i) => i.taskId), ["w-new", "w-old"], "waiting is always the whole list");
  assert.deepEqual(buildCheckin([], null), { waiting: [], running: [], finished: [], queued: 0, shelved: 0 });
});

test("F4 checkin: the first call lists all finished work, the next only what changed after it", async () => {
  let now = 100;
  resetCheckinsForTest(() => now);
  const repo = realpathSync(mkdtempSync(join(repos, "r-")));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  let items = [item("old", "ready", 50), item("ask", "waiting", 60)];
  const asked: string[] = [];
  const deps = {
    readInbox: async (input: { repo: string }) => {
      asked.push(input.repo);
      return { status: 200 as const, body: { items } };
    },
  };
  const caller = { sessionId: "s1", claudePid: null, cwd: repo };
  const first = await handleCheckin(caller, deps);
  assert.equal(first.status, 200);
  assert.deepEqual((first.body as { finished: { taskId: string }[] }).finished.map((i) => i.taskId), ["old"]);
  assert.deepEqual(asked, [repo], "the inbox is read for the session's repository root");
  now = 200;
  items = [...items, item("new", "ready", 150)];
  const second = await handleCheckin(caller, deps);
  assert.deepEqual((second.body as { finished: { taskId: string }[] }).finished.map((i) => i.taskId), ["new"]);
  const other = await handleCheckin({ ...caller, sessionId: "s2" }, deps);
  assert.deepEqual((other.body as { finished: { taskId: string }[] }).finished.map((i) => i.taskId), ["new", "old"], "each session has its own last check-in");
});

test("F4 checkin: a refused inbox read passes its status through and does not record a check-in", async () => {
  let now = 100;
  resetCheckinsForTest(() => now);
  const caller = { sessionId: "s1", claudePid: null, cwd: tmpdir() };
  const refused = await handleCheckin(caller, { readInbox: async () => ({ status: 409, body: { error: "inbox unavailable" } }) });
  assert.equal(refused.status, 409);
  now = 200;
  const ok = await handleCheckin(caller, { readInbox: async () => ({ status: 200, body: { items: [item("old", "ready", 50)] } }) });
  assert.equal((ok.body as { finished: unknown[] }).finished.length, 1, "the failed read did not count as a check-in");
});

test("F4 checkin route: the flag gate answers 404 off, and the body is validated on", async () => {
  const registry = new Registry();
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() };
  const call = (body: unknown) => app.request("/mcp/dispatch/checkins", { method: "POST", headers, body: JSON.stringify(body) });
  const off = await call({ sessionId: "s1", cwd: repos });
  assert.equal(off.status, 404);
  assert.deepEqual(await off.json(), DISPATCH_FEATURE_DISABLED);
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  assert.equal((await call({ cwd: repos })).status, 400, "sessionId is required");
});

test("F4 checkin route: while the inbox handler is still a stub, the live route lists this repository's tasks", async () => {
  const { openDb } = await import("../src/server/db.ts");
  const { stampTaskOrigin } = await import("../src/server/home-dispatch/origin.ts");
  openDb().exec("DELETE FROM tasks");
  const repo = realpathSync(mkdtempSync(join(repos, "live-")));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const file = (title: string, enabled: boolean, origin: string | null) => {
    const t = tasks.create({ repoRoot: repo, intent: title, title, kind: "ship", agent: "claude", backlog: true, enabled });
    if (origin) stampTaskOrigin(t.id, { surface: "home-session", repo: origin, sessionId: "s1" });
    return t;
  };
  file("queued one", true, repo);
  file("shelved one", false, repo);
  file("not mine", true, "/somewhere/else");
  file("dashboard task", true, null);
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks, queues: new QueueManager(registry) });
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const res = await app.request("/mcp/dispatch/checkins", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ sessionId: "s1", cwd: repo }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { waiting: [], running: [], finished: [], queued: 1, shelved: 1 });
});

test("F4 checkin route: tasks are classified into waiting, running and finished, with the 7-day and 24-hour edges", async () => {
  const { openDb } = await import("../src/server/db.ts");
  const { stampTaskOrigin } = await import("../src/server/home-dispatch/origin.ts");
  openDb().exec("DELETE FROM tasks");
  const repo = realpathSync(mkdtempSync(join(repos, "classify-")));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const HOUR = 3_600_000;
  const now = Date.now();
  const file = (title: string, patch: Record<string, unknown>) => {
    const t = tasks.create({ repoRoot: repo, intent: title, title, kind: "ship", agent: "claude", backlog: true });
    stampTaskOrigin(t.id, { surface: "home-session", repo, sessionId: "s1" });
    registry.upsertTask({ ...t, ...patch } as never);
  };
  file("asking", { status: "running", sessionId: "sess-a", updatedAt: now - HOUR });
  file("working", { status: "running", sessionId: "sess-b", updatedAt: now - HOUR });
  file("starting", { status: "dispatching", updatedAt: now - HOUR });
  file("ready inside", { status: "done", completedAt: now - 6 * 24 * HOUR, updatedAt: now - 6 * 24 * HOUR, outcomeUrl: "https://example.test/pr/1" });
  file("ready outside", { status: "done", completedAt: now - 8 * 24 * HOUR, updatedAt: now - 8 * 24 * HOUR });
  file("failed inside", { status: "failed", updatedAt: now - 23 * HOUR });
  file("failed outside", { status: "failed", updatedAt: now - 25 * HOUR });
  file("cancelled inside", { status: "cancelled", updatedAt: now - HOUR });
  registry.upsertReview({
    id: "rev-1", sessionId: "sess-a", kind: "input", title: "A question", body: "Keep or drop?", status: "pending", response: null,
    createdAt: now - HOUR / 2,
    decisions: [{ id: "d1", question: "Keep or drop?", options: [{ id: "keep", label: "Keep" }, { id: "drop", label: "Drop" }] }],
  } as never);
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks, queues: new QueueManager(registry) });
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const res = await app.request("/mcp/dispatch/checkins", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({ sessionId: "s1", cwd: repo }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { waiting: any[]; running: any[]; finished: any[]; queued: number; shelved: number };
  assert.deepEqual(body.waiting.map((i) => [i.title, i.reviewId, i.question, i.options]), [["asking", "rev-1", "Keep or drop?", ["Keep", "Drop"]]]);
  assert.deepEqual(body.running.map((i) => i.title).sort(), ["starting", "working"]);
  assert.deepEqual(body.finished.map((i) => i.title).sort(), ["cancelled inside", "failed inside", "ready inside"]);
  assert.equal(body.finished.find((i) => i.title === "ready inside").pullRequestUrl, "https://example.test/pr/1");
  assert.deepEqual([body.queued, body.shelved], [0, 0]);
});
