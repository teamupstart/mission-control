import assert from "node:assert/strict";
import test from "node:test";
import { VoiceHardware } from "../src/main/voice-hardware.ts";

test("reports the chord in force after first refusal, replacement, and unregistration", () => {
  const attempts: string[] = [];
  let unregistered = 0;
  const hardware = new VoiceHardware({ value: {
    register(chord) { attempts.push(chord); if (chord === "bad") throw Error("Reserved"); },
    unregister() { unregistered++; },
  } }, { reason: "Requires macOS 14.2" }, () => -1, () => {}, () => {}, () => 1);
  hardware.update(null, "listening");
  assert.deepEqual(attempts, []);
  hardware.update("bad", "listening");
  assert.deepEqual(hardware.report().hotkeyError, { reason: "macOS refused bad: Reserved", chordInForce: null });
  hardware.update("ctrl+k", "listening");
  assert.equal(hardware.report().registeredHotkey, "ctrl+k");
  hardware.update("bad", "listening");
  hardware.update("bad", "listening");
  assert.deepEqual(attempts, ["bad", "ctrl+k", "bad"]);
  assert.deepEqual(hardware.report().hotkeyError, { reason: "macOS refused bad: Reserved", chordInForce: "ctrl+k" });
  assert.equal(hardware.report().registeredHotkey, "ctrl+k");
  hardware.update(null, "listening");
  assert.equal(unregistered, 1);
  assert.equal(hardware.report().hotkeyError, null);
  assert.equal(hardware.report().registeredHotkey, null);
  assert.equal(hardware.report().capabilities["call-detection"].available, false);
  hardware.stop();
});

test("tap toggles, hold during auto-mute publishes physical edges, other holds do nothing", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1000 });
  let edge!: (down: boolean, at: number) => void;
  let taps = 0;
  let active = true;
  let failed = false;
  let pid = 1;
  const pids: number[] = [];
  const clock = () => Date.now() * 1000;
  const hardware = new VoiceHardware({ value: { register(_, cb) { edge = cb; }, unregister() {} } },
    { value: { running(listener) { pids.push(listener); if (failed) throw Error("CoreAudio error"); return active; } } },
    () => pid, () => taps++, () => {}, clock);
  hardware.update("ctrl+k", "auto-muted");
  edge(true, clock());
  t.mock.timers.tick(349);
  assert.equal(hardware.report().pushToTalk, false);
  edge(false, clock());
  assert.equal(taps, 1);
  const press = clock();
  edge(true, press);
  t.mock.timers.tick(350);
  edge(true, clock());
  assert.equal(hardware.report().pushToTalk, true);
  assert.equal(hardware.report().pushToTalkPressedAtHostUs, press);
  edge(false, clock());
  assert.equal(hardware.report().pushToTalk, false);
  assert.equal(hardware.report().pushToTalkReleasedAtHostUs, clock());
  assert.equal(taps, 1);
  pid = 2;
  active = false;
  t.mock.timers.tick(500);
  assert.equal(pids.at(-1), 2);
  assert.equal(hardware.report().callActive, false);
  hardware.update("ctrl+k", "listening");
  edge(true, clock());
  t.mock.timers.tick(500);
  assert.equal(hardware.report().pushToTalk, false);
  edge(false, clock());
  assert.equal(taps, 1);
  failed = true;
  t.mock.timers.tick(500);
  assert.equal(hardware.report().capabilities["call-detection"].reason, "CoreAudio error");
  failed = false;
  t.mock.timers.tick(500);
  assert.equal(hardware.report().capabilities["call-detection"].available, true);
  hardware.stop();
});
