import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Hono } from "hono";
import { FakeVoiceListener } from "./helpers/fake-voice-listener.ts";
import { registerVoiceRoutes, registerVoiceUtteranceRoutes } from "../src/server/voice/routes.ts";
import { wireVoiceStateEvents } from "../src/server/voice/state.ts";
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
  assert.deepEqual(await (await listener.utterance("hello", words)).json(), { accepted: true });
  const pending = listener.poll(initial.revision);
  await app.request("/api/voice/mute", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"muted":true}' });
  const muted = await pending;
  assert.equal(muted.capture, false);
  assert.deepEqual(await (await listener.utterance("hello", words)).json(), { accepted: false });
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
