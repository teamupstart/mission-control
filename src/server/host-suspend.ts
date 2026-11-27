import { performance } from "node:perf_hooks";

/**
 * Host suspension, observed from inside the process.
 *
 * A laptop that idle-sleeps freezes every process on it, and on macOS Node's timers keep
 * counting while it is frozen: a ten-minute timeout armed 23 seconds before a seventeen-minute
 * sleep fires three seconds after the next wake, having watched almost none of the work it was
 * meant to bound (issue #1734). Nothing in the process is told the host slept. What it CAN see
 * is a heartbeat that was due every few seconds arriving minutes late, and that gap is the
 * whole signal this module keeps.
 *
 * Two callers read it, for two different questions:
 *
 *   - `setAwakeTimeout`: has this work had its full budget of AWAKE time yet? A timeout that
 *     fires across a suspension re-arms for the time the host was asleep instead of failing
 *     work that never got to run.
 *   - The workflow engine: did this failed call overlap a suspension? Then the failure is
 *     evidence about the host, not about the call, and it must not spend the call's budget.
 *
 * A gap is recorded only past `gapMs`, well above the heartbeat interval, so ordinary
 * scheduling jitter is never mistaken for sleep. An event loop blocked for that long is
 * indistinguishable from a suspension and is treated as one; both mean the work did not get
 * the time it was given. The windows are conservative: each starts one interval after the last
 * heartbeat, so a suspension is never credited with more time than the host was gone.
 *
 * Process-local and in memory. A restart forgets earlier windows, which costs nothing: work in
 * flight across a restart is already interrupted and re-run by its owner.
 */
export interface HostSuspendClock {
  /** A timestamp on this clock, to pass back to `suspendedMsSince`. */
  mark(): number;
  /** Milliseconds of observed suspension between `since` and now. Zero when none was seen. */
  suspendedMsSince(since: number): number;
}

export interface HostSuspendMonitorDeps {
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  /** Heartbeat period. */
  intervalMs?: number;
  /** A heartbeat later than this is a suspension. */
  gapMs?: number;
  /** How long a recorded window is kept, bounding memory on a host that sleeps often. */
  retainMs?: number;
}

export const HOST_SUSPEND_INTERVAL_MS = 5_000;
export const HOST_SUSPEND_GAP_MS = 30_000;
const HOST_SUSPEND_RETAIN_MS = 24 * 60 * 60_000;
const MAX_WINDOWS = 512;

interface SuspendWindow {
  start: number;
  end: number;
}

function overlap(window: SuspendWindow, since: number, now: number): number {
  return Math.max(0, Math.min(window.end, now) - Math.max(window.start, since));
}

export class HostSuspendMonitor implements HostSuspendClock {
  private readonly now: () => number;
  private readonly setIntervalFn: NonNullable<HostSuspendMonitorDeps["setIntervalFn"]>;
  private readonly clearIntervalFn: NonNullable<HostSuspendMonitorDeps["clearIntervalFn"]>;
  private readonly intervalMs: number;
  private readonly gapMs: number;
  private readonly retainMs: number;
  private readonly windows: SuspendWindow[] = [];
  private lastTick: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: HostSuspendMonitorDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((timer) => clearInterval(timer));
    this.intervalMs = deps.intervalMs ?? HOST_SUSPEND_INTERVAL_MS;
    this.gapMs = deps.gapMs ?? HOST_SUSPEND_GAP_MS;
    this.retainMs = deps.retainMs ?? HOST_SUSPEND_RETAIN_MS;
    this.lastTick = this.now();
  }

  /** Idempotent. The heartbeat never keeps the process alive on its own. */
  start(): this {
    if (this.timer) return this;
    this.lastTick = this.now();
    this.timer = this.setIntervalFn(() => this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /** One heartbeat. Public so a test can drive the clock without real timers. */
  tick(): void {
    const now = this.now();
    const pending = this.pendingWindow(now);
    if (pending) {
      this.windows.push(pending);
      if (this.windows.length > MAX_WINDOWS) this.windows.shift();
    }
    this.lastTick = now;
    const horizon = now - this.retainMs;
    while (this.windows.length && this.windows[0]!.end < horizon) this.windows.shift();
  }

  mark(): number {
    return this.now();
  }

  suspendedMsSince(since: number): number {
    const now = this.now();
    let total = 0;
    for (const window of this.windows) total += overlap(window, since, now);
    // A gap the heartbeat has not caught up with yet. A timer due across the same sleep can run
    // before the heartbeat does on wake, and it must still see the sleep it slept through.
    const pending = this.pendingWindow(now);
    if (pending) total += overlap(pending, since, now);
    return total;
  }

  private pendingWindow(now: number): SuspendWindow | null {
    return now - this.lastTick > this.gapMs ? { start: this.lastTick + this.intervalMs, end: now } : null;
  }
}

let shared: HostSuspendMonitor | null = null;
let installed: HostSuspendClock | null = null;

/** This process's monitor, started on first use. */
export function hostSuspendMonitor(): HostSuspendClock {
  if (installed) return installed;
  shared ??= new HostSuspendMonitor().start();
  return shared;
}

/**
 * Replace the clock every default caller reads, returning a restore hook. The seam a test uses
 * to put a real runner's timeout through a sleep it cannot cause.
 */
export function configureHostSuspendClock(clock: HostSuspendClock): () => void {
  const previous = installed;
  installed = clock;
  return () => {
    installed = previous;
  };
}

export interface AwakeTimeout {
  clear(): void;
}

export interface AwakeTimeoutDeps {
  clock?: HostSuspendClock;
  /** The clock Node's timers run on. Defaults to `performance.now`. */
  timerNow?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * `setTimeout` that spends only time the host was awake. Unref'd, like every timeout it
 * replaces.
 *
 * With no suspension observed it is exactly `setTimeout`: the timer fires and so does `fn`.
 * When the host slept, the elapsed time is measured on both clocks and the smaller is taken as
 * awake time, which is correct whichever way the platform's timer clock treats sleep - macOS
 * counts it (wall and timer elapsed agree, minus the suspension), Linux's monotonic clock does
 * not (timer elapsed is already awake time). The timer re-arms for whatever is left.
 */
export function setAwakeTimeout(fn: () => void, ms: number, deps: AwakeTimeoutDeps = {}): AwakeTimeout {
  const clock = deps.clock ?? hostSuspendMonitor();
  const timerNow = deps.timerNow ?? (() => performance.now());
  const setTimeoutFn = deps.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  const wallStart = clock.mark();
  const timerStart = timerNow();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const arm = (delay: number): void => {
    timer = setTimeoutFn(check, Math.max(1, Math.ceil(delay)));
    (timer as { unref?: () => void }).unref?.();
  };
  const check = (): void => {
    if (done) return;
    const suspended = clock.suspendedMsSince(wallStart);
    if (suspended > 0) {
      const wallElapsed = clock.mark() - wallStart;
      const awake = Math.min(timerNow() - timerStart, wallElapsed - suspended);
      if (awake < ms) {
        arm(ms - awake);
        return;
      }
    }
    done = true;
    fn();
  };
  arm(ms);
  return {
    clear(): void {
      done = true;
      if (timer) clearTimeoutFn(timer);
      timer = null;
    },
  };
}
