// Headless mode phase 2: the shared fakes satisfy P1's schemas, so every later phase can build
// against them. This file tests the fakes themselves, not the code that will use them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { HOME_DISPATCH_ROUTES } from "../src/shared/home-dispatch.ts";
import {
  CANNED_ROUTES,
  FAKE_SESSION_ID,
  FAKE_TOKEN,
  ROUTE_REQUEST_SCHEMAS,
  ROUTE_RESPONSE_SCHEMAS,
  createFakeClaude,
  createFakeDaemon,
  createFakeModHost,
  type FakeRouteKey,
} from "./helpers/home-dispatch-fakes.ts";

const concrete = (path: string) =>
  path.replace(":id", "draft-1").replace(":runId", "run-1").replace(":action", "pause").replace(":taskId", "mc-91c2");
const keys = HOME_DISPATCH_ROUTES.map((r) => `${r.method} ${r.path}` as FakeRouteKey);

/** A body each POST route's request schema accepts. */
const BODIES: Partial<Record<FakeRouteKey, unknown>> = {
  "POST /dispatch/sessions": {
    sessionId: FAKE_SESSION_ID, harness: "claude", cwd: "/fake/repo", clientVersion: "2.1.329", source: "startup",
    entrypoint: null, interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
  },
  "POST /dispatch/answers": { action: "answer", taskId: "mc-91c2", reviewId: "review-1", sessionId: FAKE_SESSION_ID, option: "Keep" },
  "POST /dispatch/dispatch-options": { sessionId: FAKE_SESSION_ID, cwd: "/fake/repo", entry: "command" },
  "POST /dispatch/drafts": { sessionId: FAKE_SESSION_ID, kind: "ship" },
  "POST /dispatch/drafts/:id": { sessionId: FAKE_SESSION_ID, words: "clean up logging" },
  "POST /dispatch/drafts/:id/confirm": { sessionId: FAKE_SESSION_ID, choice: "start" },
  "POST /dispatch/residents/:runId/:action": { sessionId: FAKE_SESSION_ID },
  "POST /dispatch/tasks/:taskId/send": { sessionId: "session-worker-1", text: "hello" },
};

test("the fake daemon has a canned reply and a response schema for every /dispatch route", () => {
  assert.deepEqual(Object.keys(CANNED_ROUTES).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ROUTE_RESPONSE_SCHEMAS).sort(), [...keys].sort());
  for (const key of Object.keys(ROUTE_REQUEST_SCHEMAS)) assert.ok(key.startsWith("POST "), key);
});

for (const key of keys) {
  test(`fake daemon: ${key} serves a schema-valid reply to a schema-valid request`, async () => {
    const daemon = createFakeDaemon();
    const [method, pattern] = key.split(" ") as [string, string];
    const response = await daemon.handle(method, concrete(pattern), BODIES[key], { "x-harness-token": FAKE_TOKEN });
    assert.equal(response.status, 200);
    const schema = ROUTE_RESPONSE_SCHEMAS[key];
    if (schema) assert.equal(schema.safeParse(JSON.parse(response.text)).success, true, response.text);
    else assert.equal(response.contentType, "text/event-stream");
    const request = daemon.requests.at(-1)!;
    assert.equal(request.pattern, pattern);
    if (key === "POST /dispatch/drafts/:id/confirm") assert.equal(request.params.id, "draft-1");
  });
}

test("fake daemon: a body that does not parse is 400, a missing token 401, a flag off 404", async () => {
  const daemon = createFakeDaemon();
  const auth = { "x-harness-token": FAKE_TOKEN };
  assert.equal((await daemon.handle("POST", "/dispatch/answers", { action: "nope" }, auth)).status, 400);
  assert.equal((await daemon.handle("GET", "/dispatch/inbox")).status, 401);
  daemon.setFlag(false);
  const off = await daemon.handle("GET", "/dispatch/inbox", undefined, auth);
  assert.equal(off.status, 404);
  assert.deepEqual(JSON.parse(off.text), { error: "This feature is disabled.", feature: "headless-mode" });
  const health = JSON.parse((await daemon.handle("GET", "/api/health")).text) as { capabilities: string[] };
  assert.equal(health.capabilities.includes("home-dispatch-v1"), false);
  daemon.setFlag(true);
  const on = JSON.parse((await daemon.handle("GET", "/api/health")).text) as { service: string; capabilities: string[] };
  assert.equal(on.service, "mission-control");
  assert.equal(on.capabilities.includes("home-dispatch-v1"), true);
  daemon.setDown(true);
  await assert.rejects(daemon.handle("GET", "/api/health"), /down/);
});

test("fake daemon: a test override wins over the canned reply, and an unknown route is 404", async () => {
  const daemon = createFakeDaemon({ routes: { "GET /dispatch/inbox": () => ({ status: 409, body: { error: "x" } }) } });
  assert.equal((await daemon.handle("GET", "/dispatch/inbox", undefined, { "x-harness-token": FAKE_TOKEN })).status, 409);
  daemon.override("GET /dispatch/inbox", () => ({ body: { items: [] } }));
  assert.deepEqual(JSON.parse((await daemon.handle("GET", "/dispatch/inbox", undefined, { "x-harness-token": FAKE_TOKEN })).text), { items: [] });
  assert.equal((await daemon.handle("GET", "/nope")).status, 404);
});

test("fake daemon: serves over a loopback socket, and the fake host reaches it in process", async () => {
  const daemon = createFakeDaemon({ token: null });
  const { port, url } = await daemon.listen();
  try {
    const live = await fetch(`${url}/dispatch/config`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { launcher: { prompt: true } });
    assert.ok(port > 0);

    const fake = createFakeModHost({ daemon: createFakeDaemon() });
    const result = await fake.host.fetch("/dispatch/inbox?repo=%2Ffake%2Frepo");
    assert.equal(result.status, 200);
    assert.deepEqual(fake.fetches.map((f) => f.path), ["/dispatch/inbox?repo=%2Ffake%2Frepo"]);
  } finally {
    await daemon.close();
  }
});

const claudes: ReturnType<typeof createFakeClaude>[] = [];
after(() => { for (const c of claudes) c.cleanup(); });
const claudeAt = (c: ReturnType<typeof createFakeClaude>, ...args: string[]) =>
  spawnSync(c.path, args, { cwd: "/", encoding: "utf8" });

test("fake claude: marketplace add, install, list, uninstall and a settable installed version", () => {
  const fake = createFakeClaude({ stagedVersion: "2.3.0" });
  claudes.push(fake);
  assert.equal(claudeAt(fake, "plugin", "list").stdout, "");
  assert.equal(claudeAt(fake, "plugin", "marketplace", "add", "/state/mod").status, 0);
  assert.deepEqual(fake.state().marketplaces, ["/state/mod"]);
  assert.equal(claudeAt(fake, "plugin", "install", "mission-control@mission-control", "--scope", "user").status, 0);
  assert.equal(claudeAt(fake, "plugin", "list").stdout, "mission-control@mission-control (2.3.0, user, enabled)\n");
  assert.deepEqual(JSON.parse(claudeAt(fake, "plugin", "list", "--json").stdout), [
    { id: "mission-control@mission-control", version: "2.3.0", scope: "user", enabled: true },
  ]);
  fake.setInstalledVersion("2.2.0");
  assert.match(claudeAt(fake, "plugin", "list").stdout, /\(2\.2\.0, user, enabled\)/);
  assert.equal(claudeAt(fake, "plugin", "uninstall", "mission-control@mission-control").status, 0);
  assert.equal(claudeAt(fake, "plugin", "list").stdout, "");
  assert.equal(claudeAt(fake, "plugin", "validate", "/x").status, 0);
  assert.equal(claudeAt(fake, "plugin", "test", "/x").status, 0);
});

