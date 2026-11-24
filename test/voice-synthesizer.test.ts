import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { NeuralSynthesizer } from "../src/server/voice/synthesizer.ts";
import { VoiceStateStore } from "../src/server/voice/state.ts";
import { VOICE_SPEECH_DEFAULT_NEURAL, type VoiceSpeechVoice } from "../src/shared/voice-speech.ts";
import { VOICE_CONFIG_DEFAULTS, VOICE_MODEL_STATE_NONE, voiceStateOff } from "../src/shared/voice.ts";

type Message = { type: string; id: number; text?: string };
type Behavior = "ok" | "hang" | "crash" | Record<string, unknown>;
class Helper extends EventEmitter {
  alive = true;
  readonly messages: Message[] = [];
  constructor(private behavior: Behavior) { super(); }
  send(message: Message) {
    this.messages.push(message);
    queueMicrotask(() => {
      if (typeof this.behavior === "object") this.emit("message", { ...this.behavior, id: message.id });
      if (this.behavior === "crash") this.kill();
      if (this.behavior === "ok") this.emit("message", { id: message.id, wav: Uint8Array.of(42), durationMs: 10 });
    });
  }
  kill() { this.alive = false; this.emit("exit"); }
}
const voice = { engine: "neural", id: VOICE_SPEECH_DEFAULT_NEURAL } as const;
function fixture(...behaviors: Behavior[]) {
  const children: Helper[] = [];
  const synth = new NeuralSynthesizer(() => "/verified", () => {
    const child = new Helper(behaviors[children.length] ?? "ok");
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { synth, children };
}

test("starts lazily and releases the warm helper ten minutes after the last work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { synth, children } = fixture();
  assert.equal(children.length, 0);
  synth.warm();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(599_999);
  assert.ok(children[0]?.alive);
  await synth.synthesize("Steve?", voice);
  t.mock.timers.tick(599_999);
  assert.ok(children[0]?.alive);
  t.mock.timers.tick(1);
  assert.equal(children[0]?.alive, false);
  await synth.synthesize("Will?", voice);
  assert.equal(children.length, 2);
  synth.stop();
  assert.equal(children[1]?.alive, false);
});

test("retries an interrupted synthesis once, including a crash of the replacement", async () => {
  for (const replacement of ["ok", "crash"] as const) {
    const { synth, children } = fixture("crash", replacement);
    const result = synth.synthesize("Steve?", voice);
    if (replacement === "ok") assert.equal((await result).durationMs, 10);
    else await assert.rejects(result);
    assert.equal(children.length, 2);
    synth.stop();
  }
});

test("rejects an explicit helper failure with the synthesis error", async t => {
  const { synth } = fixture({ failed: true });
  t.after(() => synth.stop());
  await assert.rejects(synth.synthesize("Steve?", voice), { message: "Speech synthesis failed" });
});

for (const [name, reply] of [
  ["missing WAV", { durationMs: 10 }],
  ["non-byte WAV", { wav: [42], durationMs: 10 }],
  ["non-finite duration", { wav: Uint8Array.of(42), durationMs: Infinity }],
  ["zero duration", { wav: Uint8Array.of(42), durationMs: 0 }],
] as const) {
  test(`rejects a malformed helper reply with ${name}`, async t => {
    const { synth } = fixture(reply);
    t.after(() => synth.stop());
    await assert.rejects(synth.synthesize("Steve?", voice), { message: "Invalid synthesis response" });
  });
}

test("a stalled helper fails within the five-second synthesis deadline and is reaped", async () => {
  const { synth, children } = fixture("hang");
  // AbortSignal.timeout is unrefed. Stand in for the real child's IPC handle.
  const handle = setInterval(() => {}, 1000);
  try {
    await assert.rejects(synth.synthesize("Steve?", voice), { name: "TimeoutError" });
    assert.equal(children.length, 1);
    assert.equal(children[0]?.alive, false);
  } finally { clearInterval(handle); synth.stop(); }
});

test("stopping a preparing audition immediately releases its helper for the next audition", async t => {
  const { synth, children } = fixture("hang", "ok");
  t.after(() => synth.stop());
  const audition = new AbortController();
  const discarded = assert.rejects(synth.synthesize("First audition", voice, audition.signal), { name: "AbortError" });
  audition.abort();
  const replacement = synth.synthesize("Next audition", voice);
  assert.equal((await replacement).durationMs, 10);
  await discarded;
  assert.equal(children.length, 2);
  assert.equal(children[0]?.alive, false);
  assert.deepEqual(children.map(child => child.messages.map(m => m.text)), [["First audition"], ["Next audition"]]);
});

test("shutdown cancels outstanding work without restarting the child", async () => {
  const { synth, children } = fixture("hang");
  const work = synth.synthesize("Steve?", voice);
  synth.stop();
  await assert.rejects(work);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.alive, false);
});

test("the cache keeps the 32 most recently used (sentence, voice) pairs", async () => {
  const { synth, children } = fixture();
  for (let i = 0; i < 32; i++) await synth.synthesize(String(i), voice);
  await synth.synthesize("0", voice);
  await synth.synthesize("0", { ...voice, id: "supertonic-3/M1" });
  await synth.synthesize("0", voice);
  assert.equal(children[0]?.messages.length, 33);
  await synth.synthesize("1", voice);
  assert.equal(children[0]?.messages.length, 34);
  synth.stop();
});

test("resolving warms only a neural voice that could ask aloud", async t => {
  const { synth, children } = fixture();
  const config = { ...VOICE_CONFIG_DEFAULTS, whenUnsure: "ask" as "ask" | "show" };
  const store = new VoiceStateStore({ now: Date.now, config: () => config, enabled: () => true,
    speechBackend: { model: () => VOICE_MODEL_STATE_NONE, neural: () => [], synthesizer: synth } });
  const state = voiceStateOff();
  t.mock.method(store, "state", () => state);
  state.speech.voice = voice;
  state.capabilities["speech-output"] = { available: true, reason: null };
  for (const mode of ["off", "unavailable", "muted", "auto-muted", "push-to-talk"] as const) {
    state.mode = mode;
    store.warmForAsk();
  }
  state.mode = "listening";
  config.whenUnsure = "show";
  store.warmForAsk();
  config.whenUnsure = "ask";
  state.capabilities["speech-output"].available = false;
  store.warmForAsk();
  state.capabilities["speech-output"].available = true;
  for (const other of [null, { engine: "system", id: "sample" }] as Array<VoiceSpeechVoice | null>) {
    state.speech.voice = other;
    store.warmForAsk();
  }
  assert.equal(children.length, 0);
  state.speech.voice = voice;
  store.warmForAsk();
  assert.equal(children.length, 1);
  synth.stop();
});
