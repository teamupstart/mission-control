import assert from "node:assert/strict";
import test from "node:test";
import {
  nextSettingsBackupCheckDelay,
  startSettingsBackupLoop,
} from "../src/server/settings-backups/loop.ts";

process.env.TZ = "America/New_York";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the loop captures immediately, rechecks on a health cadence, and observes a new local date", async () => {
  let now = new Date(2026, 7, 24, 12, 0, 0);
  const captured: string[] = [];
  const timers: Array<{ callback: () => void; delayMs: number; unrefed: boolean }> = [];
  const stop = startSettingsBackupLoop(
    { ensureDailySnapshot: async (localDate: string) => { captured.push(localDate); return {} as never; } },
    {
      now: () => new Date(now),
      healthIntervalMs: 1_000,
      setTimer: (callback, delayMs) => {
        const handle = { callback, delayMs, unrefed: false, unref() { this.unrefed = true; } };
        timers.push(handle);
        return handle;
      },
      clearTimer: () => undefined,
    },
  );
  await turn();
  assert.deepEqual(captured, ["2026-08-24"]);
  assert.equal(timers[0]?.delayMs, 1_000);
  assert.equal(timers[0]?.unrefed, true);

  now = new Date(2026, 7, 25, 0, 5, 0);
  timers.shift()?.callback();
  await turn();
  assert.deepEqual(captured, ["2026-08-24", "2026-08-25"]);

  now = new Date(2026, 7, 24, 23, 0, 0);
  timers.shift()?.callback();
  await turn();
  assert.deepEqual(captured, ["2026-08-24", "2026-08-25", "2026-08-24"]);
  stop();
});

test("the loop contains failures and never schedules over an in-flight capture", async () => {
  let rejectFirst: (error: Error) => void = () => { throw new Error("capture did not start"); };
  let calls = 0;
  let scheduled: (() => void) | null = null;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const stop = startSettingsBackupLoop(
      {
        ensureDailySnapshot: () => {
          calls += 1;
          return new Promise((_, reject) => { rejectFirst = reject; }) as never;
        },
      },
      {
        now: () => new Date(2026, 7, 24, 12, 0, 0),
        healthIntervalMs: 100,
        setTimer: (callback) => {
          scheduled = callback;
          return { unref() {} };
        },
        clearTimer: () => undefined,
      },
    );
    await turn();
    assert.equal(calls, 1);
    assert.equal(scheduled, null, "no next tick is armed while capture is running");
    rejectFirst(new Error("disk unavailable"));
    await turn();
    assert.equal(warnings.length, 1);
    assert.ok(scheduled);
    stop();
  } finally {
    console.warn = originalWarn;
  }
});

test("stopping during a capture prevents rescheduling", async () => {
  let finish: () => void = () => { throw new Error("capture did not start"); };
  let timers = 0;
  const stop = startSettingsBackupLoop(
    {
      ensureDailySnapshot: () => new Promise<void>((resolve) => { finish = resolve; }) as never,
    },
    {
      now: () => new Date(2026, 7, 24, 12, 0, 0),
      setTimer: () => { timers += 1; return {}; },
      clearTimer: () => undefined,
      healthIntervalMs: 100,
    },
  );
  await turn();
  stop();
  finish();
  await turn();
  assert.equal(timers, 0);
});

test("next-check delay is capped but tightens at local midnight", () => {
  assert.equal(nextSettingsBackupCheckDelay(new Date(2026, 7, 24, 12, 0, 0), 60_000), 60_000);
  assert.equal(nextSettingsBackupCheckDelay(new Date(2026, 7, 24, 23, 59, 59, 750), 60_000), 250);
});

test("local-midnight scheduling follows 23-hour and 25-hour DST days", () => {
  const longCap = 48 * 60 * 60 * 1_000;
  assert.equal(
    nextSettingsBackupCheckDelay(new Date(2026, 2, 8, 0, 0, 0), longCap),
    23 * 60 * 60 * 1_000,
  );
  assert.equal(
    nextSettingsBackupCheckDelay(new Date(2026, 10, 1, 0, 0, 0), longCap),
    25 * 60 * 60 * 1_000,
  );
});
