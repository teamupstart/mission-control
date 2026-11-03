export interface BackgroundProcess {
  /** Resolves once the process has left. See `UtilityProcessController.stop`. */
  stop(): Promise<void>;
}

export interface ElectronBackgroundStack<D, F> {
  daemon: D;
  foreman: F | null;
}

export interface BackgroundStartOwnership<D, F> {
  ready: Promise<ElectronBackgroundStack<D, F> | null>;
  /**
   * Stop both processes, including one whose start is still pending, and resolve once every
   * process this ownership started has exited. Idempotent: every call shares one stop.
   */
  stop(): Promise<void>;
}

/**
 * How long a quitting app waits for its daemon's orderly shutdown before letting Electron reap it.
 *
 * The daemon's shutdown is where workflow-check process groups are cancelled and their leases
 * released (`WorkflowEngine.stop`). Electron reaps utility processes when the main process exits,
 * so quitting without waiting cuts that shutdown short and leaves the detached check supervisors
 * running from inside the app bundle - which is exactly what kept an in-place update's
 * bundle-exit wait from ever succeeding. Sized well inside the update helper's two-minute wait
 * for the app to quit, and far above a healthy shutdown, so reaching it means something is wrong
 * rather than slow.
 */
export const BACKGROUND_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Own the packaged app's background processes even while either start is pending.
 *
 * A Vite URL means `dev:server` and, for `make start`, `dev:foreman` own those lifecycles.
 * Starting packaged copies from Electron would create competing restart loops. In a packaged
 * app, Foreman starts immediately after the daemon controller exists; it already retries an
 * unreachable daemon and its lease makes a concurrently started worker a safe standby.
 */
export function ownElectronBackgroundStart<
  D extends BackgroundProcess,
  F extends BackgroundProcess,
>(
  devServerUrl: string | undefined,
  startDaemon: () => Promise<D>,
  startForeman: () => Promise<F>,
): BackgroundStartOwnership<D, F> {
  let daemon: D | null = null;
  let foreman: F | null = null;
  let stopRequested = false;
  // Stops issued by a start that finished after `stop()` was called. `stop()` awaits them too,
  // so a quit during startup still waits for the daemon it raced.
  const lateStops: Promise<void>[] = [];
  const ready = (async (): Promise<ElectronBackgroundStack<D, F> | null> => {
    if (devServerUrl) return null;
    daemon = await startDaemon();
    if (stopRequested) {
      lateStops.push(daemon.stop());
      return { daemon, foreman: null };
    }
    foreman = await startForeman();
    if (stopRequested) {
      lateStops.push(foreman.stop(), daemon.stop());
    }
    return { daemon, foreman };
  })();
  let stopping: Promise<void> | null = null;
  return {
    ready,
    stop() {
      if (stopping) return stopping;
      stopRequested = true;
      // Release Foreman's lease while the daemon can still receive the shutdown request.
      const immediate = [foreman?.stop(), daemon?.stop()];
      stopping = (async () => {
        await Promise.allSettled(immediate);
        // A start that was still pending stops what it started as soon as it resolves.
        await ready.catch(() => null);
        await Promise.allSettled(lateStops);
      })();
      return stopping;
    },
  };
}

/**
 * Stop the background stack and wait for it, up to `timeoutMs`.
 *
 * Never rejects: a quit must always be able to finish. `timed-out` is returned rather than
 * thrown so the caller can log it and let Electron reap what is left.
 */
export async function drainBackgroundStart(
  ownership: Pick<BackgroundStartOwnership<unknown, unknown>, "stop"> | null,
  timeoutMs = BACKGROUND_DRAIN_TIMEOUT_MS,
): Promise<"drained" | "timed-out"> {
  if (!ownership) return "drained";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  try {
    return await Promise.race([ownership.stop().then(() => "drained" as const, () => "drained" as const), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
