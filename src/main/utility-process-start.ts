export interface KillableUtilityProcess {
  kill(): boolean;
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
    throw err;
  }
}
