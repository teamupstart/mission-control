import assert from "node:assert/strict";
import test from "node:test";
import { act, cards, interrupts, name, pending, post, queued, readHeard, registry, reviews, roster, say } from "./helpers/voice-http.ts";
import { HibernationManager } from "../src/server/hibernation/manager.ts";
import { mkTask } from "./helpers/session-fixture.ts";

test("idle starts, busy queues and an addressed stop bypasses the enabled cancel window", async () => {
  registry.applyDriverEvent("sdk:Steve", { kind: "state", state: "idle", activity: null });
  await say("Steve, check idle", "idle");
  await act("idle", "send-now");
  assert.equal(cards.at(-1)?.state, "sent");
  registry.applyDriverEvent("sdk:Steve", { kind: "state", state: "working", activity: null });
  await say("Steve, check busy", "busy");
  await act("busy", "send-now");
  assert.equal(cards.at(-1)?.state, "queued");
  const before = queued("Steve");
  await say("Steve, stop", "stop");
  assert.equal(cards.at(-1)?.state, "sent");
  assert.deepEqual(interrupts, ["sdk:Steve"]);
  assert.deepEqual(queued("Steve"), before);
  assert.equal((await act("stop", "cancel")).status, 409);
});

test("hibernated task queues on the resumed binding and stopped agents get their own hint", async t => {
  const sleeping = { ...name("Alice"), state: "hibernated" as const, sessionId: null };
  const resident = { ...name("Rex"), kind: "resident" as const, state: "not-running" as const, sessionId: null };
  const exited = { ...name("Zara"), state: "not-running" as const };
  roster.push(sleeping, resident, exited);
  const resume = t.mock.method(HibernationManager.prototype, "resume", async (id: string) => ({
    ok: true as const, task: mkTask({ id, sessionId: "sdk:Bill", status: "running" }),
  }));
  await say("Alice, test resume", "resume");
  await act("resume", "send-now");
  assert.deepEqual(resume.mock.calls[0]?.arguments, ["Alice"]);
  assert.equal(cards.at(-1)?.state, "queued");
  assert.ok(queued("Bill").includes("test resume"));
  const submit = t.mock.method(pending, "submitSpoken");
  for (const [who, hint] of [["Rex", "Relaunch the resident."], ["Zara", "Start a follow-up task."]]) {
    await say(who + ", do this", who);
    await act(who!, "send-now");
    assert.equal(cards.at(-1)?.state, "not-running");
    assert.equal(cards.at(-1)?.detail, who + " isn't running. Nothing was sent. " + hint);
  }
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(resume.mock.callCount(), 1);
});

test("a refused hibernated resume reports the reason and never queues the spoken message", async t => {
  roster.push({ ...name("Nora"), state: "hibernated", sessionId: null });
  t.after(() => { roster.pop(); });
  const reason = "The conversation is already open in another session.";
  const resume = t.mock.method(HibernationManager.prototype, "resume", async () => ({
    ok: false as const, status: 409, error: reason,
  }));
  const submit = t.mock.method(pending, "submitSpoken");

  const id = "resume-refusal";
  await say("Nora, check the build", id);
  await act(id, "send-now");

  assert.deepEqual(resume.mock.calls.map(call => call.arguments), [["Nora"]]);
  assert.equal(submit.mock.callCount(), 0);
  const card = cards.at(-1);
  assert.equal(card?.id, id);
  assert.equal(card.state, "failed");
  assert.equal(card.detail, reason);
  const entry = (await readHeard()).find(entry => entry.id === id);
  assert.equal(entry?.outcome, "failed");
  assert.equal(entry.detail, reason);
});

test("Foreman cannot resolve a held call until cancellation or recall, even past ten minutes", async t => {
  const id = "sdk:Will";
  registry.setForemanInvite(id, "dispatch");
  const review = reviews.create(id, "input", "Which build?", "Choose one.", null, { snoozable: true });
  const answer = () => post(`/api/reviews/${review.id}/resolve`, { action: "answer", response: "main", by: "foreman" });
  await say("Will, check the build", "cancel");
  assert.equal(cards.at(-1)?.openQuestions, 1);
  assert.equal((await answer()).status, 409);
  await act("cancel", "cancel");
  assert.equal(registry.voiceHold(id), false);
  await say("Will, check the build", "held");
  await act("held", "send-now");
  assert.equal(cards.at(-1)?.state, "held");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(700_000);
  const refusal = await answer();
  assert.equal(refusal.status, 409);
  assert.equal((await refusal.json()).error, "voice-message-pending");
  const row = registry.getSession(id)!.pendingTurns.at(-1)!;
  assert.ok(pending.recall(id, row.id, row.revision));
  assert.equal((await answer()).status, 200);
});
