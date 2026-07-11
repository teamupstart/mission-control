/**
 * Timer helpers shared across the daemon's long-lived loops (pollers, SSE
 * heartbeats, long-poll waiters). Every background timer must be unref'd so a
 * pending tick never keeps the process alive on shutdown.
 */

/**
 * Detach a timer from the event loop's ref count so it won't hold the process
 * open. Node's `setTimeout` returns a `Timeout` object with `.unref()`; other
 * runtimes return a bare number - guard for both and return the handle so this
 * can wrap a `setTimeout(...)` call inline.
 */
export function unref<T>(timer: T): T {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as unknown as { unref(): void }).unref();
  }
  return timer;
}

/** Resolve after `ms`, on an unref'd timer (won't keep the process alive). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unref(setTimeout(resolve, ms));
  });
}
