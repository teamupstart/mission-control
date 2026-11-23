/**
 * What is at stake: a Stuck row's Nudge, Continue and Tell it to push send words the operator
 * adopted, and send them as the DAEMON's words. A fixed message recorded as the operator's would
 * be captured as the session's Goal and journaled as something the operator said. The route is
 * also behind the `inbox` flag, like every other part of Stuck rows.
 */
import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-inbox-message-http-"));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { originOf } = await import("../src/server/injections.ts");
const { INBOX_MESSAGES, INBOX_MESSAGE_TURN_PREFIX } = await import("../src/shared/inbox.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function setInbox(enabled: boolean): void {
  const result = applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled });
  assert.equal(result.ok, true);
}

let serial = 0;

function fixture() {
  serial += 1;
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: `sdk:inbox-message:${serial}`,
    agent: "claude",
    name: "stuck session",
    cwd: "/repo/stuck",
    agentSessionId: `agent:inbox-message:${serial}`,
  });
  const sent: string[] = [];
  const supervisor = {
    ...unexpectedActiveSdkDelivery,
    send: async (_id: string, turn: { text: string }) => {
      sent.push(turn.text);
      return "started" as const;
    },
    sendWhenIdle: async (_id: string, turn: { text: string }) => {
      sent.push(turn.text);
      return "started" as const;
    },
  } as unknown as SdkSupervisor;
  const pending = new PendingTurnManager(registry, supervisor, { idleSettleMs: 0 });
  pending.start();
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    sdkSessions: supervisor,
    pendingTurns: pending,
  });
  const post = (body: unknown) => app.request(`/api/sessions/${encodeURIComponent(session.id)}/inbox-message`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { registry, session, sent, pending, post, app };
}

async function settles(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("with the inbox flag off the route refuses and queues nothing", async () => {
  setInbox(false);
  const f = fixture();
  const response = await f.post({ kind: "nudge" });
  assert.equal(response.status, 403);
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns, []);
  f.pending.stop();
});

test("each kind queues its fixed text under the daemon-written prefix", async () => {
  setInbox(true);
  for (const kind of ["nudge", "continue", "push"] as const) {
    const f = fixture();
    const response = await f.post({ kind });
    assert.equal(response.status, 200, kind);
    const body = (await response.json()) as { ok: boolean; pendingTurn: { id: string; text: string } };
    assert.equal(body.ok, true);
    assert.equal(body.pendingTurn.text, INBOX_MESSAGES[kind]);
    assert.ok(body.pendingTurn.id.startsWith(INBOX_MESSAGE_TURN_PREFIX), body.pendingTurn.id);
    f.pending.stop();
  }
  assert.match(INBOX_MESSAGES.nudge, /^Status check from your operator: you have gone quiet\./);
  assert.match(INBOX_MESSAGES.continue, /^Your operator asks you to continue\./);
  assert.equal(INBOX_MESSAGES.push, "Push your commits. The review is waiting for a pushed head on this branch.");
});

test("a delivered fixed message is the daemon's words, never the operator's Goal", async () => {
  setInbox(true);
  const f = fixture();
  f.registry.applyDriverEvent(f.session.id, { kind: "state", state: "idle", activity: null });
  const response = await f.post({ kind: "continue" });
  assert.equal(response.status, 200);
  await settles(() => (f.registry.getSession(f.session.id)?.pendingTurns.length ?? 1) === 0);
  assert.deepEqual(f.sent, [INBOX_MESSAGES.continue], "delivered once");
  assert.equal(originOf(f.session.id, INBOX_MESSAGES.continue), "harness");
  assert.equal(f.registry.getGoal(f.session.id), null, "never captured as the operator's Goal");
  f.pending.stop();
});

test("the route takes a kind, never free text, and needs a session", async () => {
  setInbox(true);
  const f = fixture();
  assert.equal((await f.post({ kind: "cancel" })).status, 400);
  assert.equal((await f.post({ text: "anything" })).status, 400);
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns, []);
  const missing = await f.app.request("/api/sessions/nope/inbox-message", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ kind: "nudge" }),
  });
  assert.equal(missing.status, 404);
  f.pending.stop();
});

test("the operator's own submit never carries the daemon-written mark, even with the same words", async () => {
  setInbox(true);
  const f = fixture();
  const typed = f.pending.submit(f.session.id, INBOX_MESSAGES.nudge);
  assert.equal(typed.ok, true);
  assert.ok(typed.ok && typed.pendingTurn && !typed.pendingTurn.id.startsWith(INBOX_MESSAGE_TURN_PREFIX));
  const fixed = f.pending.submitInboxMessage(f.session.id, "nudge");
  assert.ok(fixed.ok && fixed.pendingTurn?.id.startsWith(INBOX_MESSAGE_TURN_PREFIX));
  assert.equal(fixed.ok && fixed.pendingTurn?.text, INBOX_MESSAGES.nudge);
  f.pending.stop();
});

test("without a pending-turn outbox the route answers 503 and sends nothing", async () => {
  setInbox(true);
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: "sdk:inbox-message:no-outbox",
    agent: "claude",
    name: "no outbox",
    cwd: "/repo/no-outbox",
    agentSessionId: "agent:inbox-message:no-outbox",
  });
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
  const response = await app.request(`/api/sessions/${encodeURIComponent(session.id)}/inbox-message`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ kind: "nudge" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "pending turns are unavailable" });
  assert.deepEqual(registry.getSession(session.id)?.pendingTurns, []);
});
