import { setImmediate } from "node:timers/promises";
import type { Vad } from "sherpa-onnx-node";
import type { RecordingSegment } from "./playback.ts";

const WINDOW = 512;
const BATCH = 64 * WINDOW;

/** One capture directive authorizes at most one batch. A null result asks playback to poll again. */
export function recordingSegments(samples: Float32Array, vad: Vad, signal: AbortSignal): AsyncIterator<RecordingSegment | null, void, string> {
  let offset = 0;
  let revision: string | undefined;
  let pending: Float32Array | undefined;
  return {
    async next(current?: string) {
      await setImmediate(undefined, { signal });
      if (revision !== undefined && current !== revision) {
        // Neither a buffered utterance nor partial speech belongs to the new directive.
        pending = undefined;
        vad.reset();
      }
      revision = current;
      const end = Math.min(offset + BATCH, samples.length);
      for (;;) {
        while (!vad.isEmpty()) {
          const previous = pending;
          pending = vad.front().samples;
          vad.pop();
          if (previous) return { done: false, value: { samples: previous, last: false } };
        }
        if (offset === end) break;
        const next = Math.min(offset + WINDOW, end);
        vad.acceptWaveform(samples.subarray(offset, next));
        offset = next;
        if (offset === samples.length) vad.flush();
      }
      if (offset < samples.length) return { done: false, value: null };
      if (!pending) return { done: true, value: undefined };
      const last = pending;
      pending = undefined;
      return { done: false, value: { samples: last, last: true } };
    },
  };
}
