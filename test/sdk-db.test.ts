import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: an embedded session is the one kind of session the OS cannot rebuild.
// Its row is the ONLY record that its harness-native thread id, its checkout and the task it
// is running belong together, so a schema that does not reach an existing database is a
// feature that works on a fresh install and loses every session on an upgraded one.
//
// The database here is deliberately an UPGRADED one, seeded the way `schedule-db.test.ts`
// seeds its own and for the same reason: a fresh-schema test would pass with the whole
// CREATE deleted from the wrong side of `migrate()`. It is a new table, so it needs no
// `addColumn` - but proving that on a pre-feature FILE is what makes the claim worth
// anything.
//
// The second half is the persisted-enum doctrine: a status this build cannot read must come
// back `null`, never the nearest thing we do know, and the restore sweep must leave such a
// row alone rather than failing a session a newer daemon could resume.

const home = mkdtempSync(join(tmpdir(), "mission-sdk-db-"));
// MISSION_HOME *is* the state dir, so the db lands at <home>/harness.db - the file db.ts
// opens below. Set before importing anything that resolves it.
process.env.MISSION_HOME = home;

/** A database that predates embedded sessions: real tables, real rows, no `sdk_sessions`. */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  raw.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`).run(
    "ui",
    "{}",
    1,
  );
  const tables = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sdk_sessions'`)
    .all();
  assert.equal(tables.length, 0, "the seed must not already have the table under test");
  raw.close();
}

seedPreFeatureDb();

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const {
  SDK_SESSION_STATUSES,
  getSdkSession,
  listSdkSessions,
  recordSdkSessionBinding,
  sdkSessionIsLive,
  setSdkSessionStatus,
  upsertSdkSession,
} = await import("../src/server/sdk/store.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();

test("the table reaches a database that already had rows", () => {
  const cols = db.prepare(`PRAGMA table_info(sdk_sessions)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  assert.deepEqual(
    cols.map((c) => c.name),
    [
      "id",
      "agent",
      "agent_session_id",
      "cwd",
      "task_id",
      "model",
      "effort",
      "permission_mode",
      "status",
      "created_at",
      "updated_at",
    ],
  );
  // The id is the registry's map key as well as this primary key, which is what lets a
  // restored row register the same card instead of a second one. On a non-STRICT rowid table
  // SQLite does not imply NOT NULL from PRIMARY KEY, so it is declared - the same reason
  // every TEXT PRIMARY KEY in the ensemble family says it out loud.
  const notNull = new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
  for (const required of ["id", "agent", "cwd", "status", "created_at", "updated_at"]) {
    assert.ok(notNull.has(required), `${required} must be NOT NULL`);
  }
  // The pre-feature row survived: this is an upgrade, not a rebuild.
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM app_config`).get() as { n: number }).n,
    1,
  );
});

test("a row round-trips, and the id is upserted rather than duplicated", () => {
  upsertSdkSession(
    {
      id: "sdk:aaa",
      agent: "claude",
      agentSessionId: null,
      cwd: "/wt/one",
      taskId: "task-1",
      model: "claude-opus-5",
      effort: "high",
      permissionMode: "auto",
      status: "starting",
    },
    5_000,
  );
  const row = getSdkSession("sdk:aaa");
  assert.equal(row?.agent, "claude");
  assert.equal(row?.taskId, "task-1");
  assert.equal(row?.effort, "high");
  assert.equal(row?.permissionMode, "auto");
  assert.equal(row?.status, "starting");
  assert.equal(row?.createdAt, 5_000);

  recordSdkSessionBinding("sdk:aaa", "agent-xyz", "actual-model", 6_000);
  assert.equal(getSdkSession("sdk:aaa")?.agentSessionId, "agent-xyz");
  assert.equal(getSdkSession("sdk:aaa")?.model, "actual-model");
  assert.equal(getSdkSession("sdk:aaa")?.status, "running");

  // A resume after a restart is the SAME session continuing, so it must land on the same
  // row - two rows for one conversation would give the next restart two things to resume.
  upsertSdkSession(
    {
      id: "sdk:aaa",
      agent: "claude",
      agentSessionId: "agent-xyz",
      cwd: "/wt/one",
      taskId: "task-1",
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
    },
    7_000,
  );
  assert.equal(listSdkSessions().filter((r) => r.id === "sdk:aaa").length, 1);
  assert.equal(getSdkSession("sdk:aaa")?.createdAt, 5_000, "created_at is not rewritten");
});

test("a status this build cannot read is null, never the nearest known one", () => {
  // Exactly what a row written by a NEWER build looks like. It still LOADS - a session
  // nobody can see is one nobody can clean up - and reports what it could not read.
  db.prepare(
    `INSERT INTO sdk_sessions (id, agent, cwd, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("sdk:future", "claude", "/wt/future", "hibernating", 1, 1);
  const row = getSdkSession("sdk:future")!;
  assert.equal(row.status, null);
  assert.equal(row.statusRaw, "hibernating");
  // And "unreadable" is not "live": the conservative act is to leave it for a build that
  // knows what it means, not to fail a session that may still be resumable.
  assert.equal(sdkSessionIsLive(row), false);

  // Same doctrine for the agent, which is persisted from a closed list of its own.
  db.prepare(
    `INSERT INTO sdk_sessions (id, agent, cwd, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("sdk:alien", "some-new-harness", "/wt/alien", "running", 1, 1);
  assert.equal(getSdkSession("sdk:alien")?.agent, null);
});

test("the status vocabulary is what the live check is built from", () => {
  // Append-only, because these strings are in operators' databases. The point of asserting
  // the tuple is that a RENAME reads as a fresh set here rather than as a migration - and
  // that an APPEND (which is allowed, and which `suspended` was) is a deliberate edit here
  // rather than something that slipped in.
  assert.deepEqual(
    [...SDK_SESSION_STATUSES],
    ["starting", "running", "exited", "failed", "suspended"],
  );
  for (const status of SDK_SESSION_STATUSES) {
    upsertSdkSession(
      {
        id: `sdk:st-${status}`,
        agent: "claude",
        agentSessionId: null,
        cwd: "/wt/st",
        taskId: null,
        model: null,
        effort: null,
        permissionMode: null,
        status,
      },
      1,
    );
    assert.equal(
      sdkSessionIsLive(getSdkSession(`sdk:st-${status}`)!),
      // `suspended` is live for the reason it exists: WE stopped it on the way down, and a
      // restart owes it a resume. Reading it as settled is how a clean restart reclaims the
      // worktree of work that was merely interrupted.
      status === "starting" || status === "running" || status === "suspended",
      `${status} liveness`,
    );
  }
});

test("restore fails a row nothing can resume, and leaves an unreadable one alone", async () => {
  // `sdk:aaa` has a binding, so it would be resumable if its harness could still be
  // launched. Point it at an agent id this build does not know instead - the same shape as
  // a driver that was removed - so `restore` exercises its refusal path without this test
  // ever spawning a real agent. (`sdk:alien` from the previous case is that row.)
  setSdkSessionStatus("sdk:alien", "running", 8_000);
  await new SdkSupervisor(new Registry()).restore();
  // A row nothing can resume is FAILED, which is what makes the task it was running settle
  // visibly through the ordinary path instead of sitting `running` for ever with no session
  // anyone can see.
  assert.equal(getSdkSession("sdk:alien")?.status, "failed");
  // Untouched, for the doctrine above: this row is a newer build's business.
  assert.equal(getSdkSession("sdk:future")?.statusRaw, "hibernating");
  // And an already-settled row is not rewritten.
  assert.equal(getSdkSession("sdk:st-exited")?.status, "exited");
});
