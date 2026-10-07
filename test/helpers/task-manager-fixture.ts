import { afterEach } from "node:test";
import { TaskManager as ProductionTaskManager } from "../../src/server/tasks.ts";

export * from "../../src/server/tasks.ts";

const managers = new Set<ProductionTaskManager>();

// Stop every producer before waiting on any one manager. Otherwise a later fixture's
// timer can keep adding work while an earlier fixture drains the shared durable rows.
afterEach(async () => {
  const owned = [...managers];
  managers.clear();
  await Promise.all(owned.map((manager) => manager.stop()));
});

/**
 * A real TaskManager with test-owned lifetime and explicit host evidence. Most unit tests
 * use invented checkout paths and test task policy, not the operator's process table.
 * Unknown occupancy retains those trees through the real fail-closed return path. Tests
 * of successful return/occupancy supply their own evidence through the existing seam.
 * Import dynamically after setting the fixture home, just like the production module.
 */
export class TaskManager extends ProductionTaskManager {
  constructor(...args: ConstructorParameters<typeof ProductionTaskManager>) {
    args[5] = {
      occupancy: async (paths) => new Map(paths.map((path) => [path, {
        status: "unknown" as const,
        reason: "unit fixture has no host occupancy evidence",
      }])),
      ...args[5],
    };
    super(...args);
    managers.add(this);
  }
}
