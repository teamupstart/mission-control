import { readFileSync } from "node:fs";
import {
  VOICE_LISTENER_ID_HEADER, VOICE_LISTENER_PROTOCOL_VERSION,
  VoiceListenerDirectiveSchema, type VoiceListenerDirective, type VoiceListenerHello,
} from "../shared/voice.ts";
import type { VoiceUtterance } from "../shared/voice-routing.ts";
import { loopbackDaemonUrl } from "./daemon-url.ts";

/** Loopback contract I client. A process keeps the same lease ID for its lifetime. */
export class ListenerClient {
  private readonly id = crypto.randomUUID();

  constructor(private readonly url: string, private readonly tokenFile: string,
    private readonly send: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly backend: VoiceListenerHello["backend"] = "sherpa-onnx") {
    loopbackDaemonUrl(url);
  }

  private request(path: string, body?: unknown, signal?: AbortSignal) {
    return this.send(new URL(path, this.url).href, {
      headers: { "x-harness-token": readFileSync(this.tokenFile, "utf8").trim(),
        [VOICE_LISTENER_ID_HEADER]: this.id, "content-type": "application/json" },
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  }

  hello(overrides: Partial<VoiceListenerHello> = {}, signal?: AbortSignal) {
    return this.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION, backend: this.backend,
      modelLoaded: true, microphone: "granted", primingAvailable: true, devices: [], ...overrides }, signal);
  }

  async poll(revision?: string, signal?: AbortSignal): Promise<VoiceListenerDirective> {
    const response = await this.request("/voice/listener/directive" + (revision ? "?revision=" + encodeURIComponent(revision) : ""), undefined, signal);
    if (!response.ok) throw new Error("Directive HTTP " + response.status);
    const directive = VoiceListenerDirectiveSchema.safeParse(await response.json());
    if (!directive.success) throw new Error("Invalid voice listener directive");
    return directive.data;
  }

  utterance(text: string, words: VoiceUtterance["words"], revision: string, capturedAt = Date.now(), signal?: AbortSignal) {
    return this.request("/voice/utterances?revision=" + encodeURIComponent(revision),
      { text, words, id: crypto.randomUUID(), capturedAt, backend: this.backend }, signal);
  }
}
