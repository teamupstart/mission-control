import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { RecentlyHeard, VoiceRouter } from "../src/server/voice/router.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import type { VoiceCard, VoiceUtterance } from "../src/shared/voice-routing.ts";

before(() => { ensureNativeStateLockAddon(); });

test("a daemon-dated dashboard pick and timestamped speech stay ordered across a backward clock step", async t => {
  const will: SpokenName = { key: "task:will", name: "Will", kind: "session", sessionId: "will", taskId: "will",
    role: "", colorId: null, agent: "codex", state: "running" };
  const steve = { ...will, key: "task:steve", name: "Steve" };
  const unix = Date.now();
  let wallNow = unix;
  let hostNow = 100_000;
  t.mock.method(Date, "now", () => wallNow);
  const cards: VoiceCard[] = [];
  const router = new VoiceRouter(() => ({ backend: "fluidaudio", mode: "listening", roster: [steve, will] }),
    () => ({ enabled: true, seconds: 30 }), { deliver: async () => "queued" }, card => cards.push(card), undefined, () => hostNow);
  t.after(() => router.reset());
  const say = (id: string, text: string, capturedAt: number, startHostUs?: number) =>
    router.accept({ id, text, capturedAt, backend: "fluidaudio", words: [] }, { startHostUs });
  assert.ok(await say("choice", "Steven ask Will about the deployment", unix, 100_000));
  await router.resolution("choice");
  hostNow += 10_000;
  assert.ok(await router.pick("choice", will.key));
  wallNow -= 60_000;
  hostNow += 10_000;
  // Arrives after the pick, but was spoken one microsecond before it.
  assert.ok(await say("early", "cancel", unix, 109_999));
  assert.equal(cards.at(-1)?.state, "pending");
  assert.ok(await say("late", "cancel", wallNow, 110_001));
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.equal(router.heard.list().find(entry => entry.id === "early")?.time, unix);
  assert.equal(await say("future", "Will skip", wallNow, hostNow + 1_000_001), false);
  assert.equal(await say("unix-only-future", "Will skip", unix), false);
});

test("Recently heard retains the newest 50 reasons and clears in memory", async () => {
  const cat: SpokenName = { key: "task:cat", name: "Cat", kind: "session", sessionId: null, taskId: "cat",
    role: "", colorId: null, agent: "codex", state: "not-running" };
  const router = new VoiceRouter(() => ({ backend: "fluidaudio", mode: "listening", roster: [cat] }),
    () => ({ enabled: false, seconds: 1 }), { deliver: async () => "not-running" }, () => {});
  const say = (id: number, text: string) => router.accept({ id: String(id), text, capturedAt: id, backend: "fluidaudio", words: [] });
  for (let i = 0; i < 50; i++) await say(i, "morning everyone");
  await say(50, "Pat help");
  await say(51, "Cat help");
  const entries = router.heard.list();
  assert.equal(entries.length, 50);
  assert.equal(entries.at(-1)?.time, 2);
  assert.equal(entries[0]?.outcome, "not-running");
  assert.equal(entries[0]?.rule, "exact");
  assert.equal(entries[1]?.matchedName, "Cat");
  assert.equal(entries[1]?.rule, "near-miss");
  assert.equal(entries[2]?.rule, "no-name");
  router.heard.clear();
  assert.deepEqual(router.heard.list(), []);
});

test("Recently heard retains the 50 newest capture times and breaks ties by latest arrival", () => {
  const heard = new RecentlyHeard();
  const record = (id: string, time: number) => heard.record({
    id, time, text: "hello", outcome: "ignored", rule: "no-name", matchedName: null, pauseMs: null, detail: "",
  });
  for (let time = 1; time <= 50; time++) record(String(time), time);
  record("too-old", 0);
  assert.equal(heard.list().at(-1)?.id, "1");
  record("tie", 25);
  const ids = heard.list().map((entry) => entry.id);
  assert.equal(ids.length, 50);
  assert.equal(ids.at(-1), "2");
  assert.deepEqual(ids.slice(24, 28), ["26", "tie", "25", "24"]);
});

test("queued cards still publish their final receipt after Recently heard rolls over", async () => {
  const target: SpokenName = { key: "task:steve", name: "Steve", kind: "session", sessionId: "sdk:steve",
    taskId: "steve", role: "", colorId: null, agent: "codex", state: "running" };
  const cards: VoiceCard[] = [];
  const router = new VoiceRouter(() => ({ backend: "fluidaudio", mode: "listening", roster: [target] }),
    () => ({ enabled: false, seconds: 1 }),
    { deliver: async (_target, _text, id) => ({ outcome: "queued", turnId: "turn-" + id }) }, card => cards.push(card));
  const say = (id: number, text: string) => router.accept({ id: String(id), text, capturedAt: id, backend: "fluidaudio", words: [] });
  await say(0, "Steve, inspect the build");
  await say(1, "Steve, inspect the logs");
  for (let i = 2; i < 52; i++) await say(i, "morning everyone");
  assert.equal(router.heard.list().at(-1)?.id, "2");
  cards.length = 0;
  router.settleSpoken("turn-0", "sent");
  router.settleSpoken("turn-1", "cancelled");
  router.settleSpoken("turn-0", "sent");
  assert.deepEqual(cards.map(({ id, state }) => [id, state]), [["0", "sent"], ["1", "cancelled"]]);
  assert.equal(router.heard.list().at(-1)?.id, "2", "settlement does not restore old history");
});

test("a rejected delivery marks the card and Recently heard failed and cannot deliver twice", async (t) => {
  const target: SpokenName = {
    key: "task:release", name: "Release", kind: "session", sessionId: "session:release",
    taskId: "release", role: "", colorId: null, agent: "codex", state: "running",
  };
  const deliver = t.mock.fn(async () => { throw new Error("queue unavailable"); });
  const cards: VoiceCard[] = [];
  const router = new VoiceRouter(
    () => ({ backend: "fluidaudio", mode: "listening", roster: [target] }),
    () => ({ enabled: true, seconds: 1 }),
    { deliver },
    (card) => cards.push(card),
  );
  const utterance: VoiceUtterance = {
    id: "rejected", text: "Release, run tests", capturedAt: 1, backend: "fluidaudio", words: [],
  };

  await router.accept(utterance);
  await router.sendNow(utterance.id);
  assert.equal(await router.sendNow(utterance.id), false);
  await router.accept(utterance);
  assert.equal(deliver.mock.callCount(), 1);
  assert.equal(router.heard.list()[0]?.detail, "queue unavailable");
  assert.deepEqual(cards.map(({ id, state, reason }) => [id, state, reason]), [
    ["rejected", "pending", "exact"], ["rejected", "pending", "delivering"], ["rejected", "failed", "exact"],
  ]);
  assert.deepEqual(router.heard.list().map(({ id, outcome }) => [id, outcome]), [["rejected", "failed"]]);
});

test("direct and picked stops interrupt immediately while ordinary speech keeps its cancel window", async () => {
  const steve: SpokenName = {
    key: "task:steve", name: "Steve", kind: "session", sessionId: "sdk:steve", taskId: "steve",
    role: "", colorId: null, agent: "codex", state: "running",
  };
  const roster = [steve, { ...steve, key: "task:other", name: "Stevie" }];
  const deliveries: unknown[] = [];
  const router = new VoiceRouter(
    () => ({ backend: "fluidaudio", mode: "listening", roster }),
    () => ({ enabled: true, seconds: 30 }),
    { async deliver(target, text, id, command) {
      deliveries.push([target.key, text, id, command]);
      return "sent";
    } },
    () => {},
  );
  const say = (id: string, text: string) => router.accept({ id, text, capturedAt: 1, backend: "fluidaudio", words: [] });
  try {
    await say("direct", "Steve, STOP!");
    await say("picked", "Steven, stop.");
    assert.deepEqual(deliveries, [[steve.key, "STOP!", "direct", "stop"]]);
    await router.resolution("picked");
    assert.equal(await router.pick("picked", steve.key), true);
    await say("message", "Steve, stop the build");
    assert.deepEqual(deliveries, [
      [steve.key, "STOP!", "direct", "stop"],
      [steve.key, "stop.", "picked", "stop"],
    ]);
    for (const id of ["direct", "picked"]) assert.equal(await router.sendNow(id), false);
    assert.equal(await router.sendNow("message"), true);
    assert.equal(deliveries.length, 3);
    assert.deepEqual(deliveries[2], [steve.key, "stop the build", "message", undefined]);
  } finally {
    router.reset();
  }
});

test("a split interrupts its second recipient before waiting for the first one's resume", async t => {
  const sleeping: SpokenName = { key: "task:steve", name: "Steve", kind: "session", sessionId: null,
    taskId: "steve", role: "", colorId: null, agent: "claude", state: "hibernated" };
  const will: SpokenName = { ...sleeping, key: "task:will", name: "Will", taskId: "will", sessionId: "sdk:will", state: "running" };
  let finishResume!: () => void;
  const resume = new Promise<void>(resolve => { finishResume = resolve; });
  const calls: string[] = [];
  const cards: VoiceCard[] = [];
  const router = new VoiceRouter(() => ({ backend: "fluidaudio", mode: "listening", roster: [sleeping, will] }),
    () => ({ enabled: false, seconds: 30 }), { async deliver(target, _text, _id, command) {
      if (command === "stop") { calls.push("interrupt " + target.name); return "sent"; }
      calls.push("resume " + target.name);
      await resume;
      return "queued";
    } }, card => cards.push(card), { ask: async () => ({ rung: "job", answers: [{ choice: "split", confidence: 1 }], detail: "test" }) });
  t.after(() => router.reset());
  await router.accept({ id: "resume-and-stop", text: "Steve, inspect the build, and Will, stop", capturedAt: 1, backend: "fluidaudio", words: [] });
  await router.resolution("resume-and-stop");
  assert.deepEqual(calls, ["interrupt Will", "resume Steve"]);
  finishResume();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cards.at(-1)?.state, "queued");
  assert.match(cards.at(-1)!.detail!, /Part 1 \(Steve\) queued\. Part 2 \(Will\) sent\./);
});
