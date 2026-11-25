import { join } from "node:path";
import type { SpeechRequest, SpeechReply } from "./protocol.ts";
import { OfflineTts } from "sherpa-onnx-node";
import { VOICE_SPEECH_MODELS, VOICE_SPEECH_NEURAL_VOICES } from "../shared/voice-models.ts";

const revision = process.argv[2];
if (!revision || !process.send) throw new Error("Speech helper requires a model directory and IPC");
process.once("disconnect", () => process.exit(0));
const manifest = VOICE_SPEECH_MODELS["supertonic-3"];
function file(name: string) {
  const match = manifest.files.find(entry => entry.path.endsWith("/" + name));
  if (!match) throw new Error("Incomplete Supertonic manifest");
  return join(revision!, match.path);
}
const tts = new OfflineTts({
  model: {
    supertonic: {
      durationPredictor: file("duration_predictor.int8.onnx"), textEncoder: file("text_encoder.int8.onnx"),
      vectorEstimator: file("vector_estimator.int8.onnx"), vocoder: file("vocoder.int8.onnx"),
      ttsJson: file("tts.json"), unicodeIndexer: file("unicode_indexer.bin"), voiceStyle: file("voice.bin"),
    },
    numThreads: 2, provider: "cpu", debug: 0,
  },
  maxNumSentences: 1,
});

function monoWav(samples: Float32Array, rate: number) {
  const size = samples.length * 2;
  const wav = Buffer.allocUnsafe(44 + size);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + size, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(size, 40);
  for (let i = 0; i < samples.length; ++i) {
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768))), 44 + 2 * i);
  }
  return wav;
}

// Only the parent has this IPC channel. Neither sentences nor waveforms leave it.
const reply = (message: SpeechReply) => process.send!(message);
process.on("message", (msg: SpeechRequest & { id: number }) => {
  try {
    if (msg.type === "warm") return reply({ id: msg.id, ready: true });
    const voice = VOICE_SPEECH_NEURAL_VOICES.find(v => v.id === msg.voice);
    if (msg.type !== "synthesize" || !voice) throw new Error("Unknown speech request");
    const { samples, sampleRate } = tts.generate({ text: msg.text,
      generationConfig: { sid: voice.index, speed: 1, numSteps: 8, extra: { lang: "en" } } });
    if (!samples.length || !(sampleRate > 0)) throw new Error("No speech generated");
    reply({ id: msg.id, wav: monoWav(samples, sampleRate), durationMs: samples.length * 1000 / sampleRate });
  } catch {
    reply({ id: msg.id, failed: true });
  }
});
