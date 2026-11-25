import { setImmediate } from "node:timers/promises";
import type { Vad } from "sherpa-onnx-node";
import type { RecordingSegments } from "./playback.ts";
import { VOICE_CONFIG_DEFAULTS, VOICE_END_OF_SPEECH_MS } from "../shared/voice.ts";

export const WINDOW = 512;
const SAMPLE_RATE = 16_000;
const MAX_SEGMENT = 30 * SAMPLE_RATE;
// Half a second covers Silero's 150 ms onset confirmation and its overlapping analysis windows.
const LEAD = 16 * WINDOW;
const DISCARD_LOOKBACK = LEAD + Math.ceil(Math.max(...VOICE_END_OF_SPEECH_MS) * 16 / WINDOW) * WINDOW;
const BATCH = 64 * WINDOW;
const PREVIEW_INTERVAL = 0.75 * SAMPLE_RATE;

/** One capture directive authorizes at most one batch. A null result asks playback to poll again. */
export function recordingSegments(samples: Float32Array, createVad: (endOfSpeechMs: number) => Vad, signal: AbortSignal, hostNowUs: () => number) {
  let speechStartUs: number | undefined;
  let previewThrough = 0;
  let vad: Vad | undefined;
  let duration: number | undefined;
  let offset = 0;
  let captureRevision: string | undefined;
  let pendingStart = 0;
  let readThrough = 0;
  let detectorBase = 0;
  let discardedThrough = 0;
  // The WAV has no host clock. Date each 512-sample window when playback feeds it to the detector.
  // VAD segment indices start at zero again on reset. Ordinary playback needs no timestamp table.
  const windowTimes: number[] = [];
  return {
    get exhausted() { return offset === samples.length && (vad?.isEmpty() ?? true); },
    async next({ revision, captureRevision: current = revision, endOfSpeechMs, held, preview }: Parameters<RecordingSegments["next"]>[0]) {
      await setImmediate(undefined, { signal });
      const ms = endOfSpeechMs ?? (held ? 800 : VOICE_CONFIG_DEFAULTS.endOfSpeechMs);
      if (current !== captureRevision) {
        // Even a missed mute/unmute revokes every sample seen under the old capture.
        speechStartUs = undefined;
        previewThrough = 0;
        offset = readThrough;
        pendingStart = readThrough;
        detectorBase = readThrough;
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
        detectorBase = offset;
        windowTimes.length = 0;
      }
      const end = Math.min(offset + BATCH, samples.length);
      while (offset < end && vad.isEmpty()) {
        const next = Math.min(offset + WINDOW, end);
        if (held) windowTimes.push(hostNowUs());
        vad.acceptWaveform(samples.subarray(offset, next));
        offset = next;
        if (!vad.isDetected()) pendingStart = Math.max(pendingStart, offset - LEAD);
        else if (preview && pendingStart >= discardedThrough && offset - pendingStart <= MAX_SEGMENT &&
            (speechStartUs === undefined || offset - previewThrough >= PREVIEW_INTERVAL)) {
          speechStartUs ??= windowTimes.at(-1) ?? hostNowUs();
          previewThrough = offset;
          await preview.update(speechStartUs, samples.subarray(pendingStart, offset));
        }
        if (offset === samples.length) vad.flush();
      }
      readThrough = Math.max(readThrough, offset);
      if (!vad.isEmpty()) {
        pendingStart = offset;
        const { start, samples } = vad.front();
        vad.pop();
        const onset = detectorBase + start;
        const speechOnset = speechStartUs;
        speechStartUs = undefined;
        if (onset < discardedThrough || offset - onset > MAX_SEGMENT) {
          await preview?.finish();
          return { done: false, value: null };
        }
        if (!held && speechOnset === undefined) return { done: false, value: { samples } };
        const startUs = held ? windowTimes[Math.floor(start / WINDOW)] : speechOnset;
        const lastUs = held ? windowTimes[Math.floor((start + samples.length - 1) / WINDOW)] : hostNowUs();
        if (startUs === undefined || lastUs === undefined) throw new Error("Missing playback time for a held speech segment");
        // A delay edit can replay the first window after we already reported onset.
        const capture = { startUs: Math.min(startUs, speechOnset ?? startUs), speechStartUs: speechOnset,
          endMs: Math.ceil((lastUs + 1) / 1000) };
        return { done: false, value: { samples, capture } };
      }
      // Bound the native buffer while an overlong command is still in progress.
      // Replay enough context to recognize even the longest allowed pause. A segment
      // starting in the discarded command is ineligible, including after another delay edit.
      if (offset - pendingStart > MAX_SEGMENT + LEAD) {
        await preview?.finish();
        speechStartUs = undefined;
        discardedThrough = offset;
        pendingStart = offset - DISCARD_LOOKBACK;
        offset = pendingStart;
        detectorBase = pendingStart;
        vad.reset();
        windowTimes.length = 0;
      }
      return offset === samples.length ? { done: true, value: undefined } : { done: false, value: null };
    },
  } satisfies RecordingSegments;
}
