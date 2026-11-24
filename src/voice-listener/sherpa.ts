import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { OfflineRecognizer, Vad, readWave } from "sherpa-onnx-node";
import { playRecording } from "./playback.ts";
import { VOICE_MODELS, VOICE_TEST_MODEL } from "../shared/voice-models.ts";
import { ListenerClient } from "./client.ts";
import { rosterHotwords } from "./words.ts";

const { values } = parseArgs({ options: { "input-file": { type: "string" }, "test-model": { type: "boolean" } } });
const file = values["input-file"];
if (!file) throw new Error("Sherpa currently requires --input-file <16 kHz mono WAV>. Live capture is unverified.");
if (process.versions.electron || realpathSync(fileURLToPath(import.meta.url)).includes(".app/Contents/")) {
  throw new Error("File input is available only from a development checkout.");
}
const { MISSION_VOICE_DAEMON_URL: url, MISSION_VOICE_TOKEN_FILE: token, MISSION_VOICE_MODEL_DIR: directory } = process.env;
if (!url || !token || !directory) throw new Error("Missing voice listener connection settings");
const client = new ListenerClient(url, token);
const manifest = values["test-model"] ? VOICE_TEST_MODEL : VOICE_MODELS["sherpa-onnx"]!;
function modelFile(name: string) {
  const file = manifest.files.find(file => file.path.endsWith("/" + name));
  if (!file) throw new Error("Missing model file " + name);
  return join(directory!, file.path);
}
const suffix = values["test-model"] ? ".onnx" : ".int8.onnx";
const tokens = modelFile("tokens.txt");
const vocabulary = new Set(readFileSync(tokens, "utf8").split(/\r?\n/u).map(row => row.split(" ")[0]!));
const recognizer = new OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: modelFile("encoder" + suffix), decoder: modelFile("decoder" + suffix),
    joiner: modelFile("joiner" + suffix) }, tokens, numThreads: 2, provider: "cpu", modelType: "nemo_transducer" },
  decodingMethod: "modified_beam_search",
});
const vad = new Vad({ sileroVad: { model: modelFile("onnx/model.onnx"), windowSize: 512, minSilenceDuration: 0.8,
  minSpeechDuration: 0.15 }, numThreads: 1, sampleRate: 16000 }, 60);

function* segments(path: string) {
  const wave = readWave(path);
  if (wave.sampleRate !== 16000) throw new Error("Expected a 16 kHz mono WAV");
  for (let offset = 0; offset < wave.samples.length; offset += 512) {
    vad.acceptWaveform(wave.samples.subarray(offset, offset + 512));
    if (offset + 512 >= wave.samples.length) vad.flush();
    while (!vad.isEmpty()) {
      const { samples } = vad.front();
      vad.pop();
      yield samples;
    }
  }
}

await playRecording(client, segments(file), async (samples, roster) => {
  const stream = recognizer.createStream(rosterHotwords(roster, vocabulary));
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  return recognizer.decodeAsync(stream);
});
