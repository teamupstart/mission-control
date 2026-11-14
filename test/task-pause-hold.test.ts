import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Task } from "../src/shared/types.ts";

// What is at stake: Pause all and priority hold the backlog autopilot's launches, and a person's
// own launches go through. The hold has its OWN override, separate from the parked-task one,
// because the two are different decisions: launching a parked task is not consent to launch
// during a pause, and launching during a pause is not consent to start a parked task. A Foreman
// worker that claims neither is held by both, which is what stops one older than this change.

const home = mkdtempSync(join(tmpdir(), "mission-task-pause-hold-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const HELD = "everything is paused - automatic launches are held until you resume";
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function setup(over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry, undefined, undefined, undefined, undefined, {}, undefined, undefined, {
    launchHoldReason: () => HELD,
    releaseNow: () => null,
  });
  registry.upsertTask(mkTask({ id: "t1", status: "backlog", ...over }));
  let launches = 0;
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher.dispatch = async () => {
    launches++;
  };
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = HEADERS) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { tasks, post, launches: () => launches };
}

test("a launch that claims no override is held - the autopilot's case", async () => {
  const { post, launches } = setup();
  const dispatch = await post("/api/tasks/t1/dispatch", {});
  assert.equal(dispatch.status, 409);
  assert.match((await dispatch.json() as { error: string }).error, /automatic launches are held/);
  const assign = await post("/api/tasks/t1/assign", { sessionId: "missing-session" });
  assert.equal(assign.status, 409);
  assert.match((await assign.json() as { error: string }).error, /automatic launches are held/);
  assert.equal(launches(), 0);
});

test("the parked-task override does not lift the pause hold", async () => {
  const { post, launches } = setup();
  const dispatch = await post("/api/tasks/t1/dispatch", { overrideDisabled: true });
  assert.equal(dispatch.status, 409);
  assert.match((await dispatch.json() as { error: string }).error, /automatic launches are held/);
  const assign = await post("/api/tasks/t1/assign", { sessionId: "missing-session", overrideDisabled: true });
  assert.equal(assign.status, 409);
  assert.match((await assign.json() as { error: string }).error, /automatic launches are held/);
  assert.equal(launches(), 0);
});

test("the pause override does not start a parked task", async () => {
  const { post, launches } = setup({ enabled: false });
  const dispatch = await post("/api/tasks/t1/dispatch", { overridePauseHold: true });
  assert.equal(dispatch.status, 409);
  assert.match((await dispatch.json() as { error: string }).error, /disabled/);
  assert.equal(launches(), 0);
});

test("a person's launch claims the pause override and goes through", async () => {
  const { post, launches } = setup();
  const dispatch = await post("/api/tasks/t1/dispatch", { overridePauseHold: true });
  assert.equal(dispatch.status, 200);
  assert.equal(launches(), 1);
  const parked = setup({ enabled: false });
  const both = await parked.post("/api/tasks/t1/dispatch", { overrideDisabled: true, overridePauseHold: true });
  assert.equal(both.status, 200, "a parked task during a pause needs both claims");
  assert.equal(parked.launches(), 1);
});

test("an agent's dispatch through MCP cannot lift the pause hold for itself", async () => {
  const { post, launches } = setup();
  // Authenticated as an agent is, with the daemon token, and claiming the override anyway.
  const res = await post("/mcp/tasks/t1/dispatch", { overridePauseHold: true }, { ...HEADERS, "x-harness-token": ensureToken() });
  assert.equal(res.status, 409);
  assert.match((await res.json() as { error: string }).error, /automatic launches are held/);
  assert.equal(launches(), 0);
  // The tool does not even offer the field to the agent.
  const mcp = await readFile(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  assert.match(mcp, /DispatchBacklogTaskSchema\.omit\(\{ overridePauseHold: true \}\)\.shape/);
});

test("the dashboard claims the pause override, and Foreman's client never does", async () => {
  const api = await readFile(new URL("../src/web/lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /\/dispatch`, \{ overrideDisabled, overridePauseHold: true \}/);
  assert.match(api, /overridePauseHold: true,\n\s+confirmReset,/);
  const foreman = await readFile(new URL("../src/server/foreman/client.ts", import.meta.url), "utf8");
  assert.ok(!foreman.includes("overridePauseHold"), "the backlog autopilot must never lift the hold it is gated by");
});
