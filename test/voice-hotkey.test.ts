import assert from "node:assert/strict";
import test from "node:test";
import { VoiceHardware } from "../src/main/voice-hardware.ts";

test("reports the chord in force after first refusal, replacement, and unregistration", () => {
  const attempts: string[] = [];
  let unregistered = 0;
  const hardware = new VoiceHardware({ value: {
    register(chord) { attempts.push(chord); if (chord === "bad") throw Error("Reserved"); return true; },
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

test("stopping active voice hardware releases the mute shortcut and stops microphone polling", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let shortcut: ((down: boolean, at: number) => void) | undefined;
  let toggles = 0;
  let polls = 0;
  const hardware = new VoiceHardware({ value: {
    register(_, onEdge) { shortcut = onEdge; return true; },
    unregister() { shortcut = undefined; },
  } }, { value: { running() { polls++; return false; } } },
  () => -1, () => toggles++, () => {}, () => 0);
  const tap = () => { shortcut?.(true, 0); shortcut?.(false, 100_000); };

  hardware.update("ctrl+k", "listening");
  tap();
  assert.equal(toggles, 1);
  assert.equal(polls, 1);
  t.mock.timers.tick(500);
  assert.equal(polls, 2);

  hardware.stop();
  tap();
  t.mock.timers.tick(1500);
  assert.equal(toggles, 1, "the released shortcut cannot toggle mute");
  assert.equal(polls, 2, "no more microphone queries after shutdown");
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
  const hardware = new VoiceHardware({ value: { register(_, cb) { edge = cb; return true; }, unregister() {} } },
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
  assert.equal(hardware.report().capabilities["call-detection"].reason, "Retrying microphone check. CoreAudio error");
  failed = false;
  t.mock.timers.tick(500);
  assert.equal(hardware.report().capabilities["call-detection"].available, true);
  hardware.stop();
});

test("an input-source change remaps a retained shortcut and retries the refused preference", () => {
  let layout = new Map([["ctrl+v", 9]]);
  let physical: number | undefined;
  let reports = 0;
  const hardware = new VoiceHardware({ value: {
    register(chord) {
      const code = layout.get(chord);
      if (code === undefined) throw Error("Unavailable");
      const changed = physical !== code;
      physical = code;
      return changed;
    },
    unregister() { physical = undefined; },
  } }, { reason: "Unused" }, () => -1, () => {}, () => reports++, () => 0);
  hardware.update("ctrl+v", "listening");
  hardware.update("ctrl+k", "listening");
  assert.equal(physical, 9);
  layout = new Map([["ctrl+v", 47]]);
  hardware.layoutChanged();
  assert.equal(physical, 47);
  assert.equal(hardware.report().hotkeyError?.chordInForce, "ctrl+v");
  layout.clear();
  hardware.layoutChanged();
  assert.equal(physical, undefined);
  assert.equal(hardware.report().registeredHotkey, null);
  assert.equal(hardware.report().hotkeyError?.chordInForce, null);
  layout.set("ctrl+k", 40);
  hardware.layoutChanged();
  assert.equal(physical, 40);
  assert.equal(hardware.report().registeredHotkey, "ctrl+k");
  assert.equal(hardware.report().hotkeyError, null);
  assert.equal(reports, 3);
  hardware.stop();
});

test("recording releases the chord in force, then restores it when a replacement is refused", t => {
  let bound: string | null = null;
  const hardware = new VoiceHardware({ value: {
    register(chord) {
      if (chord === "alt+Space") throw Error("Reserved");
      bound = chord;
      return true;
    },
    unregister() { bound = null; },
  } }, { reason: "Unused" }, () => -1, () => {}, () => {}, () => 0);
  t.after(() => hardware.stop());
  hardware.update("ctrl+k", "listening");
  hardware.update("alt+Space", "listening");
  assert.equal(bound, "ctrl+k");
  hardware.update("alt+Space", "listening", true);
  hardware.layoutChanged();
  assert.equal(bound, null);
  assert.equal(hardware.report().registeredHotkey, null);
  hardware.update("alt+Space", "listening");
  assert.equal(bound, "ctrl+k");
  assert.equal(hardware.report().hotkeyError?.chordInForce, "ctrl+k");
});

test("a failed poll preserves confirmed contention until a successful poll finds the input free", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let sample: boolean | Error = true;
  const hardware = new VoiceHardware({ reason: "Unused" }, { value: {
    running() { if (sample instanceof Error) throw sample; return sample; },
  } }, () => -1, () => {}, () => {}, () => 0);
  t.after(() => hardware.stop());
  hardware.update(null, "auto-muted");
  assert.equal(hardware.report().callActive, true);
  sample = new Error("CoreAudio busy");
  t.mock.timers.tick(500);
  assert.equal(hardware.report().callActive, true);
  assert.deepEqual(hardware.report().capabilities["call-detection"], { available: false, reason: "Retrying microphone check. CoreAudio busy" });
  sample = true;
  t.mock.timers.tick(500);
  assert.equal(hardware.report().callActive, true);
  assert.equal(hardware.report().capabilities["call-detection"].available, true);
  sample = false;
  t.mock.timers.tick(500);
  assert.equal(hardware.report().callActive, false);
});
