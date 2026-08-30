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
