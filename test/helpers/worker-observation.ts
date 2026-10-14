import { setTimeout } from "node:timers/promises";

/** A bounded opportunity to observe a subprocess, crediting a starved parent poll. */
export async function waitForWorkerObservation(
  until: () => boolean,
  ms: number,
  timing = { now: () => performance.now(), sleep: (delay: number) => setTimeout(delay) },
): Promise<boolean> {
  let deadline = timing.now() + ms;
  let ceiling = timing.now() + ms * 6;
  while (!until()) {
    const asked = Math.min(50, Math.max(1, deadline - timing.now()));
    const before = timing.now();
    await timing.sleep(asked);
    const overslept = timing.now() - before - asked;
    // A host suspension can outlast the entire ceiling in one poll. Preserve the
    // remaining budget on resume instead of killing the child before it can answer.
    // Ordinary scheduling contention still shares the original six-budget ceiling.
    if (overslept > ms * 6) ceiling += overslept;
    if (overslept > asked) deadline = Math.min(deadline + overslept, ceiling);
    if (timing.now() >= deadline) return until();
  }
  return true;
}
