import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: `TaskManager.create` grew a second door, and both halves of that have
// to hold. The internal door is what makes the schedule ledger exactly-once - a crash
// between reserving an occurrence and filing its task is repaired by calling create again
// with the SAME id, which is only safe if a repeat is a no-op rather than a second task.
// The ordinary door is every other caller in the daemon, and it must not have changed at
// all: a UUID it did not choose, null schedule provenance, and the model titler still on
// the path when the title is blank.
//
// The idempotency lives here rather than in the scheduler because it has to hold for any
// future durable producer, and because a caller that has to remember to check first is a
// caller that will one day forget.

const home = mkdtempSync(join(tmpdir(), "mission-schedule-task-create-"));
process.env.MISSION_HOME = home;

const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager, TaskIdCollisionError } = await import("../src/server/tasks.ts");

after(() => rmSync(home, { recursive: true, force: true }));

db.openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);

const SCHEDULED_FOR = Date.parse("2026-07-23T09:00:00Z");

function input(over: Record<string, unknown> = {}) {
  return {
    repoRoot: "/repos/main",
    intent: "Read the inbox and file whatever needs filing.",
    title: "Sweep the inbox",
    kind: "ship" as const,
    agent: "claude" as const,
    backlog: true,
    ...over,
  };
}

function provenance(occurrenceId: string) {
  return {
    scheduleId: "schedule-1",
    scheduleOccurrenceId: occurrenceId,
    scheduledFor: SCHEDULED_FOR,
  };
}

test("an ordinary create is untouched: its own id, and no schedule provenance", () => {
  const task = tasks.create(input({ title: "Human work" }));

  assert.notEqual(task.id, "");
  assert.match(task.id, /^[0-9a-f-]{36}$/, "a UUID nobody outside chose");
  assert.equal(task.scheduleId, null);
  assert.equal(task.scheduleOccurrenceId, null);
  assert.equal(task.scheduledFor, null);
});

test("an internal create uses the reserved id and carries all three provenance values", () => {
  const task = tasks.create(input(), { id: "reserved-1", schedule: provenance("occ-1") });

  assert.equal(task.id, "reserved-1");
  assert.equal(task.scheduleId, "schedule-1");
  assert.equal(task.scheduleOccurrenceId, "occ-1");
  assert.equal(task.scheduledFor, SCHEDULED_FOR);
  // Everything else is a perfectly ordinary backlog task: schedulable by Foreman, with no
  // prerequisites of its own.
  assert.equal(task.status, "backlog");
  assert.equal(task.enabled, true);
  assert.deepEqual(task.dependencies, []);
  assert.equal(task.title, "Sweep the inbox");
  assert.deepEqual(db.getTask("reserved-1")?.id, "reserved-1", "and it is durable before it returns");
});

test("repeating an internal create returns the same task and rewrites nothing", () => {
  const first = tasks.create(input(), { id: "reserved-2", schedule: provenance("occ-2") });
  const again = tasks.create(
    input({ title: "A title from a later edit", intent: "different intent" }),
    { id: "reserved-2", schedule: provenance("occ-2") },
  );

  assert.equal(again.id, first.id);
  // The recovery pass must not overwrite the task the crashed pass already filed - an
  // operator may have edited it, and the schedule has since been revised.
  assert.equal(again.title, "Sweep the inbox");
  assert.equal(again.updatedAt, first.updatedAt);
  assert.equal(db.listTasks().filter((t) => t.id === "reserved-2").length, 1);
});

test("idempotency compares the scheduled instant as part of durable provenance", () => {
  tasks.create(input(), { id: "reserved-instant", schedule: provenance("occ-instant") });

  assert.throws(
    () =>
      tasks.create(input(), {
        id: "reserved-instant",
        schedule: {
          ...provenance("occ-instant"),
          scheduledFor: SCHEDULED_FOR + 1,
        },
      }),
    TaskIdCollisionError,
  );
  assert.equal(db.getTask("reserved-instant")?.scheduledFor, SCHEDULED_FOR);
});

test("a collision hidden from the Registry cache still fails closed", () => {
  const source = db.getTask("reserved-1")!;
  db.upsertTask({
    ...source,
    id: "durable-only",
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
  });
  assert.equal(registry.getTask("durable-only"), undefined);

  assert.throws(
    () => tasks.create(input(), { id: "durable-only", schedule: provenance("occ-durable") }),
    TaskIdCollisionError,
  );
  assert.equal(db.getTask("durable-only")?.scheduleId, null);
});

test("a reserved id belonging to another occurrence is corruption, and fails closed", () => {
  tasks.create(input(), { id: "reserved-3", schedule: provenance("occ-3") });

  assert.throws(
    () => tasks.create(input(), { id: "reserved-3", schedule: provenance("occ-DIFFERENT") }),
    TaskIdCollisionError,
  );
  // The existing task is left exactly as it was rather than re-provenanced onto the
  // occurrence that collided with it.
  assert.equal(db.getTask("reserved-3")?.scheduleOccurrenceId, "occ-3");
});

test("a reserved id belonging to a task no schedule filed also fails closed", () => {
  const stranger = tasks.create(input({ title: "Human work" }));

  assert.throws(
    () => tasks.create(input(), { id: stranger.id, schedule: provenance("occ-4") }),
    TaskIdCollisionError,
  );
  assert.equal(db.getTask(stranger.id)?.scheduleId, null);
});

test("a schedule cannot file work that dispatches - the refusal is here, not at the caller", () => {
  // The one line that would turn "this mission runs hourly" into "this mission launches
  // an agent hourly", with none of Foreman's capacity, allowlist or pane gates consulted.
  assert.throws(
    () => tasks.create(input({ backlog: false }), { id: "reserved-5", schedule: provenance("occ-5") }),
    /must be backlog/,
  );
  assert.equal(db.getTask("reserved-5"), undefined, "and nothing was written");
});

test("a schedule cannot file an untitled task, because that would spend a model call per run", () => {
  assert.throws(
    () => tasks.create(input({ title: "   " }), { id: "reserved-6", schedule: provenance("occ-6") }),
    /must carry a title/,
  );
  assert.equal(db.getTask("reserved-6"), undefined);
});
