import type { SettingsBackupService } from "./service.ts";
import { settingsBackupLocalDate } from "./service.ts";

export const SETTINGS_BACKUP_HEALTH_INTERVAL_MS = 60_000;

interface TimerHandle {
  unref?(): void;
}

export interface SettingsBackupLoopDeps {
  now(): Date;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  healthIntervalMs: number;
}

const defaultDeps: SettingsBackupLoopDeps = {
  now: () => new Date(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  healthIntervalMs: SETTINGS_BACKUP_HEALTH_INTERVAL_MS,
};

export function nextSettingsBackupCheckDelay(now: Date, healthIntervalMs: number): number {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  ).getTime();
  return Math.max(1, Math.min(healthIntervalMs, nextMidnight - now.getTime()));
}

export function startSettingsBackupLoop(
  service: Pick<SettingsBackupService, "ensureDailySnapshot">,
  overrides: Partial<SettingsBackupLoopDeps> = {},
): () => void {
  const deps = { ...defaultDeps, ...overrides };
  let stopped = false;
  let timer: TimerHandle | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = deps.now();
    try {
      await service.ensureDailySnapshot(settingsBackupLocalDate(now));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[mission-control] settings backup failed: ${reason}`);
    }
    if (stopped) return;
    timer = deps.setTimer(
      () => { void tick(); },
      nextSettingsBackupCheckDelay(deps.now(), deps.healthIntervalMs),
    );
    timer.unref?.();
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) deps.clearTimer(timer);
    timer = null;
  };
}
