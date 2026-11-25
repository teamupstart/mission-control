import { setImmediate } from "node:timers/promises";
import type { Vad } from "sherpa-onnx-node";
import type { RecordingSegments } from "./playback.ts";
import { VOICE_CONFIG_DEFAULTS } from "../shared/voice.ts";

const WINDOW = 512;
const BATCH = 64 * WINDOW;

/** One capture directive authorizes at most one batch. A null result asks playback to poll again. */
export function recordingSegments(samples: Float32Array, createVad: (endOfSpeechMs: number) => Vad, signal: AbortSignal, hostNowUs: () => number) {
  let vad: Vad | undefined;
  let duration: number | undefined;
  let offset = 0;
  let captureRevision: string | undefined;
  let pendingStart = 0;
  let readThrough = 0;
  // The WAV has no host clock. Date each 512-sample window when playback feeds it to the detector.
  // VAD segment indices start at zero again on reset. Ordinary playback needs no timestamp table.
  const windowTimes: number[] = [];
  return {
    get exhausted() { return offset === samples.length && (vad?.isEmpty() ?? true); },
    async next({ revision, captureRevision: current = revision, endOfSpeechMs, held }: Parameters<RecordingSegments["next"]>[0]) {
      await setImmediate(undefined, { signal });
      const ms = endOfSpeechMs ?? (held ? 800 : VOICE_CONFIG_DEFAULTS.endOfSpeechMs);
      if (current !== captureRevision) {
        // Even a missed mute/unmute revokes every sample seen under the old capture.
        offset = readThrough;
        pendingStart = readThrough;
        windowTimes.length = 0;
        vad?.reset();
        captureRevision = current;
      }
      if (!vad || ms !== duration) {
        vad = createVad(ms);
        duration = ms;
        // The recording owns its PCM. Re-feed only the unfinished portion to the new
        // detector in normal, interruptible batches, including speech before VAD onset.
        offset = pendingStart;
        windowTimes.length = 0;
      }
      const end = Math.min(offset + BATCH, samples.length);
      while (offset < end && vad.isEmpty()) {
        const next = Math.min(offset + WINDOW, end);
        if (held) windowTimes.push(hostNowUs());
        vad.acceptWaveform(samples.subarray(offset, next));
        offset = next;
        if (offset === samples.length) vad.flush();
      }
      readThrough = Math.max(readThrough, offset);
      if (!vad.isEmpty()) {
        pendingStart = offset;
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
