export interface KillableUtilityProcess {
  kill(): boolean;
}

export class UtilityProcessInitializationError<T extends KillableUtilityProcess> extends Error {
  readonly child: T;

  constructor(child: T, cause: unknown) {
    super("utility process initialization failed", { cause });
    this.name = "UtilityProcessInitializationError";
    this.child = child;
  }
}

/**
 * Ask a utility process to leave and let it take as long as its own shutdown needs.
 *
 * Deliberately not `UtilityProcess.kill()`. That sends `SIGTERM` and then `SIGKILL`s the child
 * about two seconds later whatever it is doing (measured in `test/quit-drain-electron.test.ts`),
 * so the daemon's orderly shutdown - which reaches the workflow-check teardown only after
 * sessions and transfers have stopped - was cut short on every stop, and the checks it would
 * have torn down kept running from inside the app bundle. A plain `SIGTERM` reaches the same
 * handler with no deadline attached; how long to wait is the owner's decision, and Electron
 * still reaps whatever is left when the app finally exits. `kill()` remains the fallback for a
 * child with no pid or one that cannot be signalled.
 */
export function stopChild(
  child: (KillableUtilityProcess & { pid?: number | undefined }) | null,
  signal: (pid: number, signal: "SIGTERM") => void = (pid, name) => { process.kill(pid, name); },
): void {
  if (!child) return;
  if (child.pid !== undefined) {
    try {
      signal(child.pid, "SIGTERM");
      return;
    } catch {
      // Already gone or not ours to signal; fall back to Electron's own teardown.
    }
  }
  child.kill();
}

/**
 * Fork a utility process and finish its synchronous initialization as one owned operation.
 *
 * Once the fork succeeds, every failure path must terminate that child. Otherwise a throwing
 * initialization hook leaves an unobserved process alive while its supervisor starts another.
 */
export function forkAndInitializeUtilityProcess<T extends KillableUtilityProcess>(
  fork: () => T,
  initialize?: (child: T) => void,
): T {
  const child = fork();
  try {
    initialize?.(child);
    return child;
  } catch (err) {
    try {
      child.kill();
    } catch {
      // Preserve the initialization failure that caused teardown. The supervisor logs it and
      // retries; a second exception here must not bypass that recovery path.
    }
    throw new UtilityProcessInitializationError(child, err);
  }
}
