import { setImmediate } from "node:timers/promises";
import type { Vad } from "sherpa-onnx-node";
import type { RecordingSegments } from "./playback.ts";

const WINDOW = 512;
const BATCH = 64 * WINDOW;

/** One capture directive authorizes at most one batch. A null result asks playback to poll again. */
export function recordingSegments(samples: Float32Array, vad: Vad, signal: AbortSignal) {
  let offset = 0;
  let revision: string | undefined;
  return {
    get exhausted() { return offset === samples.length && vad.isEmpty(); },
    async next(current?: string) {
      await setImmediate(undefined, { signal });
      if (revision !== undefined && current !== revision) {
        // Partial speech from the old capture must not enter the next utterance.
        vad.reset();
      }
      revision = current;
      const end = Math.min(offset + BATCH, samples.length);
      while (offset < end && vad.isEmpty()) {
        const next = Math.min(offset + WINDOW, end);
        vad.acceptWaveform(samples.subarray(offset, next));
        offset = next;
        if (offset === samples.length) vad.flush();
      }
      if (!vad.isEmpty()) {
        const speech = vad.front().samples;
        vad.pop();
        return { done: false, value: speech };
      }
      return offset === samples.length ? { done: true, value: undefined } : { done: false, value: null };
    },
  } satisfies RecordingSegments;
}
