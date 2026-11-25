import { PLAN_APPROVAL_DECISION } from "../src/shared/managed-plans.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cards, post, queued, registry, reviews, say, readHeard, act } from "./helpers/voice-http.ts";
import { mockCaptureClock, put, question, answers } from "./helpers/voice-question.ts";

async function form(count = 3) {
  const review = reviews.create("sdk:Steve", "plan-decisions", "Cache plan", "Choose settings",
    ["cache", "expiry", PLAN_APPROVAL_DECISION].slice(0, count).map(id => ({
      id, question: id, options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }],
    })));
  registry.voiceRouter!.openCards.connect("dashboard");
  const show = (open: boolean) => put("/api/voice/open-cards", { windowId: "dashboard", focused: true,
    cards: open ? [{ kind: "plan", id: review.id, sessionId: review.sessionId, focused: true }] : [] });
  assert.equal((await show(true)).status, 200);
  return { review, show, fill: () => registry.voiceRouter!.forms.get(review.id) };
}

test("fill-only ordinals include the appended approval. Submit requires an open dashboard and a live single-use id", async t => {
  mockCaptureClock(t);
  const { review, show, fill } = await form();
  let submitId = "";
  t.after(registry.subscribe(event => { if (event.type === "voice_form_submit") submitId = event.submitId; }));
  const resolve = () => post("/api/reviews/" + review.id + "/resolve", { action: "answer", response: "Approved", selections: fill()?.selections, voiceSubmitId: submitId });
  await say("Steve, first one B, second one A");
  assert.deepEqual(fill()?.selections.map(s => s.selected), [["b"], ["a"]]);
  await say("reply, submit");
  assert.ok(submitId);
  assert.equal((await post("/api/voice/form-submit/" + submitId + "/refuse", { missing: 3 })).status, 200);
  assert.match(cards.at(-1)!.detail!, /third one/);
  await say("reply, third one A");
  const filled = fill();
  assert.equal(filled?.selections[2]?.decisionId, PLAN_APPROVAL_DECISION);
  await show(false);
  await say("Steve, submit");
  assert.equal(cards.at(-1)?.reason, "form-not-open");
  assert.deepEqual(fill(), filled);
  await show(true);
  await say("Steve, submit");
  t.mock.timers.tick(5000);
  assert.equal(cards.at(-1)?.reason, "form-not-open");
  assert.equal((await resolve()).status, 409);
  assert.equal(registry.getReview(review.id)?.status, "pending");
  assert.deepEqual(queued("Steve"), []);
  await say("Steve, submit");
  assert.equal((await resolve()).status, 200);
  assert.equal(registry.getReview(review.id)?.status, "answered");
  assert.equal((await resolve()).status, 409);
  assert.equal(fill(), undefined);
  await say("Steve, submit", "plain");
  await act("plain", "send-now");
  assert.ok(queued("Steve").some(s => s.includes("submit")));
});

test("resolve refuses an incomplete selection payload with a live voice submit ID and leaves the review pending", async t => {
  const { review, fill } = await form(2);
  let submitId = "";
  t.after(registry.subscribe(event => { if (event.type === "voice_form_submit") submitId = event.submitId; }));
  await say("Steve, first one B");
  await say("Steve, submit");
  assert.ok(submitId);
  const selections = fill()?.selections;
  assert.deepEqual(selections?.map(s => s.decisionId), ["cache"]);
  const response = await post(`/api/reviews/${review.id}/resolve`, {
    action: "answer", response: "First one B", selections, voiceSubmitId: submitId,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Answer every decision first." });
  assert.equal(registry.getReview(review.id)?.status, "pending");
});

test("fills stay outside cancel and correction order and clear on opt-out", async t => {
  mockCaptureClock(t);
  const { fill } = await form(2);
  await say("Will, check the build");
  await say("Steve first one B second one A");
  assert.deepEqual(fill()?.selections.map(s => s.selected), [["b"], ["a"]]);
  await say("cancel");
  await say("cancel");
  assert.equal((await readHeard()).at(0)?.rule, "nothing-pending");
  assert.deepEqual(queued("Will"), []);
  question("What database?", "sdk:Will");
  await say("Will, option B");
  await say("Steve, second one B");
  await say("no, A");
  assert.equal(answers()[0]?.text, "SQLite");
  assert.deepEqual(fill()?.selections.map(s => s.selected), [["b"], ["b"]]);
  await put("/api/voice/config", { planFormsByVoice: false });
  assert.equal(fill(), undefined);
  await say("Steve, first one B", "ordinary");
  assert.equal(registry.voiceRouter!.activeCards().find(c => c.id === "ordinary")?.parts[0]?.text, "first one B");
  await put("/api/voice/config", { planFormsByVoice: true });
});

test("a fill expires ten minutes after the dashboard last reported the form open", async t => {
  mockCaptureClock(t);
  const { show, fill } = await form(2);
  await say("Steve, first one B");
  assert.ok(fill());
  t.mock.timers.tick(599_000);
  await show(true);
  t.mock.timers.tick(599_999);
  assert.ok(fill());
  t.mock.timers.tick(1);
  assert.equal(fill(), undefined);
});

test("a slow option lookup preserves later picks and cannot repopulate a retired form", async () => {
  const { review, fill } = await form(2);
  const forms = registry.voiceRouter!.forms;
  const older = forms.beginFill(review.id, 10);
  const later = forms.beginFill(review.id, 11);
  const choice = (decisionId: string, option: string) => ({ decisionId, selected: [option], other: null });
  later([choice("cache", "a")]);
  assert.deepEqual(older([choice("cache", "b"), choice("expiry", "b")]), [choice("expiry", "b")]);
  assert.deepEqual(fill()?.selections, [choice("cache", "a"), choice("expiry", "b")]);
  forms.clear();
  forms.observed(review.id);
  assert.equal(later([choice("cache", "b")]), null);
  assert.equal(fill(), undefined);
});
