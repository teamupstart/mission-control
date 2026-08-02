import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A reviewed SHA written by an older build has no trustworthy record of whether its
// review ran live. Seed that exact schema and make the production migration prove it
// reads fail-closed instead of retroactively licensing the review to merge.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-posture-migrate-"));
process.env.MISSION_HOME = home;

const raw = new DatabaseSync(join(home, "harness.db"));
raw.exec(`
  CREATE TABLE inspector_prs (
    key TEXT PRIMARY KEY, url TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
    number INTEGER NOT NULL, repo_root TEXT, cwd TEXT, session_id TEXT,
    source TEXT NOT NULL, state TEXT NOT NULL, head_sha TEXT,
    round INTEGER NOT NULL DEFAULT 0, last_reviewed_at INTEGER, last_error TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0, last_fail_kind TEXT, next_attempt_at INTEGER,
    last_attempt_sha TEXT, merged_at INTEGER, merge_block TEXT,
    adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO inspector_prs
    (key, url, owner, repo, number, source, state, head_sha, round,
     adopted_at, updated_at)
  VALUES
    ('mancej/ai-harness#146', 'https://github.com/mancej/ai-harness/pull/146',
     'mancej', 'ai-harness', 146, 'retired-provenance', 'open', 'abc', 1, 1, 1);
`);
raw.close();

const { getInspectorPr, updateInspectorPr } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("legacy reviewed heads gain nullable posture and cannot count as live", () => {
  const legacy = getInspectorPr("mancej/ai-harness#146");
  assert.equal(legacy?.headSha, "abc");
  assert.equal(legacy?.source, "legacy");
  assert.equal(legacy?.reviewPosture, null);
});

test("a subsequent live review can persist its posture", () => {
  updateInspectorPr("mancej/ai-harness#146", { reviewPosture: "live" }, 2);
  assert.equal(getInspectorPr("mancej/ai-harness#146")?.reviewPosture, "live");
});
