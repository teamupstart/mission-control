import assert from "node:assert/strict";
import test from "node:test";
import { WindowStartup, type StartupScreen } from "../src/main/window-startup.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  let now = 0;
  let ready = false;
  let resume: (() => void) | undefined;
  let loads = 0;
  let loaded = 0;
  let rejectLoad = false;
  const screens: StartupScreen[] = [];
  const errors: unknown[] = [];
  const startup = new WindowStartup({
    now: () => now,
    show: async (screen) => { screens.push(screen); },
    ready: async () => ready,
    load: async () => { loads++; if (rejectLoad) throw new Error("connection lost after health"); },
    loaded: () => { loaded++; },
    log: (error) => { errors.push(error); },
    pause: (signal) => new Promise<void>((resolve) => {
      const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
      resume = finish;
      signal.addEventListener("abort", finish, { once: true });
    }),
  });
  return {
    startup, screens, errors,
    ready: (value: boolean) => { ready = value; },
    failLoad: (value: boolean) => { rejectLoad = value; },
    loads: () => loads,
    loaded: () => loaded,
    async tick(time: number) { now = time; resume?.(); await flush(); },
  };
}

test("startup waits for readiness, reports a delay at 60 seconds, then recovers automatically", async () => {
  const f = fixture();
  const done = f.startup.start();
  await flush();
  assert.deepEqual(f.screens, ["starting"]);
  await f.tick(20_000);
  assert.equal(f.loads(), 0, "crossing the former retry budget cannot load an unavailable origin");
  await f.tick(59_999);
  assert.deepEqual(f.screens, ["starting"]);
  await f.tick(60_000);
  assert.deepEqual(f.screens, ["starting", "slow"]);
  await f.tick(120_000);
  assert.equal(f.loads(), 0);
  assert.deepEqual(f.screens, ["starting", "slow"], "polling preserves the retry control and focus");
  f.ready(true);
  await f.tick(121_000);
  await done;
  assert.equal(f.loaded(), 1);
  await f.startup.start();
  assert.equal(f.loads(), 1, "a completed startup cannot reload active work");
});

test("a healthy startup loads immediately without waiting for the timeout", async () => {
  const f = fixture();
  f.ready(true);
  await f.startup.start();
  assert.equal(f.loads(), 1);
  assert.equal(f.loaded(), 1);
  assert.deepEqual(f.screens, ["starting"]);
});

test("Retry cancels the old attempt and resets the delay message", async () => {
  const f = fixture();
  const first = f.startup.start();
  await flush();
  await f.tick(60_000);
  const second = f.startup.start();
  await flush();
  await first;
  assert.deepEqual(f.screens, ["starting", "slow", "starting"]);
  f.ready(true);
  await f.tick(60_001);
  await second;
  assert.equal(f.loads(), 1);
  assert.equal(f.loaded(), 1);
});

test("a navigation failure after successful health returns to a visible retry screen", async () => {
  const f = fixture();
  f.ready(true);
  f.failLoad(true);
  const done = f.startup.start();
  await flush();
  assert.deepEqual(f.screens, ["starting", "error"]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.loaded(), 0);
  f.failLoad(false);
  await f.tick(1000);
  await done;
  assert.equal(f.loads(), 2);
  assert.equal(f.loaded(), 1);
});

for (const boundary of ["health", "navigation"] as const) {
  test(`closing the window during ${boundary} prevents stale startup work`, async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let signal!: AbortSignal;
    let loads = 0;
    let loaded = 0;
    const startup = new WindowStartup({
      now: Date.now, show: async () => {},
      ready: async (s) => { signal = s; if (boundary === "health") await pending; return true; },
      load: async (s) => { signal = s; loads++; await pending; },
      loaded: () => { loaded++; }, log: assert.fail,
      pause: async () => { assert.fail("closed startup must not schedule another attempt"); },
    });
    const done = startup.start();
    await flush();
    startup.stop();
    assert.equal(signal.aborted, true);
    release();
    await done;
    await startup.start();
    assert.equal(loads, boundary === "health" ? 0 : 1);
    assert.equal(loaded, 0);
  });
}
