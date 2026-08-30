import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-sse-initial-"));
process.env.HARNESS_HOME = join(home, "state");

const { Registry } = await import("../src/server/registry.ts");
const { streamRegistryEvents } = await import("../src/server/sse.ts");
type RestoringSession = import("../src/shared/types.ts").RestoringSession;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

test.after(() => rmSync(home, { recursive: true, force: true }));

const row: RestoringSession = {
  id: "sdk:sse-restore",
  agent: "claude",
  name: "Restore through the snapshot gap",
  cwd: "/repo/worktree",
  repoRoot: "/repo",
  taskId: null,
  taskTitle: null,
  createdAt: 1,
};

function parse(data: string): ServerEvent {
  return JSON.parse(data) as ServerEvent;
}

test("an upsert during snapshot write is queued after the snapshot", async () => {
  const registry = new Registry();
  const delivered: ServerEvent[] = [];
  let aborted = false;
  let abort: (() => void) | null = null;
  let writes = 0;

  await streamRegistryEvents(registry, {
    get aborted() {
      return aborted;
    },
    onAbort(callback) {
      abort = callback;
    },
    async writeSSE(message) {
      delivered.push(parse(message.data));
      writes += 1;
      if (writes === 1) registry.upsertRestoringSession(row);
      else {
        aborted = true;
        abort?.();
      }
    },
  });

  assert.equal(delivered[0]?.type, "snapshot");
  assert.deepEqual(
    delivered.slice(1),
    [{ type: "restoring_session_upsert", session: row }],
  );
  assert.equal(registry.listenerCount("event"), 0, "abort unsubscribes the Registry listener");
});

test("a remove during snapshot write cannot leave the snapshotted row visible", async () => {
  const registry = new Registry();
  registry.upsertRestoringSession(row);
  const delivered: ServerEvent[] = [];
  let aborted = false;
  let abort: (() => void) | null = null;
  let writes = 0;

  await streamRegistryEvents(registry, {
    get aborted() {
      return aborted;
    },
    onAbort(callback) {
      abort = callback;
    },
    async writeSSE(message) {
      delivered.push(parse(message.data));
      writes += 1;
      if (writes === 1) registry.removeRestoringSession(row.id);
      else {
        aborted = true;
        abort?.();
        abort?.();
      }
    },
  });

  const snapshot = delivered[0];
  assert.equal(snapshot?.type, "snapshot");
  if (snapshot?.type === "snapshot") assert.deepEqual(snapshot.restoringSessions, [row]);
  assert.deepEqual(delivered.at(-1), { type: "restoring_session_remove", id: row.id });
  assert.equal(registry.listenerCount("event"), 0, "repeated abort cleanup remains exact");
});
