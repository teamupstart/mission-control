import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, Task } from "../src/shared/types.ts";

// The whole reported failure, end to end, at the seams a person actually feels it:
// a dispatched ship session is launched, the composed prompt comes back through
// Claude's prompt hook, and Foreman's completion has to start the workflow run the
// session was bound to.
//
// WHY THIS EXISTS ALONGSIDE launch-presentation.test.ts. That file owns the Registry
// seam and proves the narrow property - a recognized echo opens no second prompt
// revision. It cannot prove the thing that was actually broken, because a prompt
// revision is four modules away from a `workflow_runs` row:
//
//   registry goal capture -> resolvedSessionIntent -> decidePromptedWrapup
//     -> the completion claim -> WorkflowStore.claimForemanCompletion
//
// Every one of those re-derives the intent guard from its own source, and the LAST of
// them reads `session_goals` back out of SQLite rather than trusting anything the
// caller passed. A guard that holds in memory and not on disk would pass the narrow
// test and still strand the session, which is the failure mode this file closes.
//
// The second test is the regression itself, not a mutant: before the fix
// `isSeededLaunchEcho` did not exist and the hook captured unconditionally, which is
// byte-for-byte what a marker carrying no `echo_fingerprint` produces today. So the
// pre-fix path is reachable from HEAD by nulling that one column, and it is asserted
// to fail at exactly the step the operator saw it fail at.

const home = mkdtempSync(join(tmpdir(), "mission-dispatched-launch-workflow-"));
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
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { substantivePrompt } = await import("../src/server/harness/claude/scaffolding.ts");
const { decidePromptedWrapup } = await import("../src/server/foreman/prompted-wrapup.ts");
const { promptedCompletionClaim } = await import("../src/server/foreman/workflow-claim.ts");
const { resolvedSessionIntent } = await import("../src/shared/goal.ts");

/** The operator's own request. Everything else in the delivered prompt is the platform's. */
const INTENT = "Look at the current sessions. None of them were submitted to their pipelines.";

const WRAPUP_CFG = {
  triggers: ["prompted"] as const,
  wrapup: "pr" as const,
  settleMs: 0,
  skipScoutWrapup: false,
  skipReviewArtifactWrapup: false,
};

function mkTask(): Task {
  return {
    id: "task-1",
    title: "Idle sessions are never submitted",
    intent: INTENT,
    kind: "ship",
    agent: "claude",
    priority: null,
    labels: [],
    dependencies: [],
    enabled: true,
    model: null,
    effort: null,
    workflowId: null,
    source: null,
    repoRoot: "/repo",
    worktreePath: "/repo",
    branch: null,
    provider: null,
    baseSha: null,
    extraRepos: [],
    homeName: null,
    terminalResourceId: null,
    sessionId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    error: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    createdAt: 1,
    updatedAt: 1,
    dispatchedAt: null,
    completedAt: null,
    backlogRank: null,
    pipelineRun: null,
    worktreeLeaseId: null,
    automaticCleanup: null,
  };
}

function seedVersion(db: ReturnType<typeof openDb>): void {
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [
      { id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" },
    ],
  };
  const defaults = JSON.stringify({
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 2,
  });
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

function mkWorkflows(
  registry: InstanceType<typeof Registry>,
  personas: InstanceType<typeof PersonaManager>,
  queues: InstanceType<typeof QueueManager>,
): InstanceType<typeof WorkflowManager> {
  return new WorkflowManager(registry, personas.store, {
    queueManager: queues,
    inject: (async () => ({ ok: true, pasted: true, submitVerified: true })) as never,
    recordInjection: (() => {}) as never,
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: INTENT, refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "ship", cwd: "/repo", branch: "feature" },
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
}

interface Dispatched {
  registry: InstanceType<typeof Registry>;
  workflows: InstanceType<typeof WorkflowManager>;
  queues: InstanceType<typeof QueueManager>;
  app: ReturnType<typeof buildApp>;
  sessionId: string;
  noteKey: string;
  bindingId: string;
  delivered: string;
  /** Exactly what Claude's prompt hook hands the Registry for that delivered prompt. */
  echoed: string;
}

/**
 * Dispatch a ship session the way the daemon does, up to the instant before the hook echo.
 *
 * The ordering here is the real one and it matters: the supervisor persists the launch
 * marker under the REGISTRATION id before the driver can stream, the conversation binds to
 * its native id (which moves the marker), and only then is the operator's own request
 * captured as prompt revision one under that native key.
 */
function dispatch(slug: string): Dispatched {
  const db = openDb();
  const registry = new Registry();
  const queues = new QueueManager(registry);
  const personas = new PersonaManager(registry);
  const workflows = mkWorkflows(registry, personas, queues);
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry),
    queues,
    personas,
    workflows,
  });

  const task = mkTask();
  const delivered = withTaskKindContract(task, task.intent);
  const registrationId = `sdk:${slug}`;
  const noteKey = `agent:${slug}`;

  registry.recordLaunchTurnForKey(registrationId, delivered, task.intent, 1);
  registry.registerSdkSession({
    id: registrationId,
    agent: "claude",
    name: slug,
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
  });
  registry.bindLaunchedAgentSession(registrationId, "claude", noteKey);
  registry.captureAcceptedPrompt(registrationId, task.intent, noteKey, 2);

  // What the refiner writes for a first prompt it could classify. Tier 2 is a model call,
  // so its OUTPUT is seeded rather than its call - the reconciler's own behaviour is
  // goal-refiner.test.ts's subject, and faking the call would not make this test say more.
  registry.upsertGoal(registrationId, {
    objective: INTENT,
    text: INTENT,
    focus: INTENT,
    relationship: "initial",
    rationale: "Initial objective",
    objectiveVersion: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
    source: "model",
  }, 3);

  const bindingId = workflows.store.insertBinding({
    id: `binding-${slug}`,
    workflowVersionId: "v",
    noteKey,
    sessionId: registrationId,
    sessionAgent: "claude",
    sessionName: slug,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 1,
  }).id;
  db.prepare(
    `INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
     VALUES (?, '/repo', 'feature', NULL, NULL, NULL, 10)`,
  ).run(noteKey);

  const echoed = substantivePrompt(delivered);
  assert.ok(echoed, "the delivered prompt survives Claude's scaffolding filter");
  assert.notEqual(echoed, delivered, "and reaches the Registry with its whitespace collapsed");

  return { registry, workflows, queues, app, sessionId: registrationId, noteKey, bindingId, delivered, echoed };
}

/** Work, then park: one completed work cycle, hooks seen, settled idle. */
function workAndPark(registry: InstanceType<typeof Registry>, noteKey: string, at: number): void {
  registry.applyHook({
    agent: "claude", event: "PreToolUse", sessionId: noteKey, cwd: "/repo",
    transcriptPath: null, env: {}, toolName: "Edit", ts: at,
  });
  registry.applyHook({
    agent: "claude", event: "Stop", sessionId: noteKey, cwd: "/repo",
    transcriptPath: null, env: {}, ts: at + 1,
  });
}

function submitEcho(registry: InstanceType<typeof Registry>, noteKey: string, echoed: string, at: number): void {
  registry.applyHook({
    agent: "claude", event: "UserPromptSubmit", sessionId: noteKey, cwd: "/repo",
    transcriptPath: null, env: {}, prompt: echoed, ts: at,
  });
}

function wrapupDecision(
  d: Dispatched,
  now: number,
): ReturnType<typeof decidePromptedWrapup> {
  const session = d.registry.getSession(d.sessionId) as Session;
  return decidePromptedWrapup({
    session,
    bucket: "idle",
    queue: d.registry.getQueue(d.sessionId),
    intent: d.registry.getGoal(d.sessionId),
    cfg: WRAPUP_CFG,
    now,
  });
}

async function claim(d: Dispatched, generation: number) {
  const intent = resolvedSessionIntent(d.registry.getGoal(d.sessionId));
  assert.ok(intent, "a claim cannot be built without a resolved intent");
  const body = promptedCompletionClaim({
    noteKey: d.noteKey,
    workCycle: { logicalKey: d.noteKey, generation },
    intent,
    headSha: "abc",
    transcriptAnchor: 1,
    summary: "The requested change is implemented and verified.",
  });
  return await d.app.request(`/api/sessions/${d.sessionId}/workflow-completion`, {
    method: "POST",
    headers: { host: `127.0.0.1:7317`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

setForemanConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });

test("a dispatched ship session's launch echo settles, and Foreman's completion starts its bound workflow run", async () => {
  const db = openDb();
  seedVersion(db);
  const d = dispatch("green");

  // 1. The operator's request is prompt revision one, and the refiner resolved it.
  assert.equal(d.registry.getGoal(d.sessionId)?.promptRevision, 1);
  assert.ok(resolvedSessionIntent(d.registry.getGoal(d.sessionId)));

  // 2. The launch comes back through the prompt hook. It is recognized, so it is not a
  //    second instruction - the objective is still the operator's, still resolved.
  submitEcho(d.registry, d.noteKey, d.echoed, 4);
  const goal = d.registry.getGoal(d.sessionId);
  assert.equal(goal?.promptRevision, 1, "the echo opened no second revision");
  assert.equal(goal?.resolvedPromptRevision, 1);
  assert.equal(goal?.objective, INTENT);
  assert.equal(goal?.relationship, "initial");

  // 3. The agent works and parks.
  workAndPark(d.registry, d.noteKey, 5);
  const decision = wrapupDecision(d, 10_000);
  assert.equal(
    decision.kind,
    "check",
    `Foreman must spend a verifier call here, not skip: ${JSON.stringify(decision)}`,
  );
  assert.equal(decision.kind === "check" ? decision.objective : null, INTENT);

  // 4. The verifier says complete, and Foreman claims the completion over the same HTTP
  //    route its out-of-process worker uses. This is the step the operator was watching
  //    for and never saw.
  const response = await claim(d, 1);
  const claimed = await response.json() as { claimed: boolean; runId: string; state: string };
  assert.equal(response.status, 200, JSON.stringify(claimed));
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.state, "started");

  // 5. The bound pipeline has a run. Read from the store, not from the reply, so this is
  //    the durable row and not the answer that promised one.
  const run = d.workflows.store.getRun(claimed.runId);
  assert.equal(run?.bindingId, d.bindingId);
  const rows = db.prepare(
    `SELECT id, binding_id FROM workflow_runs WHERE binding_id = ?`,
  ).all(d.bindingId) as Array<{ id: string; binding_id: string }>;
  assert.deepEqual(rows.map((r) => r.id), [claimed.runId], "exactly one run, and it is that one");
});

test("the regression: an unrecognized launch echo strands the same session short of its workflow", async () => {
  const db = openDb();
  const d = dispatch("stranded");

  // Exactly the pre-fix Registry. Before this change `isSeededLaunchEcho` did not exist
  // and every hook prompt was captured; a marker with no echo fingerprint takes the same
  // branch today, because absence means "cannot recognize the echo" by design. Nulled in
  // SQLite and reloaded so the null arrives through the boot path a restart would use.
  db.prepare(`UPDATE session_launch_turns SET echo_fingerprint = NULL WHERE note_key = ?`)
    .run(d.noteKey);
  const stale = new Registry();
  const queues = new QueueManager(stale);
  const personas = new PersonaManager(stale);
  const workflows = mkWorkflows(stale, personas, queues);
  stale.registerSdkSession({
    id: d.sessionId, agent: "claude", name: "stranded", cwd: "/repo",
    gitBranch: "feature", gitRoot: "/repo", repoRoot: "/repo",
  });
  stale.bindLaunchedAgentSession(d.sessionId, "claude", d.noteKey);
  const before: Dispatched = { ...d, registry: stale, workflows, queues };

  assert.equal(stale.getGoal(d.sessionId)?.promptRevision, 1, "the durable Goal is unchanged");
  submitEcho(stale, d.noteKey, d.echoed, 4);

  // The platform's own contract sections are now an unreconciled second instruction.
  const goal = stale.getGoal(d.sessionId);
  assert.equal(goal?.promptRevision, 2, "the echo was taken for a new human instruction");
  assert.equal(goal?.resolvedPromptRevision, 1, "and the refiner has not caught up");
  assert.equal(resolvedSessionIntent(goal), null);

  // Which is the whole bug: the session parks, and Foreman declines to look at it.
  workAndPark(stale, d.noteKey, 5);
  const decision = wrapupDecision(before, 10_000);
  assert.deepEqual(decision, { kind: "skip", why: "the latest instruction has unresolved intent" });

  // No verifier call, no claim, no run - the session sits idle with an armed binding.
  assert.equal(workflows.store.activeBindingForNote(d.noteKey)?.triggerMode, "foreman_complete");
  assert.equal(workflows.store.latestRunForBinding(d.bindingId), null);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE binding_id = ?`)
      .get(d.bindingId) as { n: number }).n,
    0,
  );
});
