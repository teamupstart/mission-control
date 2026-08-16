import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { SessionIntentGuard } from "../src/shared/types.ts";

const PROMPTED_INTENT: SessionIntentGuard = {
  objective: "Finish the prompted workflow",
  objectiveVersion: 1,
  promptRevision: 1,
  episodeKey: "intent:1:1",
};

const home = mkdtempSync(join(tmpdir(), "mission-workflow-completion-http-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    pid: id.length,
    tty: `tty-${id}`,
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession;
}

function request(
  app: ReturnType<typeof buildApp>,
  sessionId: string,
  marker: string,
  completionKind: "drain" | "prompted" = "drain",
  expectedIntent: SessionIntentGuard | null = completionKind === "prompted"
    ? PROMPTED_INTENT
    : null,
  extra: Record<string, unknown> = {},
) {
  return app.request(`/api/sessions/${sessionId}/workflow-completion`, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({
      completionKind,
      marker,
      summary: "Foreman proved the queue complete.",
      evidenceFingerprint: "evidence",
      expectedIntent,
      ...extra,
    }),
  });
}

function seedVersion(): void {
  const db = openDb();
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  };
  const defaults = JSON.stringify({ triggerMode: "foreman_complete", deliveryMode: "preview", maxRepairRounds: 2 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'Review', 'review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify(graph), defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
}

test("completion HTTP claims server-owned identity once and atomically retires the drain guard", async () => {
  seedVersion();
  const registry = new Registry();
  registry.applyDiscovery([
    discovered("claimed"),
    discovered("unbound"),
    discovered("manual"),
    discovered("repair"),
    discovered("concurrent"),
    discovered("prompted"),
  ]);
  const queues = new QueueManager(registry);
  const personas = new PersonaManager(registry);
  // Everything the `repair` binding's Live nudge needs to actually be typed somewhere. The
  // other bindings stay Preview, so this changes nothing for them.
  const injected: string[] = [];
  const workflows = new WorkflowManager(registry, personas.store, {
    queueManager: queues,
    inject: (async (
      _session: unknown,
      payload: string,
      _deps?: unknown,
      beforeWrite?: () => string | null,
    ) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    }) as never,
    recordInjection: (() => {}) as never,
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Original goal", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "claimed", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "abc",
          diffFingerprint: "diff",
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [],
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
          headSha: "abc",
          transcriptPath: null,
          transcriptSize: 1,
          repositoryFingerprint: "repo",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test"),
  });
  const claimedBinding = workflows.store.insertBinding({
    id: "binding",
    workflowVersionId: "v",
    noteKey: "claimed",
    sessionId: "claimed",
    sessionAgent: "claude",
    sessionName: "claimed",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 1,
  });
  workflows.store.insertBinding({
    id: "manual-binding",
    workflowVersionId: "v",
    noteKey: "manual",
    sessionId: "manual",
    sessionAgent: "claude",
    sessionName: "manual",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 1,
  });
  const repairBinding = workflows.store.insertBinding({
    id: "repair-binding",
    workflowVersionId: "v",
    noteKey: "repair",
    sessionId: "repair",
    sessionAgent: "claude",
    sessionName: "repair",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    // LIVE, unlike its siblings, and that is the point of this binding now. An
    // unchanged-evidence refusal answers with a nudge packet, and it is that packet's confirmed
    // delivery that re-arms the completion episode. Under Preview nothing is ever typed, so
    // nothing re-arms - which is the deliberate design, and why the round-limit sequence below
    // used to need `wrapup_asked_at` cleared with raw SQL to continue.
    deliveryMode: "live",
    maxRepairRounds: 1,
    now: 1,
  });
  const concurrentBinding = workflows.store.insertBinding({
    id: "concurrent-binding",
    workflowVersionId: "v",
    noteKey: "concurrent",
    sessionId: "concurrent",
    sessionAgent: "claude",
    sessionName: "concurrent",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 1,
  });
  const promptedBinding = workflows.store.insertBinding({
    id: "prompted-binding",
    workflowVersionId: "v",
    noteKey: "prompted",
    sessionId: "prompted",
    sessionAgent: "claude",
    sessionName: "prompted",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 1,
  });
  registry.upsertGoal("prompted", {
    prompt: "Finish the prompted workflow",
    text: "Finish the prompted workflow",
    objective: "Finish the prompted workflow",
    focus: "Finish the prompted workflow",
    relationship: "initial",
    rationale: "Initial objective",
    objectiveVersion: 1,
    promptRevision: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
    source: "heuristic",
  }, 5);
  const db = openDb();
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES ('claimed', '/repo', 'feature', NULL, NULL, NULL, 10)`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES ('repair', '/repo', 'feature', NULL, NULL, NULL, 10)`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES ('concurrent', '/repo', 'feature', NULL, NULL, NULL, 10)`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES ('prompted', '/repo', 'feature', NULL, NULL, 'intent:1:1', 10)`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
       send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
       proposed_payload, recovered_at, revision, created_at, updated_at, sent_at, completed_at
     ) VALUES (
       'repair-item', 'repair', 0, 'work', 'verified', 1, 'base', 1, '[]',
       1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2
     )`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
       send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
       proposed_payload, recovered_at, revision, created_at, updated_at, sent_at, completed_at
     ) VALUES (
       'concurrent-item', 'concurrent', 0, 'work', 'verified', 1, 'base', 1, '[]',
       1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2
     )`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
       send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
       proposed_payload, recovered_at, revision, created_at, updated_at, sent_at, completed_at
     ) VALUES (
       'item', 'claimed', 0, 'work', 'verified', 1, 'base', 1, '[]',
       1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2
     )`,
  ).run();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    queues,
    undefined,
    personas,
    workflows,
  );
  setForemanConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: ["/repo"],
  });

  const bindingsBeforeUnbound = workflows.store.listBindings().length;
  assert.deepEqual(await (await request(app, "unbound", "0".repeat(64))).json(), {
    claimed: false,
    reason: "no_binding",
  });
  // A claim on an unbound conversation is answered, never satisfied by binding something.
  // This is the invariant that keeps completion single-owner: nothing reachable through
  // this route can create the second PR-producing path.
  assert.equal(workflows.store.activeBindingForNote("unbound"), null);
  assert.equal(workflows.store.listBindings().length, bindingsBeforeUnbound);

  // An older or hand-rolled client still sending the retired `fallbackWorkflow` field gets
  // the same answer: the schema drops the unknown key rather than honouring it.
  const retiredField = await request(
    app,
    "unbound",
    "7".repeat(64),
    "drain",
    null,
    { fallbackWorkflow: "builtin-review" },
  );
  assert.equal(retiredField.status, 200);
  assert.deepEqual(await retiredField.json(), { claimed: false, reason: "no_binding" });
  assert.equal(workflows.store.activeBindingForNote("unbound"), null);
  assert.equal(workflows.store.listBindings().length, bindingsBeforeUnbound);

  assert.deepEqual(await (await request(app, "manual", "1".repeat(64))).json(), {
    claimed: false,
    reason: "manual_trigger",
  });
  assert.equal(workflows.store.activeBindingForNote("manual")?.id, "manual-binding");

  const concurrent = await Promise.all([
    request(app, "concurrent", "f".repeat(64)),
    request(app, "concurrent", "f".repeat(64)),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
  const concurrentBodies = await Promise.all(concurrent.map((response) => response.json())) as Array<{
    claimed: boolean;
    runId: string;
    submissionId: string;
    state: string;
  }>;
  assert.deepEqual(
    new Set(concurrentBodies.map((body) => body.state)),
    new Set(["started", "already_claimed"]),
  );
  assert.equal(new Set(concurrentBodies.map((body) => body.runId)).size, 1);
  const concurrentRun = concurrentBodies[0]!.runId;
  assert.equal(workflows.store.getRun(concurrentRun)?.bindingId, concurrentBinding.id);
  assert.equal(workflows.store.listSubmissions(concurrentRun).length, 1);

  const heldPrompted = await request(app, "prompted", "e".repeat(64), "prompted");
  assert.equal(heldPrompted.status, 409);
  assert.equal(workflows.store.latestRunForBinding(promptedBinding.id), null);
  // Re-arm the prompted episode through the Registry's own wrap-up writer rather than the
  // column, so the next case is set up the way the daemon would set it up.
  registry.setQueueWrapup("prompted", { promptedGoal: null });
  const stalePrompted = await request(
    app,
    "prompted",
    "d".repeat(64),
    "prompted",
    { ...PROMPTED_INTENT, objective: "The prompt the verifier actually judged" },
  );
  assert.equal(stalePrompted.status, 409);
  assert.equal(workflows.store.latestRunForBinding(promptedBinding.id), null);
  const staleRevision = await request(
    app,
    "prompted",
    "c".repeat(64),
    "prompted",
    { ...PROMPTED_INTENT, promptRevision: 2, episodeKey: "intent:1:2" },
  );
  assert.equal(staleRevision.status, 409);
  assert.equal(workflows.store.latestRunForBinding(promptedBinding.id), null);
  const stalePromptedGuard = db.prepare(
    `SELECT prompted_goal FROM foreman_queues WHERE note_key = 'prompted'`,
  ).get() as { prompted_goal: string | null };
  assert.equal(stalePromptedGuard.prompted_goal, null);
  const retriedPrompted = await request(app, "prompted", "e".repeat(64), "prompted");
  assert.equal(retriedPrompted.status, 200);
  const promptedBody = await retriedPrompted.json() as { claimed: boolean; runId: string; state: string };
  assert.equal(promptedBody.claimed, true);
  assert.equal(promptedBody.state, "started");
  assert.equal(workflows.store.getRun(promptedBody.runId)?.bindingId, promptedBinding.id);
  const promptedGuard = db.prepare(
    `SELECT prompted_goal, prompted_evidence FROM foreman_queues WHERE note_key = 'prompted'`,
  ).get() as { prompted_goal: string | null; prompted_evidence: string | null };
  assert.equal(promptedGuard.prompted_goal, "intent:1:1");
  assert.equal(promptedGuard.prompted_evidence, "e".repeat(64));

  const advancedPrompted = await request(app, "prompted", "9".repeat(64), "prompted");
  assert.equal(advancedPrompted.status, 200, "new evidence on the same intent must re-arm");
  const advancedBody = await advancedPrompted.json() as {
    claimed: boolean;
    runId: string;
    state: string;
  };
  assert.equal(advancedBody.claimed, true);
  assert.notEqual(advancedBody.runId, promptedBody.runId);
  const replayPrompted = await request(app, "prompted", "9".repeat(64), "prompted");
  assert.equal(replayPrompted.status, 200);
  const replayBody = await replayPrompted.json() as {
    claimed: boolean;
    runId: string;
    state: string;
  };
  assert.equal(replayBody.runId, advancedBody.runId, "one proof may claim the binding only once");
  assert.equal(replayBody.state, "already_claimed");

  const first = await request(app, "claimed", "2".repeat(64));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as {
    claimed: boolean;
    runId: string;
    submissionId: string;
    state: string;
  };
  assert.equal(firstBody.claimed, true);
  assert.equal(firstBody.state, "started");
  assert.equal(workflows.store.getRun(firstBody.runId)?.bindingId, claimedBinding.id);
  assert.equal(workflows.store.getSubmission(firstBody.submissionId)?.triggerSource, "foreman");
  const guard = db.prepare(
    `SELECT wrapup_asked_at, wrapup_answer FROM foreman_queues WHERE note_key = 'claimed'`,
  ).get() as { wrapup_asked_at: number | null; wrapup_answer: string | null };
  assert.equal(typeof guard.wrapup_asked_at, "number");
  assert.equal(guard.wrapup_answer, `workflow:${firstBody.runId}`);

  const duplicate = await request(app, "claimed", "2".repeat(64));
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json() as { runId: string; submissionId: string; state: string };
  assert.equal(duplicateBody.state, "already_claimed");
  assert.equal(duplicateBody.runId, firstBody.runId);
  assert.equal(duplicateBody.submissionId, firstBody.submissionId);
  assert.equal(workflows.store.listSubmissions(firstBody.runId).length, 1);

  assert.equal(workflows.store.getRun(firstBody.runId)?.status, "completed");
  // A SECOND wrap-up episode on the same binding. Re-armed through the QueueManager method
  // that owns this transition rather than by hand-writing the columns - `SessionQueue.add` is
  // the other production route to the same place, and it needs an instrumented session this
  // fixture's raw-seeded queues do not have.
  queues.rearmWorkflowCompletion("claimed");
  const nextEpisode = await request(app, "claimed", "5".repeat(64));
  assert.equal(nextEpisode.status, 200);
  const nextEpisodeBody = await nextEpisode.json() as {
    claimed: boolean;
    runId: string;
    submissionId: string;
    state: string;
  };
  assert.equal(nextEpisodeBody.claimed, true);
  assert.equal(nextEpisodeBody.state, "started");
  assert.notEqual(nextEpisodeBody.runId, firstBody.runId);
  assert.equal(workflows.store.getRun(nextEpisodeBody.runId)?.bindingId, claimedBinding.id);

  // Workflows Live is a SEPARATE consent from Foreman's, granted only now and only for the
  // repair sequence below - the auto-bind assertions above depend on it NOT being granted.
  // `liveEnabled` is left to its default so a revert of that default surfaces here as a failure
  // rather than being masked by an explicit `true`.
  setWorkflowPolicy({ repoAllowlist: ["/repo"] });

  const repairContext = fallbackWorkflowContext({
    primaryGoal: { rawPrompt: "Original goal", refined: null, sourceNoteKey: "repair" },
    humanDecisions: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "claimed", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "patch",
      diffTruncated: false,
      workingTreeDirty: true,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: 1,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
  }, "test");
  const { workflowContextFingerprint } = await import("../src/server/workflows/context.ts");
  const seeded = workflows.store.createInitialSubmission(
    {
      id: "repair-run",
      binding: repairBinding,
      triggerSource: "foreman",
      triggerKey: "foreman:repair:old",
      now: 20,
    },
    {
      id: "repair-submission-1",
      triggerSource: "foreman",
      triggerKey: "foreman:repair:old",
      context: {},
      evidence: {},
      now: 20,
    },
  );
  workflows.store.updateSubmissionCapture(seeded.submission.id, {
    context: repairContext as never,
    evidence: repairContext.evidence as never,
    fingerprint: workflowContextFingerprint(repairContext),
    status: "waiting_for_session",
  }, 21);
  workflows.store.setRunState(seeded.run.id, "waiting_for_session", "persona_feedback", null, 21);
  const unchanged = await request(app, "repair", "3".repeat(64));
  assert.equal(unchanged.status, 200);
  const unchangedBody = await unchanged.json() as { claimed: boolean; state: string; submissionId: string };
  assert.equal(unchangedBody.claimed, true);
  assert.equal(unchangedBody.state, "blocked");
  assert.equal(workflows.store.getSubmission(unchangedBody.submissionId)?.round, 2);
  assert.equal(workflows.store.getRun("repair-run")?.currentPhase, "unchanged_evidence");

  // No SQL here any more. The refusal above prepared an unchanged-evidence nudge, Live typed it
  // into the pane, and confirming that delivery re-armed the drain episode - so the next claim
  // below is one the daemon really would receive rather than one the test manufactured.
  await waitFor(
    () => injected.some((payload) => /reported complete, but nothing changed/.test(payload)),
    "the unchanged-evidence refusal never delivered a nudge",
  );
  const rearmedGuard = db.prepare(
    `SELECT wrapup_asked_at FROM foreman_queues WHERE note_key = 'repair'`,
  ).get() as { wrapup_asked_at: number | null };
  assert.equal(rearmedGuard.wrapup_asked_at, null, "the nudge's delivery must re-arm the episode");
  const capped = await request(app, "repair", "4".repeat(64));
  assert.equal(capped.status, 200);
  const cappedBody = await capped.json() as { claimed: boolean; state: string; submissionId: string | null };
  assert.equal(cappedBody.claimed, true);
  assert.equal(cappedBody.state, "blocked");
  assert.equal(cappedBody.submissionId, null);
  assert.equal(workflows.store.listSubmissions("repair-run").length, 2);
  assert.equal(workflows.store.getRun("repair-run")?.currentPhase, "round_limit");
});
