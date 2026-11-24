import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { VoiceListener } from "../src/main/voice-listener.ts";
import { voiceStateOff, type VoiceState } from "../src/shared/voice.ts";

test("the shell owns one granted listener per ready model, retries crashes and drains before shutdown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const models: string[] = [];
  const signals: string[] = [];
  const diagnostics: string[] = [];
  let child = new EventEmitter();
  const listener = new VoiceListener(directory => {
    models.push(directory);
    child = new EventEmitter();
    return Object.assign(child, {
      pid: models.length === 1 ? undefined : 100 + models.length,
      kill: (signal: string) => signals.push(signal),
    }) as unknown as ChildProcess;
  }, line => diagnostics.push(line));
  const state: VoiceState = voiceStateOff();
  listener.update(state, true);
  state.mode = "unavailable";
  listener.update(state, true);
  state.model = { ...state.model, status: "ready", backend: "fluidaudio", directory: "/model/a" };
  listener.update(state, false);
  assert.deepEqual(models, []);
  listener.update(state, true);
  state.mode = "muted";
  listener.update(state, true);
  assert.deepEqual(models, ["/model/a"]);
  child.emit("error", Object.assign(new Error("spawn path should stay private"), {code: "EACCES"}));
  child.emit("close", -13, null);
  t.mock.timers.tick(499);
  assert.equal(models.length, 1);
  t.mock.timers.tick(1);
  assert.equal(models.length, 2);
  child.emit("close", 1, null);
  t.mock.timers.tick(999);
  assert.equal(models.length, 2);
  t.mock.timers.tick(1);
  state.model.directory = "/model/b";
  listener.update(state, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(models.length, 3);
  child.emit("close", 0, null);
  assert.equal(models.at(-1), "/model/b");
  const stopped = listener.stop();
  let drained = false;
  void stopped.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  t.mock.timers.tick(2000);
  assert.equal(signals.at(-1), "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await stopped;
  assert.deepEqual(diagnostics, [
    'Voice listener launch pid=none modelRevision="a"',
    "Voice listener close pid=none code=-13 signal=none requested=false error=EACCES",
    "Voice listener retry pid=none attempt=1 delayMs=500",
    'Voice listener launch pid=102 modelRevision="a"',
    "Voice listener close pid=102 code=1 signal=none requested=false",
    "Voice listener retry pid=102 attempt=2 delayMs=1000",
    'Voice listener launch pid=103 modelRevision="a"',
    "Voice listener close pid=103 code=0 signal=none requested=true",
    'Voice listener launch pid=104 modelRevision="b"',
    "Voice listener close pid=104 code=none signal=SIGKILL requested=true",
  ]);
  assert.ok(drained);
  listener.update(state, true);
  t.mock.timers.tick(5000);
  assert.equal(models.length, 4);
});

test("switching voice off disarms a pending retry", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let starts = 0;
  const child = new EventEmitter();
  const listener = new VoiceListener(() => { starts++; return child as ChildProcess; });
  const off = voiceStateOff();
  listener.update({ ...off, mode: "unavailable", model: { ...off.model, directory: "/a", status: "ready", backend: "fluidaudio" } }, true);
  child.emit("close", 1);
  listener.update(off, true);
  t.mock.timers.tick(5000);
  assert.equal(starts, 1);
});
