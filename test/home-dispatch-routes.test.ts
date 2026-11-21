// Headless mode phase 1: every /dispatch/* route is gated by the `headless-mode` flag, answers
// 501 once it is on, and the health capability follows the flag.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Above the imports: `openDb` refuses a state dir this file did not name.
const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-routes-"));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { closeDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { HOME_DISPATCH_ROUTES } = await import("../src/shared/home-dispatch.ts");
const { DAEMON_PROTOCOL_CAPABILITIES } = await import("../src/shared/daemon-protocol.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => { setFlag(false); });

const registry = new Registry();
const app = buildApp({
  registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry),
});
const loopback = { host: "127.0.0.1:7317" };
const authed = { ...loopback, "x-harness-token": ensureToken() };

function setFlag(enabled: boolean) {
  const result = flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled });
  assert.equal(result.ok, true);
}
const concrete = (path: string) =>
  path.replace(":id", "draft-1").replace(":runId", "run-1").replace(":action", "pause").replace(":taskId", "task-1");
const call = (route: { method: string; path: string }, headers: Record<string, string>) =>
  app.request(concrete(route.path), { method: route.method, headers });

test("the registered /dispatch routes are exactly the declared table", () => {
  const registered = app.routes
    .filter((route) => route.path.startsWith("/dispatch/") && route.method !== "ALL")
    .map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(registered, HOME_DISPATCH_ROUTES.map((route) => `${route.method} ${route.path}`).sort());
  assert.equal(HOME_DISPATCH_ROUTES.length, 14);
});

test("flag off: every route answers the disabled 404, even with a token, and the capability is absent", async () => {
  for (const route of HOME_DISPATCH_ROUTES) {
    const res = await call(route, authed);
    assert.equal(res.status, 404, `${route.method} ${route.path}`);
    assert.deepEqual(await res.json(), { error: "This feature is disabled.", feature: "headless-mode" });
  }
  const health = await (await app.request("/api/health", { headers: loopback })).json() as { capabilities: string[] };
  assert.ok(!health.capabilities.includes(DAEMON_PROTOCOL_CAPABILITIES.homeDispatch));
  assert.ok(health.capabilities.includes(DAEMON_PROTOCOL_CAPABILITIES.explicitScoutFiles), "other capabilities stay");
});

// Routes a later phase has filled; they no longer answer 501. Add a path when its phase lands.
const FILLED = new Set(["/dispatch/sessions", "/dispatch/inbox", "/dispatch/answers", "/dispatch/config"]);

test("flag on: every unfilled route is 501 with a token, 401 without one and 403 off loopback", async () => {
  setFlag(true);
  for (const route of HOME_DISPATCH_ROUTES) {
    const res = await call(route, authed);
    if (FILLED.has(route.path)) {
      assert.notEqual(res.status, 501, `${route.method} ${route.path} is filled`);
    } else {
      assert.equal(res.status, 501, `${route.method} ${route.path}`);
      assert.deepEqual(await res.json(), { error: "not implemented", feature: "headless-mode" });
    }
    assert.equal((await call(route, loopback)).status, 401, `${route.path} without a token`);
    assert.equal((await call(route, { host: "evil.example", "x-harness-token": authed["x-harness-token"] })).status, 403, `${route.path} off loopback`);
  }
  const health = await (await app.request("/api/health", { headers: loopback })).json() as { capabilities: string[] };
  assert.ok(health.capabilities.includes("home-dispatch-v1"));
});

test("a flag change takes effect on the next request, in both directions, with no restart", async () => {
  const route = HOME_DISPATCH_ROUTES.find((r) => !FILLED.has(r.path))!;
  assert.equal((await call(route, authed)).status, 404);
  setFlag(true);
  assert.equal((await call(route, authed)).status, 501);
  setFlag(false);
  assert.equal((await call(route, authed)).status, 404);
});
