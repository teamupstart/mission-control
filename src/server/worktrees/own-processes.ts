/**
 * The worktree Git commands this daemon has running right now.
 *
 * Occupancy means "a process whose cwd is inside the slot", and `git -C <slot>` runs with
 * exactly that cwd. Without this, the daemon's own bounded reads and removals look like
 * somebody working in the slot: a preview is blocked, or its background recheck disagrees
 * and the cleanup is refused as stale. Serializing observations covers observation against
 * observation; this covers a mutation's Git - a `git worktree remove` that deliberately
 * does not hold up previews - at the one boundary that sees processes: the occupancy scan.
 *
 * A PID is present only between spawn and completion, so a reused PID is never mistaken
 * for ours. Only commands started through `trackOwnWorktreeProcess` are recorded; setup
 * argv, agents, and checks are never in this set and are never ignored.
 */
const running = new Set<number>();

export function ownWorktreeProcesses(): ReadonlySet<number> {
  return running;
}

export async function trackOwnWorktreeProcess<T>(
  start: (onSpawn: (pid: number) => void) => Promise<T>,
): Promise<T> {
  let pid: number | null = null;
  try {
    return await start((spawned) => {
      pid = spawned;
      running.add(spawned);
    });
  } finally {
    if (pid !== null) running.delete(pid);
  }
}
