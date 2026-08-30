export interface BackgroundProcess {
  stop(): void;
}

export interface ElectronBackgroundStack<D, F> {
  daemon: D;
  foreman: F | null;
}

export interface BackgroundStartOwnership<D, F> {
  ready: Promise<ElectronBackgroundStack<D, F> | null>;
  stop(): void;
}

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
  const ready = (async (): Promise<ElectronBackgroundStack<D, F> | null> => {
    if (devServerUrl) return null;
    daemon = await startDaemon();
    if (stopRequested) {
      daemon.stop();
      return { daemon, foreman: null };
    }
    foreman = await startForeman();
    if (stopRequested) {
      foreman.stop();
      daemon.stop();
    }
    return { daemon, foreman };
  })();
  return {
    ready,
    stop() {
      if (stopRequested) return;
      stopRequested = true;
      // Release Foreman's lease while the daemon can still receive the shutdown request.
      foreman?.stop();
      daemon?.stop();
    },
  };
}
