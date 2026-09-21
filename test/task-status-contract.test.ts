import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_STATUSES, type TaskStatus } from "../src/shared/types.ts";
import { ACTIVE_TASK_STATUSES, isActiveTask, isTerminalTask } from "../src/shared/task-status.ts";
import { statusBlocksOverlap } from "../src/server/schedules/policy.ts";
import { agentIsFree, type BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-status-contract-"));
process.env.MISSION_HOME = home;
const db = await import("../src/server/db.ts");
const { Registry, completableByMerge } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { RegistryArchiveTaskGateway } = await import("../src/server/archives/task-gateway.ts");
const { findActiveTaskForSchedule } = await import("../src/server/schedules/store.ts");

after(() => {
  db.closeDb();
  rmSync(home, { recursive: true, force: true });
});

// Independent expected outcomes: adding a status must fail this focused contract until
// its behavior is defined, even when the test runner does not invoke TypeScript.
const MATRIX = {
  backlog: { active: false, overlap: true, terminal: false, merge: false },
  dispatching: { active: true, overlap: true, terminal: false, merge: true },
  running: { active: true, overlap: true, terminal: false, merge: true },
  done: { active: false, overlap: false, terminal: true, merge: false },
  cancelled: { active: false, overlap: false, terminal: true, merge: true },
  failed: { active: false, overlap: false, terminal: true, merge: true },
} satisfies Record<TaskStatus, { active: boolean; overlap: boolean; terminal: boolean; merge: boolean }>;

const cfg: BacklogConfig = {
  enabled: true,
  maxSessions: 3,
  allowlist: ["/repo"],
  mayActLive: true,
  settleMs: 10_000,
  respectOpenPrs: true,
  planExhausted: false,
};

test("every declared task status has a deliberate lifecycle matrix entry", () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...TASK_STATUSES].sort());
  assert.equal(new Set(TASK_STATUSES).size, TASK_STATUSES.length);
  assert.deepEqual(ACTIVE_TASK_STATUSES, TASK_STATUSES.filter((status) => MATRIX[status].active));
});

for (const status of TASK_STATUSES) {
  test(`${status}: shared policy and lifecycle consumers agree`, async (t) => {
    const expected = MATRIX[status];

    await t.test("active, terminal, schedule, and merge policies retain their distinct meanings", () => {
      assert.equal(isActiveTask(status), expected.active);
      assert.equal(isTerminalTask(status), expected.terminal);
      assert.equal(statusBlocksOverlap(status), expected.overlap);
      assert.equal(completableByMerge(status), expected.merge);
    });

    await t.test("dispatch selection reserves a session only for an active task", () => {
      const session = mkSession({ state: "idle", cwd: "/repo", repoRoot: "/repo" });
      const task = mkTask({ status, sessionId: session.id });
      assert.equal(agentIsFree(session, [session], [], cfg, 100_000), true, "eligible fixture");
      assert.equal(agentIsFree(session, [session], [task], cfg, 100_000), !expected.active);
    });

    await t.test("startup loading and schedule SQL also retain backlog work", () => {
      const task = mkTask({ id: `schedule-${status}`, status, scheduleId: `schedule-${status}` });
      db.upsertTask(task);
      try {
        assert.equal(db.loadActiveTasks().some((row) => row.id === task.id), expected.overlap);
        assert.equal(findActiveTaskForSchedule(task.scheduleId!)?.id ?? null,
          expected.overlap ? task.id : null);
      } finally {
        db.deleteTask(task.id);
      }
    });

    await t.test("archive recovery waits for active agents only", () => {
      const registry = new Registry();
      const task = mkTask({ id: `archive-${status}`, status, kind: "scout" });
      registry.upsertTask(task);
      try {
        const gateway = new RegistryArchiveTaskGateway(registry);
        assert.equal(gateway.awaitsAgent(task.id), expected.active);
        assert.equal(gateway.awaitsAgent("missing"), false);
      } finally {
        registry.removeTask(task.id);
      }
    });

    await t.test("deletion requires cancellation of active tasks", async () => {
      const registry = new Registry();
      const manager = new TaskManager(registry);
      const task = mkTask({ id: `remove-${status}`, status });
      registry.upsertTask(task);
      try {
        const result = await manager.remove(task.id);
        assert.equal(result.ok, !expected.active);
        if (!result.ok) assert.equal(result.error, "cancel the task before removing it");
        assert.equal(registry.getTask(task.id) !== undefined, expected.active);
        assert.equal(db.getTask(task.id) !== undefined, expected.active);
      } finally {
        registry.removeTask(task.id);
      }
    });

    for (const trigger of ["session_remove", "startup discovery"] as const) {
      await t.test(`${trigger} settles active orphans and preserves other statuses`, () => {
        const registry = new Registry();
        new TaskManager(registry);
        const task = mkTask({ id: `${trigger}-${status}`, status, sessionId: `gone-${status}` });
        registry.upsertTask(task);
        try {
          assert.equal(registry.getTask(task.id)?.status, status, "no premature settlement");
          if (trigger === "session_remove") {
            registry.emit("event", { type: "session_remove", id: task.sessionId! });
          } else {
            registry.applyDiscovery([]);
          }
          assert.equal(registry.getTask(task.id)?.status, expected.active ? "failed" : status);
          assert.equal(db.getTask(task.id)?.status, expected.active ? "failed" : status);
        } finally {
          registry.removeTask(task.id);
        }
      });
    }

    await t.test("episode reset cancels the same statuses in memory and SQLite", () => {
      const registry = new Registry();
      const task = mkTask({ id: `reset-${status}`, status, sessionId: `reset-${status}` });
      registry.upsertTask(task);
      try {
        registry.resetWorkEpisode(task.sessionId!, { at: 10_000 });
        for (const row of [registry.getTask(task.id), db.getTask(task.id)]) {
          assert.equal(row?.status, expected.active ? "cancelled" : status);
          assert.equal(row?.completedAt, expected.active ? 10_000 : null);
          assert.equal(row?.sessionId, null);
        }
      } finally {
        registry.removeTask(task.id);
      }
    });
  });
}
