import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { WorkflowBinding, WorkflowCaptureExpectation } from "../src/shared/workflow.ts";
import type { WorkflowRawCaptureRead } from "../src/server/workflows/context.ts";

// What is at stake: this is the ONLY way work that Mission Control itself selected can enter
// the shipped Preview engine, and it has no route in front of it to reject a bad request.
//
// Three things have to hold or a server-owned handoff is worse than no handoff at all. The
// claim has to be idempotent, because a lost response or a restart must not start a second
// review of the same artifact - that is N more Persona calls and a second binding fighting
// for one conversation. The capture has to be EXACT: the run may only see the commit that
// was selected, with nothing uncommitted beside it, or the review is of work nobody chose.
// And a refusal has to be resumable on the same submission, because the caller's remedy is
// to restore its artifact and ask again, not to start over.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-external-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { externalSourceKey } = await import("../src/server/workflows/external-binding.ts");
const { resetSession } = await import("../src/server/reset.ts");

const EXPECTED_HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const expectation: WorkflowCaptureExpectation = {
  expectedHeadSha: EXPECTED_HEAD,
  requireCleanWorktree: true,
};

function discovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: `ttys-${id}`,
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession;
}

function seedVersion(id: string): void {
  const db = openDb();
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "end", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  };
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`w-${id}`, `W ${id}`, `w-${id}`, JSON.stringify(graph), defaults, `v-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`v-${id}`, `w-${id}`, JSON.stringify(graph), defaults);
}

/** A capture read whose HEAD and cleanliness the test controls between attempts. */
function capture(state: { headSha: string; dirty: boolean; reads: number }) {
  return async (
    _registry: unknown,
    binding: WorkflowBinding,
  ): Promise<WorkflowRawCaptureRead> => {
    state.reads++;
    const raw = {
      primaryGoal: { rawPrompt: "Review this", refined: null, sourceNoteKey: binding.noteKey },
      humanDecisions: [],
      priorPersonaFeedback: [],
      session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
      evidence: {
        headSha: state.headSha,
        diffFingerprint: `diff-${state.headSha}-${state.dirty}`,
        diff: "patch",
        diffTruncated: false,
        workingTreeDirty: state.dirty,
        workingTreeStatus: state.dirty ? [" M file.ts"] : [],
        workingTreeStatusTruncated: false,
        transcript: [],
        transcriptAnchor: 1,
        transcriptTruncated: false,
        standards: [],
        standardsTruncated: false,
      },
    };
    return {
      raw,
      context: fallbackWorkflowContext(raw, null),
      boundary: {
        noteKey: binding.noteKey,
        sessionId: binding.sessionId!,
        headSha: state.headSha,
        transcriptPath: null,
        transcriptSize: 1,
        repositoryFingerprint: `repo-${state.headSha}-${state.dirty}`,
      },
    };
  };
}

function counts(bindingId: string): { runs: number; submissions: number; claims: number } {
  const db = openDb();
  const runs = db.prepare(
    `SELECT COUNT(*) AS n FROM workflow_runs WHERE binding_id = ?`,
  ).get(bindingId) as { n: number };
  const submissions = db.prepare(
    `SELECT COUNT(*) AS n FROM workflow_submissions
      WHERE run_id IN (SELECT id FROM workflow_runs WHERE binding_id = ?)`,
  ).get(bindingId) as { n: number };
  const claims = db.prepare(
    `SELECT COUNT(*) AS n FROM workflow_binding_claims WHERE binding_id = ?`,
  ).get(bindingId) as { n: number };
  return { runs: runs.n, submissions: submissions.n, claims: claims.n };
}

test("the source key is opaque, derived from bounded parts, and refuses ambiguous ids", () => {
  const source = { kind: "ensemble" as const, sourceId: "ens-1", resultId: "member-2" };
  assert.equal(externalSourceKey(source, "version-3"), "ensemble:ens-1:result:member-2:workflow:version-3");
  // Two different references must never spell one key, so no segment may carry the separator.
  assert.throws(() => externalSourceKey({ ...source, sourceId: "ens:1" }, "version-3"));
  assert.throws(() => externalSourceKey({ ...source, resultId: "member:2" }, "version-3"));
  assert.throws(() => externalSourceKey(source, "version:3"));
  assert.throws(() => externalSourceKey({ ...source, resultId: "" }, "version-3"));
  assert.throws(() => externalSourceKey({ ...source, sourceId: "x".repeat(201) }, "version-3"));
});

test("repeated and concurrent claims resolve to one binding, one run, and one first submission", async () => {
  seedVersion("claim");
  const registry = new Registry();
  registry.applyDiscovery([discovered("claim-session")]);
  const personas = new PersonaManager(registry);
  const state = { headSha: EXPECTED_HEAD, dirty: false, reads: 0 };
  let compactions = 0;
  const workflows = new WorkflowManager(registry, personas.store, {
    readContextRaw: capture(state),
    boundaryChanged: async () => false,
    compactContext: async (raw) => {
      compactions++;
      return fallbackWorkflowContext(raw, "test fallback");
    },
  });
  const source = { kind: "ensemble" as const, sourceId: "ens-claim", resultId: "member-1" };
  const request = {
    source,
    workflowVersionId: "v-claim",
    sessionId: "claim-session",
  };

  // Concurrent callers: the store transaction takes the write lock before its conflict
  // check, so exactly one of these creates the claim and its binding.
  const [first, second] = await Promise.all([
    Promise.resolve(workflows.ensureExternalBinding(request)),
    Promise.resolve(workflows.ensureExternalBinding(request)),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.binding.id, second.value.binding.id);
  assert.equal([first.value.created, second.value.created].filter(Boolean).length, 1);
  assert.equal(first.value.claim.sourceKey, externalSourceKey(source, "v-claim"));
  assert.equal(first.value.claim.sourceId, "ens-claim");
  const bindingId = first.value.binding.id;

  const submitted = await workflows.submitExternal(bindingId, { source, expectation });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const repeated = await workflows.submitExternal(bindingId, { source, expectation });
  assert.equal(repeated.ok, true);
  if (!repeated.ok) return;
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.value.run.id, submitted.value.run.id);
  assert.equal(repeated.value.submission.id, submitted.value.submission.id);
  assert.deepEqual(counts(bindingId), { runs: 1, submissions: 1, claims: 1 });
  assert.equal(compactions, 1);

  // The durable rows say who started this, and the trigger key is the claim's own key.
  const db = openDb();
  const row = db.prepare(
    `SELECT r.trigger_source AS run_source, r.trigger_key AS run_key,
            s.trigger_source AS submission_source, s.trigger_key AS submission_key
       FROM workflow_runs r JOIN workflow_submissions s ON s.run_id = r.id
      WHERE r.binding_id = ?`,
  ).get(bindingId) as Record<string, string>;
  assert.equal(row.run_source, "ensemble");
  assert.equal(row.submission_source, "ensemble");
  assert.equal(row.run_key, first.value.claim.sourceKey);
  assert.equal(row.submission_key, first.value.claim.sourceKey);
  assert.equal(workflows.store.getRun(submitted.value.run.id)?.status, "completed");
  await workflows.stop();
});

test("an active binding on that conversation is a typed conflict, never an adoption", async () => {
  seedVersion("conflict");
  const registry = new Registry();
  registry.applyDiscovery([discovered("conflict-session")]);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  const manual = workflows.createBinding({
    workflowVersionId: "v-conflict",
    sessionId: "conflict-session",
  });
  assert.equal(manual.ok, true);
  if (!manual.ok) return;
  const claimed = workflows.ensureExternalBinding({
    source: { kind: "ensemble", sourceId: "ens-conflict", resultId: "member-1" },
    workflowVersionId: "v-conflict",
    sessionId: "conflict-session",
  });
  assert.equal(claimed.ok, false);
  if (claimed.ok) return;
  assert.equal(claimed.reason, "conflict");
  assert.equal((claimed.current as WorkflowBinding | null)?.id, manual.value.id);
  // The operator's binding is untouched and nothing was recorded against it.
  assert.equal(workflows.store.getBinding(manual.value.id)?.state, "active");
  assert.equal(workflows.store.claimForBinding(manual.value.id), null);
  await workflows.stop();
});

test("an injected eligibility guard refuses the claim before any durable write", async () => {
  seedVersion("eligible");
  const registry = new Registry();
  registry.applyDiscovery([discovered("eligible-session")]);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store, {
    externalBindingEligibility: ({ sessionId }) =>
      sessionId === "eligible-session" ? "This member is still implementing its candidate" : null,
  });
  const refused = workflows.ensureExternalBinding({
    source: { kind: "ensemble", sourceId: "ens-eligible", resultId: "member-1" },
    workflowVersionId: "v-eligible",
    sessionId: "eligible-session",
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, "ineligible_session");
  assert.match(refused.message, /still implementing/);
  const db = openDb();
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM workflow_binding_claims WHERE source_id = 'ens-eligible'`)
      .get() as { n: number }).n,
    0,
  );
  await workflows.stop();
});

test("a wrong commit and a dirty tree each block before evidence and compaction, then resume", async () => {
  seedVersion("exact");
  const registry = new Registry();
  registry.applyDiscovery([discovered("exact-session")]);
  const personas = new PersonaManager(registry);
  const state = { headSha: OTHER_HEAD, dirty: false, reads: 0 };
  let compactions = 0;
  const workflows = new WorkflowManager(registry, personas.store, {
    readContextRaw: capture(state),
    boundaryChanged: async () => false,
    compactContext: async (raw) => {
      compactions++;
      return fallbackWorkflowContext(raw, "test fallback");
    },
  });
  const source = { kind: "ensemble" as const, sourceId: "ens-exact", resultId: "member-1" };
  const bound = workflows.ensureExternalBinding({
    source,
    workflowVersionId: "v-exact",
    sessionId: "exact-session",
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  const bindingId = bound.value.binding.id;

  // An abbreviated or upper-case commit id could never equal what capture reads, so it is
  // refused at the boundary rather than blocking forever with a message blaming the session.
  const malformed = await workflows.submitExternal(bindingId, {
    source,
    expectation: { expectedHeadSha: EXPECTED_HEAD.slice(0, 12), requireCleanWorktree: true },
  });
  assert.equal(malformed.ok, false);
  if (malformed.ok) return;
  assert.match(malformed.message, /complete lowercase commit id/);
  assert.deepEqual(counts(bindingId), { runs: 0, submissions: 0, claims: 1 });

  const wrongHead = await workflows.submitExternal(bindingId, { source, expectation });
  assert.equal(wrongHead.ok, false);
  if (wrongHead.ok) return;
  assert.equal(wrongHead.reason, "artifact_mismatch");
  const blockedRun = workflows.store.listRuns().find((run) => run.bindingId === bindingId)!;
  assert.equal(blockedRun.status, "blocked");
  assert.equal(blockedRun.currentPhase, "external_artifact_mismatch");
  // Nothing was spent and nothing was written: no provider call, and the round still holds
  // its placeholder fingerprint rather than evidence from the wrong commit.
  assert.equal(compactions, 0);
  const firstSubmission = workflows.store.latestSubmission(blockedRun.id)!;
  assert.equal(firstSubmission.status, "failed");
  assert.match(firstSubmission.evidenceFingerprint, /^capturing:/);

  // The right commit with uncommitted work beside it is still not the selected artifact.
  state.headSha = EXPECTED_HEAD;
  state.dirty = true;
  const dirty = await workflows.submitExternal(bindingId, { source, expectation });
  assert.equal(dirty.ok, false);
  if (dirty.ok) return;
  assert.equal(dirty.reason, "artifact_mismatch");
  assert.equal(compactions, 0);
  assert.deepEqual(counts(bindingId), { runs: 1, submissions: 1, claims: 1 });

  // Restored exactly: the SAME submission resumes rather than a second family starting.
  state.dirty = false;
  const restored = await workflows.submitExternal(bindingId, { source, expectation });
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.value.run.id, blockedRun.id);
  assert.equal(restored.value.submission.id, firstSubmission.id);
  assert.equal(restored.value.submission.round, 1);
  assert.equal(compactions, 1);
  assert.deepEqual(counts(bindingId), { runs: 1, submissions: 1, claims: 1 });
  assert.equal(workflows.store.getRun(blockedRun.id)?.status, "completed");
  await workflows.stop();
});

test("a restart between every durable step resumes the same run rather than starting another", async () => {
  seedVersion("restart");
  const registry = new Registry();
  registry.applyDiscovery([discovered("restart-session")]);
  const personas = new PersonaManager(registry);
  const source = { kind: "ensemble" as const, sourceId: "ens-restart", resultId: "member-1" };
  const state = { headSha: EXPECTED_HEAD, dirty: false, reads: 0 };
  const options = {
    readContextRaw: capture(state),
    boundaryChanged: async () => false,
    compactContext: async (raw: Parameters<typeof fallbackWorkflowContext>[0]) =>
      fallbackWorkflowContext(raw, "test fallback"),
  };

  // Restart 1: the claim and binding are durable, nothing else is.
  const beforeRun = new WorkflowManager(registry, personas.store, options);
  const bound = beforeRun.ensureExternalBinding({
    source,
    workflowVersionId: "v-restart",
    sessionId: "restart-session",
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  const bindingId = bound.value.binding.id;
  await beforeRun.stop();

  // Restart 2: a fresh daemon re-derives the same key and adopts the same binding.
  const afterRestart = new WorkflowManager(registry, personas.store, options);
  const rebound = afterRestart.ensureExternalBinding({
    source,
    workflowVersionId: "v-restart",
    sessionId: "restart-session",
  });
  assert.equal(rebound.ok, true);
  if (!rebound.ok) return;
  assert.equal(rebound.value.binding.id, bindingId);
  assert.equal(rebound.value.created, false);

  // Restart 3: the run and its first submission exist but capture never finished. Engine
  // recovery blocks the interrupted round; the retry resumes that exact submission.
  const created = afterRestart.store.createInitialSubmission(
    {
      id: "restart-run",
      binding: rebound.value.binding,
      triggerSource: "ensemble",
      triggerKey: rebound.value.claim.sourceKey,
      now: 5,
    },
    {
      id: "restart-submission",
      triggerSource: "ensemble",
      triggerKey: rebound.value.claim.sourceKey,
      context: {},
      evidence: {},
      now: 5,
    },
  );
  assert.equal(created.run.status, "capturing");
  const afterCapture = new WorkflowManager(registry, personas.store, options);
  afterCapture.start();
  assert.equal(afterCapture.store.getRun("restart-run")?.currentPhase, "capture_interrupted");
  const resumed = await afterCapture.submitExternal(bindingId, { source, expectation });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.value.run.id, "restart-run");
  assert.equal(resumed.value.submission.id, "restart-submission");
  assert.deepEqual(counts(bindingId), { runs: 1, submissions: 1, claims: 1 });

  // Restart 4: after activation the answer is idempotent, not a fresh round.
  const afterActivation = new WorkflowManager(registry, personas.store, options);
  const again = await afterActivation.submitExternal(bindingId, { source, expectation });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.idempotent, true);
  assert.equal(again.value.submission.id, "restart-submission");
  assert.deepEqual(counts(bindingId), { runs: 1, submissions: 1, claims: 1 });
  await afterCapture.stop();
  await afterActivation.stop();
});

test("run detail carries display provenance and never the opaque idempotency key", async () => {
  seedVersion("detail");
  const registry = new Registry();
  registry.applyDiscovery([discovered("detail-session"), discovered("detail-manual-session")]);
  const personas = new PersonaManager(registry);
  const state = { headSha: EXPECTED_HEAD, dirty: false, reads: 0 };
  const workflows = new WorkflowManager(registry, personas.store, {
    readContextRaw: capture(state),
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test fallback"),
  });
  const source = { kind: "ensemble" as const, sourceId: "ens-detail", resultId: "member-1" };
  const bound = workflows.ensureExternalBinding({
    source,
    workflowVersionId: "v-detail",
    sessionId: "detail-session",
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  const submitted = await workflows.submitExternal(bound.value.binding.id, { source, expectation });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;

  const detail = workflows.run(submitted.value.run.id)!;
  assert.deepEqual(detail.externalSource, {
    kind: "ensemble",
    sourceId: "ens-detail",
    createdAt: detail.externalSource!.createdAt,
  });
  assert.equal(JSON.stringify(detail.externalSource).includes(bound.value.claim.sourceKey), false);
  // Run SUMMARIES travel over SSE for every run in the fleet, so provenance must not widen
  // them. The summary keys are exactly what they were.
  assert.deepEqual(Object.keys(detail.summary).sort(), [
    "activePersonaNames",
    "bindingId",
    "bypassedPersonaReview",
    "failedPersonaCount",
    "id",
    "maxRepairRounds",
    "noteKey",
    "phase",
    "round",
    "sessionId",
    "status",
    "updatedAt",
    "workflowId",
    "workflowName",
    "workflowVersion",
  ]);
  for (const summary of workflows.runs()) {
    assert.equal("externalSource" in summary, false);
  }
  // A manual run reports no provenance at all rather than an empty badge.
  const manual = workflows.createBinding({
    workflowVersionId: "v-detail",
    sessionId: "detail-manual-session",
  });
  assert.equal(manual.ok, true);
  if (!manual.ok) return;
  const manualSubmit = await workflows.submit(manual.value.id, { requestId: "detail-manual" });
  assert.equal(manualSubmit.ok, true);
  if (!manualSubmit.ok) return;
  assert.equal(workflows.run(manualSubmit.value.run.id)?.externalSource, null);
  assert.equal(workflows.store.getRun(manualSubmit.value.run.id)?.triggerSource, "manual");
  await workflows.stop();
});

test("Reset removes the claim with its binding and leaves no claim pointing at a deleted row", async () => {
  seedVersion("reset");
  const registry = new Registry();
  registry.applyDiscovery([discovered("reset-session")]);
  const personas = new PersonaManager(registry);
  const state = { headSha: EXPECTED_HEAD, dirty: false, reads: 0 };
  const workflows = new WorkflowManager(registry, personas.store, {
    readContextRaw: capture(state),
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test fallback"),
  });
  const source = { kind: "ensemble" as const, sourceId: "ens-reset", resultId: "member-1" };
  const bound = workflows.ensureExternalBinding({
    source,
    workflowVersionId: "v-reset",
    sessionId: "reset-session",
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  await workflows.submitExternal(bound.value.binding.id, { source, expectation });

  await resetSession(registry, registry.getSession("reset-session")!, false, async () => ({
    ok: true,
    error: null,
    root: "/repo",
    cleared: false,
    detached: false,
    clean: true,
  }));

  const db = openDb();
  const orphans = db.prepare(
    `SELECT COUNT(*) AS n FROM workflow_binding_claims c
      WHERE NOT EXISTS (SELECT 1 FROM workflow_bindings b WHERE b.id = c.binding_id)`,
  ).get() as { n: number };
  assert.equal(orphans.n, 0);
  assert.equal(workflows.store.claimBySourceKey(bound.value.claim.sourceKey), null);
  assert.equal(workflows.store.getBinding(bound.value.binding.id), null);
  // The reusable definitions the orchestrator pinned survive; only the session family goes.
  assert.equal(workflows.store.getWorkflowVersionById("v-reset")?.id, "v-reset");
  await workflows.stop();
});
