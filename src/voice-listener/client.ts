import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  VOICE_CAPTURE_END_HEADER, VOICE_CAPTURE_START_HEADER, VOICE_HELD_REVISION_HEADER,
  VOICE_LISTENER_ID_HEADER, VOICE_LISTENER_PROTOCOL_VERSION,
  VoiceListenerDirectiveSchema, type VoiceListenerDirective, type VoiceListenerHello,
} from "../shared/voice.ts";
import type { VoiceUtterance } from "../shared/voice-routing.ts";
import { loopbackDaemonUrl } from "./daemon-url.ts";

export type CaptureBounds = { startUs: number; endMs: number };

/** Loopback contract I client. A process keeps the same lease ID for its lifetime. */
export class ListenerClient {
  private readonly id = crypto.randomUUID();

  constructor(private readonly url: string, private readonly tokenFile: string,
    private readonly send: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly backend: VoiceListenerHello["backend"] = "sherpa-onnx") {
    loopbackDaemonUrl(url);
  }

  private request(path: string, body?: unknown, signal?: AbortSignal, capture?: CaptureBounds) {
    return this.send(new URL(path, this.url).href, {
      headers: { "x-harness-token": readFileSync(this.tokenFile, "utf8").trim(),
        [VOICE_LISTENER_ID_HEADER]: this.id, "content-type": "application/json",
        ...(capture && { [VOICE_CAPTURE_START_HEADER]: String(capture.startUs), [VOICE_CAPTURE_END_HEADER]: String(capture.endMs) }) },
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  }

  hello(overrides: Partial<VoiceListenerHello> = {}, signal?: AbortSignal) {
    return this.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION, backend: this.backend,
      modelLoaded: true, microphone: "granted", primingAvailable: true, devices: [], ...overrides }, signal);
  }

  async poll(revision?: string, signal?: AbortSignal): Promise<VoiceListenerDirective & { held?: true }> {
    const response = await this.request("/voice/listener/directive" + (revision ? "?revision=" + encodeURIComponent(revision) : ""), undefined, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Directive HTTP " + response.status);
    }
    const directive = VoiceListenerDirectiveSchema.safeParse(await response.json());
    if (!directive.success) throw new Error("Invalid voice listener directive");
    return response.headers.get(VOICE_HELD_REVISION_HEADER) === directive.data.revision
      ? { ...directive.data, held: true } : directive.data;
  }

  utterance(text: string, words: VoiceUtterance["words"], revision: string, capturedAt?: number, signal?: AbortSignal): Promise<Response>;
  /** A held capture returns null when its retry budget is exhausted. */
  utterance(text: string, words: VoiceUtterance["words"], revision: string, capturedAt: number, signal: AbortSignal,
    capture: CaptureBounds | undefined): Promise<Response | null>;
  async utterance(text: string, words: VoiceUtterance["words"], revision: string, capturedAt = Date.now(), signal?: AbortSignal,
    capture?: CaptureBounds): Promise<Response | null> {
    const path = "/voice/utterances?revision=" + encodeURIComponent(revision);
    const body = { text, words, id: crypto.randomUUID(), capturedAt, backend: this.backend };
    if (!capture) return this.request(path, body, signal);

    // Match the native helper's budget across all three requests, including the daemon's long polls.
    const deadline = AbortSignal.timeout(55_000);
    const wait = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const response = await this.request(path, body, wait, capture);
        if (!response.ok || response.headers.get(VOICE_HELD_REVISION_HEADER) !== revision) return response;
        await response.body?.cancel();
        if (attempt < 3) await sleep(250, undefined, { signal: wait });
      }
    } catch (error) {
      if (!deadline.aborted || signal?.aborted) throw error;
    }
    return null;
  }
}
