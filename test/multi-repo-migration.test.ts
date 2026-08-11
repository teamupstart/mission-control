import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The multi-repo upgrade path, seeded as an existing install's database actually looks and
// then opened by db.ts on the same code path production takes.
//
// Two things have to survive it, and they fail differently:
//
//  - `tasks` gains `base_sha`. An ALTER on a table holding real rows, so a mistake here
//    does not degrade a feature, it stops the daemon opening at all.
//  - `task_repos` is a table an old database has never heard of. Every read of it has to
//    work on the tick after the upgrade, with no rows, and report a single-repo task as
//    what it is - a task with an empty `extraRepos` - rather than throwing.
//
// The second is why this test loads the seeded task rather than only checking the schema:
// `extraRepos` reaching a consumer as `undefined` is the failure that would matter, and
// it is invisible to a `PRAGMA table_info` assertion.

// MISSION_HOME *is* the state dir (harness-runtime's stateDir()), so the db lands at
// <home>/harness.db - the same file db.ts will open below.
const home = mkdtempSync(join(tmpdir(), "mission-multirepo-migrate-"));
process.env.MISSION_HOME = home;

/**
 * A pre-feature `tasks` table: every column this build reads EXCEPT `base_sha`, and no
 * `task_repos` table at all.
 *
 * Written out in full rather than trimmed to the interesting columns, because the point of
 * the fixture is that it is a database `openDb()` has to accept as it finds it.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      priority      TEXT,
      labels        TEXT,
      dependencies  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      model         TEXT,
      effort        TEXT,
      workflow_id   TEXT,
      source_id     TEXT,
      external_id   TEXT,
      source_url    TEXT,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      home_name     TEXT,
      terminal_resource_id TEXT,
      session_id    TEXT,
      schedule_id            TEXT,
      schedule_occurrence_id TEXT,
      scheduled_for          INTEGER,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
  `);
  raw
    .prepare(
      `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, worktree_path, branch,
                          provider, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "before-multi-repo",
      "Filed before multi-repo tasks",
      "do the thing",
      "ship",
      "claude",
      "/repo",
      "/wt/before-multi-repo",
      "harness/thing-abc123",
      "git",
      "running",
      1,
      1,
    );
  raw.close();
}

seedPreFeatureDb();

const { openDb, getTask, listTasks, upsertTask, taskReposFor, deleteTask } = await import(
  "../src/server/db.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

test("a pre-feature database still opens, and gains the multi-repo schema", () => {
  const d = openDb();
  const taskColumns = (
    d.prepare(`PRAGMA table_info(tasks)`).all() as unknown as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(taskColumns.includes("base_sha"), "the additive primary-baseline column is added");

  const repoColumns = (
    d.prepare(`PRAGMA table_info(task_repos)`).all() as unknown as Array<{ name: string }>
  ).map((c) => c.name);
  assert.deepEqual(
    repoColumns.sort(),
    ["base_sha", "branch", "position", "provider", "repo_root", "task_id", "worktree_path"],
    "task_repos arrives with exactly the columns later phases were promised",
  );
});

test("the task that was already there loads, as a single-repo task", () => {
  const t = getTask("before-multi-repo");
  assert.ok(t, "the pre-feature row is still readable");
  // The whole point of the additive shape: nothing about this row changed meaning.
  assert.equal(t.repoRoot, "/repo");
  assert.equal(t.worktreePath, "/wt/before-multi-repo");
  assert.equal(t.branch, "harness/thing-abc123");
  assert.equal(t.status, "running");
  // Null, not "": nothing recorded where this branch was cut, and that is a different
  // answer from "it was cut at no commit". Every later rule reads it as unknown.
  assert.equal(t.baseSha, null);
  // An ARRAY on a row written before the table existed - the field a consumer iterates.
  assert.deepEqual(t.extraRepos, []);
  assert.deepEqual(
    listTasks().map((task) => task.extraRepos),
    [[]],
    "the batch reader agrees with the single reader",
  );
});

test("attaching repos to that task writes, reads back in order, and deletes with it", () => {
  const t = getTask("before-multi-repo");
  assert.ok(t);
  upsertTask({
    ...t,
    baseSha: "a".repeat(40),
    extraRepos: [
      {
        repoRoot: "/other",
        worktreePath: "/wt/before-multi-repo-1",
        branch: "harness/thing-abc123",
        provider: "git",
        baseSha: "b".repeat(40),
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
      {
        repoRoot: "/third",
        worktreePath: "/wt/before-multi-repo-2",
        branch: "harness/thing-abc123",
        provider: "treehouse",
        baseSha: "c".repeat(40),
        prUrl: null,
        prState: null,
        mergedAt: null,
      },
    ],
  });

  const reloaded = getTask("before-multi-repo");
  assert.equal(reloaded?.baseSha, "a".repeat(40));
  assert.deepEqual(
    reloaded?.extraRepos.map((e) => [e.repoRoot, e.worktreePath, e.provider, e.baseSha]),
    [
      ["/other", "/wt/before-multi-repo-1", "git", "b".repeat(40)],
      ["/third", "/wt/before-multi-repo-2", "treehouse", "c".repeat(40)],
    ],
    "entries come back in position order, which is their provisioning slot",
  );

  // The write REPLACES rather than merges, so a detached repo actually goes. A stale row
  // here would go on pinning a worktree nothing is using.
  upsertTask({ ...reloaded!, extraRepos: reloaded!.extraRepos.slice(0, 1) });
  assert.deepEqual(taskReposFor("before-multi-repo").map((e) => e.repoRoot), ["/other"]);

  deleteTask("before-multi-repo");
  assert.deepEqual(taskReposFor("before-multi-repo"), [], "child rows die with the task");
});
