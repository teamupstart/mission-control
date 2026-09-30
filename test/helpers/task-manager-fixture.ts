import { afterEach } from "node:test";
import type { Registry } from "../../src/server/registry.ts";
import type { TaskManager } from "../../src/server/tasks.ts";

/** Task lifecycle fixtures whose /repo and /wt paths are identities, not real checkouts. */
export function syntheticTaskManagers(Manager: typeof TaskManager) {
  const managers: TaskManager[] = [];
  afterEach(async () => {
    const current = managers.splice(0);
    for (const manager of current) manager.stopMissionSessionClosures();
    await Promise.all(current.map((manager) => manager.settleWorktreeReturns()));
  });
  return (registry: Registry): TaskManager => {
    const manager = new Manager(registry, undefined, undefined, undefined, undefined, {
      // Retain fictional paths without scanning the operator's processes. Real provider
      // return and occupancy behavior is covered by task-worktree-return.test.ts.
      occupancy: async (paths) => new Map(paths.map((path) => [path, {
        status: "unknown" as const, reason: "synthetic task fixture",
      }])),
    });
    managers.push(manager);
    return manager;
  };
}
