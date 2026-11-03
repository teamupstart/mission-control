import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-dependency-history-migration-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb, historicalTaskWorkEpisodeBindingsForTask } = await import("../src/server/db.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

test("upgrading historical bindings preserves evidence without inventing an ownership end", () => {
  const db = openDb();
  db.exec(`ALTER TABLE historical_task_work_episode_bindings DROP COLUMN ended_at;
    ALTER TABLE historical_task_work_episode_bindings DROP COLUMN work_head_sha;
    ALTER TABLE task_work_episode_bindings DROP COLUMN work_head_sha;
    INSERT INTO historical_task_work_episode_bindings
      (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, bound_at, updated_at)
    VALUES ('source', 'earlier', 'session', 'agent', 'feat/reused', NULL, NULL, NULL, 100, 200)`);
  closeDb();
  openDb();
  const [binding] = historicalTaskWorkEpisodeBindingsForTask("source");
  assert.equal(binding?.endedAt, null, "updated_at is not an ownership end and must not be backfilled as one");
  assert.equal(binding?.workHeadSha, null, "old rows cannot invent commit evidence");
  assert.equal(binding?.branch, "feat/reused");
  assert.equal(binding?.boundAt, 100);
  closeDb();
  openDb();
  assert.deepEqual(historicalTaskWorkEpisodeBindingsForTask("source"), [binding], "reopening is idempotent");
});
