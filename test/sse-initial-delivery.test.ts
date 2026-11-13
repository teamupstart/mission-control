import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-sse-initial-"));
process.env.HARNESS_HOME = join(home, "state");

const { Registry } = await import("../src/server/registry.ts");
const { streamRegistryEvents } = await import("../src/server/sse.ts");
const { repoIndexIdentity } = await import("../src/server/repos.ts");
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

test("the snapshot names the current repository index, so a reconnecting window can check its list", async () => {
  const registry = new Registry();
  const delivered: ServerEvent[] = [];
  let aborted = false;
  let abort: (() => void) | null = null;
  await streamRegistryEvents(registry, {
    get aborted() {
      return aborted;
    },
    onAbort(callback) {
      abort = callback;
    },
    async writeSSE(message) {
      delivered.push(parse(message.data));
      aborted = true;
      abort?.();
    },
  });
  const snapshot = delivered[0];
  assert.equal(snapshot?.type, "snapshot");
  assert.equal(snapshot.type === "snapshot" ? snapshot.repoIndexIdentity : undefined, repoIndexIdentity());
  assert.match(repoIndexIdentity(), /^[0-9a-f]{16}$/);
});

test("a snapshot sent while the index config cannot be read names the unknown index, and logs why", async (t) => {
  const { openDb } = await import("../src/server/db.ts");
  const { REPO_INDEX_IDENTITY_UNKNOWN } = await import("../src/shared/repo-index.ts");
  // Valid JSON, wrong shape: the config parse throws, as a corrupt or half-migrated row would.
  openDb().prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('repoIndex', ?)").run('{"directories":"nope"}');
  const warned: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warned.push(String(message));
  });
  try {
    const registry = new Registry();
    const delivered: ServerEvent[] = [];
    let aborted = false;
    let abort: (() => void) | null = null;
    await streamRegistryEvents(registry, {
      get aborted() {
        return aborted;
      },
      onAbort(callback) {
        abort = callback;
      },
      async writeSSE(message) {
        delivered.push(parse(message.data));
        aborted = true;
        abort?.();
      },
    });
    const snapshot = delivered[0];
    assert.equal(snapshot?.type, "snapshot");
    // Never an absent field: a window that missed `repo_index_changed` must still let go.
    assert.equal(snapshot.type === "snapshot" ? snapshot.repoIndexIdentity : undefined, REPO_INDEX_IDENTITY_UNKNOWN);
    assert.ok(warned.some((line) => /\[repos\] could not read the repository index for the event snapshot/.test(line)));
  } finally {
    openDb().exec("DELETE FROM app_config WHERE key = 'repoIndex'");
  }
});
