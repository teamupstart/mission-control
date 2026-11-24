import { setTimeout as sleep } from "node:timers/promises";
import { VOICE_HELLO_INTERVAL_MS } from "../shared/voice.ts";
import { ListenerClient } from "./client.ts";
import { tokenWords, type Recognition } from "./words.ts";

/** File playback is a finite listener session. A changed directive invalidates only the segment decoded under it. */
export async function playRecording(client: ListenerClient, segments: IterableIterator<Float32Array>,
  decode: (samples: Float32Array, roster: string[]) => Promise<Recognition>): Promise<void> {
  const lifetime = new AbortController();
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
    for (;;) {
      let directive = await client.poll(undefined, lifetime.signal);
      while (!directive.capture) directive = await client.poll(directive.revision, lifetime.signal);
      const segment = segments.next();
      if (segment.done) return;
      const capturedAt = Date.now();
      const result = await decode(segment.value, directive.roster);
      lifetime.signal.throwIfAborted();
      if (!result.text.trim()) continue;
      const response = await client.utterance(result.text, tokenWords(result), directive.revision, capturedAt, lifetime.signal);
      if (!response.ok) throw new Error("Utterance HTTP " + response.status);
      if (!(await response.json()).accepted) {
        const current = await client.poll(undefined, lifetime.signal);
        if (current.revision === directive.revision) throw new Error("Daemon refused the capture");
        // Capture changed during decoding. Discard this segment and continue from the next one.
      }
    }
  }
  await hello();
  try {
    await Promise.race([heartbeat(), play()]);
  } finally {
    lifetime.abort();
    segments.return?.();
  }
}
