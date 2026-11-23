import type { DatabaseBackupService } from "./service.ts";

/**
 * How often the loop asks whether a scheduled copy is due. The first wake is this long after
 * start, which is also the grace that keeps a capture from competing with daemon startup.
 */
export const DATABASE_BACKUP_WAKE_MS = 5 * 60 * 1_000;

interface TimerHandle {
  unref?(): void;
}

interface DatabaseBackupLoopDeps {
  wakeMs: number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

const defaultDeps: DatabaseBackupLoopDeps = {
  wakeMs: DATABASE_BACKUP_WAKE_MS,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Wake on a short fixed timer and capture when the service says a scheduled copy is due. The
 * cadence is measured by wall clock from the copies on disk, not by timing one interval from
 * each start, so a restart, a sleep or a changed interval takes effect at the next wake.
 */
export function startDatabaseBackupLoop(
  service: Pick<DatabaseBackupService, "captureScheduled" | "prune" | "scheduledDue">,
  overrides: Partial<DatabaseBackupLoopDeps> = {},
): () => Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  if (!Number.isSafeInteger(deps.wakeMs) || deps.wakeMs < 1) {
    throw new RangeError("Database backup wake interval must be a positive integer");
  }
  let stopped = false;
  let timer: TimerHandle | null = null;
  let activeTick: Promise<void> | null = null;

  const schedule = (): void => {
    timer = deps.setTimer(run, deps.wakeMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (service.scheduledDue()) await service.captureScheduled();
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

  // A lowered count, or the old fixed 24 hourly copies, is pruned at startup rather than after
  // the first capture an interval away. A failure here only warns: it never stops the daemon.
  try {
    service.prune();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[mission-control] database backup prune failed: ${reason}`);
  }
  schedule();
  return async () => {
    stopped = true;
    if (timer) deps.clearTimer(timer);
    timer = null;
    await activeTick;
  };
}
