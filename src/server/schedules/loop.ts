import { unref } from "../util/timers.ts";
import { nextDueAt } from "./store.ts";

/**
 * The heartbeat behind Recurring Missions, and the only thing in the daemon that calls
 * the scheduler.
 *
 * Standby is what this shape is designed around, and the design is that it does NOT try
 * to detect it. A laptop that sleeps for a fortnight pauses Node's timers; when it wakes,
 * the overdue timeout fires and calls `tick` with the current wall clock. Correctness
 * comes entirely from the persisted cursor being enumerated against that clock - not from
 * knowing that we slept, how long for, or why the timer was late. That is why V1 needs no
 * `powerMonitor` bridge and no Electron capability: a resume notification could only make
 * this happen sooner, never differently, and anything that could REPLACE the cursor would
 * be a second answer to "what is still owed" that agrees with the first only by luck.
 *
 * The same property covers a clock jumped forward by hand, an NTP correction, and a
 * container resumed from a checkpoint.
 */

/** The longest the loop will sleep, however far away the next instant is. */
const MAX_SLEEP_MS = 60_000;

/**
 * The shortest, so a cursor that is already overdue cannot spin the loop.
 *
 * A tick that files work leaves the cursor at the next instant, which is at least an hour
 * out (`SCHEDULE_MIN_INTERVAL_MS`), so this floor is normally never reached. It matters in
 * the one case that would otherwise be a hot loop: a due instant that cannot be settled -
 * an unreadable revision, a repository that has gone - where the cursor stays put and the
 * next wake-up is immediately due again.
 */
const MIN_SLEEP_MS = 1_000;

/**
 * The two calls the loop makes, and nothing else.
 *
 * Structural rather than `ScheduleManager` so the lifecycle - unref, self-rescheduling,
 * non-overlap, the stop closure - can be tested against a manager that does not need a
 * database, which is the only way to assert "a tick that throws still reschedules".
 * `ScheduleManager` satisfies it.
 */
export interface SchedulerTicker {
  tick(now?: number): Promise<unknown>;
  recover(now?: number, scope?: "open" | "stale"): Promise<unknown>;
}

export interface ScheduleLoopDeps {
  /** Seams for the lifecycle test; production passes none. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** When the soonest live schedule is due, or null when none is. */
  dueAt?: () => number | null;
}

/**
 * Start the scheduler and return the closure that stops it.
 *
 * Inert with no schedules: the first tick reads an empty due list and the loop settles
 * onto its one-minute health check, which is one indexed aggregate per minute.
 *
 * Never overlapping, and it is a `setTimeout` chain rather than a `setInterval` for
 * exactly that reason: the next sleep is scheduled from the END of a tick, so a catch-up
 * that takes ten seconds cannot have a second pass started on top of it - which would put
 * two callers into the claim transaction and make every "already_exists" branch load
 * bearing for correctness rather than for tidiness.
 */
export function startScheduleManager(
  manager: SchedulerTicker,
  deps: ScheduleLoopDeps = {},
): () => void {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const dueAt = deps.dueAt ?? nextDueAt;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first = true;

  const sleepMs = (): number => {
    let due: number | null = null;
    try {
      due = dueAt();
    } catch (err) {
      // A failed read must not end the loop. Fall through to the health interval, which
      // is what the loop would do with nothing scheduled anyway.
      console.error("[schedules] could not read the next due instant:", err);
    }
    if (due === null) return MAX_SLEEP_MS;
    return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, due - now()));
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // At startup every reservation on disk belongs to a process that is gone - the port
      // bind is the mutex, so there is exactly one daemon - and waiting for the staleness
      // window would leave a task the last run reserved uncreated for five more minutes.
      // Afterwards only stale claims are swept, so a Run now in flight is never stolen.
      if (first) {
        first = false;
        await manager.recover(now(), "open");
      }
      await manager.tick(now());
    } catch (err) {
      // Contained: a scheduler that stopped rescheduling itself on one bad tick would go
      // quiet for the life of the daemon with nothing on screen to say so.
      console.error("[schedules] tick failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimer(() => void tick(), sleepMs()));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  };
}
