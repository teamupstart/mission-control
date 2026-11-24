import { fork, type ChildProcess } from "node:child_process";
import { once, EventEmitter } from "node:events";
import type { VoiceSpeechVoice } from "@shared/voice-speech.ts";
import { resolveOwnedRuntime } from "../../shared/owned-runtime.mjs";
import { currentOwnedRuntime } from "../owned-runtime.ts";
import { speechHelperPath } from "../config.ts";
import type { SpeechRequest, SpeechReply } from "../../voice-speaker/protocol.ts";
import type { VoiceSynthesizer } from "./speech.ts";

type Audio = Awaited<ReturnType<VoiceSynthesizer["synthesize"]>>;

function startHelper(directory: string) {
  const runtime = resolveOwnedRuntime(currentOwnedRuntime());
  return fork(speechHelperPath(), [directory], {
    execPath: runtime.command, env: runtime.env, execArgv: [], serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

export class NeuralSynthesizer implements VoiceSynthesizer {
  private helper?: ReturnType<NeuralSynthesizer["launch"]>;
  private idle?: NodeJS.Timeout;
  private lifetime = new AbortController();
  private serial = 0;
  private readonly cache = new Map<string, Audio>();

  constructor(
    private readonly directory: () => string | null,
    private readonly start: (directory: string) => ChildProcess = startHelper,
  ) {}

  private launch(directory: string) {
    const child = this.start(directory);
    const closed = new AbortController();
    const replies = new EventEmitter();
    const close = () => {
      if (this.helper?.child === child) this.helper = undefined;
      closed.abort(new Error("Speech helper exited"));
    };
    child.once("exit", close);
    child.once("error", close);
    child.on("message", (msg: { id: number }) => replies.emit(String(msg.id), msg));
    return { child, closed, replies };
  }

  private keepAlive() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.helper?.child.kill("SIGKILL");
      this.helper = undefined;
    }, 10 * 60_000);
    this.idle.unref();
  }

  private async request(message: SpeechRequest, caller?: AbortSignal): Promise<SpeechReply> {
    const directory = this.directory();
    if (!directory) throw new Error("No verified speech model");
    const deadline = AbortSignal.timeout(5000);
    const lifetime = this.lifetime.signal;
    const signal = AbortSignal.any(caller ? [deadline, lifetime, caller] : [deadline, lifetime]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      this.keepAlive();
      const helper = this.helper ??= this.launch(directory);
      const id = ++this.serial;
      const stop = AbortSignal.any([signal, helper.closed.signal]);
      const response = once(helper.replies, String(id), { signal: stop });
      helper.child.send({ ...message, id }, error => { if (error) helper.child.kill("SIGKILL"); });
      try {
        const [reply] = await response as [SpeechReply];
        signal.throwIfAborted();
        if ("failed" in reply) throw new Error("Speech synthesis failed");
        this.keepAlive();
        return reply;
      } catch (error) {
        if (deadline.aborted && this.helper === helper) {
          helper.child.kill("SIGKILL");
          this.helper = undefined;
        }
        signal.throwIfAborted();
        if (attempt || !helper.closed.signal.aborted) throw error;
      }
    }
  }

  warm(): void {
    if (this.helper) this.keepAlive();
    else void this.request({ type: "warm" }).catch(() => { /* An actual request can start a fresh helper. */ });
  }

  async synthesize(text: string, voice: VoiceSpeechVoice, signal?: AbortSignal): Promise<Audio> {
    signal?.throwIfAborted();
    if (voice.engine !== "neural" || !this.directory()) throw new Error("No verified neural voice");
    const key = JSON.stringify([text, voice.id]);
    let audio = this.cache.get(key);
    if (audio) {
      this.cache.delete(key);
      if (this.helper) this.keepAlive();
    } else {
      const reply = await this.request({ type: "synthesize", text, voice: voice.id }, signal);
      if (!("wav" in reply) || !(reply.wav instanceof Uint8Array) || !Number.isFinite(reply.durationMs) || reply.durationMs <= 0) {
        throw new Error("Invalid synthesis response");
      }
      audio = { wav: new Uint8Array(reply.wav), durationMs: reply.durationMs };
    }
    this.cache.set(key, audio);
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
    return audio;
  }

  stop(): void {
    clearTimeout(this.idle);
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.helper?.child.kill("SIGKILL");
    this.helper = undefined;
    this.cache.clear();
  }
}
