import assert from "node:assert/strict";
import test from "node:test";
import { act, applyFeatureFlagIntent, cards, interrupts, name, pending, post, queued, readHeard, registry, reviews, roster, say, sdk, voiceStateStore } from "./helpers/voice-http.ts";
import { onFeatureFlagsChanged } from "../src/server/feature-flags/index.ts";
import { HibernationManager } from "../src/server/hibernation/manager.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { claimNextPendingTurn, clearPendingTurns, listPendingTurns, openDb, recoverSendingPendingTurns, retireDeliveredPendingTurn } from "../src/server/db.ts";
import { reserveSpokenHandoff } from "../src/server/delivery-ledgers.ts";

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

test("clearing the outbox cancels only committed removals and preserves the other spoken receipt", async () => {
  const session = "sdk:Steve";
  registry.applyDriverEvent(session, { kind: "state", state: "working", activity: null });
  for (const id of ["clear-me", "keep-me"]) {
    await say("Steve, inspect the build", id);
    await act(id, "send-now");
  }
  const [clear, keep] = registry.getSession(session)!.pendingTurns;
  const key = clear!.noteKey;
  const d = openDb();
  d.exec("CREATE TEMP TRIGGER refuse_clear BEFORE DELETE ON pending_turns BEGIN SELECT RAISE(ABORT, 'refused clear'); END");
  try {
    assert.throws(() => registry.clearPendingTurns(key, [keep!.id]), /refused clear/);
    assert.ok((await readHeard()).every(entry => entry.outcome === "queued"));
  } finally {
    d.exec("DROP TRIGGER refuse_clear");
  }
  assert.ok(registry.clearPendingTurns(key, [keep!.id]));
  registry.turnDelivered({ sessionId: session, turnId: clear!.id, deliveredAt: Date.now(), spoken: { generation: 0 } });
  assert.deepEqual((await readHeard()).map(({ id, outcome }) => [id, outcome]), [["keep-me", "queued"], ["clear-me", "cancelled"]]);
  assert.deepEqual(cards.filter(card => card.state === "cancelled").map(card => card.id), ["clear-me"]);
  registry.turnDelivered({ sessionId: session, turnId: keep!.id, deliveredAt: Date.now(), spoken: { generation: 0 } });
  assert.equal((await readHeard())[0]?.outcome, "sent");
});

for (const recovered of [false, true]) {
  test(recovered
    ? "a failed spoken retirement recovered as uncertain never publishes sent on the stale retry"
    : "a failed spoken retirement publishes sent once when its retry commits, without resending", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const send = t.mock.method(sdk, "sendWhenIdle", async (...args: Parameters<typeof sdk.sendWhenIdle>) => {
      assert.equal(args[2]?.(), null);
      return "started" as const;
    });
    const id = "retire-speech-" + recovered;
    const sessionId = "sdk:Bill";
    const key = registry.getSession(sessionId)!.agentSessionId!;
    const d = openDb();
    d.exec(`CREATE TEMP TRIGGER refuse_spoken_retire BEFORE DELETE ON pending_turns
      WHEN OLD.spoken_words IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected retire failure'); END`);
    t.after(() => {
      d.exec("DROP TRIGGER IF EXISTS refuse_spoken_retire");
      clearPendingTurns(key);
      registry.refreshPendingTurns(key);
    });
    registry.applyDriverEvent(sessionId, { kind: "state", state: "idle", activity: null });
    await say("Bill, inspect the build", id);
    await act(id, "send-now");
    t.mock.timers.tick(60_001);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(listPendingTurns(key)[0]?.state, "sending");
    assert.equal(cards.at(-1)?.state, "queued");
    assert.equal((await readHeard())[0]?.outcome, "queued");
    d.exec("DROP TRIGGER refuse_spoken_retire");
    if (recovered) recoverSendingPendingTurns(Date.now());
    t.mock.timers.tick(1_001);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(listPendingTurns(key)[0]?.state, recovered ? "uncertain" : undefined);
    assert.equal(cards.filter(card => card.id === id && card.state === "sent").length, recovered ? 0 : 1);
    assert.equal((await readHeard())[0]?.outcome, recovered ? "queued" : "sent");
    assert.equal(send.mock.callCount(), 1);
  });
}

test("replaying a forgotten capture returns the same queued spoken row and tracks its receipt", async () => {
  const id = "replayed-capture";
  registry.applyDriverEvent("sdk:Steve", { kind: "state", state: "working", activity: null });
  await say("Steve, inspect the build", id);
  await act(id, "send-now");
  const [original] = registry.getSession("sdk:Steve")!.pendingTurns;
  assert.ok(original);
  registry.voiceRouter!.reset();
  await say("Steve, inspect the build", id);
  await act(id, "send-now");
  assert.equal(cards.at(-1)?.state, "queued");
  assert.equal((await readHeard())[0]?.outcome, "queued");
  assert.deepEqual(registry.getSession("sdk:Steve")!.pendingTurns, [original]);
  registry.turnDelivered({ sessionId: "sdk:Steve", turnId: original.id, deliveredAt: Date.now(), spoken: { generation: 0 } });
  assert.equal((await readHeard())[0]?.outcome, "sent");
});

test("a replay observes a receipt during submission before its queued card can publish", async t => {
  const sessionId = "sdk:Steve";
  registry.applyDriverEvent(sessionId, { kind: "state", state: "working", activity: null });
  for (const outcome of ["sent", "cancelled"] as const) {
    const id = "replay-during-" + outcome;
    await say("Steve, inspect the build", id);
    await act(id, "send-now");
    const turn = registry.getSession(sessionId)!.pendingTurns.at(-1)!;
    const claim = outcome === "sent" ? claimNextPendingTurn(turn.noteKey, Date.now(), turn, words => words) : null;
    const handoff = claim && reserveSpokenHandoff({ key: turn.noteKey, transcript: null }, claim, "inspect the build", true, 0, Date.now());
    registry.voiceRouter!.reset();
    await say("Steve, inspect the build", id);
    const submit = pending.submitSpoken.bind(pending);
    const replay = t.mock.method(pending, "submitSpoken", (...args: Parameters<typeof submit>) => {
      const result = submit(...args);
      assert.equal(result.pendingTurn?.id, turn.id);
      if (outcome === "sent") {
        assert.ok(claim && handoff);
        assert.equal(result.pendingTurn?.state, "sending");
        assert.ok(retireDeliveredPendingTurn(turn.id, claim.revision, Date.now(), handoff.id));
        registry.refreshPendingTurns(turn.noteKey);
        registry.turnDelivered({ sessionId, turnId: turn.id, deliveredAt: Date.now(), spoken: { generation: 0 } });
      } else {
        assert.ok(pending.recall(sessionId, turn.id, turn.revision));
      }
      return result;
    });
    cards.length = 0;
    await act(id, "send-now");
    replay.mock.restore();
    assert.equal((await readHeard())[0]?.outcome, outcome);
    assert.equal(cards.at(-1)?.state, outcome);
    assert.equal(cards.filter(card => card.state === "queued").length, 0);
  }
});

test("an early session upsert for a held split leg only publishes the live split card", async t => {
  const id = "split-delivery";
  const sessionId = "sdk:Will";
  const ask = reviews.create(sessionId, "input", "Which deployment?", "Choose one.", null);
  t.after(async () => { await post(`/api/reviews/${ask.id}/resolve`, { action: "answer", response: "main" }); });
  const submit = pending.submitSpoken.bind(pending);
  t.mock.method(pending, "submitSpoken", (...[session, words, partId, onQueued]: Parameters<typeof submit>) => {
    // Make the real queue publish its session upsert before handing the receipt to the router.
    const result = submit(session, words, partId);
    if (result.pendingTurn) onQueued?.(result.pendingTurn.id);
    return result;
  });
  await say("Steve, inspect the build, and Will, check the deployment", id);
  await registry.voiceRouter!.resolution(id);
  assert.equal((await act(id, "pick", { id: "task:Will" })).status, 200);
  assert.equal((await act(id, "send-now")).status, 200);
  const turn = registry.getSession(sessionId)!.pendingTurns.find(row => row.id === "voice:" + id + "#2");
  assert.ok(turn);
  assert.deepEqual(cards.filter(card => card.state === "held").map(card => card.id), [id]);
  assert.deepEqual(registry.voiceRouter!.activeCards().map(card => card.id), [id]);
  assert.equal(pending.recall(sessionId, turn.id, turn.revision)?.id, turn.id);
  assert.equal(cards.at(-1)?.parts[1]?.outcome, "cancelled");
  assert.deepEqual(registry.voiceRouter!.activeCards(), []);
});

test("a blocking review holds just its queued split part and answering returns that part to the queue", async () => {
  const id = "split-review-after-queue";
  const sessionId = "sdk:Will";
  for (const session of [sessionId, "sdk:Steve"]) registry.applyDriverEvent(session, { kind: "state", state: "working", activity: null });
  await say("Steve, inspect the build, and Will, check the deployment", id);
  await registry.voiceRouter!.resolution(id);
  await act(id, "pick", { id: "task:Will" });
  await act(id, "send-now");
  const parts = () => cards.at(-1)?.parts.map(({ turnId, outcome }) => [turnId, outcome]);
  const first = ["voice:" + id, "queued"];
  const second = "voice:" + id + "#2";
  assert.deepEqual(parts(), [first, [second, "queued"]]);
  const ask = reviews.create(sessionId, "input", "Which deployment?", "Choose one.", null);
  try {
    assert.deepEqual(parts(), [first, [second, "held"]]);
    assert.deepEqual(registry.voiceRouter!.activeCards().map(card => card.id), [id]);
    assert.equal(registry.voiceRouter!.isHeldTurn(second), true);
  } finally {
    await post(`/api/reviews/${ask.id}/resolve`, { action: "answer", response: "main" });
  }
  assert.deepEqual(parts(), [first, [second, "queued"]]);
  assert.deepEqual(registry.voiceRouter!.activeCards(), []);
  assert.equal(registry.voiceRouter!.isHeldTurn(second), false);
});

test("a blocking question opened during submission survives the queued return value", async t => {
  const sessionId = "sdk:Steve";
  registry.applyDriverEvent(sessionId, { kind: "state", state: "working", activity: null });
  const submit = pending.submitSpoken.bind(pending);
  t.mock.method(pending, "submitSpoken", (...args: Parameters<typeof submit>) => {
    const result = submit(...args);
    const ask = reviews.create(sessionId, "input", "Which build?", "Choose one.", null);
    t.after(async () => { await post(`/api/reviews/${ask.id}/resolve`, { action: "answer", response: "main" }); });
    return result;
  });
  await say("Steve, inspect the build", "review-during-submit");
  await act("review-during-submit", "send-now");
  assert.equal(cards.at(-1)?.state, "held");
  assert.deepEqual(registry.voiceRouter!.activeCards().map(card => card.id), ["review-during-submit"]);
});

test("an awaiting-review session label alone cannot turn a queued spoken message into a held card", async t => {
  const sessionId = "sdk:Will";
  const ask = reviews.create(sessionId, "input", "Which release?", "Keep working meanwhile.", null, { waitMode: "message", snoozable: true });
  t.after(async () => { await post(`/api/reviews/${ask.id}/resolve`, { action: "answer", response: "main" }); });
  const session = registry.getSession(sessionId)!;
  assert.equal(session.pendingReviews, 0);
  assert.equal(session.openQuestions, 1);
  await say("Will, check the release", "still-queued");
  await act("still-queued", "send-now");
  assert.equal(cards.at(-1)?.state, "queued");
  registry.voiceRouter!.reset();
  const getSession = registry.getSession.bind(registry);
  t.mock.method(registry, "getSession", (id: string) => id === sessionId ? { ...session, state: "awaiting_review" as const } : getSession(id));
  registry.emitVoiceRoster(roster);
  assert.deepEqual(registry.voiceRouter!.activeCards(), []);
});

test("resuming a session with a blocking review reports held on its card and in Recently heard", async t => {
  const sleeping = { ...name("Ada"), state: "hibernated" as const, sessionId: null };
  roster.push(sleeping);
  t.after(() => { roster.splice(roster.indexOf(sleeping), 1); });
  const sessionId = "sdk:Bill";
  const ask = reviews.create(sessionId, "input", "Which target?", "Choose one.", null, { snoozable: true });
  t.after(async () => { assert.equal((await post(`/api/reviews/${ask.id}/resolve`, { action: "answer", response: "main" })).status, 200); });
  t.mock.method(HibernationManager.prototype, "resume", async (id: string) => ({
    ok: true as const, task: mkTask({ id, sessionId, status: "running" }),
  }));
  await say("Ada, inspect the build", "resume-held");
  await act("resume-held", "send-now");
  assert.equal(cards.at(-1)?.state, "held");
  assert.equal((await readHeard())[0]?.outcome, "held");
  assert.deepEqual(queued("Bill"), ["inspect the build"]);
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

test("a resident that stops during the cancel window keeps its relaunch guidance", async t => {
  const resident = { ...name("Bill"), key: "resident:Marlowe", name: "Marlowe", kind: "resident" as const };
  roster.push(resident);
  t.after(() => { roster.splice(roster.indexOf(resident), 1); });
  await say("Marlowe, inspect the build", "stopped-during-window");
  assert.equal(cards.at(-1)?.parts[0]?.target?.sessionId, "sdk:Bill");
  resident.state = "not-running";
  resident.taskId = null;
  resident.sessionId = null;
  const submit = t.mock.method(pending, "submitSpoken");
  await act("stopped-during-window", "send-now");
  const message = "Marlowe isn't running. Nothing was sent. Relaunch the resident.";
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(cards.at(-1)?.detail, message);
  assert.equal(cards.at(-1)?.parts[0]?.target?.state, "not-running");
  assert.equal((await readHeard())[0]?.detail, message);
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a pending capture follows its hibernated task after another capture wakes it", async t => {
  const target = name("Mira");
  target.state = "hibernated";
  target.sessionId = null;
  roster.push(target);
  t.after(() => { roster.splice(roster.indexOf(target), 1); });
  const resume = t.mock.method(HibernationManager.prototype, "resume", async (id: string) => {
    target.state = "running";
    target.sessionId = "sdk:Bill";
    return { ok: true as const, task: mkTask({ id, sessionId: target.sessionId, status: "running" }) };
  });
  for (const [text, id] of [["inspect the build", "wake"], ["check the result", "after-wake"], ["publish it", "stale-task"]] as const) {
    await say("Mira, " + text, id);
  }
  await act("wake", "send-now");
  await act("after-wake", "send-now");
  assert.equal(cards.at(-1)?.state, "queued");
  assert.equal(cards.at(-1)?.parts[0]?.target?.sessionId, target.sessionId);
  assert.equal((await readHeard()).find(entry => entry.id === "after-wake")?.outcome, "queued");
  target.taskId = "another-task";
  await act("stale-task", "send-now");
  assert.equal(cards.at(-1)?.state, "not-running");
  assert.deepEqual(queued("Bill"), ["inspect the build", "check the result"]);
  assert.equal(resume.mock.callCount(), 1);
});

test("overlapping spoken messages share one hibernated resume and queue each active delivery", async t => {
  const sleeping = { ...name("Mira"), state: "hibernated" as const, sessionId: null };
  roster.push(sleeping);
  t.after(() => { roster.splice(roster.indexOf(sleeping), 1); });
  const gate = signal();
  const task = mkTask({ id: "Mira", status: "hibernated", hibernation: {
    sessionId: "sdk:old", runtime: "sdk", agentSessionId: "c", noteKey: "c", hibernatedAt: 1,
    checkout: null, permissionMode: null, blocker: null, failure: null,
  } });
  const getTask = registry.getTask.bind(registry);
  t.mock.method(registry, "getTask", (id: string) => id === task.id ? task : getTask(id));
  const eviction = t.mock.method(registry, "waitForPendingEviction", () => gate.promise);
  const resume = t.mock.method(HibernationManager.prototype, "resume", async (id: string) => ({
    ok: true as const, task: mkTask({ id, sessionId: "sdk:Bill", status: "running" }),
  }));
  await say("Mira, inspect the build", "first-wake");
  await say("Mira, run the tests", "second-wake");
  const first = act("first-wake", "send-now");
  const second = act("second-wake", "send-now");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(eviction.mock.calls.map(call => call.arguments), [["sdk:old"]]);
  assert.equal(resume.mock.callCount(), 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(resume.mock.callCount(), 1);
  assert.deepEqual(queued("Bill"), ["inspect the build", "run the tests"]);
  assert.deepEqual((await readHeard()).map(e => e.outcome), ["queued", "queued"]);
});

test("a cancelled spoken message cannot queue through a resume shared with a later capture", async t => {
  const sleeping = { ...name("Mira"), state: "hibernated" as const, sessionId: null };
  roster.push(sleeping);
  t.after(() => { roster.splice(roster.indexOf(sleeping), 1); });
  const gate = signal();
  const entered = signal();
  const resume = t.mock.method(HibernationManager.prototype, "resume", async (id: string) => {
    entered.resolve();
    await gate.promise;
    return { ok: true as const, task: mkTask({ id, sessionId: "sdk:Bill", status: "running" }) };
  });
  await say("Mira, inspect the build", "cancelled-wake");
  const first = act("cancelled-wake", "send-now");
  await entered.promise;
  registry.voiceRouter!.reset();
  await say("Mira, run the tests", "active-wake");
  const second = act("active-wake", "send-now");
  await new Promise<void>(resolve => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(resume.mock.callCount(), 1);
  assert.deepEqual(queued("Bill"), ["run the tests"]);
  assert.deepEqual((await readHeard()).map(e => [e.id, e.outcome]), [["active-wake", "queued"]]);
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

for (const kind of ["input", "plan-decisions"] as const) {
  for (const convertible of [true, false]) {
    test(`spoken delivery to a ${convertible ? "convertible" : "legacy"} ${kind} is ${convertible ? "queued" : "held"}`, async t => {
      const id = "sdk:Will";
      const row = reviews.create(id, kind, "Which target?", "Choose one.", null, { snoozable: kind === "input" });
      t.after(() => { reviews.resolve(row.id, "dismiss", null); });
      const poll = reviews.wait(row.id, 5000, undefined, convertible);
      pending.submit(id, "Typed first");
      assert.equal(registry.getReview(row.id)?.waitMode, undefined);
      const captureId = `voice-question-${kind}-${convertible}`;
      await say("Will, inspect the build", captureId);
      await act(captureId, "send-now");
      assert.equal(cards.at(-1)?.state, convertible ? "queued" : "held");
      assert.equal((await readHeard())[0]?.outcome, convertible ? "queued" : "held");
      assert.deepEqual(queued("Will"), ["Typed first", "inspect the build"]);
      if (!convertible) reviews.resolve(row.id, "answer", "main");
      assert.equal(Boolean((await poll)?.converted), convertible);
    });
  }
}

test("recalling speech held by a legacy call leaves every compatible call attached", async () => {
  const sessionId = "sdk:Will";
  const question = reviews.create(sessionId, "input", "Which branch?", "Choose", null, { snoozable: true });
  const plan = reviews.create(sessionId, "plan-decisions", "Release", "Choose a channel", null);
  // A legacy poll vetoes the plan durably, even if a capable poll later takes its place.
  const expired = new AbortController();
  const legacy = reviews.wait(plan.id, 5000, expired.signal);
  expired.abort();
  await legacy;
  const calls = [question, plan].map(ask => reviews.wait(ask.id, 5000, undefined, true));
  await say("Will, check the release", "mixed-blockers");
  await act("mixed-blockers", "send-now");
  assert.equal(cards.at(-1)?.state, "held");
  for (const ask of [question, plan]) assert.equal(registry.getReview(ask.id)?.filedByVoiceAt, undefined);
  const turn = registry.getSession(sessionId)!.pendingTurns.at(-1)!;
  assert.ok(pending.recall(sessionId, turn.id, turn.revision));
  for (const ask of [question, plan]) reviews.resolve(ask.id, "answer", "stable");
  for (const result of await Promise.all(calls)) {
    assert.equal(result?.response, "stable");
    assert.equal(result?.converted, undefined);
  }
});

test("settling the last legacy call releases held speech through the existing compatible poll", async t => {
  const sessionId = "sdk:Will";
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  registry.applyDriverEvent(sessionId, { kind: "state", state: "idle", activity: null });
  const send = t.mock.method(sdk, "sendWhenIdle", async () => "started" as const);
  const ask = reviews.create(sessionId, "input", "Which tag?", "Choose", null, { snoozable: true });
  const legacy = reviews.create(sessionId, "input", "Which target?", "Choose", null, { snoozable: true });
  t.after(() => { reviews.resolve(ask.id, "dismiss", null); reviews.resolve(legacy.id, "dismiss", null); });
  const capableCall = reviews.wait(ask.id, 5000, undefined, true);
  const legacyCall = reviews.wait(legacy.id, 5000);
  await say("Will, inspect the target", "settled-last-legacy");
  await act("settled-last-legacy", "send-now");
  assert.equal(cards.at(-1)?.state, "held");

  reviews.resolve(legacy.id, "answer", "stable");
  assert.equal((await legacyCall)?.response, "stable");
  assert.equal(registry.getReview(ask.id)?.waitMode, "message");
  assert.ok((await capableCall)?.converted?.receipt.includes(ask.id));
  assert.equal(cards.at(-1)?.state, "queued");
  t.mock.timers.tick(60_001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 1);
  assert.equal(cards.at(-1)?.state, "sent");
});

test("the SDK receives the spoken words with both converted asks in its open-questions note", async t => {
  const sessionId = "sdk:Will";
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const send = t.mock.method(sdk, "sendWhenIdle", async (...args: Parameters<typeof sdk.sendWhenIdle>) => {
    assert.equal(args[2]?.(), null);
    return "started" as const;
  });
  registry.applyDriverEvent(sessionId, { kind: "state", state: "idle", activity: null });
  const question = reviews.create(sessionId, "input", "Which build?", "Choose", null, { snoozable: true });
  const plan = reviews.create(sessionId, "plan-decisions", "Ship plan", "Choose", null);
  const asks = [question, plan];
  t.after(() => { for (const ask of asks) reviews.resolve(ask.id, "dismiss", null); });
  const polls = asks.map(ask => reviews.wait(ask.id, 5000, undefined, true));
  await say("Will, inspect the build", "convert-and-deliver");
  await act("convert-and-deliver", "send-now");
  assert.equal(cards.at(-1)?.state, "queued");
  for (const response of await Promise.all(polls)) assert.ok(response?.converted);
  t.mock.timers.tick(60_001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 1);
  const text = send.mock.calls[0]!.arguments[1].text;
  assert.ok(text.startsWith("inspect the build\n\nYour open questions:\n"));
  for (const ask of asks) assert.ok(text.includes(`- ${ask.id}: ${ask.title}`));
  assert.equal(cards.at(-1)?.state, "sent");
});

test("replaying a queued utterance keeps a later question in its call", async t => {
  const sessionId = "sdk:Will";
  await say("Will, inspect the build", "existing-voice");
  await act("existing-voice", "send-now");
  registry.voiceRouter!.reset();
  const question = reviews.create(sessionId, "input", "New question?", "Choose", null, { snoozable: true });
  t.after(() => { reviews.resolve(question.id, "dismiss", null); });
  const wait = reviews.wait(question.id, 5000, undefined, true);
  await say("Will, inspect the build", "existing-voice");
  await act("existing-voice", "send-now");
  assert.equal(cards.at(-1)?.state, "held");
  reviews.resolve(question.id, "answer", "Yes");
  assert.equal((await wait)?.response, "Yes");
});

test("a retired capture cannot deliver twice or file a question opened after delivery", async t => {
  const id = "sdk:Will";
  const captureId = "retired-speech";
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const send = t.mock.method(sdk, "sendWhenIdle", async (...args: Parameters<typeof sdk.sendWhenIdle>) => {
    assert.equal(args[2]?.(), null);
    return "started" as const;
  });
  registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
  await say("Will, inspect the build", captureId);
  await act(captureId, "send-now");
  t.mock.timers.tick(60_001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cards.at(-1)?.state, "sent");
  registry.voiceRouter!.reset();
  const ask = reviews.create(id, "input", "New question?", "Choose", null, { snoozable: true });
  t.after(() => { reviews.resolve(ask.id, "dismiss", null); });
  const wait = reviews.wait(ask.id, 5000, undefined, true);
  await say("Will, inspect the build", captureId);
  await act(captureId, "send-now");
  assert.equal(cards.at(-1)?.state, "failed");
  assert.match(cards.at(-1)?.detail ?? "", /already queued/);
  assert.deepEqual(queued("Will"), []);
  assert.equal(send.mock.callCount(), 1);
  reviews.resolve(ask.id, "answer", "Yes");
  assert.equal((await wait)?.response, "Yes");
});

test("a plan's first compatible wait releases speech queued in the create-to-poll gap", async t => {
  const id = "sdk:Will";
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const send = t.mock.method(sdk, "sendWhenIdle", async (...args: Parameters<typeof sdk.sendWhenIdle>) => {
    assert.equal(args[2]?.(), null);
    return "started" as const;
  });
  registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
  const plan = reviews.create(id, "plan-decisions", "Release plan", "Choose a channel", null);
  t.after(() => { reviews.resolve(plan.id, "dismiss", null); });
  await say("Will, inspect the build", "before-first-poll");
  await act("before-first-poll", "send-now");
  assert.equal(cards.at(-1)?.state, "held");
  assert.equal(registry.getReview(plan.id)?.waitMode, undefined);
  const call = reviews.wait(plan.id, 5000, undefined, true);
  assert.equal(cards.at(-1)?.state, "queued");
  assert.equal((await readHeard())[0]?.outcome, "queued");
  t.mock.timers.tick(5001);
  assert.ok((await call)?.converted);
  t.mock.timers.tick(60_001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 1);
  assert.ok(send.mock.calls[0]!.arguments[1].text.includes(plan.id));
  assert.equal(cards.at(-1)?.state, "sent");
});

test("a filing failure preserves queued speech and its receipt until a compatible poll retries", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const sessionId = "sdk:Will";
  registry.applyDriverEvent(sessionId, { kind: "state", state: "idle", activity: null });
  const send = t.mock.method(sdk, "sendWhenIdle", async (...args: Parameters<typeof sdk.sendWhenIdle>) => {
    assert.equal(args[2]?.(), null);
    return "started" as const;
  });
  const question = reviews.create(sessionId, "input", "Which target?", "Choose", null, { snoozable: true });
  const db = openDb();
  db.exec(`CREATE TEMP TRIGGER refuse_voice_filing BEFORE UPDATE OF filed_by_voice_at ON reviews
    BEGIN SELECT RAISE(ABORT, 'injected filing failure'); END`);
  t.after(() => {
    db.exec("DROP TRIGGER IF EXISTS refuse_voice_filing");
    reviews.resolve(question.id, "dismiss", null);
  });
  const firstPoll = reviews.wait(question.id, 5000, undefined, true);
  await say("Will, inspect the build", "retry-filing");
  await act("retry-filing", "send-now");
  assert.deepEqual(queued("Will"), ["inspect the build"]);
  assert.equal(cards.at(-1)?.state, "held");
  assert.equal((await readHeard())[0]?.outcome, "held");
  t.mock.timers.tick(5000);
  assert.equal((await firstPoll)?.converted, undefined);
  db.exec("DROP TRIGGER refuse_voice_filing");
  assert.ok((await reviews.wait(question.id, 5000, undefined, true))?.converted);
  assert.equal(cards.at(-1)?.state, "queued");
  assert.equal((await readHeard())[0]?.outcome, "queued");
  t.mock.timers.tick(60_001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 1);
  assert.equal(cards.at(-1)?.state, "sent");
  assert.equal((await readHeard())[0]?.outcome, "sent");
});

test("Voice re-enable restores a held receipt without a call sign or another session event", async () => {
  const sessionId = "sdk:Will";
  const id = "restore-unnamed-on-enable";
  const ask = reviews.create(sessionId, "input", "Which build?", "Choose one.", null);
  const stopFlags = onFeatureFlagsChanged(config => registry.emitFeatureFlags(config));
  try {
    await say("Will, inspect the release", id);
    await act(id, "send-now");
    assert.equal(registry.voiceRouter!.activeCards().find(card => card.id === id)?.state, "held");
    voiceStateStore.useRoster(() => []);
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
    assert.deepEqual(registry.voiceRouter!.activeCards(), []);
    applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
    const restored = registry.voiceRouter!.activeCards().find(card => card.id === id);
    assert.equal(restored?.state, "held");
    assert.equal(restored.parts[0]?.restoredSession?.id, sessionId);
    const turn = registry.getSession(sessionId)!.pendingTurns.find(row => row.id === restored.parts[0]?.turnId)!;
    assert.equal(pending.recall(sessionId, turn.id, turn.revision)?.spokenWords, "inspect the release");
  } finally {
    stopFlags();
    voiceStateStore.useRoster(() => roster);
    reviews.resolve(ask.id, "answer", "nightly");
  }
});

test("recalling held speech removes the reason to file an ask on its next poll", async () => {
  const id = "sdk:Will";
  const ask = reviews.create(id, "input", "Which channel?", "Choose", null, { snoozable: true });
  await say("Will, inspect the build", "recall-before-poll");
  await act("recall-before-poll", "send-now");
  const turn = registry.getSession(id)!.pendingTurns.at(-1)!;
  assert.ok(pending.recall(id, turn.id, turn.revision));
  const call = reviews.wait(ask.id, 1000, undefined, true);
  reviews.resolve(ask.id, "answer", "nightly");
  assert.equal((await call)?.response, "nightly");
});

test("Send now reports queued when conversion releases the session from awaiting review", async t => {
  const id = "sdk:Will";
  registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
  const ask = reviews.create(id, "input", "Which release?", "Choose", null, { snoozable: true });
  t.after(() => { reviews.resolve(ask.id, "dismiss", null); });
  const call = reviews.wait(ask.id, 5000, undefined, true);
  const getSession = registry.getSession.bind(registry);
  t.mock.method(registry, "getSession", (key: string) => {
    const session = getSession(key);
    return key === id && session?.pendingReviews ? { ...session, state: "awaiting_review" as const } : session;
  });
  await say("Will, inspect the build", "release-awaiting-review");
  assert.equal(registry.getSession(id)?.state, "awaiting_review");
  await act("release-awaiting-review", "send-now");
  assert.ok((await call)?.converted);
  assert.equal(registry.getSession(id)?.state, "idle");
  assert.equal(cards.at(-1)?.state, "queued");
  assert.equal((await readHeard())[0]?.outcome, "queued");
});
