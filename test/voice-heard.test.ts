import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceRouter } from "../src/server/voice/router.ts";
import { voiceStateOff } from "../src/shared/voice.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import type { VoiceCard, VoiceUtterance } from "../src/shared/voice-routing.ts";

test("Recently heard retains the newest 50 reasons and clears in memory", async () => {
  const cat: SpokenName = { key: "task:cat", name: "Cat", kind: "session", sessionId: null, taskId: "cat",
    role: "", colorId: null, agent: "codex", state: "not-running" };
  const router = new VoiceRouter(() => ({ ...voiceStateOff(), mode: "listening", roster: [cat] }),
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

test("a rejected delivery marks the card and Recently heard failed and cannot deliver twice", async (t) => {
  const target: SpokenName = {
    key: "task:release", name: "Release", kind: "session", sessionId: "session:release",
    taskId: "release", role: "", colorId: null, agent: "codex", state: "running",
  };
  const deliver = t.mock.fn(async () => { throw new Error("queue unavailable"); });
  const cards: VoiceCard[] = [];
  const router = new VoiceRouter(
    () => ({ ...voiceStateOff(), mode: "listening", roster: [target] }),
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
  assert.deepEqual(cards.map(({ id, state }) => [id, state]), [["rejected", "pending"], ["rejected", "failed"]]);
  assert.deepEqual(router.heard.list().map(({ id, outcome }) => [id, outcome]), [["rejected", "failed"]]);
});
