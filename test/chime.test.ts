import assert from "node:assert/strict";
import test from "node:test";
import { playChime, unlockAudio } from "../src/web/lib/chime.ts";

test("chime availability distinguishes autoplay suspension, rate limiting and playback failures", (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser: { AudioContext?: unknown } = {};
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  assert.equal(playChime("attention"), "unavailable", "missing Web Audio permits fallback");
  browser.AudioContext = class { constructor() { throw new Error("audio initialization failed"); } };
  assert.equal(playChime("attention"), "unavailable", "initialization failure permits fallback");

  let audioState = "suspended";
  let starts = 0;
  let oscillators = 0;
  let failStart = false;
  let failStop = false;
  browser.AudioContext = class {
    get state() { return audioState; }
    currentTime = 0;
    destination = {};
    async resume() { audioState = "running"; }
    createOscillator() {
      oscillators++;
      return {
        frequency: { value: 0 },
        connect: (gain: { connect: () => void }) => gain,
        start() {
          if (failStart) throw new Error("playback failed");
          starts++;
        },
        stop() { if (failStop) throw new Error("stop failed"); },
      };
    }
    createGain() {
      return { connect() {}, gain: {
        setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
      } };
    }
  };
  assert.equal(playChime("attention"), "unavailable");
  assert.equal(oscillators, 0, "suspended audio must not queue a delayed duplicate chime");
  unlockAudio();
  assert.equal(starts, 0, "unlock must not replay an alert already handled by the OS");
  assert.equal(playChime("info"), "played", "failed attempts must not consume the rate gate");
  assert.equal(starts, 1);
  now += 400;
  assert.equal(playChime("attention"), "played", "urgent audio cuts through a recent info chime");
  assert.equal(starts, 3);
  assert.equal(playChime("attention"), "rate-limited", "throttling must not enable the OS tone");
  assert.equal(starts, 3);

  now += 1_300;
  failStart = true;
  assert.equal(playChime("attention"), "unavailable");
  failStart = false;
  failStop = true;
  assert.equal(playChime("attention"), "played", "a started note prevents a duplicate fallback");
  assert.equal(starts, 4);
  assert.equal(playChime("attention"), "rate-limited");
  now += 1_300;
  audioState = "closed";
  assert.equal(playChime("attention"), "unavailable");
});
