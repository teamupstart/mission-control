// Task reads over HTTP with a shaping record: `GET /api/tasks`, the shaping route behind its
// flag, and the MCP task read the `get_task` and `list_tasks` tools return. Each shows a record
// only while it names the task's current session.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-task-shaping-http-"));
process.env.MISSION_HOME = home;
const { closeDb } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
type TaskShaping = import("../src/shared/shaping.ts").TaskShaping;

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const registry = new Registry();
const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
const setFlag = (enabled: boolean) => assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "task-shaping", enabled }).ok, true);

function record(sessionId: string): TaskShaping {
  return {
    state: "degraded", at: 5, sessionId, durationMs: 5000, entries: 1, bytes: 80, truncated: false,
    shapers: [{
      id: "acme-guidance", label: "Acme guidance", stage: "select", origin: "registered", sha256: null,
      outcome: "timed_out", reason: "Timed out after 5 s.", durationMs: 5000, entries: 0, bytes: 0,
      truncated: false, redacted: false, version: null,
    }],
  };
}

beforeEach(() => setFlag(true));

/** A running task on `sessionId` whose stored record names `recordSession`. */
function seed(id: string, sessionId: string, recordSession: string): void {
  registry.upsertTask(mkTask({ id, status: "running", sessionId }));
  assert.equal(registry.commitTaskShaping(id, record(recordSession), "## Task context\n\nbody"), true);
}

const tasksRead = async () => (await (await app.request("/api/tasks", { headers })).json()) as Array<{ id: string; shaping?: TaskShaping }>;
const mcpGet = (taskId: string) => app.request("/mcp/tasks/get", {
  method: "POST", headers: { ...headers, "x-harness-token": ensureToken() }, body: JSON.stringify({ taskId }),
});

test("a record that names the current session is in every read, and the route returns its text", async () => {
  seed("current", "s1", "s1");
  const listed = (await tasksRead()).find((task) => task.id === "current");
  assert.equal(listed?.shaping?.sessionId, "s1");
  const route = await app.request("/api/tasks/current/shaping", { headers });
  assert.equal(route.status, 200);
  assert.deepEqual(await route.json(), { summary: record("s1"), text: "## Task context\n\nbody" });
  const mcp = (await (await mcpGet("current")).json()) as { shaping?: TaskShaping };
  assert.equal(mcp.shaping?.sessionId, "s1");
});

test("a record that names another session is omitted by every read", async () => {
  seed("stale", "s2", "s1");
  const listed = (await tasksRead()).find((task) => task.id === "stale");
  assert.ok(listed);
  assert.equal("shaping" in listed, false);
  const route = await app.request("/api/tasks/stale/shaping", { headers });
  assert.equal(route.status, 404);
  assert.equal(((await route.json()) as { error: string }).error, "no_shaping");
  const mcp = (await (await mcpGet("stale")).json()) as Record<string, unknown>;
  assert.equal("shaping" in mcp, false);
});

test("the shaping route answers 404 with the flag off, and for an unknown task", async () => {
  seed("gated", "s1", "s1");
  setFlag(false);
  const gated = await app.request("/api/tasks/gated/shaping", { headers });
  assert.equal(gated.status, 404);
  assert.equal(((await gated.json()) as { feature?: string }).feature, "task-shaping");
  setFlag(true);
  assert.equal((await app.request("/api/tasks/nope/shaping", { headers })).status, 404);
});

test("with the flag off, task reads and MCP reads hide a saved record without deleting it", async () => {
  seed("flag-off", "s1", "s1");
  setFlag(false);
  try {
    const listed = (await tasksRead()).find((task) => task.id === "flag-off");
    assert.ok(listed);
    assert.equal("shaping" in listed, false);
    const mcp = (await (await mcpGet("flag-off")).json()) as Record<string, unknown>;
    assert.equal("shaping" in mcp, false);
  } finally {
    setFlag(true);
  }
  const back = (await tasksRead()).find((task) => task.id === "flag-off");
  assert.equal(back?.shaping?.sessionId, "s1", "turning the flag back on shows it again");
});
