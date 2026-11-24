import { setImmediate } from "node:timers/promises";
import type { Vad, readWave } from "sherpa-onnx-node";
import type { RecordingSegment } from "./playback.ts";

const WINDOW = 512;

/** Buffer one detection so trailing silence can mark the last utterance before decoding it. */
export async function* recordingSegments(read: () => ReturnType<typeof readWave>, vad: Vad, signal: AbortSignal): AsyncGenerator<RecordingSegment> {
  const wave = read();
  if (wave.sampleRate !== 16000) throw new Error("Expected a 16 kHz mono WAV");
  let pending: Float32Array | undefined;
  for (let offset = 0; offset < wave.samples.length; offset += WINDOW) {
    // Give the heartbeat and cancellation a turn even through long runs of silence.
    if (offset % (64 * WINDOW) === 0) await setImmediate(undefined, { signal });
    vad.acceptWaveform(wave.samples.subarray(offset, offset + WINDOW));
    if (offset + WINDOW >= wave.samples.length) vad.flush();
    while (!vad.isEmpty()) {
      // The next detection stays in the detector until playback has capture permission again.
      if (pending) yield { samples: pending, last: false };
      pending = vad.front().samples;
      vad.pop();
    }
  }
  if (pending) yield { samples: pending, last: true };
}
