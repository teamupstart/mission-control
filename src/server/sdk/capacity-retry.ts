/**
 * When an SDK session's model is at capacity, how long to wait before asking it to continue.
 *
 * A capacity failure ends the turn with the work unfinished. Reporting it as a completed turn
 * hands half-done work to whatever waits on the turn (a workflow review, Foreman's
 * completion check), so the supervisor waits and sends a continuation instead. Each attempt
 * doubles the wait from 15 seconds up to a 10 minute ceiling, and after the last attempt the
 * turn is reported as the failure it is, so a session cannot be held busy for ever.
 */

export const CAPACITY_RETRY_BASE_MS = 15_000;
export const CAPACITY_RETRY_MAX_DELAY_MS = 10 * 60_000;
/** Attempts before the failure is reported: 15s, 30s, 1m, 2m, 4m, 8m, 10m, 10m. */
export const CAPACITY_RETRY_MAX_ATTEMPTS = 8;

/** What the session is told when a retry lands. Written as harness input, never as a human. */
export const CAPACITY_CONTINUATION_PROMPT =
  "Your previous turn stopped because the model provider reported it was at capacity. " +
  "Mission Control waited and is retrying automatically. Continue that work from the " +
  "current checkout and conversation. Inspect the current state before acting and do not " +
  "repeat completed work.";

export interface CapacityRetryPlan {
  /** 1-based attempt this wait leads to. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

/** The wait before `attempt` (1-based), or null once the attempts are spent. */
export function capacityRetryPlan(attempt: number): CapacityRetryPlan | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > CAPACITY_RETRY_MAX_ATTEMPTS) {
    return null;
  }
  const delayMs = Math.min(CAPACITY_RETRY_BASE_MS * 2 ** (attempt - 1), CAPACITY_RETRY_MAX_DELAY_MS);
  return { attempt, maxAttempts: CAPACITY_RETRY_MAX_ATTEMPTS, delayMs };
}

/** The card's one-line activity while a retry waits. */
export function capacityRetryActivity(plan: CapacityRetryPlan): string {
  return `Model at capacity - retrying in ${formatWait(plan.delayMs)} ` +
    `(attempt ${plan.attempt} of ${plan.maxAttempts})`;
}

function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
