import { setImmediate } from "node:timers/promises";
import type { Vad } from "sherpa-onnx-node";
import type { RecordingSegments } from "./playback.ts";

const WINDOW = 512;
const BATCH = 64 * WINDOW;

/** One capture directive authorizes at most one batch. A null result asks playback to poll again. */
export function recordingSegments(samples: Float32Array, vad: Vad, signal: AbortSignal, hostNowUs: () => number) {
  let offset = 0;
  let revision: string | undefined;
  // The WAV has no host clock. Date each 512-sample window when playback feeds it to the detector.
  // VAD segment indices start at zero again on reset. Ordinary playback needs no timestamp table.
  const windowTimes: number[] = [];
  return {
    get exhausted() { return offset === samples.length && vad.isEmpty(); },
    async next({ revision: current, held }: { revision: string; held?: true }) {
      await setImmediate(undefined, { signal });
      if (revision !== undefined && current !== revision) {
        // Partial speech from the old capture must not enter the next utterance.
        vad.reset();
        windowTimes.length = 0;
      }
      revision = current;
      const end = Math.min(offset + BATCH, samples.length);
      while (offset < end && vad.isEmpty()) {
        const next = Math.min(offset + WINDOW, end);
        if (held) windowTimes.push(hostNowUs());
        vad.acceptWaveform(samples.subarray(offset, next));
        offset = next;
        if (offset === samples.length) vad.flush();
      }
      if (!vad.isEmpty()) {
        const { start, samples } = vad.front();
        vad.pop();
        if (!held) return { done: false, value: { samples } };
        const startUs = windowTimes[Math.floor(start / WINDOW)];
        const lastUs = windowTimes[Math.floor((start + samples.length - 1) / WINDOW)];
        if (startUs === undefined || lastUs === undefined) throw new Error("Missing playback time for a held speech segment");
        return { done: false, value: { samples, capture: { startUs, endMs: Math.ceil((lastUs + 1) / 1000) } } };
      }
      return offset === samples.length ? { done: true, value: undefined } : { done: false, value: null };
    },
  } satisfies RecordingSegments;
}
