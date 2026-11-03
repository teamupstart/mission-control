import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-dependency-history-migration-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb, historicalTaskWorkEpisodeBindingsForTask } = await import("../src/server/db.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

for (const fromVersion of [14, 15, 16]) {
  test(`upgrading version ${fromVersion} preserves evidence without inventing an ownership end`, () => {
    const backupRoot = join(home, "backups", "database");
    rmSync(backupRoot, { recursive: true, force: true });
    const db = openDb();
    db.exec(`ALTER TABLE historical_task_work_episode_bindings DROP COLUMN ended_at;
      ALTER TABLE historical_task_work_episode_bindings DROP COLUMN work_head_sha;
      ALTER TABLE task_work_episode_bindings DROP COLUMN work_head_sha;
      ALTER TABLE task_work_episode_bindings DROP COLUMN repo_changes;
      ALTER TABLE historical_task_work_episode_bindings DROP COLUMN repo_changes;
      PRAGMA user_version = ${fromVersion};
      INSERT OR REPLACE INTO historical_task_work_episode_bindings
        (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, bound_at, updated_at)
      VALUES ('source', 'earlier', 'session', 'agent', 'feat/reused', NULL, NULL, NULL, 100, 200)`);
    closeDb();
    const migrated = openDb();
    const backups = existsSync(backupRoot) ? readdirSync(backupRoot).filter(name => name.startsWith("pre-migration-")) : [];
    assert.equal(backups.length, 1, `version ${fromVersion} must get a recovery point before adding the binding columns`);
    const recovery = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
    try {
      assert.equal(recovery.prepare("PRAGMA user_version").get()!.user_version, fromVersion);
      const columns = recovery.prepare("PRAGMA table_info(historical_task_work_episode_bindings)").all();
      assert.ok(!columns.some(column => column.name === "ended_at" || column.name === "work_head_sha" || column.name === "repo_changes"));
      assert.equal(recovery.prepare("SELECT branch FROM historical_task_work_episode_bindings WHERE task_id = 'source'").get()!.branch, "feat/reused");
    } finally { recovery.close(); }
    assert.ok(Number(migrated.prepare("PRAGMA user_version").get()!.user_version) > fromVersion);
    const [binding] = historicalTaskWorkEpisodeBindingsForTask("source");
    assert.equal(binding?.endedAt, null, "updated_at is not an ownership end and must not be backfilled as one");
    assert.equal(binding?.repoChanges, null);
    assert.equal(binding?.workHeadSha, null, "old rows cannot invent commit evidence");
    assert.equal(binding?.branch, "feat/reused");
    assert.equal(binding?.boundAt, 100);
    closeDb();
    openDb();
    assert.deepEqual(historicalTaskWorkEpisodeBindingsForTask("source"), [binding], "reopening is idempotent");
    assert.deepEqual(readdirSync(backupRoot).filter(name => name.startsWith("pre-migration-")), backups);
  });
}
