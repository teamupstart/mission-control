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
  assert.equal((await act("answer", "send-now")).status, 409);
  assert.equal(answers()[0]?.text, "SQLite");
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
  assert.equal(windows.target([q]), undefined);
  await say("reply, option B");
  assert.deepEqual(answers(), []);
  t.mock.timers.tick(10_000);
  assert.equal(windows.target([q]), undefined);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  await say("Steve, check the build");
  assert.deepEqual(answers(), []);
});

test("a reload after a backward clock adjustment restores focus and rejects older reports", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const windows = registry.voiceRouter!.openCards;
  const close = windows.connect("previous");
  const closeOlder = windows.connect("delayed");
  const report = (windowId: string, stamp: number) => windows.report({ windowId, focused: true, cards: [] }, stamp);
  assert.ok(report("previous", now * 1000));
  close();
  t.mock.timers.tick(10_001);
  t.mock.timers.setTime(now - 60_000);
  t.after(windows.connect("reloaded"));
  t.after(windows.connect("other-reload"));
  assert.ok(report("reloaded", Date.now() * 1000 + 30));
  assert.ok(report("other-reload", Date.now() * 1000 + 10));
  assert.equal(windows.dashboard, "reloaded");
  assert.ok(report("delayed", (now - 1) * 1000));
  assert.equal(windows.dashboard, "reloaded");
  closeOlder();
});
