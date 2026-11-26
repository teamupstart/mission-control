import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { voiceHostTimeUs } from "../src/server/voice/host-clock.ts";
import { act, app, cards, listenerId, post, queued, readHeard, token, utterancePath, voiceStateStore } from "./helpers/voice-http.ts";

const EXAMPLE = "Steve, check the build, bagel, Will, give me a report on the status of some project";
const words = (text: string) => text.split(/\s+/u).map((word, i) => ({ text: word, startMs: 300 * i, endMs: 300 * i + 250 }));

const config = (body: unknown) => app.request("/api/voice/config", { method: "PUT",
  headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
const readConfig = async () => (await (await app.request("/api/voice/config", { headers: { host: "localhost" } })).json()).config;

afterEach(async () => { await config({ separatorWord: "bagel" }); });

/** Post one final capture the way the native listener does, with its host-clock headers. */
async function speak(text: string, id: string = randomUUID()) {
  const startUs = voiceHostTimeUs() - 5_000_000;
  const revision = voiceStateStore.directive().revision;
  await post(`/voice/listener/transcript?revision=${encodeURIComponent(revision)}`, { phase: "words", onset: startUs, text }, token);
  const partial = voiceStateStore.state().transcript?.text;
  const response = await app.request(utterancePath(revision), { method: "POST", headers: {
    host: "localhost", "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": listenerId,
    "x-voice-capture-start-host-us": String(startUs), "x-voice-speech-start-host-us": String(startUs),
    "x-voice-capture-end-host-ms": String(Math.ceil(voiceHostTimeUs() / 1000)),
  }, body: JSON.stringify({ id, text, words: words(text), backend: "fluidaudio", capturedAt: Date.now() - 5000 }) });
  return { accepted: (await response.json()).accepted as boolean, partial, final: voiceStateStore.state().transcript?.text };
}

test("the separator word persists in Voice settings and refuses a voice command", async () => {
  assert.equal((await readConfig()).separatorWord, "bagel");
  assert.equal((await config({ separatorWord: "  pineapple " })).status, 200);
  assert.equal((await readConfig()).separatorWord, "pineapple");
  const refused = await config({ separatorWord: "cancel" });
  assert.equal(refused.status, 400);
  assert.equal((await config({ separatorWord: "two words" })).status, 400);
  assert.equal((await readConfig()).separatorWord, "pineapple");
});

test("one native Always-on capture becomes two addressed messages while the live transcript keeps every word", async () => {
  const steve = queued("Steve").length;
  const will = queued("Will").length;
  const heard = await speak(EXAMPLE, "native-capture");
  assert.equal(heard.accepted, true);
  // Partials and the final overlay show what was said, separator included.
  assert.equal(heard.partial, EXAMPLE);
  assert.equal(heard.final, EXAMPLE);
  const open = cards.filter(card => card.state === "pending");
  assert.deepEqual(open.map(card => [card.id, card.parts[0]?.target?.name, card.parts[0]?.text]), [
    ["native-capture~1", "Steve", "check the build"],
    ["native-capture~2", "Will", "give me a report on the status of some project"],
  ]);
  assert.equal((await act("native-capture~1", "cancel")).status, 200);
  assert.equal((await act("native-capture~2", "send-now")).status, 200);
  assert.deepEqual(queued("Steve").slice(steve), []);
  assert.equal(queued("Will").length, will + 1);
  assert.match(queued("Will").at(-1)!, /give me a report on the status of some project/);
  assert.doesNotMatch(queued("Will").at(-1)!, /bagel/i);
  const entries = await readHeard();
  assert.deepEqual(entries.map(entry => [entry.text, entry.matchedName]).toSorted(), [
    ["Steve, check the build", "Steve"],
    ["Will, give me a report on the status of some project", "Will"],
  ]);
});

test("a custom separator replaces the default for the next capture", async () => {
  assert.equal((await config({ separatorWord: "pineapple" })).status, 200);
  await speak("Steve, check the build pineapple Will, run the tests");
  assert.deepEqual(cards.filter(card => card.state === "pending").map(card => [card.parts[0]?.target?.name, card.parts[0]?.text]), [
    ["Steve", "check the build"], ["Will", "run the tests"],
  ]);
  cards.length = 0;
  await speak("Steve, toast a bagel for me");
  assert.deepEqual(cards.filter(card => card.state === "pending").map(card => card.parts[0]?.text), ["toast a bagel for me"]);
});

test("the listener directive carries the separator for automatic capture, and an edit keeps the capture grant", async () => {
  const before = voiceStateStore.directive();
  assert.equal(before.capture, true);
  assert.equal(before.separator, "bagel");
  assert.equal((await config({ separatorWord: "pineapple" })).status, 200);
  const after = voiceStateStore.directive();
  assert.equal(after.separator, "pineapple");
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.captureRevision, before.captureRevision);
  assert.equal((await config({ listeningMode: "push-to-talk" })).status, 200);
  assert.equal(voiceStateStore.directive().separator, undefined);
  assert.equal((await config({ listeningMode: "always-on" })).status, 200);
});
