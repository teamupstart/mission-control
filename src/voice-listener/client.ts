import { claimCaptureProcess } from "../server/voice/capture-process.ts";
import { dirname, join } from "node:path";
import { closeSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  VOICE_CAPTURE_LOCK_HEADER, VOICE_CAPTURE_PID_HEADER,
  VOICE_SPEECH_START_HEADER, VOICE_CAPTURE_END_HEADER, VOICE_CAPTURE_START_HEADER, VOICE_HELD_REVISION_HEADER,
  VOICE_LISTENER_ID_HEADER, VOICE_LISTENER_PROTOCOL_VERSION,
  VoiceListenerDirectiveSchema, type VoiceListenerDirective, type VoiceListenerHello,
} from "../shared/voice.ts";
import { VOICE_INSTANCE_HEADER } from "../shared/voice-speech.ts";
import type { VoiceUtterance } from "../shared/voice-routing.ts";
import { loopbackDaemonUrl } from "./daemon-url.ts";

export type CaptureBounds = { startUs: number; endMs: number; speechStartUs?: number };

/** Loopback contract I client. A process keeps the same lease ID for its lifetime. */
export class ListenerClient {
  private readonly id = crypto.randomUUID();

  private processHeaders: Record<string, string> = {};

  private captureAddon?: string;
  private captureLock?: { fd: number; offset: number };

  trackProcess(addon: string) {
    const instance = process.env.MISSION_VOICE_LISTENER_INSTANCE;
    if (instance) this.processHeaders = { [VOICE_INSTANCE_HEADER]: instance };
    else {
      this.captureAddon = addon;
      this.processHeaders = { [VOICE_CAPTURE_PID_HEADER]: String(process.pid) };
    }
  }

  constructor(private readonly url: string, private readonly tokenFile: string,
    private readonly send: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly backend: VoiceListenerHello["backend"] = "sherpa-onnx") {
    loopbackDaemonUrl(url);
  }

  private request(path: string, body?: unknown, signal?: AbortSignal, capture?: CaptureBounds) {
    return this.send(new URL(path, this.url).href, {
      headers: { ...this.processHeaders, "x-harness-token": readFileSync(this.tokenFile, "utf8").trim(),
        [VOICE_LISTENER_ID_HEADER]: this.id, "content-type": "application/json",
        ...(capture?.speechStartUs !== undefined && { [VOICE_SPEECH_START_HEADER]: String(capture.speechStartUs) }),
        ...(capture && { [VOICE_CAPTURE_START_HEADER]: String(capture.startUs), [VOICE_CAPTURE_END_HEADER]: String(capture.endMs) }) },
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  }

  async hello(overrides: Partial<VoiceListenerHello> = {}, signal?: AbortSignal) {
    const response = await this.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION, backend: this.backend,
      modelLoaded: true, microphone: "granted", primingAvailable: true, devices: [], ...overrides }, signal);
    const challenge = response.headers.get(VOICE_CAPTURE_LOCK_HEADER);
    if (response.ok && this.captureAddon && challenge !== null) {
      const offset = Number(challenge);
      if (!Number.isSafeInteger(offset) || offset < 1 || offset >= 2 ** 48) throw new Error("Invalid capture process challenge.");
      if (this.captureLock?.offset !== offset) {
        if (this.captureLock) closeSync(this.captureLock.fd);
        this.captureLock = undefined;
        const fd = claimCaptureProcess(join(dirname(this.tokenFile), "voice-capture.lock"), offset, this.captureAddon);
        this.captureLock = { fd, offset };
      }
    }
    return response;
  }

  async poll(revision?: string, signal?: AbortSignal): Promise<VoiceListenerDirective & { held?: true }> {
    const path = "/voice/listener/directive" + (revision ? "?revision=" + encodeURIComponent(revision) : "");
    let response = await this.request(path, undefined, signal);
    for (let backoff = 100; response.status === 503; backoff = Math.min(2000, backoff * 2)) {
      await response.body?.cancel();
      await sleep(backoff, undefined, { signal });
      response = await this.request(path, undefined, signal);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Directive HTTP " + response.status);
    }
    const directive = VoiceListenerDirectiveSchema.safeParse(await response.json());
    if (!directive.success) throw new Error("Invalid voice listener directive");
    return response.headers.get(VOICE_HELD_REVISION_HEADER) === directive.data.revision
      ? { ...directive.data, held: true } : directive.data;
  }

  async speech(revision: string, speechStartUs: number, event: { phase: "start" | "focus" | "finish" } | { phase: "preview"; text: string }, signal: AbortSignal) {
    const response = await this.request("/voice/listener/speech?revision=" + encodeURIComponent(revision), { ...event, speechStartUs }, signal);
    await response.body?.cancel();
    if (!response.ok) throw new Error("Listener speech HTTP " + response.status);
    return response.headers.get("x-voice-dictation") === "1";
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
