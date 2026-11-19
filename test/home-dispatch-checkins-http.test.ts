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
  const refused = await handleCheckin(caller, { readInbox: async () => ({ status: 501, body: { error: "not implemented" } }) });
  assert.equal(refused.status, 501);
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
