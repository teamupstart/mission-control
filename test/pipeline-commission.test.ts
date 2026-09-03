import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { EngineerLifecycleEvent, PipelineCommission } from "../src/shared/pipeline.ts";

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-commission-"));
process.env.HARNESS_HOME = join(home, "state");

const {
  MAX_PIPELINE_COMMISSION_EVENTS,
  advancePipelineCommissionEvidence,
  countPipelineCommissionEvents,
  deletePipelineCommissionRow,
  getPipelineCommission,
  loadActiveTasks,
  loadPipelineCommissions,
  openDb,
  upsertTask,
} = await import("../src/server/db.ts");
const {
  appendPipelineCommissionAttempt,
  applyEngineerEvent,
  bindPipelineCommissionAttempt,
  createPipelineCommission,
  parseEngineerEvent,
} = await import("../src/server/pipelines/commissions.ts");
const { ENGINEER_EVENT_LIMITS, MAX_PIPELINE_COMMISSION_ATTEMPTS } = await import(
  "../src/shared/pipeline.ts"
);
const { setPipelinesConfig } = await import("../src/server/pipelines/config.ts");
const { ingestConductorEvents } = await import("../src/server/pipelines/ingest.ts");
const { refreshPipelineCommission, restorePipelineProjection } = await import(
  "../src/server/pipelines/index.ts"
);
const { PIPELINE_PROVIDERS } = await import("../src/server/pipelines/providers.ts");
const { Registry } = await import("../src/server/registry.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const repo = realpathSync(home);
mkdirSync(repo, { recursive: true });

function reset(): void {
  db.exec(`
    DROP TRIGGER IF EXISTS fail_pipeline_commission_claim;
    DROP TRIGGER IF EXISTS fail_pipeline_commission_event;
    DELETE FROM pipeline_commission_events;
    DELETE FROM pipeline_commission_attempts;
    DELETE FROM pipeline_commissions;
    DELETE FROM tasks;
  `);
  setPipelinesConfig({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
  });
}

function task(id: string, repoRoot = repo): void {
  db.prepare(
    `INSERT INTO tasks
       (id, title, intent, kind, agent, repo_root, status, created_at, updated_at)
     VALUES (?, ?, ?, 'ship', 'codex', ?, 'backlog', 1, 1)`,
  ).run(id, `Task ${id}`, `Intent ${id}`, repoRoot);
}

function commission(taskId = "task-1"): PipelineCommission {
  task(taskId);
  const created = createPipelineCommission({
    taskId,
    provider: "ai-conductor",
    repoRoot: repo,
    id: `commission-${taskId}`,
    correlationId: `correlation-${taskId}`,
    launchKey: `launch-${taskId}`,
    now: 1_700_000_000_000,
  });
  return bindPipelineCommissionAttempt({
    commissionId: created.id,
    attempt: 1,
    engineerRunId: `run-${taskId}`,
    providerAttempt: 1,
    attemptKey: `launch-${taskId}`,
    previousEngineerRunId: null,
    now: 1_700_000_000_001,
  });
}

function event(
  type: EngineerLifecycleEvent["type"],
  revision: number,
  extra: Record<string, unknown> = {},
  taskId = "task-1",
): EngineerLifecycleEvent {
  return {
    schemaVersion: 1,
    engineerRunId: `run-${taskId}`,
    correlationId: `correlation-${taskId}`,
    attemptKey: `launch-${taskId}`,
    attempt: 1,
    previousEngineerRunId: null,
    repoRoot: repo,
    revision,
    ts: new Date(1_700_000_000_000 + revision).toISOString(),
    type,
    ...extra,
  } as EngineerLifecycleEvent;
}

test("migration creates one durable commission per task and preserves exact task binding", () => {
  reset();
  const held = commission();
  assert.equal(loadPipelineCommissions().length, 1);
  assert.equal(held.activeAttempt, 1);
  assert.equal(held.attempts[0]?.providerRevision, 0);
  const row = db.prepare(`SELECT pipeline_commission_id FROM tasks WHERE id = 'task-1'`).get() as {
    pipeline_commission_id: string | null;
  };
  assert.equal(row.pipeline_commission_id, held.id);
  assert.throws(
    () =>
      createPipelineCommission({
        taskId: "task-1",
        provider: "ai-conductor",
        repoRoot: repo,
        id: "another",
        correlationId: "another",
        launchKey: "another",
      }),
    /UNIQUE constraint failed/,
  );
  task("wrong-repo", `${repo}/other`);
  assert.throws(
    () =>
      createPipelineCommission({
        taskId: "wrong-repo",
        provider: "ai-conductor",
        repoRoot: repo,
      }),
    /repository does not match/,
  );
});

test("attempt origin and evidence advances persist with compare-and-swap and freeze", () => {
  reset();
  const held = commission();
  assert.equal(held.attempts[0]?.origin, "mission_control");
  assert.equal(held.attempts[0]?.evidenceCommit, null);

  const first = "1".repeat(40);
  const second = "2".repeat(40);
  const losing = "3".repeat(40);
  assert.equal(advancePipelineCommissionEvidence({
    commissionId: held.id,
    attempt: 1,
    previousCommit: null,
    commit: first,
    provenance: "live_validation",
  }), "stored");
  assert.equal(advancePipelineCommissionEvidence({
    commissionId: held.id,
    attempt: 1,
    previousCommit: null,
    commit: losing,
    provenance: "live_validation",
  }), "stale");
  assert.equal(advancePipelineCommissionEvidence({
    commissionId: held.id,
    attempt: 1,
    previousCommit: first,
    commit: second,
    provenance: "live_validation",
  }), "stored");

  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  assert.equal(applyEngineerEvent(event("engineer_spec_handoff", 2, {
    planSlug: "durable-evidence",
    branch: "spec/durable-evidence",
    prUrl: null,
    outcome: "local_commit",
    state: "awaiting_spec_merge",
  })).outcome, "stored");
  const frozen = getPipelineCommission(held.id)?.attempts[0];
  assert.equal(frozen?.evidenceCommit, second);
  assert.equal(frozen?.evidenceCommitProvenance, "live_validation");
  assert.equal(typeof frozen?.evidenceFrozenAt, "number");
  assert.equal(advancePipelineCommissionEvidence({
    commissionId: held.id,
    attempt: 1,
    previousCommit: second,
    commit: losing,
    provenance: "live_validation",
  }), "frozen");
});

test("a handoff without a pinned commit leaves the evidence slot available", () => {
  reset();
  commission();
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  assert.equal(applyEngineerEvent(event("engineer_spec_handoff", 2, {
    planSlug: "late-evidence",
    branch: "spec/late-evidence",
    prUrl: null,
    outcome: "local_commit",
    state: "awaiting_spec_merge",
  })).outcome, "stored");

  const attempt = getPipelineCommission("commission-task-1")?.attempts[0];
  assert.equal(attempt?.evidenceCommit, null);
  assert.equal(attempt?.evidenceFrozenAt, null);
  assert.equal(advancePipelineCommissionEvidence({
    commissionId: "commission-task-1",
    attempt: 1,
    previousCommit: null,
    commit: "4".repeat(40),
    provenance: "legacy_branch_resolution",
    frozenAt: 1_700_000_000_003,
  }), "stored");
});

test("authoring branch and plan slug are stable within one attempt", () => {
  reset();
  commission();
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  assert.equal(applyEngineerEvent(event("engineer_worktree_created", 2, {
    worktreePath: `${repo}/spec-worktree`,
    branch: "spec/stable-identity",
    planSlug: "stable-identity",
  })).outcome, "stored");
  const retained = getPipelineCommission("commission-task-1");
  assert.equal(retained?.authoringBranch, "spec/stable-identity");
  assert.equal(retained?.planSlug, "stable-identity");

  assert.equal(applyEngineerEvent(event("engineer_worktree_created", 3, {
    worktreePath: `${repo}/reused-worktree`,
    branch: "spec/different",
    planSlug: "different",
  })).outcome, "stored");
  const conflicted = getPipelineCommission("commission-task-1");
  assert.equal(conflicted?.lifecycle, "unsupported");
  assert.equal(conflicted?.authoringBranch, "spec/stable-identity");
  assert.equal(conflicted?.planSlug, "stable-identity");
  assert.match(conflicted?.error ?? "", /identity changed/);
});

test("the initial commission and task claim roll back as one transaction", () => {
  reset();
  task("task-1");
  db.exec(`
    CREATE TRIGGER fail_pipeline_commission_claim
    BEFORE UPDATE OF pipeline_commission_id ON tasks
    WHEN NEW.pipeline_commission_id IS NOT NULL
    BEGIN
      SELECT RAISE(FAIL, 'forced task claim failure');
    END;
  `);

  assert.throws(
    () =>
      createPipelineCommission({
        taskId: "task-1",
        provider: "ai-conductor",
        repoRoot: repo,
        id: "commission-task-1",
        correlationId: "correlation-task-1",
        launchKey: "launch-task-1",
      }),
    /forced task claim failure/,
  );

  assert.equal(loadPipelineCommissions().length, 0);
  const attempts = db.prepare(
    `SELECT COUNT(*) AS count FROM pipeline_commission_attempts`,
  ).get() as { count: number };
  const claimed = db.prepare(
    `SELECT pipeline_commission_id FROM tasks WHERE id = 'task-1'`,
  ).get() as { pipeline_commission_id: string | null };
  assert.equal(attempts.count, 0);
  assert.equal(claimed.pipeline_commission_id, null);
});

test("task upserts preserve a commission binding when the in-memory shape predates it", () => {
  reset();
  task("task-1");
  const stale = loadActiveTasks()[0]!;
  delete stale.pipelineCommissionId;
  createPipelineCommission({
    taskId: stale.id,
    provider: "ai-conductor",
    repoRoot: repo,
    id: "commission-task-1",
    correlationId: "correlation-task-1",
    launchKey: "launch-task-1",
  });

  upsertTask({ ...stale, title: "Updated from stale task" });

  const row = db.prepare(`SELECT pipeline_commission_id, title FROM tasks WHERE id = ?`).get(
    stale.id,
  ) as { pipeline_commission_id: string | null; title: string };
  assert.equal(row.pipeline_commission_id, "commission-task-1");
  assert.equal(row.title, "Updated from stale task");
});

test("commission retirement removes its bounded authoring history and task binding", () => {
  reset();
  commission();
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  deletePipelineCommissionRow("commission-task-1");
  assert.equal(getPipelineCommission("commission-task-1"), null);
  assert.equal(countPipelineCommissionEvents("commission-task-1"), 0);
  const row = db.prepare(`SELECT pipeline_commission_id FROM tasks WHERE id = 'task-1'`).get() as {
    pipeline_commission_id: string | null;
  };
  assert.equal(row.pipeline_commission_id, null);
});

test("task retirement atomically removes its commission family and live projection", () => {
  reset();
  const held = commission();
  assert.equal(
    applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome,
    "stored",
  );
  const registry = new Registry();
  registry.initializePipelineCommissions([held]);
  const frames: string[] = [];
  registry.subscribe((message) => frames.push(message.type));

  registry.removeTask("task-1");

  assert.equal(getPipelineCommission(held.id), null);
  assert.equal(countPipelineCommissionEvents(held.id), 0);
  assert.equal(
    Number(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM pipeline_commission_attempts WHERE commission_id = ?`).get(
          held.id,
        ) as { count: number }
      ).count,
    ),
    0,
  );
  assert.equal(db.prepare(`SELECT id FROM tasks WHERE id = ?`).get("task-1"), undefined);
  assert.deepEqual(registry.listPipelineCommissions(), []);
  assert.ok(frames.includes("pipeline_commission_remove"));
});

test("Engineer event field and total byte limits fail closed before persistence", () => {
  reset();
  commission();
  const overlongField = event("engineer_run_created", 1, {
    idea: "x".repeat(ENGINEER_EVENT_LIMITS.textChars + 1),
  });
  assert.equal(applyEngineerEvent(overlongField).outcome, "malformed");

  const oversized = {
    ...event("engineer_run_started", 1),
    type: "engineer_future_observation",
    evidence: "x".repeat(ENGINEER_EVENT_LIMITS.maxBytes),
  };
  assert.deepEqual(parseEngineerEvent(oversized), {
    ok: false,
    code: "oversized",
    error: `Engineer event exceeds ${ENGINEER_EVENT_LIMITS.maxBytes} bytes`,
  });
  assert.equal(applyEngineerEvent(oversized).outcome, "oversized");
  assert.equal(countPipelineCommissionEvents("commission-task-1"), 0);
  assert.equal(getPipelineCommission("commission-task-1")?.attempts[0]?.providerRevision, 0);

  const envelope = (engineerEvent: {
    revision: number;
    engineerRunId: string;
    correlationId: string | null;
    attempt: number;
    attemptKey: string;
  }) => ({
    repo,
    seq: engineerEvent.revision,
    event: engineerEvent,
    engineerRunId: engineerEvent.engineerRunId,
    correlationId: engineerEvent.correlationId,
    engineerAttempt: engineerEvent.attempt,
    attemptKey: engineerEvent.attemptKey,
  });
  const good = event("engineer_run_created", 1, { idea: "bounded" });
  const ingested = ingestConductorEvents(
    `${JSON.stringify(envelope(oversized))}\n${JSON.stringify(envelope(good))}\n`,
  );
  assert.deepEqual(ingested.counts, {
    received: 2,
    stored: 1,
    duplicate: 0,
    malformed: 1,
    unconsented: 0,
  });
  assert.equal(getPipelineCommission("commission-task-1")?.attempts[0]?.providerRevision, 1);
});

test("live and replay ordering converge through one monotonic reducer", () => {
  reset();
  commission();
  const created = event("engineer_run_created", 1, { idea: "Intent task-1" });
  assert.equal(applyEngineerEvent(created).outcome, "stored");
  assert.equal(applyEngineerEvent(created).outcome, "duplicate");
  assert.equal(applyEngineerEvent(event("engineer_run_started", 2)).outcome, "stored");
  assert.equal(
    applyEngineerEvent(
      event("engineer_step_started", 3, {
        step: "architecture_review",
        stepAttempt: 1,
      }),
    ).outcome,
    "stored",
  );
  assert.equal(
    applyEngineerEvent(
      event("engineer_step_completed", 4, {
        step: "architecture_review",
        stepAttempt: 1,
        completion: "accepted_result",
      }),
    ).outcome,
    "stored",
  );
  assert.equal(
    applyEngineerEvent(
      event("engineer_spec_handoff", 5, {
        planSlug: "final-plan",
        branch: "spec/final-plan",
        prUrl: "https://github.com/acme/demo/pull/1",
        outcome: "pr_opened",
        state: "awaiting_spec_merge",
      }),
    ).outcome,
    "stored",
  );
  const held = getPipelineCommission("commission-task-1");
  assert.equal(held?.lifecycle, "awaiting_spec_merge");
  assert.equal(held?.linkedRun?.slug, "final-plan");
  assert.equal(
    held?.steps.find((step) => step.name === "architecture_review")?.state,
    "done",
  );
  const taskRow = db.prepare(
    `SELECT pipeline_provider, pipeline_slug FROM tasks WHERE id = 'task-1'`,
  ).get() as { pipeline_provider: string | null; pipeline_slug: string | null };
  assert.equal(taskRow.pipeline_provider, "ai-conductor");
  assert.equal(taskRow.pipeline_slug, "final-plan");
});

test("recoverable Engineer blockers retain exact provenance and clear on recovery", () => {
  reset();
  commission();
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  assert.equal(applyEngineerEvent(event("engineer_run_started", 2)).outcome, "stored");
  assert.equal(
    applyEngineerEvent(
      event("engineer_step_started", 3, {
        step: "architecture_review",
        stepAttempt: 1,
      }),
    ).outcome,
    "stored",
  );

  const stepReason = "provider credentials expired";
  assert.equal(
    applyEngineerEvent(
      event("engineer_step_failed", 4, {
        step: "architecture_review",
        stepAttempt: 1,
        error: stepReason,
      }),
    ).outcome,
    "stored",
  );
  assert.deepEqual(getPipelineCommission("commission-task-1")?.blocker, {
    kind: "step_failed",
    step: "architecture_review",
    reason: stepReason,
  });

  assert.equal(
    applyEngineerEvent(
      event("engineer_step_retried", 5, {
        step: "architecture_review",
        stepAttempt: 2,
        reason: "provider access restored",
      }),
    ).outcome,
    "stored",
  );
  let held = getPipelineCommission("commission-task-1")!;
  assert.equal(held.blocker, null);
  assert.equal(held.error, "provider access restored");
  assert.equal(held.currentStep, "architecture_review");
  assert.equal(
    held.steps.find((step) => step.name === "architecture_review")?.state,
    "in_progress",
  );

  const landReason = "artifact stem does not match the reserved feature slug";
  assert.equal(
    applyEngineerEvent(event("engineer_land_refused", 6, { reason: landReason })).outcome,
    "stored",
  );
  held = getPipelineCommission("commission-task-1")!;
  assert.equal(held.lifecycle, "authoring");
  assert.deepEqual(held.blocker, { kind: "land_refused", reason: landReason });

  assert.equal(
    applyEngineerEvent(
      event("engineer_step_completed", 7, {
        step: "architecture_review",
        stepAttempt: 2,
        completion: "accepted_result",
      }),
    ).outcome,
    "stored",
  );
  held = getPipelineCommission("commission-task-1")!;
  assert.equal(held.blocker, null);
  assert.equal(held.error, null);
});

test("legacy commission JSON without blocker normalizes to null", () => {
  reset();
  commission();
  const row = db.prepare(`SELECT state_json FROM pipeline_commissions WHERE id = ?`).get(
    "commission-task-1",
  ) as { state_json: string };
  const legacy = JSON.parse(row.state_json) as Record<string, unknown>;
  delete legacy.blocker;
  db.prepare(`UPDATE pipeline_commissions SET state_json = ? WHERE id = ?`).run(
    JSON.stringify(legacy),
    "commission-task-1",
  );

  const held = getPipelineCommission("commission-task-1")!;
  assert.equal(held.lifecycle, "created");
  assert.equal(held.blocker, null);
});

test("unknown kinds advance the exact cursor without changing the projection", () => {
  reset();
  commission();
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  const before = getPipelineCommission("commission-task-1")!;
  const unknown = {
    ...event("engineer_run_started", 2),
    type: "engineer_future_observation",
    future: true,
  };
  assert.equal(applyEngineerEvent(unknown).outcome, "stored");
  const after = getPipelineCommission("commission-task-1")!;
  assert.equal(after.lifecycle, before.lifecycle);
  assert.deepEqual(after.steps, before.steps);
  assert.equal(after.attempts[0]?.providerRevision, 2);
});

test("terminal attempts are immutable and retry appends a successor cursor", () => {
  reset();
  commission();
  applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" }));
  applyEngineerEvent(event("engineer_run_failed", 2, { error: "host failed" }));
  assert.equal(applyEngineerEvent(event("engineer_run_started", 3)).outcome, "terminal");
  const retried = appendPipelineCommissionAttempt({
    commissionId: "commission-task-1",
    launchKey: "launch-2",
    now: 1_700_000_000_100,
  });
  assert.equal(retried.activeAttempt, 2);
  assert.deepEqual(
    retried.attempts.map((attempt) => [attempt.attempt, attempt.providerRevision, attempt.state]),
    [
      [1, 2, "failed"],
      [2, 0, "reserved"],
    ],
  );
  assert.equal(
    applyEngineerEvent(event("engineer_run_started", 3)).outcome,
    "mismatch",
    "an old attempt cannot move the successor projection",
  );
  assert.throws(
    () =>
      bindPipelineCommissionAttempt({
        commissionId: "commission-task-1",
        attempt: 2,
        engineerRunId: "run-task-1-retry",
        providerAttempt: 2,
        attemptKey: "launch-2",
        previousEngineerRunId: "wrong-predecessor",
      }),
    /predecessor does not match/,
  );
  const rebound = bindPipelineCommissionAttempt({
    commissionId: "commission-task-1",
    attempt: 2,
    engineerRunId: "run-task-1-retry",
    providerAttempt: 2,
    attemptKey: "launch-2",
    previousEngineerRunId: "run-task-1",
  });
  assert.equal(rebound.attempts[1]?.previousEngineerRunId, "run-task-1");
});

test("a settled commission cannot append another attempt", () => {
  reset();
  commission();
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  assert.equal(
    applyEngineerEvent(
      event("engineer_run_settled", 2, { outcome: "awaiting_spec_merge" }),
    ).outcome,
    "stored",
  );
  assert.equal(getPipelineCommission("commission-task-1")?.attempts[0]?.state, "settled");
  assert.throws(
    () => appendPipelineCommissionAttempt({ commissionId: "commission-task-1" }),
    /settled pipeline commission/,
  );
});

test("commission snapshots bound attempt history while SQLite retains the full audit", () => {
  reset();
  commission();
  const total = MAX_PIPELINE_COMMISSION_ATTEMPTS + 3;
  const runId = (attempt: number): string =>
    attempt === 1 ? "run-task-1" : `run-task-1-${attempt}`;
  const launchKey = (attempt: number): string =>
    attempt === 1 ? "launch-task-1" : `launch-task-1-${attempt}`;

  for (let attempt = 1; attempt <= total; attempt += 1) {
    const identity = {
      engineerRunId: runId(attempt),
      attemptKey: launchKey(attempt),
      attempt,
      previousEngineerRunId: attempt === 1 ? null : runId(attempt - 1),
    };
    assert.equal(
      applyEngineerEvent(event("engineer_run_created", 1, { ...identity, idea: "retry" })).outcome,
      "stored",
    );
    assert.equal(
      applyEngineerEvent(event("engineer_run_failed", 2, { ...identity, error: "retry" })).outcome,
      "stored",
    );
    if (attempt === total) continue;
    const next = appendPipelineCommissionAttempt({
      commissionId: "commission-task-1",
      launchKey: launchKey(attempt + 1),
    });
    assert.ok(next.attempts.length <= MAX_PIPELINE_COMMISSION_ATTEMPTS);
    bindPipelineCommissionAttempt({
      commissionId: next.id,
      attempt: attempt + 1,
      engineerRunId: runId(attempt + 1),
      providerAttempt: attempt + 1,
      attemptKey: launchKey(attempt + 1),
      previousEngineerRunId: runId(attempt),
    });
  }

  const projected = getPipelineCommission("commission-task-1")!;
  assert.equal(projected.attempts.length, MAX_PIPELINE_COMMISSION_ATTEMPTS);
  assert.equal(projected.attempts[0]?.attempt, total - MAX_PIPELINE_COMMISSION_ATTEMPTS + 1);
  assert.equal(projected.attempts.at(-1)?.attempt, total);
  const attemptCount = db.prepare(
    `SELECT COUNT(*) AS count FROM pipeline_commission_attempts WHERE commission_id = ?`,
  ).get("commission-task-1") as { count: number };
  assert.equal(Number(attemptCount.count), total);
  const stored = db.prepare(`SELECT state_json FROM pipeline_commissions WHERE id = ?`).get(
    "commission-task-1",
  ) as { state_json: string };
  assert.equal(
    (JSON.parse(stored.state_json) as PipelineCommission).attempts.length,
    MAX_PIPELINE_COMMISSION_ATTEMPTS,
  );
});

test("identity, ordering, terminal, malformed handoff, and collision checks fail closed", () => {
  reset();
  commission();
  assert.equal(
    applyEngineerEvent(event("engineer_run_created", 1, { idea: "x", repoRoot: `${repo}/other` })).outcome,
    "mismatch",
  );
  assert.equal(
    applyEngineerEvent(event("engineer_run_created", 1, { idea: "x", correlationId: "wrong" })).outcome,
    "mismatch",
  );
  assert.equal(
    applyEngineerEvent(event("engineer_run_created", 1, { idea: "x", attemptKey: "wrong" })).outcome,
    "mismatch",
  );
  assert.equal(
    applyEngineerEvent(event("engineer_run_created", 1, { idea: "x", engineerRunId: "unknown" })).outcome,
    "unknown_commission",
  );
  assert.equal(applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" })).outcome, "stored");
  assert.equal(
    applyEngineerEvent(event("engineer_run_started", 1)).outcome,
    "stale",
    "same revision with another body is not an idempotent duplicate",
  );
  assert.equal(
    applyEngineerEvent(
      event("engineer_spec_handoff", 2, {
        planSlug: "missing-fields",
        state: "awaiting_spec_merge",
      }),
    ).outcome,
    "malformed",
  );
  assert.equal(getPipelineCommission("commission-task-1")?.attempts[0]?.providerRevision, 1);

  assert.equal(
    applyEngineerEvent(event("engineer_run_cancelled", 2, { reason: "operator" })).outcome,
    "stored",
  );
  assert.equal(applyEngineerEvent(event("engineer_run_started", 3)).outcome, "terminal");
  assert.throws(
    () => appendPipelineCommissionAttempt({ commissionId: "commission-task-1" }),
    /terminal pipeline commission/,
  );

  reset();
  commission("task-1");
  commission("task-2");
  for (const taskId of ["task-1", "task-2"]) {
    assert.equal(
      applyEngineerEvent(event("engineer_run_created", 1, { idea: "x" }, taskId)).outcome,
      "stored",
    );
  }
  const handoff = {
    planSlug: "one-final-run",
    branch: "spec/one-final-run",
    prUrl: null,
    outcome: "local_commit",
    state: "awaiting_spec_merge",
  };
  assert.equal(
    applyEngineerEvent(event("engineer_spec_handoff", 2, handoff, "task-1")).outcome,
    "stored",
  );
  assert.equal(
    applyEngineerEvent(event("engineer_spec_handoff", 2, handoff, "task-2")).outcome,
    "collision",
  );
  assert.equal(getPipelineCommission("commission-task-2")?.attempts[0]?.providerRevision, 1);
});

test("Engineer ingest is item-tolerant, consented, identity-bound, and idempotent", () => {
  reset();
  commission();
  const good = event("engineer_run_created", 1, { idea: "x" });
  const envelope = {
    repo,
    seq: 1,
    event: good,
    engineerRunId: good.engineerRunId,
    correlationId: good.correlationId,
    engineerAttempt: good.attempt,
    attemptKey: good.attemptKey,
  };
  const bad = { ...envelope, engineerRunId: "wrong" };
  const first = ingestConductorEvents(`${JSON.stringify(bad)}\n${JSON.stringify(envelope)}\n`);
  assert.deepEqual(first.counts, {
    received: 2,
    stored: 1,
    duplicate: 0,
    malformed: 1,
    unconsented: 0,
  });
  assert.equal(first.commissions.length, 1);
  const again = ingestConductorEvents(`${JSON.stringify(envelope)}\n`);
  assert.equal(again.counts.duplicate, 1);

  setPipelinesConfig({ enabled: true, repos: [] });
  const unconsented = ingestConductorEvents(`${JSON.stringify(envelope)}\n`);
  assert.equal(unconsented.counts.unconsented, 1);
  assert.equal(unconsented.counts.stored, 0);
});

test("one internal Engineer write failure costs only its line in the ingest batch", () => {
  reset();
  commission("task-1");
  commission("task-2");
  db.exec(`
    CREATE TEMP TRIGGER fail_pipeline_commission_event
    BEFORE INSERT ON pipeline_commission_events
    WHEN NEW.commission_id = 'commission-task-1'
    BEGIN
      SELECT RAISE(ABORT, 'simulated Engineer evidence failure');
    END;
  `);
  const line = (taskId: string): string => {
    const next = event("engineer_run_created", 1, { idea: "x" }, taskId);
    return JSON.stringify({
      repo,
      seq: next.revision,
      event: next,
      engineerRunId: next.engineerRunId,
      correlationId: next.correlationId,
      engineerAttempt: next.attempt,
      attemptKey: next.attemptKey,
    });
  };
  try {
    const result = ingestConductorEvents(`${line("task-1")}\n${line("task-2")}\n`);
    assert.deepEqual(result.counts, {
      received: 2,
      stored: 1,
      duplicate: 0,
      malformed: 1,
      unconsented: 0,
    });
    assert.deepEqual(
      result.commissions.map((held) => held.id),
      ["commission-task-2"],
    );
    assert.equal(getPipelineCommission("commission-task-1")?.attempts[0]?.providerRevision, 0);
    assert.equal(getPipelineCommission("commission-task-2")?.attempts[0]?.providerRevision, 1);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS fail_pipeline_commission_event`);
  }
});

test("an unsupported Engineer schema preserves the last good projection and records evidence", () => {
  reset();
  commission();
  const good = event("engineer_run_created", 1, { idea: "x" });
  assert.equal(applyEngineerEvent(good).outcome, "stored");
  const future = { ...event("engineer_run_started", 2), schemaVersion: 2 };
  const envelope = {
    repo,
    seq: 2,
    event: future,
    engineerRunId: future.engineerRunId,
    correlationId: future.correlationId,
    engineerAttempt: future.attempt,
    attemptKey: future.attemptKey,
  };
  const result = ingestConductorEvents(`${JSON.stringify(envelope)}\n`);
  assert.equal(result.counts.stored, 1);
  const held = getPipelineCommission("commission-task-1")!;
  assert.equal(held.lifecycle, "unsupported");
  assert.match(held.error ?? "", /schema version 2/);
  assert.equal(held.attempts[0]?.providerRevision, 2);
  assert.equal(held.steps.length, 12, "the last good step projection is retained");
});

test("replay routes a future Engineer schema through the unsupported reducer", async () => {
  reset();
  const held = commission();
  const future = { ...event("engineer_run_started", 1), schemaVersion: 2 };
  const original = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async () => ({ ok: false, error: "unused", outcomeUnknown: false }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [future] }),
    cancel: async () => ({ ok: false, error: "unused", outcomeUnknown: false }),
  };
  try {
    const registry = new Registry();
    registry.initializePipelineCommissions([held]);
    await refreshPipelineCommission(registry, held);
    const reconciled = getPipelineCommission(held.id);
    assert.equal(reconciled?.lifecycle, "unsupported");
    assert.equal(reconciled?.attempts[0]?.providerRevision, 1);
    assert.match(reconciled?.error ?? "", /schema version 2/);
    assert.equal(countPipelineCommissionEvents(held.id), 1);
  } finally {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = original;
  }
});

test("the authoring ledger stays bounded per commission", () => {
  reset();
  commission();
  for (let revision = 1; revision <= MAX_PIPELINE_COMMISSION_EVENTS + 1; revision += 1) {
    const future = {
      ...event("engineer_run_started", revision),
      type: "engineer_future_observation",
      ordinal: revision,
    };
    assert.equal(applyEngineerEvent(future).outcome, "stored");
  }
  assert.equal(
    countPipelineCommissionEvents("commission-task-1"),
    MAX_PIPELINE_COMMISSION_EVENTS,
  );
});

test("one malformed persisted projection degrades explicitly without breaking the catalog", () => {
  reset();
  const original = commission();
  db.prepare(`UPDATE pipeline_commissions SET state_json = '{bad' WHERE id = ?`).run(
    "commission-task-1",
  );
  let held = loadPipelineCommissions();
  assert.equal(held.length, 1);
  assert.equal(held[0]?.lifecycle, "unsupported");
  assert.match(held[0]?.error ?? "", /unreadable/);

  db.prepare(`UPDATE pipeline_commissions SET state_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...original, attempts: [null] }),
    "commission-task-1",
  );
  held = loadPipelineCommissions();
  assert.equal(held[0]?.lifecycle, "unsupported");
  assert.match(held[0]?.error ?? "", /unreadable/);

  db.prepare(`UPDATE pipeline_commissions SET state_json = ? WHERE id = ?`).run(
    JSON.stringify(original),
    "commission-task-1",
  );
  db.prepare(`UPDATE pipeline_commission_attempts SET origin = 'future_origin' WHERE commission_id = ?`).run(
    "commission-task-1",
  );
  held = loadPipelineCommissions();
  assert.equal(held[0]?.lifecycle, "unsupported");
  assert.match(held[0]?.error ?? "", /unsupported stored attempt origin future_origin/);

  db.prepare(
    `UPDATE pipeline_commission_attempts
        SET origin = NULL, evidence_commit_provenance = 'future_provenance'
      WHERE commission_id = ?`,
  ).run("commission-task-1");
  held = loadPipelineCommissions();
  assert.equal(held[0]?.lifecycle, "unsupported");
  assert.match(held[0]?.error ?? "", /unsupported stored evidence provenance future_provenance/);

  db.prepare(
    `UPDATE pipeline_commission_attempts
        SET evidence_commit_provenance = NULL
      WHERE commission_id = ?`,
  ).run("commission-task-1");
  held = loadPipelineCommissions();
  assert.equal(held[0]?.attempts[0]?.origin, "mission_control");
  assert.equal(held[0]?.attempts[0]?.evidenceCommit, null);
});

test("live-first, replay-first, and restart reconciliation converge on one projection", async () => {
  reset();
  const held = commission();
  const created = event("engineer_run_created", 1, { idea: "x" });
  const started = event("engineer_run_started", 2);
  // Live wins revision one while the replay command is in flight. Replay still returns both
  // provider events, and the shared reducer treats one as duplicate before storing revision two.
  assert.equal(applyEngineerEvent(created).outcome, "stored");
  const original = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: async () => ({ ok: true, value: { supported: true } }),
    create: async () => ({ ok: false, error: "unused", outcomeUnknown: false }),
    inspectCorrelation: async () => ({ ok: true, value: [] }),
    replay: async () => ({ ok: true, value: [created, started] }),
    cancel: async () => ({ ok: false, error: "unused", outcomeUnknown: false }),
  };
  try {
    const registry = new Registry();
    registry.initializePipelineCommissions([held]);
    const frames: string[] = [];
    registry.subscribe((message) => frames.push(message.type));
    await refreshPipelineCommission(registry, getPipelineCommission(held.id)!);
    assert.equal(getPipelineCommission(held.id)?.attempts[0]?.providerRevision, 2);
    assert.equal(getPipelineCommission(held.id)?.lifecycle, "authoring");
    assert.ok(frames.includes("pipeline_commission_upsert"));

    // A replay health error is durable, but the next provider call may race a live push.
    // Clearing that old health error must decorate revision three, not restore the stale
    // revision-two snapshot captured before the provider await.
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle.capability = async () => ({
      ok: true,
      value: { supported: false },
    });
    await refreshPipelineCommission(registry, getPipelineCommission(held.id)!);
    const staleWithReplayError = getPipelineCommission(held.id)!;
    assert.match(staleWithReplayError.error ?? "", /Engineer replay:/);
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle.capability = async () => ({
      ok: true,
      value: { supported: true },
    });
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle.replay = async () => {
      assert.equal(
        applyEngineerEvent(
          event("engineer_step_started", 3, {
            step: "explore",
            stepAttempt: 1,
          }),
        ).outcome,
        "stored",
      );
      return { ok: true, value: [created] };
    };
    await refreshPipelineCommission(registry, staleWithReplayError);
    assert.equal(getPipelineCommission(held.id)?.attempts[0]?.providerRevision, 3);
    assert.equal(getPipelineCommission(held.id)?.currentStep, "explore");
    assert.equal(getPipelineCommission(held.id)?.error, null);

    // Simulate daemon restart. Restore reads the durable cursor, and an empty exact replay
    // leaves the same whole-object projection in the fresh Registry.
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle.replay = async () => ({
      ok: true,
      value: [],
    });
    const restarted = new Registry();
    restorePipelineProjection(restarted);
    await refreshPipelineCommission(restarted, restarted.listPipelineCommissions()[0]!);
    assert.deepEqual(
      restarted.listPipelineCommissions(),
      [getPipelineCommission(held.id)],
    );
  } finally {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = original;
  }
});
