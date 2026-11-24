/**
 * The order shared pane state is written in. The pane's state is shared by every session, so each
 * read-modify-write and each write runs after those queued before it, and checks its own guard as
 * its turn comes: a write an old session already has in flight finishes before the replacement's
 * begins, and a session that ended in the meantime has its turn skipped.
 */
export interface WriteQueue {
  /** Settles when everything queued so far has finished. */
  writes: Promise<void>;
}

/**
 * Runs `task` after everything already queued. `guard` is read when the turn comes, not when the
 * work is queued; a false answer skips the task. A task that throws does not stop the queue and
 * the returned promise still settles.
 */
export function runQueued(queue: WriteQueue, guard: (() => boolean) | undefined, task: () => Promise<void>): Promise<void> {
  const run = queue.writes.then(async () => {
    if (guard && !guard()) return;
    await task();
  });
  queue.writes = run.catch(() => undefined);
  return run.catch(() => undefined);
}
