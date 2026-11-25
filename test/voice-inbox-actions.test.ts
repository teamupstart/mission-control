import assert from "node:assert/strict";
import test from "node:test";
import { INBOX_ACTIONS } from "../src/shared/inbox.ts";
import { spokenInboxAction } from "../src/shared/voice-inbox.ts";
import type { DrawnVoiceCard, VoiceInboxEvent } from "../src/shared/voice-answers.ts";
import { act, cards, post, registry, reports, say } from "./helpers/voice-http.ts";
import { put } from "./helpers/voice-question.ts";

test("all declared spoken forms map to their click action and click-only controls have no mapping", () => {
  for (const { id, spoken, label } of INBOX_ACTIONS) {
    const named = spoken?.named.replace("{name}, ", "").replace("...", "some words") ?? label;
    assert.equal(spokenInboxAction([id], named, false)?.action, spoken ? id : undefined, id);
    if (spoken?.whileOpen) assert.deepEqual(spokenInboxAction([id], "some words", true), { action: id, text: "some words" });
  }
  assert.deepEqual(spokenInboxAction(["reply", "mark-read"], "mark read", false), { action: "mark-read", text: "" });
});

test("named commands and follow-up dictation select their unique offer and use focus for competing offers", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const windowId = "mixed-inbox";
  const router = registry.voiceRouter!;
  t.after(router.openCards.connect(windowId));
  const claims: Array<[string, string, string]> = [];
  t.after(registry.subscribe(event => {
    if (event.type !== "voice_inbox_action") return;
    claims.push([event.cardId, event.action, event.text]);
    assert.ok(router.claimInbox(event.requestId));
    assert.ok(router.completeInbox(event.requestId, true));
  }));
  const open: DrawnVoiceCard[] = [
    { kind: "report", id: "first", sessionId: "sdk:Steve", focused: false, actions: ["open-report", "follow-up"] },
    { kind: "report", id: "second", sessionId: "sdk:Steve", focused: false, actions: ["open-report", "reply"] },
    { kind: "stuck", id: "stuck", sessionId: "sdk:Steve", focused: false, actions: ["message", "nudge"] },
    { kind: "stuck", id: "other-agent", sessionId: "sdk:Will", focused: false, actions: ["nudge"] },
  ];
  const focus = (id: string | null) => put("/api/voice/open-cards", { windowId, focused: true,
    cards: open.map(c => ({ ...c, focused: c.id === id })) });
  const speak = async (words: string) => {
    await say(words);
    t.mock.timers.tick(1000);
    return claims.splice(0);
  };

  await focus(null);
  assert.deepEqual(await speak("Steve, nudge"), [["stuck", "nudge", ""]]);
  await focus("stuck");
  assert.deepEqual(await speak("Steve, follow up, verify the build"), [["first", "follow-up", "verify the build"]]);
  assert.deepEqual(await speak("Steve, open report"), []);
  assert.equal(cards.at(-1)?.state, "cancelled");
  assert.deepEqual(await speak("reply, open report"), [["stuck", "message", "open report"]]);
  await focus("second");
  assert.deepEqual(await speak("Steve, open report"), [["second", "open-report", ""]]);
  assert.deepEqual(await speak("Steve, send the results"), [["second", "reply", "send the results"]]);
});

test("mark read cancels, refuses ambiguity, requests the drawn button, and reads the sole report with the inbox closed", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const steve = registry.getSession("sdk:Steve")!;
  const first = await reports.post(steve, { title: "First report", body: "Ready." });
  await say("Steve, mark read");
  await say("cancel");
  t.mock.timers.tick(1500);
  assert.equal(reports.get(first.id)?.readAt, null);
  const other = await reports.post(steve, { title: "Second report", body: "Ready too." });
  await say("Steve, mark read");
  assert.equal(cards.at(-1)?.detail, "Open the report first.");
  const windowId = "inbox-test";
  t.after(registry.voiceRouter!.openCards.connect(windowId));
  const actions: Extract<VoiceInboxEvent, { type: "voice_inbox_action" }>[] = [];
  t.after(registry.subscribe(event => { if (event.type === "voice_inbox_action") actions.push(event); }));
  await put("/api/voice/open-cards", { windowId, focused: true, cards: [
    { kind: "report", id: first.id, sessionId: steve.id, focused: false, actions: ["mark-read", "reply"] },
  ] });
  await say("Steve, mark read");
  assert.equal(reports.get(first.id)?.readAt, null);
  t.mock.timers.tick(1000);
  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.ok(action);
  assert.equal(action.action, "mark-read");
  assert.equal(action.cardId, first.id);
  assert.equal(action.windowId, windowId);
  const path = `/api/voice/inbox-actions/${action.requestId}`;
  assert.equal((await post(path + "/complete", { invoked: true })).status, 409);
  assert.equal((await post(path + "/claim")).status, 200);
  assert.equal((await post(path + "/claim")).status, 409);
  assert.equal(cards.at(-1)?.state, "pending");
  assert.equal(reports.get(first.id)?.readAt, null, "claiming the button must leave the write to its click callback");
  assert.equal((await post(`/api/reports/${first.id}/read`)).status, 200);
  assert.equal((await post(path + "/complete", { invoked: true })).status, 200);
  assert.equal(cards.at(-1)?.state, "sent");
  assert.equal((await post(path + "/complete", { invoked: false })).status, 409);
  assert.equal(reports.get(other.id)?.readAt, null);
  await put("/api/voice/open-cards", { windowId, focused: true, cards: [] });
  await say("Steve, mark read", "closed-inbox");
  assert.equal((await act("closed-inbox", "send-now")).status, 200);
  assert.equal(reports.get(other.id)?.readBy, "mark-read");
});

test("an accepted inbox claim whose dashboard never confirms invocation expires and refuses a late success", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const windowId = "unresponsive-dashboard";
  const router = registry.voiceRouter!;
  t.after(router.openCards.connect(windowId));
  let requestId = "";
  t.after(registry.subscribe(event => { if (event.type === "voice_inbox_action") requestId = event.requestId; }));
  await put("/api/voice/open-cards", { windowId, focused: true, cards: [
    { kind: "stuck", id: "sdk:Steve", sessionId: "sdk:Steve", focused: true, actions: ["nudge"] },
  ] });
  await say("Steve, nudge");
  t.mock.timers.tick(1000);
  assert.ok(requestId);
  t.mock.timers.tick(4000);
  const path = `/api/voice/inbox-actions/${requestId}`;
  assert.equal((await post(path + "/claim")).status, 200);
  t.mock.timers.tick(4999);
  assert.equal((await post(path + "/claim")).status, 409);
  assert.equal(cards.at(-1)?.state, "pending");
  t.mock.timers.tick(1);
  assert.equal((await post(path + "/complete", { invoked: true })).status, 409);
  assert.equal(cards.at(-1)?.state, "failed");
  assert.equal(cards.at(-1)?.detail, "The dashboard did not confirm the inbox action.");
});
