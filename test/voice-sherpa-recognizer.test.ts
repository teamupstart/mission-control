import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ensureToken } from "../src/server/auth.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { voiceStateStore } from "../src/server/voice/state.ts";
import { voiceModelManager } from "../src/server/voice/models.ts";
import { setVoiceConfig } from "../src/server/voice/config.ts";
import { registerVoiceRoutes, registerVoiceUtteranceRoutes } from "../src/server/voice/routes.ts";
import { VOICE_REQUIRED_FLAGS } from "../src/shared/voice.ts";
import { VOICE_TEST_MODEL } from "../src/shared/voice-models.ts";
import { VoiceUtteranceSchema, type VoiceUtterance } from "../src/shared/voice-routing.ts";
import { stateDir, tokenPath } from "../src/shared/harness-runtime.mjs";
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
  const cwd = await mkdtemp(join(tmpdir(), "voice-listener-checkout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await run(process.execPath, ["scripts/build-voice-sherpa.mjs", join(cwd, "dist")]);
  const manifests = join(cwd, "models.json");
  await writeFile(manifests, JSON.stringify({ "sherpa-onnx": VOICE_TEST_MODEL }));
  process.env.MISSION_VOICE_MODEL_MANIFEST = manifests;
  const installed = join(stateDir(), "voice", "models", "sherpa-onnx");
  await mkdir(installed, { recursive: true });
  await symlink(model, join(installed, VOICE_TEST_MODEL.revision), "dir");
  ensureToken();
  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
  setVoiceConfig({ muted: false, backend: "sherpa-onnx", cancelWindow: { enabled: false } });
  voiceModelManager.sync();
  await voiceModelManager.idle();
  assert.equal(voiceModelManager.state().status, "ready");
  voiceStateStore.useRoster(() => [{ key: "resident:steve", name: "Steve", kind: "resident", state: "running",
    sessionId: "sdk:steve", taskId: "task-steve", role: "", colorId: null, agent: "codex" }]);
  t.after(() => voiceStateStore.useRoster(null));
  const app = new Hono();
  const captures: VoiceUtterance[] = [];
  let posts = 0;
  let hellos = 0;
  app.use("/voice/listener/hello", async (_c, next) => { hellos++; await next(); });
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
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + addr.port, MISSION_VOICE_TOKEN_FILE: tokenPath() };
  delete env.MISSION_VOICE_MODEL_MANIFEST;
  delete env.MISSION_VOICE_BACKEND;
  const play = (file: string, ...args: string[]) => run(process.execPath,
    [resolve("scripts/run-voice-listener.ts"), ...args, "--input-file", file], { cwd, env, timeout: 60_000 });
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
    const path = join(cwd, "wrong-rate.wav");
    await writeFile(path, wrongRate);
    await assert.rejects(play(path), /Expected a 16 kHz mono WAV/);
    assert.equal(posts, 1);
  });
  await t.test("finishes a silent recording without posting an utterance", async () => {
    voiceStateStore.reset();
    wav.fill(0, 44);
    const path = join(cwd, "silence.wav");
    await writeFile(path, wav);
    await play(path);
    assert.equal(posts, 1);
  });
  await t.test("a conflicting explicit backend is refused before hello, while auto admits the same helper", async () => {
    voiceStateStore.reset();
    setVoiceConfig({ backend: "fluidaudio" });
    const before = hellos;
    await assert.rejects(play(fixture, "--backend", "sherpa-onnx"), /Select sherpa-onnx with PUT \/api\/voice\/config.*Voice Setup/);
    assert.equal(hellos, before, "the incompatible helper must never start its protocol");
    assert.equal(posts, 1);

    setVoiceConfig({ backend: "auto" });
    await play(fixture, "--backend", "sherpa-onnx");
    assert.ok(hellos > before);
    assert.equal(captures.length, 2);
    assert.equal(normalize(captures[1]!.text), "steve check the build");
  });
});
