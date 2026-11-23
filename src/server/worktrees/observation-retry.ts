/**
 * The one retry an observation read gets before it counts as unknown.
 *
 * A read that fails under load (a `git status` killed at its timeout while installs push the
 * load average past 100, a `ps` that did not answer in time) usually answers a moment later.
 * The occupancy listing, `git worktree list`, a slot inspection and an owner lookup each try
 * once more in the same pass, this long after the first failure and with this multiple of
 * the first attempt's timeout. Only a read that fails both times is unknown.
 */
export const OBSERVATION_RETRY_DELAY_MS = 2_000;
export const OBSERVATION_RETRY_TIMEOUT_SCALE = 2;

export function pauseFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TIMED_OUT = /^(.*) timed out after (\d+(?:\.\d+)? s)$/;

/**
 * The reason a read that failed twice records, naming both attempts: "git status timed out
 * after 15 s, and after 30 s on retry" when the same step timed out twice.
 */
export function bothAttempts(first: string, second: string): string {
  const a = TIMED_OUT.exec(first);
  const b = TIMED_OUT.exec(second);
  if (a && b && a[1] === b[1]) return `${a[1]} timed out after ${a[2]}, and after ${b[2]} on retry`;
  if (first === second) return `${first}, and again on retry`;
  return `${first}, and on retry ${second}`;
}
