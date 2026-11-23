import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stacked pull requests over a database written before it existed. The `tasks` and
// `inspector_prs` tables gain nullable columns through `addColumn`, an edge stored without any
// stack field reads as "inherit, unstamped", and a pre-phase pull request has no lineage - so
// neither stacking gate can ever touch it. Also pinned here: the settings snapshot keeps an
// unchosen `stacking` absent, and a PR packet for an unstacked task is byte-identical.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-migration-"));
process.env.MISSION_HOME = home;

function seedPrePhaseDb(): void {
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL, kind TEXT NOT NULL,
      agent TEXT NOT NULL, priority TEXT, labels TEXT, dependencies TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, model TEXT, effort TEXT, workflow_id TEXT,
      source_id TEXT, external_id TEXT, source_url TEXT, repo_root TEXT NOT NULL,
      worktree_path TEXT, branch TEXT, provider TEXT, home_name TEXT,
      terminal_resource_id TEXT, session_id TEXT, schedule_id TEXT,
      schedule_occurrence_id TEXT, scheduled_for INTEGER, status TEXT NOT NULL,
      outcome TEXT, outcome_url TEXT, error TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, dispatched_at INTEGER, completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS inspector_prs (
      key TEXT PRIMARY KEY, url TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, repo_root TEXT, cwd TEXT, session_id TEXT, source TEXT NOT NULL,
      state TEXT NOT NULL, head_sha TEXT, review_posture TEXT, round INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
      last_fail_kind TEXT, next_attempt_at INTEGER, last_attempt_sha TEXT, merged_at INTEGER,
      merge_block TEXT, observed_head_sha TEXT, observed_state TEXT, observed_at INTEGER,
      head_ref_name TEXT, title TEXT, adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const legacyEdge = JSON.stringify([{
    type: "task", taskId: "parent", title: "Phase 1", sessionId: null, episodeId: null,
    agentSessionId: null, branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null,
  }]);
  raw.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, dependencies, repo_root, status, created_at, updated_at)
     VALUES ('child', 'Phase 2', 'do it', 'ship', 'claude', ?, '/repo', 'backlog', 1, 1)`,
  ).run(legacyEdge);
  raw.prepare(
    `INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
     VALUES ('parent', 'Phase 1', 'do it', 'ship', 'claude', '/repo', 'running', 1, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO inspector_prs (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
       head_sha, review_posture, round, adopted_at, updated_at)
     VALUES ('acme/repo#5', 'https://github.com/acme/repo/pull/5', 'acme', 'repo', 5, '/repo', '/repo',
       's1', 'hook', 'open', 'reviewed', 'live', 1, 1, 1)`,
  ).run();
  raw.close();
}

seedPrePhaseDb();

const { openDb, getTask: getDurableTask, getInspectorPr, recordInspectorPrLineage, updateInspectorPr } = await import("../src/server/db.ts");
const { declaredBlockers } = await import("../src/shared/backlog.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { logicalConfigValue, settingPayloadForEntry, mergeSettingPayload } = await import("../src/server/settings-backups/config-registry.ts");
const { setShippingConfig, getShippingConfig } = await import("../src/server/shipping/config.ts");
const { renderSessionAction, renderPrHandoff } = await import("../src/server/workflows/feedback.ts");
after(() => rmSync(home, { recursive: true, force: true }));
openDb();

test("a pre-phase task reads as unstacked, and its stored edge as inherit-and-unstamped", () => {
  const child = getDurableTask("child")!;
  const parent = getDurableTask("parent")!;
  assert.deepEqual(
    [child.stackParentTaskId, child.stackBaseBranch, child.stackBaseSha, child.stackPrUrl],
    [null, null, null, null],
  );
  const edge = child.dependencies[0]!;
  if (edge.type !== "task") throw new Error("expected a task edge");
  assert.equal(edge.mode, undefined, "an absent mode means inherit");
  assert.equal("stackReadyAt" in edge, false, "an unstamped edge carries no stamp fields at all");
  // So it blocks exactly as before.
  assert.deepEqual(declaredBlockers(child, [child, parent]).map((b) => b.taskId), ["parent"]);
});

test("a pre-phase pull request row has no lineage and no recorded base, and can gain lineage once", () => {
  const row = getInspectorPr("acme/repo#5")!;
  assert.equal(row.stack, null);
  assert.equal(row.baseRefName, null);
  assert.equal(row.reviewedBaseRef, null);
  updateInspectorPr("acme/repo#5", { baseRefName: "main" }, 2);
  assert.equal(getInspectorPr("acme/repo#5")!.baseRefName, "main");
  assert.equal(recordInspectorPrLineage("acme/repo#5", {
    taskId: "child", episode: "ep1", adoptedAt: 3, parentPrUrl: "https://github.com/acme/repo/pull/4",
    baseSha: "c".repeat(40), history: [],
  }), true);
  assert.equal(getInspectorPr("acme/repo#5")!.stack?.parentPrUrl, "https://github.com/acme/repo/pull/4");
  assert.equal(recordInspectorPrLineage("acme/repo#5", {
    taskId: "child", episode: "ep1", adoptedAt: 4, parentPrUrl: "https://github.com/acme/repo/pull/9",
    baseSha: null, history: [],
  }), false, "lineage is written once");
});

test("a settings snapshot keeps an unchosen stacking value absent through a round trip", () => {
  setShippingConfig({ soakMinutes: 12 });
  const entry = APP_CONFIG_ENTRIES.shipping;
  const payload = settingPayloadForEntry(entry, logicalConfigValue(entry)) as Record<string, unknown>;
  assert.equal("stacking" in payload, false);
  assert.equal(payload.maxStackDepth, 3);
  const restored = mergeSettingPayload(entry, getShippingConfig(), payload) as Record<string, unknown>;
  assert.equal(restored.stacking, undefined);
  // An explicit choice is captured and restored.
  setShippingConfig({ stacking: "stack" });
  const chosen = settingPayloadForEntry(entry, logicalConfigValue(entry)) as Record<string, unknown>;
  assert.equal(chosen.stacking, "stack");
});

test("a PR packet carries the stacked base only when one is given", () => {
  const base = {
    origin: { kind: "run" as const, workflowName: "W", workflowVersion: 1, runId: "r1", repoRoot: null },
    actionName: "Pull request", promptMarkdown: "Open it.", skillCommand: null, workflowEvidence: false,
    pullRequestPolicy: true,
  };
  const plain = renderSessionAction(base);
  const nulled = renderSessionAction({ ...base, stackInstruction: null });
  assert.equal(plain.ok && nulled.ok && plain.payload === nulled.payload, true, "unstacked packets are byte-identical");
  const stacked = renderSessionAction({ ...base, stackInstruction: "## Stacked pull request\nOpen with `gh pr create --base feat/a`." });
  assert.match(stacked.ok ? stacked.payload : "", /--base feat\/a/);
  const handoff = renderPrHandoff({
    workflowName: "W", workflowVersion: 1, runId: "r1", originalGoal: "g", skillCommand: "/pr",
    workflowEvidence: false, repoRoot: null, stackInstruction: "## Stacked pull request\nOpen with `--base feat/a`.",
  });
  assert.match(handoff.payload, /--base feat\/a/);
});
