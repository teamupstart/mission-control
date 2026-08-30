import type { DatabaseBackupService } from "./service.ts";

export const DATABASE_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;

interface TimerHandle {
  unref?(): void;
}

interface DatabaseBackupLoopDeps {
  intervalMs: number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

const defaultDeps: DatabaseBackupLoopDeps = {
  intervalMs: DATABASE_BACKUP_INTERVAL_MS,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function startDatabaseBackupLoop(
  service: Pick<DatabaseBackupService, "captureScheduled">,
  overrides: Partial<DatabaseBackupLoopDeps> = {},
): () => Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs < 1) {
    throw new RangeError("Database backup interval must be a positive integer");
  }
  let stopped = false;
  let timer: TimerHandle | null = null;
  let activeTick: Promise<void> | null = null;

  const schedule = (): void => {
    timer = deps.setTimer(run, deps.intervalMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await service.captureScheduled();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[mission-control] database backup failed: ${reason}`);
    }
    if (stopped) return;
    schedule();
  };

  const run = (): void => {
    timer = null;
    activeTick = tick().finally(() => {
      activeTick = null;
    });
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer) deps.clearTimer(timer);
    timer = null;
    await activeTick;
  };
}
