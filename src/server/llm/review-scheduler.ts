// One daemon-owned ceiling on tool-less REVIEW work, and the reason it is created rather
// than imported.
//
// Workflow already had a ceiling, but only half of one: `WorkflowEngine` gated its Persona
// attempts at three while context compaction called the provider outside that gate, so a
// dashboard capturing several submissions at once could exceed the number it was supposed
// to hold. Anything that later reviews evidence with a fresh, tool-less model call belongs
// under the same ceiling, or each subsystem's "three" quietly becomes nine.
//
// It is NOT module-global, and that is deliberate twice over. The Foreman is a SEPARATE
// PROCESS, so a module-level counter could not cap it even if it should - and it should not:
// its serial review queue has its own latency contract. The daemon's unrelated background
// jobs (titling, goal refresh, the away digest) keep their own limits for the same reason;
// they degrade differently and must not queue behind a 120s Persona call. So the daemon
// constructs exactly one of these at startup and injects it into the subsystems that share
// the budget, which also lets a test drive a scheduler it can observe.

export type ReviewPriority = "normal" | "capture";

/** Runs `fn` once the shared review budget has a slot. */
export type ReviewScheduler = <T>(
  fn: () => Promise<T>,
  priority?: ReviewPriority,
) => Promise<T>;

/**
 * How many review calls the daemon runs at once.
 *
 * Three is what `WorkflowEngine` already enforced for Persona attempts; the change is that
 * compaction now counts against it too.
 */
export const DEFAULT_REVIEW_CONCURRENCY = 3;

export function createReviewScheduler(
  concurrency: number = DEFAULT_REVIEW_CONCURRENCY,
): ReviewScheduler {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Review concurrency must be a positive integer");
  }

  let active = 0;
  const waiting: Record<ReviewPriority, Array<() => void>> = {
    capture: [],
    normal: [],
  };
  const release = (): void => {
    active--;
    (waiting.capture.shift() ?? waiting.normal.shift())?.();
  };

  return async function schedule<T>(
    fn: () => Promise<T>,
    priority: ReviewPriority = "normal",
  ): Promise<T> {
    // Re-check after waking. A newly submitted task can observe the released slot before
    // this continuation resumes, and treating a wake-up as a reservation would then exceed
    // the daemon-wide ceiling.
    while (active >= concurrency) {
      await new Promise<void>((resolve) => waiting[priority].push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
