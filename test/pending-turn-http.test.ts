import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-pending-turn-http-"));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

let fixtureSerial = 0;

function fixture() {
  fixtureSerial += 1;
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: `sdk:pending-http:${fixtureSerial}`,
    agent: "claude",
    name: "pending routes",
    cwd: "/repo/http",
    agentSessionId: `agent:pending-http:${fixtureSerial}`,
  });
  const direct: string[] = [];
  const supervisor = {
    send: async (_id: string, turn: { text: string }) => {
      direct.push(turn.text);
      return "started" as const;
    },
    sendWhenIdle: async () => "started" as const,
  } as unknown as SdkSupervisor;
  const pending = new PendingTurnManager(registry, supervisor, { idleSettleMs: 0 });
  pending.start();
  const app = buildApp(
    registry,
    {} as ReviewManager,
    {} as TaskManager,
    {} as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisor,
    undefined,
    undefined,
    undefined,
    pending,
  );
  return { registry, session, direct, pending, app };
}

test("send returns the full durable pending row instead of an opaque queued indicator", async () => {
  const f = fixture();
  const response = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "show this entire message",
    submit: true,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    delivery: string;
    pendingTurn: { id: string; text: string; state: string; revision: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.delivery, "pending");
  assert.equal(body.pendingTurn.text, "show this entire message");
  assert.equal(body.pendingTurn.state, "queued");
  assert.equal(f.registry.getSession(f.session.id)?.pendingTurns[0]?.id, body.pendingTurn.id);
  f.pending.stop();
});

test("human inject buffers by default while an explicit workflow boundary stays direct", async () => {
  const f = fixture();
  const buffered = await post(f.app, `/api/sessions/${f.session.id}/inject`, {
    text: "free-form reply",
  });
  assert.equal(buffered.status, 200);
  assert.equal(((await buffered.json()) as { delivery: string }).delivery, "pending");
  assert.deepEqual(f.direct, []);

  const direct = await post(f.app, `/api/sessions/${f.session.id}/inject`, {
    text: "work queue wrap-up",
    buffer: false,
  });
  assert.equal(direct.status, 200);
  assert.equal(((await direct.json()) as { delivery: string }).delivery, "started");
  assert.deepEqual(f.direct, ["work queue wrap-up"]);
  f.pending.stop();
});

test("recall is a CAS mutation and returns the exact message text", async () => {
  const f = fixture();
  const sent = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "line one\nline two",
  });
  const pendingTurn = ((await sent.json()) as {
    pendingTurn: { id: string; revision: number };
  }).pendingTurn;

  const stale = await post(
    f.app,
    `/api/sessions/${f.session.id}/pending-turns/${pendingTurn.id}/recall`,
    { revision: pendingTurn.revision + 1 },
  );
  assert.equal(stale.status, 409);
  assert.equal(f.registry.getSession(f.session.id)?.pendingTurns.length, 1);

  const recalled = await post(
    f.app,
    `/api/sessions/${f.session.id}/pending-turns/${pendingTurn.id}/recall`,
    { revision: pendingTurn.revision },
  );
  assert.equal(recalled.status, 200);
  assert.deepEqual(await recalled.json(), { ok: true, text: "line one\nline two" });
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns, []);
  f.pending.stop();
});

test("pending-turn mutations reject malformed revisions before touching state", async () => {
  const f = fixture();
  const sent = await post(f.app, `/api/sessions/${f.session.id}/send`, { text: "keep me" });
  const id = ((await sent.json()) as { pendingTurn: { id: string } }).pendingTurn.id;
  const response = await post(
    f.app,
    `/api/sessions/${f.session.id}/pending-turns/${id}/recall`,
    { revision: -1 },
  );
  assert.equal(response.status, 400);
  assert.equal(f.registry.getSession(f.session.id)?.pendingTurns[0]?.text, "keep me");
  f.pending.stop();
});
