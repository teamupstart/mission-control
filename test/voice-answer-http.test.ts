import assert from "node:assert/strict";
import test from "node:test";
import { act, applyFeatureFlagIntent, post, registry, say } from "./helpers/voice-http.ts";
import { answers, put, question, show } from "./helpers/voice-question.ts";

test("the deadline resolves through the human click path, correction restarts it", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const q = question();
  await show([q.id]);
  await say("Steve, option B", "answer");
  t.mock.timers.tick(500);
  await say("no, A");
  t.mock.timers.tick(501);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  t.mock.timers.tick(500);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(registry.getReview(q.id)?.status, "answered");
  assert.deepEqual(registry.getReview(q.id)?.selections, [{ decisionId: "q", selected: ["sqlite"], other: null }]);
  assert.match(registry.getReview(q.id)!.response!, /SQLite/);
  assert.equal((await act("answer", "send-now")).status, 409);
});

test("window off resolves immediately, a competing human answer survives a late send", async () => {
  const first = question();
  await say("Steve, option B", "late");
  await post("/api/reviews/" + first.id + "/resolve", { action: "answer", response: "by click" });
  await act("late", "send-now");
  assert.equal(registry.getReview(first.id)?.response, "by click");
  assert.deepEqual(answers(), []);
  const next = question();
  await put("/api/voice/config", { cancelWindow: { enabled: false } });
  await say("Steve, option A");
  assert.equal(registry.getReview(next.id)?.status, "answered");
  assert.deepEqual(answers(), []);
});

test("disconnected windows cannot claim cards and the disabled preview refuses reports", async () => {
  const body = { windowId: "unconnected", focused: true, cards: [] };
  assert.equal((await put("/api/voice/open-cards", body)).status, 409);
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  assert.equal((await put("/api/voice/open-cards", body)).status, 404);
});

test("a closed stream loses its open cards after the disconnect grace period", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const q = question();
  const windows = registry.voiceRouter!.openCards;
  const close = windows.connect("dashboard");
  await put("/api/voice/open-cards", { windowId: "dashboard", focused: true, cards: [{ kind: "question", id: q.id, focused: true }] });
  close();
  assert.equal(windows.dashboard, undefined);
  assert.equal(windows.target([q])?.id, q.id);
  t.mock.timers.tick(10_000);
  assert.equal(windows.target([q]), undefined);
  await say("Steve, check the build");
  assert.deepEqual(answers(), []);
});
