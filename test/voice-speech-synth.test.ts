import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { supportsSherpaHelpers } from "../src/shared/sherpa-platform.ts";
import { VOICE_SPEECH_MODELS, VOICE_SPEECH_NEURAL_VOICES } from "../src/shared/voice-models.ts";
import { VOICE_SPEECH_DEFAULT_NEURAL } from "../src/shared/voice-speech.ts";
import { NeuralSynthesizer } from "../src/server/voice/synthesizer.ts";
import { ensureCachedModelFile } from "./helpers/voice-test-model.ts";

test("the published helper synthesizes non-silent PCM for all ten published voices", async t => {
  const required = process.env.MISSION_VOICE_RECOGNIZER_JOB !== undefined;
  if (!supportsSherpaHelpers(process.platform, process.arch)) {
    assert.ok(!required, "The dedicated Linux job must support the speech helper");
    return t.skip("No sherpa speech helper for this platform");
  }
  const model = VOICE_SPEECH_MODELS["supertonic-3"];
  const directory = resolve(process.env.MISSION_VOICE_SPEECH_TEST_MODEL_DIR || join(tmpdir(), "mission-voice-test-model", model.revision));
  for (const file of model.files) {
    if (!await ensureCachedModelFile(directory, file, required)) {
      assert.ok(!required, "The dedicated Linux voice job requires the pinned speech model");
      return t.skip("Pinned Supertonic 3 model is absent from the offline test cache");
    }
  }
  const dist = await mkdtemp(join(tmpdir(), "voice-synth-build-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, ["scripts/build-voice-sherpa.mjs", dist]);
  const synth = new NeuralSynthesizer(() => directory, dir => fork(join(dist, "voice-speaker", "synth.mjs"), [dir],
    { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" }));
  t.after(() => synth.stop());
  assert.ok(VOICE_SPEECH_NEURAL_VOICES.some(voice => voice.id === VOICE_SPEECH_DEFAULT_NEURAL));
  for (const voice of VOICE_SPEECH_NEURAL_VOICES) {
    await t.test(voice.id, async t => {
      const { wav, durationMs } = await synth.synthesize("Steve or Stephen?", { engine: "neural", id: voice.id });
      const bytes = Buffer.from(wav);
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
      assert.equal(bytes.toString("ascii", 8, 16), "WAVEfmt ");
      assert.equal(bytes.readUInt16LE(20), 1);
      assert.equal(bytes.readUInt16LE(22), 1);
      assert.equal(bytes.readUInt16LE(34), 16);
      assert.equal(bytes.toString("ascii", 36, 40), "data");
      assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
      assert.equal(durationMs, (bytes.length - 44) / 2 * 1000 / bytes.readUInt32LE(24));
      assert.ok(durationMs >= 500 && durationMs <= 4000, String(durationMs));
      let peak = 0;
      for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
      assert.ok(peak > 32, String(peak));
      t.diagnostic(`${voice.name}: ${bytes.length} WAV bytes, ${durationMs} ms, PCM peak ${peak}`);
    });
  }
});
