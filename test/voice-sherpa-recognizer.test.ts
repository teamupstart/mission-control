import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
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
import { VOICE_CAPTURE_START_HEADER, VOICE_REQUIRED_FLAGS, VoiceShellReportSchema } from "../src/shared/voice.ts";
import { VOICE_TEST_MODEL } from "../src/shared/voice-models.ts";
import { VoiceUtteranceSchema, type VoiceUtterance } from "../src/shared/voice-routing.ts";
import { stateDir, tokenPath } from "../src/shared/harness-runtime.mjs";
import { voiceTestModel } from "./helpers/voice-test-model.ts";
import { voiceHostTimeUs } from "../src/server/voice/host-clock.ts";
import { tempDirAsync } from "./temp-root.mjs";

const run = promisify(execFile);
test("the published sherpa addon transcribes a recording through the listener and daemon", async t => {
  const required = process.env.MISSION_VOICE_RECOGNIZER_JOB !== undefined;
  const model = await voiceTestModel(required);
  if (model === null) {
    assert.ok(!required, "The dedicated Linux recognizer job requires a verified model");
    t.skip("Pinned recognizer model is absent from the offline unit-test cache");
    return;
  }
  const cwd = await tempDirAsync("voice-listener-checkout-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await run(process.execPath, ["scripts/build-voice-sherpa.mjs", join(cwd, "dist")]);
  const manifests = join(cwd, "models.json");
  await writeFile(manifests, JSON.stringify({ "sherpa-onnx": VOICE_TEST_MODEL }));
  const originalManifest = process.env.MISSION_VOICE_MODEL_MANIFEST;
  t.after(() => {
    if (originalManifest === undefined) delete process.env.MISSION_VOICE_MODEL_MANIFEST;
    else process.env.MISSION_VOICE_MODEL_MANIFEST = originalManifest;
  });
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
  const readings: { phase: string; posts: number; final: boolean; text: string }[] = [];
  app.use("/voice/listener/transcript", async (c, next) => {
    const sample = await c.req.raw.clone().json();
    await next();
    if ((await c.res.clone().json()).accepted) {
      const preview = voiceStateStore.state().transcript;
      if (preview) readings.push({ phase: preview.phase, posts, final: sample.final === true, text: preview.text });
    }
  });
  let hellos = 0;
  let acceptedAfterRelease = false;
  let onDirectivePoll: (() => void) | undefined;
  app.use("/voice/listener/directive", async (_c, next) => {
    onDirectivePoll?.();
    await next();
  });
  let onAcceptedCapture: (() => void) | undefined;
  let onCaptureResult: ((revision: string | undefined, accepted: boolean, response: Response) => void) | undefined;
  app.use("/voice/listener/hello", async (_c, next) => { hellos++; await next(); });
  app.use("/voice/utterances", async (c, next) => {
    posts++;
    const payload = await c.req.raw.clone().json();
    if (c.req.header(VOICE_CAPTURE_START_HEADER) && voiceStateStore.state().mode === "push-to-talk") {
      setTimeout(() => {
        const released = voiceHostTimeUs();
        voiceStateStore.acceptShellReport(VoiceShellReportSchema.parse({
          reportedAtHostUs: released, callActive: true, pushToTalkReleasedAtHostUs: released,
        }));
      }, 5);
    }
    await next();
    const { accepted } = await c.res.clone().json();
    onCaptureResult?.(c.req.query("revision"), accepted, c.res);
    if (accepted) {
      captures.push(VoiceUtteranceSchema.parse(payload));
      onAcceptedCapture?.();
      if (voiceStateStore.state().mode === "auto-muted") {
        acceptedAfterRelease = true;
        voiceStateStore.acceptShellReport(VoiceShellReportSchema.parse({ reportedAtHostUs: voiceHostTimeUs(), callActive: false }));
      }
    }
  });
  registerVoiceRoutes(app);
  const deliveries: { target: string; text: string }[] = [];
  const dictation: { target: string; capture: string; text: string; interim: boolean }[] = [];
  let probe: ((windowId: string, sequence: number) => void) | undefined;
  const router = registerVoiceUtteranceRoutes(app, { deliver: async (target, text) => {
    deliveries.push({ target: target.key, text });
    return "queued";
  } }, () => {}, undefined, {
    dictate: (_window, target, text, capture, interim) => dictation.push({ target, capture, text, interim }),
    probeDictation: (windowId, sequence) => probe?.(windowId, sequence),
    pending: () => [], forSession: () => [], resolve: async () => false, publish() {}, removeCompanion() {}, open() {}, confirmFocus() {},
  });
  t.after(() => router.reset());
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const fixture = resolve("test/fixtures/voice/steve-check-the-build.wav");
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + addr.port, MISSION_VOICE_TOKEN_FILE: tokenPath() };
  delete env.MISSION_VOICE_MODEL_MANIFEST;
  const play = (file: string, ...args: string[]) => run(process.execPath,
    [resolve("scripts/run-voice-listener.ts"), ...args, "--input-file", file], { cwd, env, timeout: 60_000 });
  // The fixture is mono 16-bit PCM with a 44-byte RIFF header.
  const wav = await readFile(fixture);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  await t.test("finishes a zero-frame WAV without claiming the listener lease", async () => {
    const header = Buffer.from(wav.subarray(0, 44));
    header.writeUInt32LE(header.length - 8, 4);
    header.writeUInt32LE(0, 40);
    const path = join(cwd, "empty.wav");
    await writeFile(path, header);
    await play(path);
    assert.equal(hellos, 0);
    assert.equal(posts, 0);
  });
  await t.test("refuses non-finite float PCM samples before hello", async () => {
    const float = Buffer.from(wav.subarray(0, 48)); // One mono float32 sample after the header.
    float.writeUInt32LE(float.length - 8, 4);
    float.writeUInt16LE(3, 20);
    float.writeUInt32LE(16000 * 4, 28);
    float.writeUInt16LE(4, 32);
    float.writeUInt16LE(32, 34);
    float.writeUInt32LE(4, 40);
    const path = join(cwd, "nonfinite.wav");
    for (const sample of [NaN, Infinity, -Infinity]) {
      float.writeFloatLE(sample, 44);
      await writeFile(path, float);
      await assert.rejects(play(path), /Non-finite WAV sample/);
      assert.equal(hellos, 0);
      assert.equal(posts, 0);
    }
  });
  await t.test("refuses an oversized file and an overstated WAV data chunk before hello", async () => {
    const path = join(cwd, "oversized.wav");
    await writeFile(path, wav.subarray(0, 44));
    await truncate(path, 32 * 1024 * 1024 + 1);
    await assert.rejects(play(path), /32 MiB WAV limit/);
    const truncated = Buffer.from(wav);
    truncated.writeUInt32LE(0xffffffff, 40);
    await writeFile(path, truncated);
    await assert.rejects(play(path), /Truncated WAV chunk/);
    assert.equal(hellos, 0);
    assert.equal(posts, 0);
  });
  await t.test("rejects a 16 kHz stereo WAV with speech on channel two before hello", async () => {
    const data = wav.subarray(44);
    const stereo = Buffer.alloc(44 + data.length * 2);
    wav.copy(stereo, 0, 0, 44);
    stereo.writeUInt32LE(stereo.length - 8, 4); // RIFF chunk size
    stereo.writeUInt16LE(2, 22); // channels
    stereo.writeUInt32LE(16000 * 4, 28); // bytes per second
    stereo.writeUInt16LE(4, 32); // bytes per stereo frame
    stereo.writeUInt32LE(data.length * 2, 40);
    for (let i = 0; i < data.length; i += 2) stereo.writeInt16LE(data.readInt16LE(i), 44 + i * 2 + 2);
    const path = join(cwd, "stereo.wav");
    await writeFile(path, stereo);
    await assert.rejects(play(path), /Expected a 16 kHz mono WAV/);
    assert.equal(hellos, 0);
    assert.equal(posts, 0);
  });
  await t.test("rejects an 8 kHz WAV before hello and admits an immediate valid retry", async () => {
    const wrongRate = Buffer.from(wav);
    wrongRate.writeUInt32LE(8000, 24);
    wrongRate.writeUInt32LE(16000, 28);
    const path = join(cwd, "wrong-rate.wav");
    await writeFile(path, wrongRate);
    await assert.rejects(play(path), /Expected a 16 kHz mono WAV/);
    assert.equal(hellos, 0);
    assert.equal(posts, 0);
    await play(fixture);
    assert.ok(hellos > 0);
    assert.equal(posts, 1);
  });
  assert.equal(captures.length, 1);
  await t.test("short WAV playback reports quiet and audio and publishes the accepted final words", () => {
    // Either decoder can finish first on a short file. Completed addressing has priority.
    assert.deepEqual(readings.slice(0, 2).map(r => r.phase), ["ready", "audio"]);
    assert.deepEqual(readings.at(-1), { phase: "words", final: true, posts: 1, text: captures[0]!.text });
  });
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
  await t.test("the native WAV segment remains admissible when key-up arrives during its POST", async () => {
    voiceStateStore.reset();
    voiceStateStore.acceptShellReport(VoiceShellReportSchema.parse({
      reportedAtHostUs: voiceHostTimeUs(), callActive: true, pushToTalk: true,
    }));
    await play(fixture, "--backend", "sherpa-onnx");
    assert.equal(acceptedAfterRelease, true);
    assert.equal(captures.length, 3);
    assert.equal(normalize(captures[2]!.text), "steve check the build");
  });
  const recording = await readFile(fixture);
  const phrase = recording.subarray(44);
  const pcmBytesPerMs = 32;
  const silence = (ms: number) => Buffer.alloc(ms * pcmBytesPerMs);
  async function playPhrases(name: string, ...pcm: Buffer[]): Promise<VoiceUtterance[]> {
    const sequence = Buffer.concat([recording.subarray(0, 44), ...pcm]);
    sequence.writeUInt32LE(sequence.length - 8, 4);
    sequence.writeUInt32LE(sequence.length - 44, 40);
    const path = join(cwd, name);
    await writeFile(path, sequence);
    const before = captures.length;
    await play(path, "--backend", "sherpa-onnx");
    return captures.slice(before);
  }
  await t.test("Sherpa splits or joins the same recorded phrases at the selected silence boundary", async () => {
    // The recording already has about 1.2 seconds of combined trailing and leading quiet.
    for (const [endOfSpeechMs, addedQuietMs, expected] of [[500, 0, 2], [2000, 0, 1], [2000, 1800, 2], [5000, 1800, 1]] as const) {
      voiceStateStore.reset();
      setVoiceConfig({ endOfSpeechMs });
      const messages = await playPhrases("two-phrases.wav", phrase, silence(addedQuietMs), phrase);
      assert.equal(messages.length, expected, `delay ${endOfSpeechMs} ms, added silence ${addedQuietMs} ms`);
      if (expected === 1) {
        // Recognition of the name can vary without priming. Its final word must come from the second phrase.
        assert.ok(messages[0]!.words.at(-1)!.endMs > (phrase.length / pcmBytesPerMs) + addedQuietMs);
      }
    }
  });
  await t.test("a five-second pause setting still joins recorded speech across Sherpa’s 20-second threshold", async () => {
    voiceStateStore.reset();
    setVoiceConfig({ endOfSpeechMs: 5000 });
    const before = posts;
    readings.length = 0;
    const messages = await playPhrases("past-twenty-seconds.wav", ...Array<Buffer>(9).fill(phrase), silence(5000));
    assert.equal(messages.length, 1);
    assert.ok(readings.some(r => r.posts === before && !r.final && r.phase === "words" && r.text.trim()),
      "unpaced playback published a recognized prefix before the long utterance reached the router");
    assert.ok(messages[0]!.words.at(-1)!.endMs > 8 * phrase.length / pcmBytesPerMs, "the ninth command belongs to the first capture");
  });
  await t.test("Sherpa drops a recording’s overlong command through its selected pause and admits the next command", async t => {
    voiceStateStore.reset();
    setVoiceConfig({ endOfSpeechMs: 3000 });
    let polls = 0;
    onDirectivePoll = () => { if (++polls === 18) setVoiceConfig({ endOfSpeechMs: 5000 }); };
    t.after(() => { onDirectivePoll = undefined; });
    const messages = await playPhrases("overlong.wav", ...Array<Buffer>(25).fill(phrase), silence(5000), phrase);
    assert.deepEqual(messages.map(message => normalize(message.text)), ["steve check the build"]);
    assert.ok(messages[0]!.words.at(-1)!.endMs < phrase.length / pcmBytesPerMs);
  });
  await t.test("successive delay edits retain an emerging recorded command after extended silence", async t => {
    voiceStateStore.reset();
    setVoiceConfig({ endOfSpeechMs: 2000 });
    let polls = 0;
    onDirectivePoll = () => {
      polls++;
      if (polls === 8) setVoiceConfig({ endOfSpeechMs: 5000 });
      if (polls === 9) setVoiceConfig({ endOfSpeechMs: 800 });
    };
    t.after(() => { onDirectivePoll = undefined; });
    // At poll eight only the first 64 ms of the name has been voiced, before Silero confirms onset.
    const messages = await playPhrases("quiet-before-edits.wav", silence(7 * 2048 - 256), phrase);
    assert.deepEqual(messages.map(message => normalize(message.text)), ["steve check the build"]);
    assert.ok(polls >= 9 && polls <= 12, `finished at poll ${polls}`);
  });
  await t.test("one running Sherpa listener applies a longer boundary between phrases in the same recording", async t => {
    voiceStateStore.reset();
    setVoiceConfig({ endOfSpeechMs: 500 });
    // The natural gap is ~1.2 s. Extend the later gaps to ~4.2 and ~6.2 s:
    // only the 5 s choice joins the middle pair and still splits the final phrase.
    onAcceptedCapture = () => {
      // The helper waits for this POST before polling and feeding any more audio.
      onAcceptedCapture = undefined;
      setVoiceConfig({ endOfSpeechMs: 5000 });
    };
    t.after(() => { onAcceptedCapture = undefined; });
    const messages = await playPhrases("live-delay.wav", phrase, phrase, silence(3000), phrase, silence(5000), phrase);
    assert.equal(messages.length, 3);
    const phraseMs = phrase.length / pcmBytesPerMs;
    assert.ok(messages[0]!.words.at(-1)!.endMs < phraseMs, "500 ms splits the first phrase");
    assert.ok(messages[1]!.words.at(-1)!.endMs > phraseMs + 3000, "5 s joins both middle phrases");
    assert.ok(messages[2]!.words.at(-1)!.endMs < phraseMs, "the final phrase is separate");
  });
  await t.test("Sherpa retains unfinished words when the silence delay changes during speech or the following pause", async t => {
    t.after(() => { onDirectivePoll = undefined; });
    for (const [leadMs, newDelay, expected] of [[0, 5000, 1], [1000, 5000, 1], [0, 500, 2]] as const) {
      voiceStateStore.reset();
      setVoiceConfig({ endOfSpeechMs: newDelay === 500 ? 5000 : 2000 });
      let polls = 0;
      onDirectivePoll = () => {
        // Poll two follows 2.048 seconds of input: inside the first pause, or mid-command with the lead-in.
        if (++polls === 2) setVoiceConfig({ endOfSpeechMs: newDelay });
      };
      const messages = await playPhrases("unfinished.wav", silence(leadMs), phrase, silence(1800), phrase);
      assert.equal(messages.length, expected, `after a change to ${newDelay} ms`);
      const transcript = messages.map(message => normalize(message.text)).join(" ");
      assert.equal(transcript.match(/check the build/g)?.length, 2, transcript);
    }
  });
  await t.test("a focused field receives incremental Sherpa recognition and one final transcript without session delivery", async t => {
    // Earlier recordings may still have outstanding delivery timers.
    router.reset();
    voiceStateStore.reset();
    setVoiceConfig({ endOfSpeechMs: 2000, cancelWindow: { enabled: false } });
    const disconnect = router.openCards.connect("field-window");
    t.after(disconnect);
    router.openCards.report({ windowId: "field-window", focused: true, dictationTarget: crypto.randomUUID(), cards: [] });
    const before = deliveries.length;
    await play(fixture, "--backend", "sherpa-onnx");
    const final = dictation.at(-1);
    assert.ok(final && !final.interim);
    assert.equal(normalize(final.text), "steve check the build");
    assert.ok(dictation.slice(0, -1).some(frame => normalize(frame.text) && normalize(frame.text) !== normalize(final.text)));
    assert.ok(dictation.slice(0, -1).every(frame => frame.interim && frame.capture === final.capture));
    assert.equal(deliveries.length, before);
    assert.deepEqual(router.heard.list(), []);
    t.diagnostic(JSON.stringify(dictation.map(({ interim, text }) => ({ interim, text }))));
  });
  await t.test("one Sherpa process skips a focus-refused phrase and dictates the next phrase on the same revision", async t => {
    router.reset();
    voiceStateStore.reset();
    setVoiceConfig({ endOfSpeechMs: 500, cancelWindow: { enabled: false } });
    const editor = crypto.randomUUID();
    const other = crypto.randomUUID();
    for (const id of ["editor", "other"]) t.after(router.openCards.connect(id, true));
    let refusals = 0;
    const revisions: string[] = [];
    onCaptureResult = (revision, accepted, response) => {
      assert.ok(revision);
      revisions.push(revision);
      if (!accepted) {
        assert.equal(response.headers.get("x-voice-focus-unconfirmed"), "1");
        refusals++;
      }
    };
    probe = (id, sequence) => {
      router.openCards.acknowledgeDictation(id, sequence, id === "editor" ? editor : refusals ? undefined : other);
    };
    t.after(() => { probe = undefined; onCaptureResult = undefined; });
    const start = dictation.length;
    const previousPosts = posts;
    const previousDeliveries = deliveries.length;
    const messages = await playPhrases("focus-recovers.wav", phrase, silence(1000), phrase);
    assert.equal(posts - previousPosts, 2);
    assert.equal(new Set(revisions).size, 1);
    assert.equal(refusals, 1);
    assert.equal(messages.length, 1);
    const frames = dictation.slice(start);
    const final = frames.at(-1);
    assert.ok(final && !final.interim);
    assert.equal(normalize(final.text), "steve check the build");
    assert.ok(frames.some(frame => frame.interim && normalize(frame.text) !== normalize(final.text)));
    assert.ok(frames.slice(0, -1).every(frame => frame.interim));
    assert.ok(frames.every(frame => frame.target === editor && frame.capture === final.capture));
    assert.equal(deliveries.length, previousDeliveries);
    assert.deepEqual(router.heard.list(), []);
    t.diagnostic(JSON.stringify({ refusals, accepted: messages.length, frames: frames.map(({ text, interim }) => ({ text, interim })) }));
  });
});
