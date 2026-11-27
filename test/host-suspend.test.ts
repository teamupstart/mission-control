import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_SUSPEND_GAP_MS,
  HOST_SUSPEND_INTERVAL_MS,
  HostSuspendMonitor,
  setAwakeTimeout,
  type HostSuspendClock,
} from "../src/server/host-suspend.ts";

function monitorAt(start: number) {
  let now = start;
  const monitor = new HostSuspendMonitor({ now: () => now });
  return {
    monitor,
    /** One jump of the wall clock, then (by default) one heartbeat: a sleep when it is long. */
    advance(ms: number, opts: { tick?: boolean } = {}) {
      now += ms;
      if (opts.tick !== false) monitor.tick();
    },
    /** Awake time: the heartbeat keeps its interval throughout. */
    awakeFor(ms: number) {
      while (ms > 0) {
        const step = Math.min(HOST_SUSPEND_INTERVAL_MS, ms);
        now += step;
        monitor.tick();
        ms -= step;
      }
    },
    get now() {
      return now;
    },
  };
}

test("regular heartbeats record no suspension", () => {
  const host = monitorAt(1_000_000);
  const since = host.monitor.mark();
  host.awakeFor(100 * HOST_SUSPEND_INTERVAL_MS);
  assert.equal(host.monitor.suspendedMsSince(since), 0);
});

test("jitter below the gap threshold is not a suspension", () => {
  const host = monitorAt(1_000_000);
  const since = host.monitor.mark();
  host.advance(HOST_SUSPEND_GAP_MS);
  assert.equal(host.monitor.suspendedMsSince(since), 0);
});

test("a late heartbeat records the sleep, conservatively, from one interval after the last beat", () => {
  const host = monitorAt(1_000_000);
  const since = host.monitor.mark();
  host.awakeFor(HOST_SUSPEND_INTERVAL_MS);
  host.advance(17 * 60_000);
  assert.equal(host.monitor.suspendedMsSince(since), 17 * 60_000 - HOST_SUSPEND_INTERVAL_MS);
});

test("a sleep the heartbeat has not caught up with yet is already visible", () => {
  const host = monitorAt(1_000_000);
  const since = host.monitor.mark();
  host.advance(17 * 60_000, { tick: false });
  assert.equal(host.monitor.suspendedMsSince(since), 17 * 60_000 - HOST_SUSPEND_INTERVAL_MS);
});

test("a mark taken before many long sleeps keeps all of them, however long ago they ended", () => {
  // The case a pruned history got wrong: an hour asleep, five seconds awake, then a day and an
  // hour asleep. A window list trimmed to 24 hours dropped the first hour and counted it awake.
  const host = monitorAt(1_000_000);
  const since = host.monitor.mark();
  host.awakeFor(HOST_SUSPEND_INTERVAL_MS);
  host.advance(60 * 60_000);
  host.awakeFor(HOST_SUSPEND_INTERVAL_MS);
  host.advance(25 * 60 * 60_000);
  const expected = 60 * 60_000 + 25 * 60 * 60_000 - 2 * HOST_SUSPEND_INTERVAL_MS;
  assert.equal(host.monitor.suspendedMsSince(since), expected);
  // A week of maintenance wakes on top changes nothing about the arithmetic.
  for (let i = 0; i < 600; i++) {
    host.awakeFor(HOST_SUSPEND_INTERVAL_MS);
    host.advance(17 * 60_000);
  }
  assert.equal(
    host.monitor.suspendedMsSince(since),
    expected + 600 * (17 * 60_000 - HOST_SUSPEND_INTERVAL_MS),
  );
});

test("only the part of a sleep after the mark counts", () => {
  const host = monitorAt(1_000_000);
  host.advance(10 * 60_000);
  const since = host.monitor.mark();
  host.awakeFor(HOST_SUSPEND_INTERVAL_MS);
  assert.equal(host.monitor.suspendedMsSince(since), 0);
  host.advance(5 * 60_000);
  assert.equal(host.monitor.suspendedMsSince(since), 5 * 60_000 - HOST_SUSPEND_INTERVAL_MS);
});

/** Fake timers on two clocks: wall time (Date.now) and the clock Node's timers run on. */
function fakeTimers(clock: HostSuspendClock) {
  let timerNow = 0;
  const pending: { at: number; fn: () => void }[] = [];
  const armed: number[] = [];
  return {
    armed,
    deps: {
      clock,
      timerNow: () => timerNow,
      setTimeoutFn: (fn: () => void, ms: number) => {
        armed.push(ms);
        pending.push({ at: timerNow + ms, fn });
        return pending.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {
        pending.length = 0;
      },
    },
    /** Advance the timer clock and fire whatever came due. */
    run(ms: number) {
      timerNow += ms;
      for (;;) {
        const due = pending.findIndex((entry) => entry.at <= timerNow);
        if (due < 0) return;
        const [entry] = pending.splice(due, 1);
        entry!.fn();
      }
    },
  };
}

test("an awake timeout with no sleep fires exactly like setTimeout", () => {
  const host = monitorAt(1_000_000);
  const timers = fakeTimers(host.monitor);
  let fired = 0;
  setAwakeTimeout(() => fired++, 600_000, timers.deps);
  host.awakeFor(599_999);
  timers.run(599_999);
  assert.equal(fired, 0);
  host.awakeFor(1);
  timers.run(1);
  assert.equal(fired, 1);
  assert.deepEqual(timers.armed, [600_000]);
});

test("a timeout whose clock counts sleep re-arms for the time the host was asleep (macOS)", () => {
  const host = monitorAt(1_000_000);
  const timers = fakeTimers(host.monitor);
  let fired = 0;
  setAwakeTimeout(() => fired++, 600_000, timers.deps);
  // The issue's timeline: 23 s of work, then a 17-minute idle sleep the timer keeps counting.
  host.awakeFor(23_000);
  host.advance(17 * 60_000, { tick: false });
  timers.run(23_000 + 17 * 60_000);
  assert.equal(fired, 0, "a timer that fires on wake must not end work that barely ran");
  // Credited as awake: the 23 s before the sleep plus the heartbeat interval the window
  // conservatively leaves out.
  const awake = 23_000 + HOST_SUSPEND_INTERVAL_MS;
  assert.deepEqual(timers.armed, [600_000, 600_000 - awake]);
  // The wake-side edge of a window is only known to the nearest heartbeat, so the budget may
  // run up to one interval past the remainder - never short of it.
  let afterWake = 0;
  while (!fired && afterWake < 600_000) {
    host.awakeFor(1_000);
    timers.run(1_000);
    afterWake += 1_000;
  }
  assert.equal(fired, 1);
  assert.ok(afterWake >= 600_000 - awake && afterWake <= 600_000 - awake + HOST_SUSPEND_INTERVAL_MS, `fired ${afterWake} ms after the wake`);
});

test("a timeout whose clock excludes sleep is not extended a second time (Linux)", () => {
  const host = monitorAt(1_000_000);
  const timers = fakeTimers(host.monitor);
  let fired = 0;
  setAwakeTimeout(() => fired++, 600_000, timers.deps);
  host.awakeFor(HOST_SUSPEND_INTERVAL_MS);
  host.advance(17 * 60_000);
  // The timer clock never saw the sleep, so it comes due after 600 s of awake time.
  host.awakeFor(600_000);
  timers.run(600_000);
  assert.equal(fired, 1);
  assert.deepEqual(timers.armed, [600_000]);
});

test("clearing an awake timeout stops it from firing", () => {
  const host = monitorAt(1_000_000);
  const timers = fakeTimers(host.monitor);
  let fired = 0;
  const timeout = setAwakeTimeout(() => fired++, 1_000, timers.deps);
  timeout.clear();
  host.awakeFor(1_000);
  timers.run(1_000);
  assert.equal(fired, 0);
});

test("the default awake timeout fires on real timers", async () => {
  await new Promise<void>((resolve) => {
    setAwakeTimeout(resolve, 5);
  });
});
