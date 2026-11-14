import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PauseState, SessionPause } from "../src/shared/pause.ts";
import type { Session } from "../src/shared/types.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import { PauseManager } from "../src/server/pause/manager.ts";

// What is at stake: these routes stop and start real processes. An agent's token must never
// reach them - an agent pausing its peers, or lifting its own pause, defeats both - and a
// malformed request must be refused before anything is signalled.

const home = mkdtempSync(join(tmpdir(), "mission-pause-routes-"));
process.env.HARNESS_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function harness() {
  const sessions = new Map<string, Session>([["s1", { id: "s1", state: "working", runtime: "terminal", pid: 5 } as Session]]);
  const pauses = new Map<string, SessionPause | null>();
  const fleet: PauseState[] = [];
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry: {
      getSession: (id) => {
        const s = sessions.get(id);
        return s ? { ...s, pause: pauses.get(id) ?? null } : undefined;
      },
      liveSessions: () => [...sessions.values()].map((s) => ({ ...s, pause: pauses.get(s.id) ?? null })),
      setSessionPause: (id, pause) => {
        pauses.set(id, pause);
        return sessions.has(id);
      },
      setSessionResumedAt: () => {},
      setPauseState: (state) => void fleet.push(state),
      subscribe: () => () => {},
      onSessionsObserved: (fn) => {
        fn();
        return () => {};
      },
    },
    freezer: {
      treeOf: async () => [5, 6].map((pid) => ({ pid, identity: pid.toString(16).padStart(64, "0") })),
      stop: (procs) => (stopped.push(procs.map((p) => p.pid)), []),
      resume: () => [],
    },
    store: { load: () => undefined, save: () => {} },
    log: () => {},
  });
  manager.start();
  const app = buildApp({
    registry: {} as unknown as Registry,
    reviews: {} as unknown as ReviewManager,
    tasks: {} as unknown as TaskManager,
    queues: {} as unknown as QueueManager,
    pauses: manager,
  });
  return { app, pauses, stopped, manager };
}

test("an agent's token or another origin is refused before anything is stopped", async () => {
  const { app, stopped } = harness();
  for (const headers of [
    { ...HEADERS, "x-harness-token": "agent" },
    { ...HEADERS, "x-mission-operation-actor": "agent" },
    { ...HEADERS, origin: "https://example.com" },
  ]) {
    for (const path of ["/api/sessions/s1/pause", "/api/sessions/s1/resume", "/api/sessions/s1/priority", "/api/pause/fleet", "/api/pause/fleet/resume", "/api/pause/priority/end"]) {
      const res = await app.request(path, { method: "POST", headers, body: "{}" });
      assert.equal(res.status, 403, `${path} with ${JSON.stringify(headers)}`);
    }
  }
  assert.deepEqual(stopped, []);
});

test("the operator pauses and resumes one session through the routes", async () => {
  const { app, pauses, stopped } = harness();
  const paused = await app.request("/api/sessions/s1/pause", { method: "POST", headers: HEADERS, body: JSON.stringify({ mode: "now" }) });
  assert.equal(paused.status, 200);
  assert.deepEqual(await paused.json(), { ok: true });
  assert.equal(pauses.get("s1")?.phase, "frozen");
  assert.deepEqual(stopped, [[5, 6]]);
  const resumed = await app.request("/api/sessions/s1/resume", { method: "POST", headers: HEADERS, body: "{}" });
  assert.equal(resumed.status, 200);
  assert.equal(pauses.get("s1"), null);
});

test("a malformed or impossible request is refused with the reason", async () => {
  const { app } = harness();
  const badMode = await app.request("/api/sessions/s1/pause", { method: "POST", headers: HEADERS, body: JSON.stringify({ mode: "forever" }) });
  assert.equal(badMode.status, 400);
  const unknown = await app.request("/api/sessions/nope/pause", { method: "POST", headers: HEADERS, body: "{}" });
  assert.equal(unknown.status, 404);
  const past = await app.request("/api/pause/fleet", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ holdDispatch: true, resumeAt: 1 }),
  });
  assert.equal(past.status, 400);
  assert.match(((await past.json()) as { error: string }).error, /future and within a week/);
});

test("a garbled body pauses nothing, while an empty one still takes the defaults", async () => {
  // Read as `{}`, a body cut off mid-flight would pause now - or pause the whole fleet with
  // launches held - which is exactly what the request did not say.
  const { app, pauses, manager } = harness();
  const garbled = await app.request("/api/sessions/s1/pause", { method: "POST", headers: HEADERS, body: "{" });
  assert.equal(garbled.status, 400);
  assert.match(((await garbled.json()) as { error: string }).error, /not valid JSON/);
  assert.equal(pauses.get("s1") ?? null, null, "nothing was paused");
  const garbledFleet = await app.request("/api/pause/fleet", { method: "POST", headers: HEADERS, body: "{\"holdDispatch\": tr" });
  assert.equal(garbledFleet.status, 400);
  assert.equal(manager.state().fleet, null, "the fleet was not paused");

  const empty = await app.request("/api/sessions/s1/pause", { method: "POST", headers: HEADERS });
  assert.equal(empty.status, 200, "no body at all is the default pause");
});

test("Pause all and its state read back through the routes", async () => {
  const { app } = harness();
  const res = await app.request("/api/pause/fleet", { method: "POST", headers: HEADERS, body: JSON.stringify({ holdDispatch: true }) });
  assert.equal(res.status, 200);
  const state = (await (await app.request("/api/pause", { headers: HEADERS })).json()) as PauseState;
  assert.equal(state.fleet?.holdDispatch, true);
  assert.equal(state.fleet?.resumeAt, null);
  await app.request("/api/pause/fleet/resume", { method: "POST", headers: HEADERS, body: "{}" });
  assert.equal(((await (await app.request("/api/pause", { headers: HEADERS })).json()) as PauseState).fleet, null);
});

test("a pause body past the cap is refused before it is read, and a body that cannot be read is not a default pause", async () => {
  const { app, pauses } = harness();
  const huge = await app.request("/api/sessions/s1/pause", { method: "POST", headers: HEADERS, body: JSON.stringify({ mode: "now", pad: "x".repeat(8192) }) });
  assert.equal(huge.status, 413);
  assert.equal(pauses.get("s1") ?? null, null, "nothing was paused");

  const { parseBody } = await import("../src/server/http-body.ts");
  const { PauseSessionRequestSchema } = await import("../src/shared/protocol.ts");
  const unreadable = {
    req: { text: () => Promise.reject(new Error("connection reset")) },
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  };
  const parsed = await parseBody(unreadable as never, PauseSessionRequestSchema, { strict: true });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? 0 : parsed.res.status, 400);
});
