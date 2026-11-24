import assert from "node:assert/strict";
import test from "node:test";
import { act, app, applyFeatureFlagIntent, post, registry, say } from "./helpers/voice-http.ts";
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

test("a wall-clock jump during the countdown preserves a correction until its monotonic deadline", async t => {
  let wall = Date.now();
  let elapsed = Math.floor(performance.now());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => elapsed);
  const q = question();
  await say("Steve, option B", "before-jump");
  elapsed += 400;
  t.mock.timers.tick(400);
  wall += 60_000;
  await say("no, A", "after-jump");
  assert.equal(answers()[0]?.text, "SQLite");
  elapsed += 600;
  t.mock.timers.tick(600);
  assert.equal(registry.getReview(q.id)?.status, "pending");
  // Delay the timer callback past the corrected deadline. Wall time alone
  // would still admit another correction, since the wall clock is stationary.
  elapsed += 400;
  await say("no, B", "expired");
  assert.equal(answers()[0]?.id, "after-jump");
  t.mock.timers.tick(400);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(registry.getReview(q.id)?.selections?.[0]?.selected, ["sqlite"]);
});

test("window off resolves immediately, a competing human answer survives a late send", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const first = question();
  await say("Steve, option B", "late");
  await post("/api/reviews/" + first.id + "/resolve", { action: "answer", response: "by click" });
  await act("late", "send-now");
  assert.equal(registry.getReview(first.id)?.response, "by click");
  assert.deepEqual(answers(), []);
  t.mock.timers.tick(1);
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
  let monotonicMs = now - performance.timeOrigin;
  t.mock.method(performance, "now", () => monotonicMs);
  const windows = registry.voiceRouter!.openCards;
  const close = windows.connect("previous");
  const closeOlder = windows.connect("delayed");
  const report = (windowId: string, stamp: number) => windows.report({ windowId, focused: true, cards: [] }, { focusAtUs: stamp });
  assert.ok(report("previous", now * 1000));
  close();
  monotonicMs += 10_001;
  t.mock.timers.tick(10_001);
  t.mock.timers.setTime(now - 60_000);
  t.after(windows.connect("reloaded"));
  t.after(windows.connect("other-reload"));
  assert.ok(report("reloaded", Date.now() * 1000 + 30));
  assert.ok(report("other-reload", Date.now() * 1000 + 10));
  assert.equal(windows.dashboard, "reloaded");
  // This observation was newer than the original focus, but predates both reloads.
  assert.ok(report("delayed", (now + 1) * 1000));
  assert.equal(windows.dashboard, "reloaded");
  closeOlder();
});

test("restarting voice after a backward clock change preserves the connected dashboard’s timestamps", async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const mono = performance.now();
  t.mock.method(performance, "now", () => mono);
  const q = question();
  const windows = registry.voiceRouter!.openCards;
  t.after(windows.connect("surviving"));
  const stamp = Math.floor((performance.timeOrigin + mono) * 1000);
  const report = (revision: number) => put("/api/voice/open-cards", { windowId: "surviving", focused: true,
    cards: [{ kind: "question", id: q.id, focused: true }] },
  { "x-voice-focus-at-us": String(stamp), "x-voice-report-revision": String(revision) });
  assert.equal((await report(1)).status, 200);
  t.mock.timers.setTime(now - 60_000);
  windows.clear();
  assert.equal((await report(2)).status, 200);
  assert.equal(windows.footerOwner(q.id), "surviving");
  assert.equal(windows.target([q])?.id, q.id);
});

test("withdrawing a dashboard rejects late reports and a newer dashboard report supersedes a late withdrawal", async t => {
  const q = question();
  const windowId = "role-change";
  const windows = registry.voiceRouter!.openCards;
  t.after(windows.connect(windowId));
  const report = (revision: number, withdraw = false) => put("/api/voice/open-cards" + (withdraw ? "?withdraw=1" : ""),
    { windowId, focused: !withdraw, cards: withdraw ? [] : [{ kind: "question", id: q.id, focused: true }] },
    { "x-voice-focus-at-us": "100", "x-voice-report-revision": String(revision) });
  await report(1);
  assert.equal(windows.target([q])?.id, q.id);
  await report(3, true);
  await report(2);
  assert.equal(windows.dashboard, undefined);
  assert.equal(windows.target([q]), undefined);
  await report(5);
  await report(4, true);
  assert.equal(windows.dashboard, windowId);
  assert.equal(windows.target([q])?.id, q.id);
});

test("a future focus timestamp cannot prevent another live dashboard taking over the countdown", async t => {
  const q = question();
  const windows = registry.voiceRouter!.openCards;
  const leave = windows.connect("initial");
  t.after(windows.connect("already-connected"));
  const report = (windowId: string, stamp: number) => put("/api/voice/open-cards", {
    windowId, focused: true, cards: [{ kind: "question", id: q.id, focused: true }],
  }, { "x-voice-focus-at-us": String(stamp) });
  const now = Date.now() * 1000;
  assert.equal((await report("initial", now)).status, 200);
  await say("Steve, option B");
  const [answer] = answers();
  assert.equal(answer?.footerWindowId, "initial");
  assert.equal((await report("initial", now + 60_000_000)).status, 409);
  leave();
  assert.equal((await report("already-connected", Date.now() * 1000 + 1)).status, 200);
  assert.equal(windows.target([q])?.id, q.id);
  assert.deepEqual(answers(), [{ ...answer, footerWindowId: "already-connected" }]);
});

test("a manual edit cancels corrected actions of the same answer and cannot cancel a fresh answer", async () => {
  const q = question();
  const editCancel = (reviewId: string, originId: string) => app.request("/api/voice/cards/" + originId + "/cancel", {
    method: "POST", headers: { host: "localhost", "x-voice-edit-review": reviewId },
  });
  await say("Steve, option B", "original");
  await say("no, A", "corrected");
  assert.equal(answers()[0]?.id, "corrected");
  assert.equal((await act("original", "send-now?source=card")).status, 409);
  assert.equal((await editCancel("different-question", "original")).status, 409);
  assert.equal((await editCancel(q.id, "original")).status, 200);
  assert.deepEqual(answers(), []);
  await say("Steve, option B", "fresh-answer");
  assert.equal((await editCancel(q.id, "original")).status, 409);
  assert.equal(answers()[0]?.id, "fresh-answer");
  await say("Steve, option A", "fresh-replacement");
  assert.equal((await editCancel(q.id, "fresh-answer")).status, 409);
  assert.equal(answers()[0]?.id, "fresh-replacement");
  assert.equal(registry.getReview(q.id)?.status, "pending");
});
