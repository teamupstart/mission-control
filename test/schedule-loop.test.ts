import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startScheduleManager } from "../src/server/schedules/loop.ts";

// What is at stake: the loop is the only thing in the daemon that ever calls the
// scheduler, so its failure modes are all silence. A tick that throws and is not caught
// stops rescheduling and the catalog goes quiet for the life of the process with nothing
// on screen saying so; a timer that is not unref'd holds the daemon open through
// shutdown; two overlapping ticks put two callers into the claim transaction.
//
// None of that needs a database, so this drives the real loop against a manager that
// does nothing and a clock and timer the test owns - which is also the only way to assert
// "a tick that throws still reschedules" without arranging for a real one to fail.

interface Scheduled {
  fn: () => void;
  ms: number;
}

function fakeTimers() {
  const state = { scheduled: [] as Scheduled[], unreffed: 0, cleared: 0 };
  return {
    state,
    setTimer: (fn: () => void, ms: number) => {
      state.scheduled.push({ fn, ms });
      // `unref` is applied to whatever the timer factory returned, so the handle has to
      // look like Node's.
      return { unref: () => void state.unreffed++ } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => void state.cleared++,
  };
}

/** Let the loop's async tick settle before asserting on what it did. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    manager: {
      tick: async () => {
        calls.push("tick");
      },
      recover: async (_now?: number, scope?: "open" | "stale") => {
        calls.push(`recover:${scope ?? "stale"}`);
      },
    },
  };
}

test("the loop runs at once, sweeps open claims first, and then reschedules itself", async () => {
  const timers = fakeTimers();
  const { calls, manager } = recorder();

  const stop = startScheduleManager(manager, {
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    dueAt: () => null,
  });
  await flush();

  // Recovery BEFORE the first tick, and at startup it takes every open claim rather than
  // waiting out the staleness window - each one belongs to a process that is gone.
  assert.deepEqual(calls, ["recover:open", "tick"]);
  assert.equal(timers.state.scheduled.length, 1, "self-rescheduling, not setInterval");
  assert.equal(timers.state.unreffed, 1, "and it must not hold the daemon open");

  stop();
});

test("the startup sweep happens once; later passes leave a live claim alone", async () => {
  const timers = fakeTimers();
  const { calls, manager } = recorder();

  const stop = startScheduleManager(manager, {
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    dueAt: () => null,
  });
  await flush();
  timers.state.scheduled.pop()!.fn();
  await flush();

  // Only the first pass sweeps open claims. Afterwards `tick` does its own stale-only
  // recovery, so a Run now in flight is never stolen out from under itself.
  assert.deepEqual(calls, ["recover:open", "tick", "tick"]);

  stop();
});

test("a tick that throws is contained, and the loop keeps its next appointment", async () => {
  const timers = fakeTimers();
  let ticks = 0;
  const manager = {
    tick: async () => {
      ticks++;
      throw new Error("the database is on fire");
    },
    recover: async () => {},
  };

  const stop = startScheduleManager(manager, {
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    dueAt: () => null,
  });
  await flush();

  assert.equal(ticks, 1);
  assert.equal(timers.state.scheduled.length, 1, "a bad tick must not end the loop");

  timers.state.scheduled.pop()!.fn();
  await flush();
  assert.equal(ticks, 2);

  stop();
});

test("ticks never overlap - the next sleep is scheduled from the end of one", async () => {
  const timers = fakeTimers();
  let release!: () => void;
  let started = 0;
  const manager = {
    tick: () => {
      started++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    recover: async () => {},
  };

  const stop = startScheduleManager(manager, {
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    dueAt: () => null,
  });
  await flush();

  assert.equal(started, 1);
  // Nothing is scheduled while a tick is still running, so a catch-up that takes ten
  // seconds cannot have a second pass started on top of it.
  assert.equal(timers.state.scheduled.length, 0);

  release();
  await flush();
  assert.equal(timers.state.scheduled.length, 1);

  stop();
});

test("the loop sleeps until the next instant, capped at the health interval and floored", async () => {
  const cases = [
    { due: null, now: 1_000, expected: 60_000, why: "nothing scheduled: just the health check" },
    { due: 1_000 + 5 * 60_000, now: 1_000, expected: 60_000, why: "an hour out is still capped" },
    { due: 1_000 + 20_000, now: 1_000, expected: 20_000, why: "the next instant wins when sooner" },
    { due: 500, now: 1_000, expected: 1_000, why: "already overdue: floored, never a hot loop" },
  ];

  for (const c of cases) {
    const timers = fakeTimers();
    const { manager } = recorder();
    const stop = startScheduleManager(manager, {
      now: () => c.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      dueAt: () => c.due,
    });
    await flush();
    assert.equal(timers.state.scheduled[0]?.ms, c.expected, c.why);
    stop();
  }
});

test("a failed read of the next instant falls back rather than ending the loop", async () => {
  const timers = fakeTimers();
  const { manager } = recorder();

  const stop = startScheduleManager(manager, {
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    dueAt: () => {
      throw new Error("the database is locked");
    },
  });
  await flush();

  assert.equal(timers.state.scheduled[0]?.ms, 60_000);
  stop();
});

test("the stop closure clears the pending timer and no tick runs after it", async () => {
  const timers = fakeTimers();
  const { calls, manager } = recorder();

  const stop = startScheduleManager(manager, {
    now: () => 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    dueAt: () => null,
  });
  await flush();

  const pending = timers.state.scheduled.pop()!;
  stop();
  assert.equal(timers.state.cleared, 1);

  // Even a timer that had already fired finds the loop stood down.
  pending.fn();
  await flush();
  assert.deepEqual(calls, ["recover:open", "tick"]);
  assert.equal(timers.state.scheduled.length, 0, "and nothing was scheduled on the way out");
});

test("the daemon starts open-claim recovery only after winning its listen port", () => {
  const source = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  const declaration = source.indexOf("let stopSchedules = () => {};");
  const listen = source.indexOf("const server = serve(");
  const start = source.indexOf("stopSchedules = startScheduleManager(schedules);");
  const shutdown = source.indexOf("async function shutdown");

  assert.ok(declaration >= 0 && declaration < listen, "shutdown owns a no-op stopper before listen");
  assert.ok(start > listen && start < shutdown, "startup recovery is inside the listen callback");
  assert.equal(
    source.slice(declaration, listen).includes("startScheduleManager(schedules)"),
    false,
    "a daemon that loses the port cannot sweep another daemon's open claims",
  );
});
