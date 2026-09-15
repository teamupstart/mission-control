import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The late-delivery fixture Phase 3 owes, and the boundary it must not cross.
//
// The gap, restated: `invalidateTaskOwnershipInTransaction` DELETES a task's work-episode
// binding without archiving it. After that, `mergedPrFor` reads nothing and
// `taskPrPollTargets` no longer harvests the URL, so a merge landing afterwards is observed by
// nobody. The source explains at length why archiving into
// `historical_task_work_episode_bindings` is not the fix: it would also make the invalidated
// binding eligible to COMPLETE the task and release every dependent, which is a different rule
// about who a merge speaks for.
//
// So the two halves are tested together and against each other. The telemetry observation has
// to survive invalidation AND a restart and produce exactly one late-delivery fact with the
// attribution frozen when the pull request was first seen - while the operational rows, the
// task's status and the dependency edges are asserted UNCHANGED through the real invalidation
// path, not a lookalike.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-pr-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const {
  bindTaskWorkEpisode,
  historicalTaskWorkEpisodeBindings,
  invalidateTaskWorkEpisodeBindings,
  taskWorkEpisodeForTask,
} = await import("../src/server/db.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { runRetentionPass } = await import("../src/server/telemetry/retention.ts");
const {
  prKeyFor,
  recordTelemetryPrMerges,
  retainPrObservation,
  telemetryPrCohortInputs,
  telemetryPrPollTargets,
} = await import("../src/server/telemetry/pr-observations.ts");
const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const PR_URL = "https://github.com/acme/widgets/pull/17";
const SESSION_ID = "proc:ttys004:99:1700000000000";
const TASK_ID = "task-late";
const REPO = "/Users/someone/code/widgets";

beforeEach(() => {
  const d = openDb();
  for (const table of [
    "telemetry_journal",
    "telemetry_source_identities",
    "telemetry_projection_state",
    "telemetry_series",
    "telemetry_batches",
    "telemetry_delivery",
    "telemetry_destinations",
    "telemetry_gaps",
    "telemetry_contexts",
    "telemetry_resources",
    "telemetry_pr_observations",
    "task_work_episode_bindings",
    "historical_task_work_episode_bindings",
  ]) {
    d.exec(`DELETE FROM ${table}`);
  }
  d.exec("DELETE FROM app_config");
  d.exec("DELETE FROM tasks");
});

function enableLocalOnly(): void {
  const applied = setTelemetryConfig({ enabled: true });
  assert.equal(applied.ok, true);
}

test("unknown PR task attribution survives retention, restart and late merge", () => {
  enableLocalOnly();
  const retained = retainPrObservation({
    taskId: TASK_ID, taskKind: "future-kind", repoRoot: REPO, primaryRepoRoot: REPO,
    prUrl: PR_URL, sessionId: SESSION_ID, creationVerified: false, now: 1_000,
  });
  assert.equal(retained.retained, true);
  assert.equal(prFacts()[0]?.task_kind, "unknown");
  closeDb();
  openDb();
  recordTelemetryPrMerges(new Map([[PR_URL, 2_000]]), () => false, 3_000);
  assert.equal(prFacts().at(-1)?.task_kind, "unknown");
  assert.equal(prFacts().at(-1)?.fact, "merged");
  assert.equal(prFacts().at(-1)?.delivery, "late");
});

function prFacts(): Array<Record<string, unknown>> {
  return (
    openDb()
      .prepare(
        `SELECT facts_json, refs_json FROM telemetry_journal
         WHERE name = 'mission.pr.observed' ORDER BY seq`,
      )
      .all() as unknown as Array<{ facts_json: string; refs_json: string }>
  ).map((r) => ({
    ...(JSON.parse(r.facts_json) as Record<string, unknown>),
    refs: JSON.parse(r.refs_json) as Record<string, string>,
  }));
}

/** A task row the real invalidation statement will find and rewrite. */
function seedTask(status = "running"): void {
  openDb()
    .prepare(
      `INSERT INTO tasks (id, title, intent, repo_root, agent, kind, status, session_id, created_at, updated_at)
       VALUES (?, 'ship it', 'ship it', ?, 'claude', 'ship', ?, ?, 1000, 1000)`,
    )
    .run(TASK_ID, REPO, status, SESSION_ID);
}

/** The binding whose deletion is the whole problem. */
function seedBinding(): void {
  bindTaskWorkEpisode({
    taskId: TASK_ID,
    episodeId: "episode-1",
    sessionId: SESSION_ID,
    agentSessionId: "conv-1",
    branch: "feature/widgets",
    prUrl: PR_URL,
    prHeadSha: null,
    mergedAt: null,
    boundAt: 1_000,
    updatedAt: 1_000,
  });
}

/** Retain the observation the way the daemon does: at first verified association. */
function retain(now = 2_000): void {
  const result = retainPrObservation({
    taskId: TASK_ID,
    taskKind: "ship",
    repoRoot: REPO,
    primaryRepoRoot: REPO,
    prUrl: PR_URL,
    sessionId: SESSION_ID,
    creationVerified: false,
    now,
  });
  assert.equal(result.retained, true);
}

// ---- the fixture the phase guide names ----

test("a verified merge survives ownership invalidation and a restart, exactly once", () => {
  enableLocalOnly();
  seedTask();
  seedBinding();
  retain();

  // The association is a live, operational one right now.
  assert.equal(taskWorkEpisodeForTask(TASK_ID)?.prUrl, PR_URL);
  assert.deepEqual(telemetryPrPollTargets(3_000), [PR_URL]);

  // THE REAL INVALIDATION PATH, not a lookalike: the session's work identity rotates.
  const invalidated = invalidateTaskWorkEpisodeBindings(SESSION_ID);
  assert.deepEqual(invalidated, [TASK_ID]);
  assert.equal(taskWorkEpisodeForTask(TASK_ID), null, "the operational binding is gone");
  assert.deepEqual(
    historicalTaskWorkEpisodeBindings(),
    [],
    "and it was deliberately NOT archived - that is the policy this phase must not change",
  );

  // The restart.
  closeDb();
  openDb();

  // The telemetry observation is still there, and still asks to be polled.
  assert.deepEqual(
    telemetryPrPollTargets(4_000),
    [PR_URL],
    "the retained observation outlives both the binding and the process",
  );

  // The merge, arriving through the shared poller long after the session is gone.
  const recorded = recordTelemetryPrMerges(new Map([[PR_URL, 9_000]]), () => false, 10_000);
  assert.equal(recorded, 1);

  const facts = prFacts();
  assert.equal(facts.length, 2, "one association at first sight, one merge");
  assert.equal(facts[0]?.fact, "associated_existing");
  assert.equal(facts[0]?.delivery, "live");
  const merged = facts[1]!;
  assert.equal(merged.fact, "merged");
  assert.equal(merged.delivery, "late");
  // The ORIGINAL attribution, frozen when the pull request was first seen rather than read
  // back from a task that no longer owns anything.
  assert.equal(merged.task_kind, "ship");
  assert.equal(merged.repo_role, "primary");
  assert.equal((merged.refs as Record<string, string>).task_id, TASK_ID);
  assert.equal((merged.refs as Record<string, string>).session_id, SESSION_ID);
  assert.equal((merged.refs as Record<string, string>).pr_key, prKeyFor(PR_URL));

  // The merge's own time, not the poll's. A pull request that landed overnight belongs in the
  // hour it landed.
  const occurred = (
    openDb()
      .prepare(
        `SELECT occurred_at FROM telemetry_journal WHERE name = 'mission.pr.observed' ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { occurred_at: number }
  ).occurred_at;
  assert.equal(occurred, 9_000);

  // The COHORT INPUT Phase 6 reads: one fact, with the attribution it was retained under.
  const cohort = telemetryPrCohortInputs(10_000);
  assert.equal(cohort.length, 1);
  assert.equal(cohort[0]?.taskId, TASK_ID);
  assert.equal(cohort[0]?.mergedAt, 9_000);
  assert.equal(cohort[0]?.sessionId, SESSION_ID);

  // AND THE OPERATIONAL BOUNDARY IS UNCHANGED. This is the half that would be a regression:
  // nothing here may resurrect a binding, upgrade a status or satisfy an edge.
  assert.equal(taskWorkEpisodeForTask(TASK_ID), null);
  assert.deepEqual(historicalTaskWorkEpisodeBindings(), []);
  const task = openDb()
    .prepare(`SELECT status, session_id FROM tasks WHERE id = ?`)
    .get(TASK_ID) as { status: string; session_id: string | null };
  assert.equal(
    task.status,
    "cancelled",
    "the status invalidation wrote, unchanged by the merge observation",
  );
  assert.equal(task.session_id, null);
});

test("a repeated poll result produces exactly one late-delivery fact", () => {
  enableLocalOnly();
  seedTask();
  seedBinding();
  retain();
  invalidateTaskWorkEpisodeBindings(SESSION_ID);

  assert.equal(recordTelemetryPrMerges(new Map([[PR_URL, 9_000]]), () => false, 10_000), 1);
  // The same merge on the next tick, and the one after. The stamp is taken inside the
  // transaction that selected the row, so the second pass finds nothing.
  assert.equal(recordTelemetryPrMerges(new Map([[PR_URL, 9_000]]), () => false, 11_000), 0);
  assert.equal(recordTelemetryPrMerges(new Map([[PR_URL, 9_500]]), () => false, 12_000), 0);
  assert.equal(prFacts().filter((f) => f.fact === "merged").length, 1);

  runProjectionPass();
  const rows = openDb()
    .prepare(
      `SELECT value FROM telemetry_series WHERE instrument = 'mission.pr.observations'
       AND dimensions_json LIKE '%merged%'`,
    )
    .all() as unknown as Array<{ value: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.value, 1);
});

test("a second sighting of the same association is not a second association", () => {
  enableLocalOnly();
  seedTask();
  seedBinding();
  retain(2_000);
  // The poller sees the same pull request again five minutes later. Re-stamping would reset
  // the horizon this row is polled under, and a second fact would double every delivery count.
  const again = retainPrObservation({
    taskId: TASK_ID,
    taskKind: "ship",
    repoRoot: REPO,
    primaryRepoRoot: REPO,
    prUrl: PR_URL,
    sessionId: SESSION_ID,
    creationVerified: false,
    now: 302_000,
  });
  assert.equal(again.retained, false);
  assert.equal(prFacts().length, 1);
  assert.equal(telemetryPrCohortInputs(400_000)[0]?.associatedAt, 2_000);
});

test("a merge still owned operationally is live delivery, not late", () => {
  enableLocalOnly();
  seedTask();
  seedBinding();
  retain();
  // No invalidation: the task still owns the binding, so the operational harvest is what
  // carries this URL and the observation rides along on the same `gh` call.
  recordTelemetryPrMerges(new Map([[PR_URL, 9_000]]), (o) => o.prUrl === PR_URL, 10_000);
  assert.equal(prFacts().at(-1)?.delivery, "live");
});

test("a secondary repository keeps its own role and its own observation", () => {
  enableLocalOnly();
  seedTask();
  retain();
  const secondaryUrl = "https://github.com/acme/tools/pull/3";
  retainPrObservation({
    taskId: TASK_ID,
    taskKind: "ship",
    repoRoot: "/Users/someone/code/tools",
    primaryRepoRoot: REPO,
    prUrl: secondaryUrl,
    sessionId: SESSION_ID,
    creationVerified: false,
    now: 2_500,
  });
  const roles = prFacts().map((f) => f.repo_role);
  assert.deepEqual(roles, ["primary", "secondary"]);
  // Two pull requests, two opaque identities, and no way back to either URL.
  const keys = prFacts().map((f) => (f.refs as Record<string, string>).pr_key);
  assert.equal(new Set(keys).size, 2);
});

// ---- retention and consent ----

test("an association past the late-outcome horizon is swept and counted as a gap", () => {
  enableLocalOnly();
  seedTask();
  retain(1_000);
  const pastHorizon = 1_000 + TELEMETRY_LIMITS.reducerStateRetentionMs + 1;

  // Before the horizon it is still polled for.
  assert.deepEqual(telemetryPrPollTargets(1_000 + 60_000), [PR_URL]);

  const result = runRetentionPass(pastHorizon);
  assert.equal(result.expiredPrObservations, 1);
  assert.deepEqual(telemetryPrPollTargets(pastHorizon), []);
  // "We stopped looking" and "it never merged" are different answers, and the gap is what
  // keeps a cohort able to tell them apart.
  const gap = openDb()
    .prepare(`SELECT detail FROM telemetry_gaps WHERE kind = 'payload_expired'`)
    .get() as { detail: string } | undefined;
  assert.match(gap?.detail ?? "", /late-outcome horizon/);
});

test("capture that is off retains nothing at all", () => {
  // No `enableLocalOnly`. Default-off has to mean the TABLE stays empty, not that a row is
  // written and then filtered on the way out: a retained row holds a pull request URL, which
  // is the daemon's own polling metadata but still a repository nobody consented to observing.
  seedTask();
  seedBinding();
  const result = retainPrObservation({
    taskId: TASK_ID,
    taskKind: "ship",
    repoRoot: REPO,
    primaryRepoRoot: REPO,
    prUrl: PR_URL,
    sessionId: SESSION_ID,
    creationVerified: false,
    now: 2_000,
  });
  assert.equal(result.retained, false);
  assert.equal(
    (openDb().prepare(`SELECT COUNT(*) AS n FROM telemetry_pr_observations`).get() as { n: number }).n,
    0,
    "no URL is stored for an installation that never opted in",
  );
  assert.equal(prFacts().length, 0, "and nothing is captured");
  assert.equal(
    (openDb().prepare(`SELECT COUNT(*) AS n FROM app_config`).get() as { n: number }).n,
    0,
    "and no telemetry identity is minted",
  );
  // The poller is not asked to spend a transaction on it either.
  assert.deepEqual(telemetryPrPollTargets(3_000), []);
});

// ---- the exported record carries no URL ----

test("no pull request URL, repository path or branch reaches an exported record", () => {
  enableLocalOnly();
  seedTask();
  seedBinding();
  retain();
  recordTelemetryPrMerges(new Map([[PR_URL, 9_000]]), () => false, 10_000);

  const everything = (
    openDb()
      .prepare(`SELECT facts_json, refs_json FROM telemetry_journal`)
      .all() as unknown as Array<{ facts_json: string; refs_json: string }>
  )
    .map((r) => `${r.facts_json} ${r.refs_json}`)
    .join(" ");
  for (const sentinel of [PR_URL, REPO, "widgets", "acme", "feature/widgets"]) {
    assert.ok(!everything.includes(sentinel), `${sentinel} must not appear in a captured record`);
  }
  // The URL lives exactly one place: the daemon's own polling metadata.
  const stored = openDb()
    .prepare(`SELECT pr_url FROM telemetry_pr_observations`)
    .get() as { pr_url: string };
  assert.equal(stored.pr_url, PR_URL);
});

// ---- the shared poller, and the authority split inside it ----

const { pollAndReconcilePrs } = await import("../src/server/pr.ts");

/** Everything `pollAndReconcilePrs` asks of a Registry, and nothing else. */
function stubRegistry(operational: string[]) {
  const merges: Array<Map<string, number>> = [];
  return {
    merges,
    prPollTargets: () => [],
    extraRepoPrPollTargets: () => [],
    worktreeHeadTargets: () => [],
    dependencyPrPollTargets: () => [],
    taskPrPollTargets: () => operational,
    recordWorktreeHeads: () => {},
    reconcilePrs: () => {},
    reconcileRepoPrs: () => {},
    reconcilePrMerges: (m: Map<string, number>) => merges.push(new Map(m)),
  };
}

test("a telemetry-only URL is polled but never reaches operational reconciliation", async () => {
  enableLocalOnly();
  seedTask();
  retain();

  const registry = stubRegistry([]);
  const asked: string[] = [];
  await pollAndReconcilePrs(
    registry as never,
    async () => null,
    async (url) => {
      asked.push(url);
      return { state: "merged" as const, mergedAt: 9_000 };
    },
    undefined,
    10_000,
    async () => null,
  );

  // It WAS asked about - that is the whole point of sharing the cadence rather than adding a
  // third timer that spends a second `gh` call on the same pull request.
  assert.deepEqual(asked, [PR_URL]);
  // And it did NOT reach `reconcilePrMerges`, which is what could complete a task and release
  // its dependents. An observation-only result has authority over nothing.
  assert.equal(registry.merges.length, 1);
  assert.equal(registry.merges[0]?.size, 0, "no operational merge was reconciled");
  // The telemetry fact was recorded, as late delivery.
  assert.equal(prFacts().at(-1)?.fact, "merged");
  assert.equal(prFacts().at(-1)?.delivery, "late");
});

test("a URL with BOTH reasons keeps its operational eligibility unchanged", async () => {
  enableLocalOnly();
  seedTask();
  retain();

  const registry = stubRegistry([PR_URL]);
  const asked: string[] = [];
  await pollAndReconcilePrs(
    registry as never,
    async () => null,
    async (url) => {
      asked.push(url);
      return { state: "merged" as const, mergedAt: 9_000 };
    },
    undefined,
    10_000,
    async () => null,
  );

  // Deduplicated into ONE `gh` call despite two harvests wanting it.
  assert.deepEqual(asked, [PR_URL]);
  // And the operational reconciliation sees it exactly as it did before this phase existed.
  assert.equal(registry.merges.length, 1);
  assert.deepEqual([...(registry.merges[0] ?? [])], [[PR_URL, 9_000]]);
  assert.equal(prFacts().at(-1)?.delivery, "live");
});
