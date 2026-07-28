/**
 * Carries refresh waiters forward when a newer load supersedes their request.
 *
 * A mutation may only release its in-flight guard after the newest detail has committed.
 * Keeping the waiters under that newest generation prevents an older React commit from
 * releasing a newer action, while `release` gives unmount a terminal settlement path.
 */
export interface WorkflowLoadCommitBarrier {
  waitFor(generation: number): Promise<void>;
  commit(generation: number): void;
  release(): void;
}

export interface WorkflowLoadAcknowledgement {
  /**
   * Returns true only for a settled render whose generation has already rendered loading.
   * This prevents a passive effect from acknowledging stale ready data after a refresh starts.
   */
  observe(generation: number, loading: boolean): boolean;
}

export function createWorkflowLoadAcknowledgement(): WorkflowLoadAcknowledgement {
  let loadingSeenThrough = -1;
  return {
    observe(generation, loading) {
      if (loading) {
        loadingSeenThrough = Math.max(loadingSeenThrough, generation);
        return false;
      }
      return loadingSeenThrough >= generation;
    },
  };
}

export function createWorkflowLoadCommitBarrier(): WorkflowLoadCommitBarrier {
  const waiters = new Map<number, Set<() => void>>();
  let newestGeneration = 0;

  return {
    waitFor(generation) {
      if (generation < newestGeneration) return Promise.resolve();
      if (generation > newestGeneration) {
        const carried = new Set<() => void>();
        for (const resolvers of waiters.values()) {
          for (const resolve of resolvers) carried.add(resolve);
        }
        waiters.clear();
        waiters.set(generation, carried);
        newestGeneration = generation;
      }
      const resolvers = waiters.get(generation) ?? new Set<() => void>();
      waiters.set(generation, resolvers);
      return new Promise((resolve) => {
        resolvers.add(resolve);
      });
    },
    commit(generation) {
      const resolvers = waiters.get(generation);
      if (!resolvers) return;
      waiters.delete(generation);
      for (const resolve of resolvers) resolve();
    },
    release() {
      for (const resolvers of waiters.values()) {
        for (const resolve of resolvers) resolve();
      }
      waiters.clear();
    },
  };
}
