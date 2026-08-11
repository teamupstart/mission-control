import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The per-repo pull request upgrade path, seeded as an existing install's database actually
// looks and then opened by db.ts on the code path production takes.
//
// `work_episode_prs` is a table an old database has never heard of, so what has to survive is
// not an ALTER but every READ of it working on the tick after the upgrade with no rows in it:
// the projection onto `Task.extraRepos`, the poll harvest, and the merge stamp all query it
// unconditionally, and a single-repo install will have it empty for ever.
//
// The seeded database also carries a real episode with a real pull request on the SCALAR
// columns, because the load-bearing compatibility claim is not about the new table at all - it
// is that the primary repo's pull request still lives where it always lived, and that the
// merge stamp still reaches it now that a fourth statement runs in the same transaction.

const home = mkdtempSync(join(tmpdir(), "mission-multipr-migrate-"));
process.env.MISSION_HOME = home;

/**
 * A pre-feature database: the episode tables as they shipped, with no `work_episode_prs`.
 *
 * Written out in full rather than trimmed to the interesting columns, because the point of
 * the fixture is that it is a database `openDb()` has to accept as it finds it.
 */
function seedPreFeatureDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS session_work_episodes (
      session_id       TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL UNIQUE,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      prompted_at      INTEGER,
      awaiting_agent_rebind INTEGER NOT NULL DEFAULT 0,
      rebind_from_transcript_path TEXT,
      started_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_work_episode_bindings (
      task_id          TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      bound_at         INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
  raw
    .prepare(
      `INSERT INTO session_work_episodes
         (session_id, episode_id, agent_session_id, branch, pr_url, pr_head_sha, started_at, updated_at)
       VALUES ('sess-1', 'ep-1', 'agent-1', 'harness/thing-abc123', 'https://github.com/o/r/pull/9', 'sha', 1, 1)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha, bound_at, updated_at)
       VALUES ('before-multi-pr', 'ep-1', 'sess-1', 'agent-1', 'harness/thing-abc123', 'https://github.com/o/r/pull/9', 'sha', 1, 1)`,
    )
    .run();
  raw.close();
}

seedPreFeatureDb();

const {
  openDb,
  markWorkEpisodeMerged,
  primaryRepoPrForTask,
  recordWorkEpisodeRepoPr,
  taskReposFor,
  workEpisodeRepoPrsForTask,
} = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("a pre-feature database still opens, and gains the per-repo pull request table", () => {
  const d = openDb();
  const columns = (
    d.prepare(`PRAGMA table_info(work_episode_prs)`).all() as unknown as Array<{ name: string }>
  ).map((c) => c.name);
  assert.deepEqual(
    columns.sort(),
    [
      "episode_id",
      "merged_at",
      "pr_head_sha",
      "pr_state",
      "pr_url",
      "repo_root",
      "session_id",
      "task_id",
      "updated_at",
    ],
    "work_episode_prs arrives with exactly the columns later phases were promised",
  );
  const pk = (
    d.prepare(`PRAGMA table_info(work_episode_prs)`).all() as unknown as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  assert.deepEqual(pk, ["episode_id", "repo_root"], "one pull request per repo per episode");
});

test("every read of the new table works with no rows in it", () => {
  // The failure that would matter on an upgraded single-repo install: not a missing column,
  // but a projection or a harvest that throws the first time anything asks.
  assert.deepEqual(workEpisodeRepoPrsForTask("before-multi-pr"), []);
  assert.deepEqual(taskReposFor("before-multi-pr"), []);
});

test("the primary repo's pull request is still read from where it always lived", () => {
  const primary = primaryRepoPrForTask("before-multi-pr");
  assert.deepEqual(primary, {
    prUrl: "https://github.com/o/r/pull/9",
    prState: "open",
    mergedAt: null,
  });

  // And the merge stamp still reaches it, now that the same transaction also touches the new
  // table. A single-repo task has no row there, so the fourth statement must change nothing
  // and must not stop the other three counting.
  assert.equal(
    markWorkEpisodeMerged("sess-1", "ep-1", "https://github.com/o/r/pull/9", 4_000),
    true,
  );
  assert.equal(primaryRepoPrForTask("before-multi-pr").mergedAt, 4_000);
  assert.equal(primaryRepoPrForTask("before-multi-pr").prState, "merged");
});

test("a secondary repo's pull request lands in the new table and merges there", () => {
  const url = "https://github.com/o/other/pull/11";
  assert.equal(
    recordWorkEpisodeRepoPr(
      {
        episodeId: "ep-1",
        repoRoot: "/other",
        sessionId: "sess-1",
        taskId: "before-multi-pr",
        prUrl: url,
        prState: "open",
        prHeadSha: "extra-sha",
      },
      2_000,
    ),
    true,
  );
  // A different url for the same repo on the same episode is refused, exactly as the scalar
  // guard refuses a second primary pull request.
  assert.equal(
    recordWorkEpisodeRepoPr(
      {
        episodeId: "ep-1",
        repoRoot: "/other",
        sessionId: "sess-1",
        taskId: "before-multi-pr",
        prUrl: "https://github.com/o/other/pull/12",
        prState: "open",
        prHeadSha: "extra-sha",
      },
      3_000,
    ),
    false,
  );

  assert.equal(markWorkEpisodeMerged("sess-1", "ep-1", url, 6_000), true);
  const rows = workEpisodeRepoPrsForTask("before-multi-pr");
  assert.deepEqual(
    rows.map((r) => [r.repoRoot, r.prUrl, r.prState, r.mergedAt]),
    [["/other", url, "merged", 6_000]],
  );
  // The primary's own record is untouched by any of it - one owner per repo.
  assert.equal(primaryRepoPrForTask("before-multi-pr").prUrl, "https://github.com/o/r/pull/9");
});
