import { setTimeout as sleep } from "node:timers/promises";
import { VOICE_HELD_REVISION_HEADER, VOICE_HELLO_INTERVAL_MS } from "../shared/voice.ts";
import { ListenerClient, type CaptureBounds } from "./client.ts";
import { tokenWords, type Recognition } from "./words.ts";

type Segment = { samples: Float32Array; capture?: CaptureBounds };
type Step = IteratorResult<Segment | null, void>;
/** EOF can be checked even while muted, without asking the detector to read any more audio. */
export interface RecordingSegments {
  readonly exhausted: boolean;
  next(directive: { revision: string; held?: true }): Step | Promise<Step>;
  return?(): unknown;
}

/** File playback is a finite listener session. A changed directive invalidates only the segment decoded under it. */
export async function playRecording(client: ListenerClient,
  open: (signal: AbortSignal) => RecordingSegments,
  decode: (samples: Float32Array, roster: string[]) => Promise<Recognition>): Promise<void> {
  const lifetime = new AbortController();
  const segments = open(lifetime.signal);
  async function hello() {
    const response = await client.hello({}, lifetime.signal);
    if (!response.ok) throw new Error("Listener hello refused: " + response.status);
  }
  async function heartbeat() {
    for (;;) {
      await sleep(VOICE_HELLO_INTERVAL_MS, undefined, { signal: lifetime.signal });
      await hello();
    }
  }
  async function play() {
    while (!segments.exhausted) {
      let directive = await client.poll(undefined, lifetime.signal);
      while (!directive.capture) directive = await client.poll(directive.revision, lifetime.signal);
      const segment = await segments.next(directive);
      if (segment.done) return;
      if (segment.value === null) continue;
      lifetime.signal.throwIfAborted();
      const capturedAt = Date.now();
      const result = await decode(segment.value.samples, directive.roster);
      lifetime.signal.throwIfAborted();
      if (!result.text.trim()) continue;
      const response = await client.utterance(result.text, tokenWords(result), directive.revision, capturedAt, lifetime.signal, segment.value.capture);
      if (!response.ok) throw new Error("Utterance HTTP " + response.status);
      if (response.headers.get(VOICE_HELD_REVISION_HEADER) === directive.revision) {
        await response.body?.cancel();
        console.warn("Voice listener dropped one segment after waiting for push-to-talk release.");
        continue;
      }
      if (!(await response.json()).accepted) {
        const current = await client.poll(undefined, lifetime.signal);
        if (current.revision === directive.revision) throw new Error("Daemon refused the capture");
        // Capture changed during decoding. Discard this segment and continue from the next one.
      }
    }
  }
  try {
    if (segments.exhausted) return;
    await hello();
    await Promise.race([heartbeat(), play()]);
  } finally {
    lifetime.abort();
    await segments.return?.();
  }
}
