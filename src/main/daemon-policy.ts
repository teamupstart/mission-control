/**
 * Start the daemon only when Electron owns the application stack.
 *
 * A Vite URL means the shell is part of `dev:desktop`, where `dev:server`
 * owns the daemon and restarts it independently. Treating a transiently
 * unhealthy dev daemon as absent would start Electron's supervised production
 * daemon, which then loses the port race and restarts forever.
 */
export async function startElectronOwnedDaemon<T>(
  devServerUrl: string | undefined,
  start: () => Promise<T>,
): Promise<T | null> {
  if (devServerUrl) return null;
  return start();
}

export interface DaemonStartOwnership<T> {
  ready: Promise<T | null>;
  stop(): void;
}

/** Own a daemon even while its asynchronous adopt-or-spawn decision is still pending. */
export function ownElectronDaemonStart<T extends { stop(): void }>(
  devServerUrl: string | undefined,
  start: () => Promise<T>,
): DaemonStartOwnership<T> {
  let daemon: T | null = null;
  let stopRequested = false;
  const ready = startElectronOwnedDaemon(devServerUrl, start).then((started) => {
    daemon = started;
    if (stopRequested) daemon?.stop();
    return started;
  });
  return {
    ready,
    stop() {
      if (stopRequested) return;
      stopRequested = true;
      daemon?.stop();
    },
  };
}
