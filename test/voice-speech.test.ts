import { fixtureSupervisorEnv, fixtureVoiceSupervisor } from "./helpers/voice-supervisor.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { before } from "node:test";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { askAloudPossible, askSentence, resolveSpeechVoice, VOICE_SPEECH_DEFAULT_NEURAL, VOICE_SPEECH_PREPARE_LIMIT_MS } from "../src/shared/voice-speech.ts";
import { VOICE_CONFIG_DEFAULTS, voiceStateOff } from "../src/shared/voice.ts";
import { VoiceSpeechManager } from "../src/server/voice/speech.ts";
import { tempDir } from "./temp-root.mjs";

Object.assign(process.env, fixtureSupervisorEnv);
before(() => ensureNativeStateLockAddon());

test("two or three names form a question", () => {
  assert.deepEqual([1, 2, 3, 4].map(n => askSentence(["A", "B", "C", "D"].slice(0, n))), [null, "A or B?", "A, B or C?", null]);
});

test("automatic prefers F4 then the best English system voice; an explicit voice wins when installed and stays unavailable when missing", () => {
  const entry = (id: string, detail: string) => ({ id, name: id, detail });
  const system = ["default", "enhanced", "premium"].map(q => entry(q, q));
  const catalog = { neural: [entry(VOICE_SPEECH_DEFAULT_NEURAL, "")], system };
  const resolve = (neural = catalog.neural, installed = system) => resolveSpeechVoice(VOICE_CONFIG_DEFAULTS, { neural, system: installed }).voice?.id;
  assert.equal(resolve(), VOICE_SPEECH_DEFAULT_NEURAL);
  assert.equal(resolve([]), "premium");
  assert.equal(resolve([], system.slice(0, 2)), "enhanced");
  assert.equal(resolve([], []), undefined);
  const selected = { engine: "system", id: "enhanced" } as const;
  assert.deepEqual(resolveSpeechVoice({ ...VOICE_CONFIG_DEFAULTS, speech: { voice: selected } }, catalog),
    { voice: selected, reason: null });
  assert.equal(resolveSpeechVoice({ ...VOICE_CONFIG_DEFAULTS, speech: { voice: { engine: "system", id: "missing" } } }, catalog).voice, null);
  const state = { ...voiceStateOff(), capabilities: { "speech-output": { available: true, reason: null } } };
  const ask = { ...VOICE_CONFIG_DEFAULTS, whenUnsure: "ask" as const };
  assert.equal(askAloudPossible(ask, { ...state, mode: "listening" }), true);
  for (const mode of ["off", "muted", "auto-muted", "push-to-talk", "unavailable"] as const) assert.equal(askAloudPossible(ask, { ...state, mode }), false);
  assert.equal(askAloudPossible(VOICE_CONFIG_DEFAULTS, { ...state, mode: "listening" }), false);
  assert.equal(askAloudPossible(ask, { ...state, mode: "listening", capabilities: {} }), false);
});

test("preparing, queued, failed and expired jobs preserve handoff order", async t => {
  const home = tempDir("speech-queue-");
  const directory = join(home, "voice");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { instance, proof } = fixtureVoiceSupervisor();
  let complete!: () => void;
  let reject!: () => void;
  const timers = new Map<() => void, number>();
  const manager = new VoiceSpeechManager({ directory, now: Date.now, changed() {},
    setTimer(fn, ms) { timers.set(fn, ms); return fn; }, clearTimer(handle) { timers.delete(handle as () => void); },
    target: () => ({ instance, voice: { engine: "neural", id: VOICE_SPEECH_DEFAULT_NEURAL } }),
    synthesizer: { warm() {}, stop() {}, synthesize: () => new Promise((resolve, fail) => {
      complete = () => resolve({ wav: new Uint8Array([1]), durationMs: 42 }); reject = fail;
    }) },
  });
  manager.supervised(instance, "started", proof("started"));
  const first = manager.open("ask", "First?", "A");
  const dropped = manager.open("ask", "Dropped?", "B");
  const last = manager.open("audition", "Last?", null);
  assert.ok(first && dropped && last);
  manager.stopCard("B");
  assert.equal(dropped.state, "stopped");
  complete();
  await Promise.resolve();
  assert.equal(first.state, "ready");
  assert.deepEqual(manager.speak(instance), { id: first.id, kind: "audio", durationMs: 42 });
  manager.event(first.id, instance, "started");
  const [timer, limit] = [...timers][0]!;
  assert.equal(limit, 1542);
  timer();
  assert.equal(first.state, "stopping");
  assert.equal(last.state, "preparing");
  manager.event(first.id, instance, "ended", "stopped");
  assert.equal(first.state, "timed-out");
  assert.equal(manager.live, last);
  reject();
  await Promise.resolve();
  assert.equal(last.state, "failed");
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "speech-holds.json"), "utf8")), []);
  const neverPlayed = manager.open("ask", "Preparing?", "C");
  assert.ok(neverPlayed);
  manager.stopCard("C");
  complete(); await Promise.resolve();
  assert.equal(neverPlayed.state, "stopped");
  assert.equal(manager.held, false);

  // A writable state directory can still refuse the atomic rename to the ledger.
  const blocked = join(directory, "speech-holds.json");
  rmSync(blocked);
  mkdirSync(blocked);
  const failed = manager.open("audition", "Cannot persist", null);
  assert.ok(failed);
  complete(); await Promise.resolve();
  assert.equal(failed.state, "failed");
  assert.equal(manager.speak(instance), null);
  manager.dispose();
});

test("stalled preparation fails on its deadline, advances the queue and discards late audio", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const home = tempDir("speech-preparation-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { instance, proof } = fixtureVoiceSupervisor();
  const complete: Array<() => void> = [];
  let stops = 0;
  const manager = new VoiceSpeechManager({
    directory: join(home, "voice"), now: Date.now, changed() {},
    target: () => ({ instance, voice: { engine: "neural", id: VOICE_SPEECH_DEFAULT_NEURAL } }),
    synthesizer: { warm() {}, stop() { stops++; }, synthesize: () => new Promise(resolve => {
      const sample = complete.length + 1;
      complete.push(() => resolve({ wav: new Uint8Array([sample]), durationMs: 25 }));
    }) },
  });
  t.after(() => manager.dispose());
  manager.supervised(instance, "started", proof("started"));
  const first = manager.open("audition", "First?", null);
  const second = manager.open("audition", "Second?", null);
  assert.ok(first && second);
  t.mock.timers.tick(VOICE_SPEECH_PREPARE_LIMIT_MS - 1);
  assert.equal(first.state, "preparing");
  assert.equal(complete.length, 1);
  assert.equal(manager.held, false);
  t.mock.timers.tick(1);
  assert.equal(stops, 1);
  assert.deepEqual(manager.lastAudition, { id: first.id, state: "failed" });
  assert.equal(manager.live, second);
  assert.equal(complete.length, 2);
  assert.equal(manager.speak(instance), null);
  complete[1]!(); await Promise.resolve();
  complete[0]!(); await Promise.resolve();
  assert.equal(first.state, "failed");
  assert.equal(manager.audio(first.id, instance), undefined);
  assert.deepEqual(manager.audio(second.id, instance), new Uint8Array([2]));
  assert.equal(manager.speak(instance)?.id, second.id);
  assert.equal(manager.held, true);
  assert.equal(manager.event(second.id, instance, "ended"), "accepted");
  assert.equal(manager.held, false);
});

test("cancelling active preparation aborts and stops synthesis before starting the next job", async t => {
  const home = tempDir("speech-cancel-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { instance, proof } = fixtureVoiceSupervisor();
  const events: string[] = [];
  let complete!: () => void;
  const manager = new VoiceSpeechManager({
    directory: join(home, "voice"), now: Date.now, changed() {},
    target: () => ({ instance, voice: { engine: "neural", id: VOICE_SPEECH_DEFAULT_NEURAL } }),
    synthesizer: { warm() {}, stop() { events.push("stop"); }, synthesize: (text, _voice, signal) => new Promise(resolve => {
      events.push("start " + text);
      signal?.addEventListener("abort", () => events.push("abort " + text), { once: true });
      complete = () => resolve({ wav: new Uint8Array([1]), durationMs: 10 });
    }) },
  });
  t.after(() => manager.dispose());
  manager.supervised(instance, "started", proof("started"));
  const first = manager.open("audition", "first", null)!;
  const completeFirst = complete;
  const dropped = manager.open("audition", "unused", null)!;
  const second = manager.open("audition", "second", null)!;
  manager.stop(dropped.id);
  assert.deepEqual(events, ["start first"]);
  manager.stop(first.id);
  assert.deepEqual(events, ["start first", "abort first", "stop", "start second"]);
  assert.equal(manager.held, false);
  completeFirst(); await Promise.resolve();
  assert.equal(manager.speak(instance), null);
  assert.equal(manager.audio(first.id, instance), undefined);
  complete(); await Promise.resolve();
  assert.equal(manager.speak(instance)?.id, second.id);
  assert.equal(first.state, "stopped");
});
