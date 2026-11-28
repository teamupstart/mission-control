import { setTimeout as sleep } from "node:timers/promises";
import { transcriptTail, VOICE_FOCUS_UNCONFIRMED_HEADER, VOICE_HELLO_INTERVAL_MS } from "../shared/voice.ts";
import { ListenerClient, type CaptureBounds } from "./client.ts";
import { tokenWords, type Recognition } from "./words.ts";

type Segment = { samples: Float32Array; capture?: CaptureBounds; onset?: number };
type Preview = { preview: "ready" } | { preview: "audio"; onset: number; samples?: Float32Array };
export type ObserveRecording = (sample: Preview) => void;
type Step = IteratorResult<Segment | null, void>;
interface SpeechPreview {
  update(speechStartUs: number, samples: Float32Array): Promise<void>;
  finish(): Promise<void>;
}

export interface RecordingSegments {
  /** EOF can be checked while muted without reading more audio. */
  readonly exhausted: boolean;
  next(directive: { revision: string; captureRevision?: string; endOfSpeechMs?: number; held?: true; preview?: SpeechPreview; observe?: ObserveRecording }): Step | Promise<Step>;
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
    const response = await client.hello({ reportsSpeechOnset: true }, lifetime.signal);
    await response.body?.cancel();
    if (!response.ok) throw new Error("Listener hello refused: " + response.status);
  }
  async function heartbeat() {
    for (;;) {
      await sleep(VOICE_HELLO_INTERVAL_MS, undefined, { signal: lifetime.signal });
      await hello();
    }
  }
  let speech: { revision: string; onset: number; dictating: boolean } | undefined;
  async function finishSpeech() {
    if (!speech) return;
    const { revision, onset } = speech;
    speech = undefined;
    await client.speech(revision, onset, { phase: "finish" }, AbortSignal.timeout(1500));
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
      while (!directive.capture) {
        discardPreviews();
        await finishSpeech();
        directive = await client.poll(directive.revision, lifetime.signal);
      }
      const captureRevision = directive.captureRevision ?? directive.revision;
      if (speech && speech.revision !== captureRevision) await finishSpeech();
      const preview: SpeechPreview = {
        finish: finishSpeech,
        async update(onset, samples) {
          if (!speech || speech.onset !== onset) {
            await finishSpeech();
            speech = { revision: captureRevision, onset, dictating: false };
            speech.dictating = await client.speech(captureRevision, onset, { phase: "start" }, lifetime.signal);
          } else if (!speech.dictating) {
            speech.dictating = await client.speech(captureRevision, onset, { phase: "focus" }, lifetime.signal);
          }
          if (speech.dictating) {
            let result: Recognition;
            try {
              result = await decode(samples, []);
            } catch {
              lifetime.signal.throwIfAborted();
              // A partial prefix can be undecodable even when the full utterance is valid.
              return;
            }
            if (result.text.trim()) {
              // Unchanged words can belong to a newly focused field.
              try {
                speech.dictating = await client.speech(captureRevision, onset, { phase: "preview", text: result.text }, lifetime.signal);
              } catch {
                lifetime.signal.throwIfAborted();
                console.warn("Voice listener could not deliver a dictation preview.");
              }
            }
          }
        },
      };
      if (captureRevision !== previewRevision) discardPreviews();
      previewRevision = captureRevision;
      const observe: ObserveRecording | undefined = decodePreview && (sample => {
        previewCapture ??= new AbortController();
        pending = { sample, revision: captureRevision, signal: previewCapture.signal };
        void drainPreviews();
      });
      const segment = await segments.next({ ...directive, preview, observe });
      if (segment.done) return;
      if (segment.value === null) continue;
      lifetime.signal.throwIfAborted();
      // The final starts immediately. A short recording can still have its first
      // audio report in flight, so let that preview publish until the final supersedes it.
      const capturedAt = Date.now();
      const result = await decode(segment.value.samples, speech?.dictating ? [] : directive.roster);
      lifetime.signal.throwIfAborted();
      if (!result.text.trim()) {
        await finishSpeech();
        discardPreviews();
        continue;
      }
      const response = await client.utterance(result.text, tokenWords(result), captureRevision, capturedAt, lifetime.signal, segment.value.capture);
      discardPreviews();
      if (!response) {
        await finishSpeech();
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
      if (acknowledgment.accepted) {
        if (segment.value.onset !== undefined) await client.transcript({ phase: "words", onset: segment.value.onset, text: transcriptTail(result.text), final: true },
          captureRevision, lifetime.signal);
        speech = undefined; // The final utterance closes its onset on the daemon.
      } else {
        await finishSpeech();
        if (response.headers.get(VOICE_FOCUS_UNCONFIRMED_HEADER) === "1") {
          console.warn("Voice listener skipped one phrase because editor focus could not be confirmed.");
          continue;
        }
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
    try { await finishSpeech(); } finally { await segments.return?.(); }
  }
}
