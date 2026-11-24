import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ensureToken } from "../src/server/auth.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { voiceStateStore } from "../src/server/voice/state.ts";
import { setVoiceConfig } from "../src/server/voice/config.ts";
import { registerVoiceRoutes, registerVoiceUtteranceRoutes } from "../src/server/voice/routes.ts";
import { VOICE_REQUIRED_FLAGS } from "../src/shared/voice.ts";
import { VoiceUtteranceSchema, type VoiceUtterance } from "../src/shared/voice-routing.ts";
import { tokenPath } from "../src/shared/harness-runtime.mjs";
import { voiceTestModel } from "./helpers/voice-test-model.ts";

const run = promisify(execFile);
test("the published sherpa addon transcribes a recording through the listener and daemon", async t => {
  const required = process.env.MISSION_VOICE_RECOGNIZER_JOB !== undefined;
  const model = await voiceTestModel(required);
  if (model === null) {
    assert.ok(!required, "The dedicated Linux recognizer job requires a verified model");
    t.skip("Pinned recognizer model is absent from the offline unit-test cache");
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "voice-listener-dist-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await run(process.execPath, ["scripts/build-voice-sherpa.mjs", dist]);
  ensureToken();
  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
  setVoiceConfig({ muted: false, backend: "sherpa-onnx", cancelWindow: { enabled: false } });
  voiceStateStore.useRoster(() => [{ key: "resident:steve", name: "Steve", kind: "resident", state: "running",
    sessionId: "sdk:steve", taskId: "task-steve", role: "", colorId: null, agent: "codex" }]);
  t.after(() => voiceStateStore.useRoster(null));
  const app = new Hono();
  const captures: VoiceUtterance[] = [];
  let posts = 0;
  app.use("/voice/utterances", async (c, next) => {
    posts++;
    const payload = await c.req.raw.clone().json();
    await next();
    if ((await c.res.clone().json()).accepted) captures.push(VoiceUtteranceSchema.parse(payload));
  });
  registerVoiceRoutes(app);
  const deliveries: { target: string; text: string }[] = [];
  const router = registerVoiceUtteranceRoutes(app, { deliver: async (target, text) => {
    deliveries.push({ target: target.key, text });
    return "queued";
  } }, () => {});
  t.after(() => router.reset());
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const fixture = resolve("test/fixtures/voice/steve-check-the-build.wav");
  const play = (file: string) => run(process.execPath, [join(dist, "voice-listener/sherpa.mjs"), "--test-model", "--input-file", file], {
    env: { ...process.env, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + addr.port,
      MISSION_VOICE_TOKEN_FILE: tokenPath(), MISSION_VOICE_MODEL_DIR: model }, timeout: 60_000,
  });
  await play(fixture);
  assert.equal(captures.length, 1);
  const capture = captures[0]!;
  assert.equal(capture.backend, "sherpa-onnx");
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z ]/gu, "").trim();
  assert.equal(normalize(capture.text), "steve check the build");
  assert.deepEqual(capture.words.map(word => normalize(word.text)), ["steve", "check", "the", "build"]);
  for (const [i, word] of capture.words.entries()) {
    assert.ok(word.endMs > word.startMs);
    assert.ok(word.startMs >= (capture.words[i - 1]?.endMs ?? 0));
  }
  assert.deepEqual(deliveries.map(({ target, text }) => [target, normalize(text)]), [["resident:steve", "check the build"]]);
  t.diagnostic(JSON.stringify({ transcript: capture.text, words: capture.words, deliveries }));

  // The fixture is mono 16-bit PCM with a 44-byte RIFF header.
  const wav = await readFile(fixture);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  await t.test("rejects an 8 kHz WAV", async () => {
    voiceStateStore.reset(); // A new listener process claims its own lease.
    const wrongRate = Buffer.from(wav);
    wrongRate.writeUInt32LE(8000, 24);
    wrongRate.writeUInt32LE(16000, 28);
    const path = join(dist, "wrong-rate.wav");
    await writeFile(path, wrongRate);
    await assert.rejects(play(path), /Expected a 16 kHz mono WAV/);
    assert.equal(posts, 1);
  });
  await t.test("finishes a silent recording without posting an utterance", async () => {
    voiceStateStore.reset();
    wav.fill(0, 44);
    const path = join(dist, "silence.wav");
    await writeFile(path, wav);
    await play(path);
    assert.equal(posts, 1);
  });
});
