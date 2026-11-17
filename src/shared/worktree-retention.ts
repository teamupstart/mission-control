/** Global task retention policy; independent of native pool reconciliation. */
export const TASK_RETENTION_DEFAULT_DAYS = 30;
export const TASK_RETENTION_MIN_DAYS = 7;
export const TASK_RETENTION_MAX_DAYS = 90;
export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_OBSERVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Tolerate old or damaged stored configuration without disabling destructive-boundary safety. */
export function normalizeTaskRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TASK_RETENTION_DEFAULT_DAYS;
  return Math.max(TASK_RETENTION_MIN_DAYS, Math.min(TASK_RETENTION_MAX_DAYS, Math.floor(value)));
}
