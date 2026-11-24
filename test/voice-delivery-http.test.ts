import assert from "node:assert/strict";
import test from "node:test";
import { act, cards, interrupts, name, pending, post, queued, readHeard, registry, reviews, roster, say, sdk } from "./helpers/voice-http.ts";
import { HibernationManager } from "../src/server/hibernation/manager.ts";
import { mkTask } from "./helpers/session-fixture.ts";

test("idle starts, busy queues and an addressed stop bypasses the enabled cancel window", async () => {
  registry.applyDriverEvent("sdk:Steve", { kind: "state", state: "idle", activity: null });
  await say("Steve, check idle", "idle");
  await act("idle", "send-now");
  assert.equal(cards.at(-1)?.state, "queued");
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

test("an idle agent with a backlog stays queued until its own receipt, and recall cancels only the unsent utterance", async () => {
  const sessionId = "sdk:Steve";
  registry.applyDriverEvent(sessionId, { kind: "state", state: "idle", activity: null });
  pending.submit(sessionId, "typed ahead of speech");
  for (const id of ["first-spoken", "recalled-spoken"]) {
    await say("Steve, inspect the build", id);
    await act(id, "send-now");
    assert.equal(cards.at(-1)?.state, "queued");
  }
  const [typed, first, recalled] = registry.getSession(sessionId)!.pendingTurns;
  const receipt = (turnId: string, spoken: boolean) => registry.turnDelivered({
    sessionId, turnId, deliveredAt: Date.now(), ...(spoken && { spoken: { generation: 0 } }),
  });
  receipt(typed!.id, false);
  assert.equal(pending.recall(sessionId, recalled!.id, recalled!.revision)?.id, recalled!.id);
  receipt(first!.id, true);
  receipt(first!.id, true);
  assert.deepEqual((await readHeard()).map(({ id, outcome }) => [id, outcome]), [
    ["recalled-spoken", "cancelled"], ["first-spoken", "sent"],
  ]);
  assert.deepEqual(cards.filter(card => card.state === "sent").map(card => card.id), ["first-spoken"]);
});

test("an SDK refusal after queue acceptance leaves the card and Recently heard queued", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const send = t.mock.method(sdk, "sendWhenIdle", async () => null);
  const sessionId = "sdk:Bill";
  registry.applyDriverEvent(sessionId, { kind: "state", state: "idle", activity: null });
  await say("Bill, inspect the build", "refused-by-driver");
  await act("refused-by-driver", "send-now");
  t.mock.timers.tick(60_001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 1);
  const row = registry.getSession(sessionId)!.pendingTurns.at(-1)!;
  assert.equal(row.state, "queued");
  assert.match(row.lastError!, /busy before delivery/);
  assert.equal(cards.at(-1)?.state, "queued");
  assert.equal((await readHeard())[0]?.outcome, "queued");
  assert.equal(pending.dropQueued(sessionId), 1);
  assert.equal((await readHeard())[0]?.outcome, "cancelled");
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
