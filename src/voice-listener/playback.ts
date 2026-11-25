import { setTimeout as sleep } from "node:timers/promises";
import { transcriptTail, VOICE_HELLO_INTERVAL_MS } from "../shared/voice.ts";
import { ListenerClient, type CaptureBounds } from "./client.ts";
import { tokenWords, type Recognition } from "./words.ts";

type Segment = { samples: Float32Array; capture?: CaptureBounds; onset?: number };
type Preview = { preview: "ready" } | { preview: "audio"; onset: number; samples?: Float32Array };
export type ObserveRecording = (sample: Preview) => void;
type Step = IteratorResult<Segment | null, void>;
/** EOF can be checked even while muted, without asking the detector to read any more audio. */
export interface RecordingSegments {
  readonly exhausted: boolean;
  next(directive: { revision: string; captureRevision?: string; endOfSpeechMs?: number; held?: true; observe?: ObserveRecording }): Step | Promise<Step>;
  return?(): unknown;
}

/** File playback is a finite listener session. A changed directive invalidates only the segment decoded under it. */
export async function playRecording(client: ListenerClient,
  open: (signal: AbortSignal) => RecordingSegments,
  decode: (samples: Float32Array, roster: string[]) => Promise<Recognition>,
  decodePreview?: (samples: Float32Array) => Promise<Recognition>): Promise<void> {
  const lifetime = new AbortController();
  const segments = open(lifetime.signal);
  async function hello() {
    const response = await client.hello({}, lifetime.signal);
    await response.body?.cancel();
    if (!response.ok) throw new Error("Listener hello refused: " + response.status);
  }
  async function heartbeat() {
    for (;;) {
      await sleep(VOICE_HELLO_INTERVAL_MS, undefined, { signal: lifetime.signal });
      await hello();
    }
  }
  // A detector batch may offer many growing prefixes. Keep only the newest waiting
  // prefix and at most one active decode, even across a final or a capture change.
  let pending: { sample: Preview; revision: string; signal: AbortSignal } | undefined;
  let previewRunning = false;
  let previewCapture: AbortController | undefined;
  let previewRevision: string | undefined;
  function discardPreviews() {
    pending = undefined;
    previewCapture?.abort();
    previewCapture = undefined;
  }
  async function drainPreviews() {
    if (previewRunning || !decodePreview) return;
    previewRunning = true;
    try {
      while (pending) {
        const { sample, revision, signal } = pending;
        pending = undefined;
        try {
          if (sample.preview === "ready") {
            await client.transcript({ phase: "ready" }, revision, signal);
          } else if (await client.transcript({ phase: "audio", onset: sample.onset }, revision, signal)
              && sample.samples && !signal.aborted) {
            const words = await decodePreview(sample.samples);
            if (words.text.trim() && !signal.aborted) {
              await client.transcript({ phase: "words", onset: sample.onset, text: transcriptTail(words.text) }, revision, signal);
            }
          }
        } catch {
          // Revocation, a refused preview or an undecodable prefix cannot interrupt addressing.
        }
      }
    } finally {
      previewRunning = false;
    }
  }
  async function play() {
    while (!segments.exhausted) {
      let directive = await client.poll(undefined, lifetime.signal);
      if (!directive.capture) discardPreviews();
      while (!directive.capture) directive = await client.poll(directive.revision, lifetime.signal);
      const captureRevision = directive.captureRevision ?? directive.revision;
      if (captureRevision !== previewRevision) discardPreviews();
      previewRevision = captureRevision;
      const observe: ObserveRecording | undefined = decodePreview && (sample => {
        previewCapture ??= new AbortController();
        pending = { sample, revision: captureRevision, signal: previewCapture.signal };
        void drainPreviews();
      });
      const segment = await segments.next({ ...directive, observe });
      if (segment.done) return;
      if (segment.value === null) continue;
      lifetime.signal.throwIfAborted();
      discardPreviews();
      const capturedAt = Date.now();
      const result = await decode(segment.value.samples, directive.roster);
      lifetime.signal.throwIfAborted();
      if (!result.text.trim()) continue;
      const response = await client.utterance(result.text, tokenWords(result), captureRevision, capturedAt, lifetime.signal, segment.value.capture);
      if (!response) {
        console.warn("Voice listener dropped one segment after waiting for push-to-talk release.");
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Utterance HTTP " + response.status);
      }
      const acknowledgment = await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null;
        throw error;
      });
      if (typeof acknowledgment?.accepted !== "boolean") throw new Error("Invalid voice utterance acknowledgment");
      if (acknowledgment.accepted && segment.value.onset !== undefined) {
        await client.transcript({ phase: "words", onset: segment.value.onset, text: transcriptTail(result.text), final: true },
          captureRevision, lifetime.signal);
      } else if (!acknowledgment.accepted) {
        const current = await client.poll(undefined, lifetime.signal);
        if ((current.captureRevision ?? current.revision) === captureRevision) throw new Error("Daemon refused the capture");
        // Capture changed during decoding. Discard this segment and continue from the next one.
      }
    }
  }
  try {
    if (segments.exhausted) return;
    await hello();
    await Promise.race([heartbeat(), play()]);
  } finally {
    discardPreviews();
    lifetime.abort();
    await segments.return?.();
  }
}
