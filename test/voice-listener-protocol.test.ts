import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Hono } from "hono";
import { FakeVoiceListener } from "./helpers/fake-voice-listener.ts";
import { registerVoiceRoutes, registerVoiceUtteranceRoutes } from "../src/server/voice/routes.ts";
import { voiceStateStore, wireVoiceStateEvents } from "../src/server/voice/state.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { ensureToken } from "../src/server/auth.ts";
import { tokenPath } from "../src/shared/harness-runtime.mjs";
import { VOICE_REQUIRED_FLAGS } from "../src/shared/voice.ts";
import { setVoiceConfig } from "../src/server/voice/config.ts";
import { VoiceNameRegistry, wireVoiceNameEvents } from "../src/server/voice/names.ts";
import { Registry } from "../src/server/registry.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const app = new Hono();
registerVoiceRoutes(app);
const router = registerVoiceUtteranceRoutes(app, { deliver: async () => "queued" }, () => {});
for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
ensureToken();
const listener = new FakeVoiceListener("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
const registry = new Registry();
const names = new VoiceNameRegistry(registry, { now: Date.now, enabled: () => true, taskStored: () => true });
const stopNames = wireVoiceNameEvents(names, () => {});
const stop = wireVoiceStateEvents(() => {});
after(() => { stopNames(); stop(); router.reset(); });

test("token-gated directives reflect capture, device and spoken roster changes, including a missed mute cycle", { timeout: 3000 }, async () => {
  assert.equal((await app.request("/voice/listener/directive")).status, 401);
  assert.ok((await listener.hello()).ok);
  setVoiceConfig({ muted: false });
  const initial = await listener.poll();
  assert.deepEqual(initial, { revision: initial.revision, capture: true, inputDevice: "built-in", roster: [], pauseMs: null });
  const words = [{ text: "hello", startMs: 0, endMs: 320 }];
  assert.deepEqual(await (await listener.utterance("hello", words, initial.revision)).json(), { accepted: true });
  const pending = listener.poll(initial.revision);
  await app.request("/api/voice/mute", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"muted":true}' });
  const muted = await pending;
  assert.equal(muted.capture, false);
  assert.deepEqual(await (await listener.utterance("hello", words, muted.revision)).json(), { accepted: false });
  setVoiceConfig({ muted: false });
  assert.notEqual((await listener.poll(initial.revision)).revision, initial.revision);

  const change = listener.poll((await listener.poll()).revision);
  await new Promise<void>((resolve) => setImmediate(resolve));
  registry.upsertTask(mkTask({ callSign: "Luna", status: "running", dispatchedAt: 10, sessionId: "sdk:luna" }));
  const named = await change;
  assert.deepEqual(named.roster, ["Luna"]);
  const device = listener.poll(named.revision);
  setVoiceConfig({ inputDevice: "system-default" });
  assert.equal((await device).inputDevice, "system-default");
});

test("poll holds through identical hellos then returns unchanged at 25 seconds", async (t) => {
  assert.ok((await listener.hello()).ok);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const initial = await listener.poll();
  let answered = false;
  const response = listener.poll(initial.revision).then((value) => { answered = true; return value; });
  assert.ok((await listener.hello()).ok);
  t.mock.timers.tick(24_999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(answered, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await response, initial);
});

test("a terminal denial releases capture immediately while Setup retains the denial", async () => {
  voiceStateStore.reset();
  const replacement = new FakeVoiceListener("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
  assert.ok((await listener.hello({ microphone: "denied" })).ok);
  assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "denied", source: "listener" });
  await assert.rejects(listener.poll(), /409/);
  assert.ok((await replacement.hello()).ok, "first hello reported denial, so a retry can start immediately");
  setVoiceConfig({ muted: true });
  const initial = await replacement.poll();
  assert.equal(initial.capture, false);
  const pending = assert.rejects(replacement.poll(initial.revision), /409/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok((await replacement.hello({ microphone: "denied" })).ok);
  await pending;
  assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "denied", source: "listener" });
  assert.ok((await listener.hello()).ok, "an existing owner also releases its lease on denial");
  setVoiceConfig({ muted: false });
  const current = await listener.poll();
  assert.equal(current.capture, true);
  assert.notEqual(current.revision, initial.revision);
  assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "granted", source: "listener" });
  assert.deepEqual(await (await replacement.utterance("hello", [], current.revision)).json(), { accepted: false });
});

test("a granted listener takes over immediately from a live helper without microphone access", async () => {
  const replacement = new FakeVoiceListener("http://localhost", tokenPath(), async (url, init) => app.request(url, init));
  setVoiceConfig({ muted: false });
  for (const permission of ["not-determined", "restricted", "unknown"] as const) {
    voiceStateStore.reset();
    assert.ok((await listener.hello({ microphone: permission })).ok);
    assert.deepEqual(voiceStateStore.microphoneReading(), { permission, source: "listener" });
    const waiting = await listener.poll();
    assert.equal(waiting.capture, false);
    assert.deepEqual(await (await listener.utterance("old", [], waiting.revision)).json(), { accepted: false });
    assert.ok((await listener.hello({ microphone: permission })).ok, "still sending heartbeats");
    const displaced = assert.rejects(listener.poll(waiting.revision), /409/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok((await replacement.hello()).ok, "no heartbeat lapse is required");
    await displaced;
    const current = await replacement.poll();
    assert.equal(current.capture, true);
    assert.notEqual(current.revision, waiting.revision);
    assert.deepEqual(voiceStateStore.microphoneReading(), { permission: "granted", source: "listener" });
    assert.equal((await listener.hello({ microphone: permission })).status, 409);
    assert.deepEqual(await (await listener.utterance("old", [], current.revision)).json(), { accepted: false });
    assert.deepEqual(await (await replacement.utterance("fresh", [], current.revision)).json(), { accepted: true });
  }
});
