import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
process.env.MISSION_GOAL_POLL_MS = "10";
process.env.MISSION_GOAL_REFRESH_MS = "0";
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, getSessionGoal } = await import("../src/server/db.ts");
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
const { taskCompletionContract } = await import("../src/shared/task-completion.ts");
const { processPromptedWrapup } = await import("../src/server/foreman/worker.ts");
const { ForemanClient } = await import("../src/server/foreman/client.ts");
const { ForemanConfigSchema } = await import("../src/shared/protocol.ts");
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const { startGoalRefiner } = await import("../src/server/goal/refiner.ts");

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
    workUnitId: null,
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
    advisorModel: null,
    personaId: null,
    workflowId: null,
    source: null,
    sourceParent: null,
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
        primaryGoal: { rawPrompt: registry.getGoal(binding.sessionId!)?.objective ?? INTENT, refined: null, sourceNoteKey: binding.noteKey },
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
function dispatch(slug: string, taskOverrides: Partial<Task> = {}, seedGoal = true): Dispatched {
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

  const task = { ...mkTask(), ...taskOverrides };
  const delivered = withTaskKindContract(task, task.intent, {
    planSkills: { htmlPlans: "/html-plans", phasedPlan: "/phased-plan" },
  });
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
  registry.upsertTask({ ...task, id: `task-${slug}`, sessionId: registrationId });

  // What the refiner writes for a first prompt it could classify. Tier 2 is a model call,
  // so its OUTPUT is seeded rather than its call - the reconciler's own behaviour is
  // goal-refiner.test.ts's subject, and faking the call would not make this test say more.
  if (seedGoal) registry.upsertGoal(registrationId, {
    objective: task.intent,
    text: task.intent,
    focus: task.intent,
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

function submitEcho(registry: InstanceType<typeof Registry>, noteKey: string, echoed: string, at: number, transcriptPath: string | null = null): void {
  registry.applyHook({
    agent: "claude", event: "UserPromptSubmit", sessionId: noteKey, cwd: "/repo",
    transcriptPath, env: {}, prompt: echoed, ts: at,
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

/**
 * Drive the worker's actual orchestration, not a test-authored verify/claim sequence.
 * File evidence is supplied; ownership, intent, queue, and completion requests use the real
 * ForemanClient against the isolated daemon app. Only the SDK's model result is scripted.
 */
function planWrapupFixture(t: TestContext, slug: string, hooks: {
  duringVerify?: (d: Dispatched) => void;
  beforeRequest?: (path: string, d: Dispatched) => void;
  afterRequest?: (path: string, d: Dispatched) => void;
} = {}) {
  const d = dispatch(slug, {
    kind: "plan", workflowId: "w",
    intent: "Write an approved phased plan, schedule its tasks, and open a pull request.",
  });
  const now = Date.now() - 30_000;
  submitEcho(d.registry, d.noteKey, d.echoed, now);
  workAndPark(d.registry, d.noteKey, now + 1);
  const client = new ForemanClient();
  const writes: string[] = [];
  t.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") writes.push(path);
    hooks.beforeRequest?.(path, d);
    request.headers.set("host", "127.0.0.1:7317");
    const response = await d.app.request(request);
    hooks.afterRequest?.(path, d);
    return response;
  });
  t.mock.method(client, "diff", async () => ({
    ok: true, error: null, base: "main", baseSha: "base", headSha: "abc",
    repoRoot: "/repo", branch: "feature", filesChanged: 1, insertions: 1, deletions: 0,
    patch: "diff --git a/docs/plans/example/plan.md b/docs/plans/example/plan.md\n+++ b/docs/plans/example/plan.md\n+Approved plan\n",
    truncated: false,
  }));
  t.mock.method(client, "transcriptSize", async () => 1);
  t.mock.method(client, "transcript", async () => ({ messages: [], truncated: false }));
  t.mock.method(client, "standards", async () => ({ docs: [], truncated: false }));
  t.mock.method(client, "instructions", async () => "");
  const prompts: string[] = [];
  t.after(configureClaudeRunnerTransport(() => "sdk", {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      assert.ok(typeof prompt === "string", "verification uses a one-shot prompt");
      prompts.push(prompt);
      assert.deepEqual(options.tools, [], "the real verifier remains tool-less");
      hooks.duringVerify?.(d);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", is_error: false, structured_output: {
            complete: true, confidence: 1, gaps: [], resolved: [],
            summary: "Approved plan, pushed artifacts, and dependent tasks are ready. PR deferred to the workflow.",
          } };
        },
      };
    },
  }));
  const cfg = ForemanConfigSchema.parse({
    enabled: true, mode: "live", repoAllowlist: ["/repo"],
    wrapup: "pr", wrapupTriggers: ["prompted"], skipScoutWrapup: false, skipReviewArtifactWrapup: false,
  });
  const tick = async () => {
    const session = d.registry.getSession(d.sessionId)!;
    assert.equal(session.prUrl, null, "the planning session has no PR");
    return processPromptedWrapup(client, cfg, session, [session], d.registry.getQueue(d.sessionId), new Set());
  };
  return { d, tick, writes, prompts, client };
}

for (const boundary of ["claim response", "consumption request", "SQL consumption"] as const) {
  for (const owner of ["skill", "automatic workflow", "Manual workflow", "unavailable"] as const) {
    test(`an unbound plan guards ${owner} ownership at the ${boundary}`, async (t) => {
      let claimReturned = false;
      const attach = (d: Dispatched) => {
        if (owner === "skill") return;
        const previous = d.workflows.store.getBinding(d.bindingId)!;
        const replacement = d.workflows.store.insertBinding({
          ...previous, id: `${previous.id}-replacement`, sessionId: d.sessionId,
          triggerMode: owner === "Manual workflow" ? "manual" : "foreman_complete", now: Date.now(),
        });
        if (owner === "unavailable") d.workflows.store.updateBinding(replacement.id, { state: "paused" });
      };
      const { d, tick, writes, prompts, client } = planWrapupFixture(t, `plan-direct-${boundary}-${owner}`, {
        beforeRequest: (path, d) => {
          if (boundary === "consumption request" && path.endsWith("/queue/wrapup/prompted")) attach(d);
        },
        afterRequest: (path, d) => {
          if (!path.endsWith("/workflow-completion")) return;
          claimReturned = true;
          if (boundary === "claim response") attach(d);
        },
      });
      d.workflows.archiveBinding(d.bindingId);
      if (boundary === "SQL consumption") {
        const db = openDb();
        const prepare = db.prepare.bind(db);
        t.mock.method(db, "prepare", (sql: string) => {
          const statement = prepare(sql);
          // All Registry checks and earlier reads have finished; ownership changes just
          // before the SQL statement that records the direct handoff executes.
          if (sql.includes("INSERT INTO foreman_queues (") && sql.includes("FROM session_work_cycles")) attach(d);
          return statement;
        });
      }
      const injections: string[] = [];
      t.mock.method(client, "inject", async (_id: string, payload: string) => { injections.push(payload); });
      const advanced = await tick();
      assert.equal(claimReturned, true, "the real daemon already returned its unbound answer");
      assert.equal(prompts.length, 1);
      assert.equal(advanced, owner === "skill");
      const queue = d.registry.getQueue(d.sessionId)!;
      if (owner === "skill") {
        assert.equal(injections.length, 1, "stable skill ownership retains direct PR shipping");
        assert.equal(queue.promptedDecision?.outcome, "direct_handoff");
        assert.ok(queue.promptedDirectHandoff);
      } else {
        assert.deepEqual(injections, [], "a stale no-binding answer never authorizes direct publication");
        const sessionPath = `/api/sessions/${encodeURIComponent(d.sessionId)}`;
        assert.deepEqual(writes, [
          `${sessionPath}/workflow-completion`,
          ...(boundary === "claim response" ? [] : [`${sessionPath}/queue/wrapup/prompted`]),
        ]);
        assert.equal(queue.promptedConsumedGeneration, null);
        assert.equal(queue.promptedDecision, null);
        assert.equal(queue.promptedDirectHandoff, null);
      }
      const runs = openDb().prepare(`SELECT r.id FROM workflow_runs r
        JOIN workflow_bindings b ON b.id = r.binding_id WHERE b.note_key = ?`).all(d.noteKey);
      assert.equal(runs.length, 0);
    });
  }
}

test("Foreman's prompted plan handoff supplies the PR deferral and claims its workflow exactly once", async (t) => {
  const { d, tick, writes, prompts } = planWrapupFixture(t, "plan-ready");
  assert.equal(await tick(), true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Write an approved phased plan, schedule its tasks, and open a pull request/);
  const contract = taskCompletionContract("plan", true)!;
  for (const action of contract.deferred) assert.ok(prompts[0]!.includes(action.noun), `missing verifier deferral: ${action.id}`);
  for (const requirement of contract.complete) assert.ok(prompts[0]!.includes(requirement), `missing planning requirement: ${requirement}`);
  assert.deepEqual(writes, [`/api/sessions/${encodeURIComponent(d.sessionId)}/workflow-completion`]);
  const runs = openDb().prepare("SELECT id FROM workflow_runs WHERE binding_id = ?").all(d.bindingId);
  assert.equal(runs.length, 1, "the actual worker claim created one durable workflow run");
  assert.equal(d.registry.getQueue(d.sessionId)?.promptedDecision?.outcome, "workflow_claimed");
  assert.equal(await tick(), false, "the consumed generation cannot claim or verify again");
  assert.equal(prompts.length, 1);
  assert.equal(writes.length, 1, "no direct PR injection or duplicate claim");
});

for (const change of ["binding", "version", "trigger", "state"] as const) {
  test(`a Manual plan does not consume its ask after a ${change} change at the SQL write`, async (t) => {
    const { d, tick, writes } = planWrapupFixture(t, `manual-consume-${change}`);
    const binding = d.workflows.store.updateBinding(d.bindingId, { triggerMode: "manual" })!;
    const db = openDb();
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("INSERT INTO foreman_queues (") && sql.includes("FROM session_work_cycles")) {
        if (change === "binding") {
          d.workflows.archiveBinding(binding.id);
          d.workflows.store.insertBinding({ ...binding, id: `${binding.id}-replacement`, sessionId: d.sessionId, now: Date.now() });
        } else if (change === "version") {
          prepare("UPDATE workflow_bindings SET workflow_version_id = 'unavailable-version' WHERE id = ?").run(binding.id);
        } else {
          d.workflows.store.updateBinding(binding.id, change === "trigger" ? { triggerMode: "foreman_complete" } : { state: "paused" });
        }
      }
      return statement;
    });
    assert.equal(await tick(), false);
    const sessionPath = `/api/sessions/${encodeURIComponent(d.sessionId)}`;
    assert.deepEqual(writes, [`${sessionPath}/workflow-completion`, `${sessionPath}/queue/wrapup/prompted`]);
    const queue = d.registry.getQueue(d.sessionId)!;
    assert.equal(queue.promptedConsumedGeneration, null);
    assert.equal(queue.promptedDecision, null);
    assert.equal(queue.wrapupAskedAt, null);
    assert.equal(queue.promptedDirectHandoff, null);
  });
}

test("Foreman's prompted plan handoff preserves a stable Manual binding and asks without publishing", async (t) => {
  // Manual from the first ownership read through completion, unlike the stale-binding case.
  const { d, tick, writes, prompts } = planWrapupFixture(t, "plan-manual");
  const binding = d.workflows.store.updateBinding(d.bindingId, { triggerMode: "manual" });
  assert.equal(await tick(), true);
  assert.equal(prompts.length, 1, "the Manual plan still reaches verification");
  for (const action of taskCompletionContract("plan", true)!.deferred) {
    assert.ok(prompts[0]!.includes(action.noun), `missing Manual-plan verifier deferral: ${action.id}`);
  }
  const sessionPath = `/api/sessions/${encodeURIComponent(d.sessionId)}`;
  assert.deepEqual(writes, [
    `${sessionPath}/workflow-completion`,
    `${sessionPath}/queue/wrapup/prompted`,
  ], "the worker records an ask without injecting direct PR work");
  assert.equal(d.workflows.store.latestRunForBinding(d.bindingId), null, "Manual submission has not started a workflow run");
  assert.deepEqual(d.workflows.store.getBinding(d.bindingId), binding, "the active Manual binding is preserved");
  const queue = d.registry.getQueue(d.sessionId)!;
  assert.equal(queue.promptedDecision?.outcome, "asked");
  assert.equal(typeof queue.wrapupAskedAt, "number", "the verified completion is surfaced for manual submission");
  assert.equal(queue.wrapupAnswer, null);
  assert.equal(queue.promptedDirectHandoff, null, "no direct-shipping handoff is recorded");
  assert.equal(await tick(), false, "the same completed generation cannot verify or ask again");
  assert.equal(prompts.length, 1);
  assert.equal(writes.length, 2);
});

for (const scenario of ["unavailable", "during verification", "before completion", "vanished at claim"] as const) {
  test(`Foreman's prompted plan handoff holds ownership ${scenario}`, async (t) => {
    let contextReads = 0;
    const { d, tick, writes, prompts } = planWrapupFixture(t, `plan-${scenario.replaceAll(" ", "-")}`, {
      duringVerify: (d) => {
        if (scenario === "during verification") d.workflows.store.updateBinding(d.bindingId, { triggerMode: "manual" });
      },
      beforeRequest: (path, d) => {
        if (path.endsWith("/plan-publication")) {
          contextReads++;
          if (scenario === "unavailable" || (scenario === "before completion" && contextReads === 3)) {
            d.workflows.store.updateBinding(d.bindingId, { state: "paused" });
          }
        }
        if (scenario === "vanished at claim" && path.endsWith("/workflow-completion")) d.workflows.archiveBinding(d.bindingId);
      },
    });
    assert.equal(await tick(), false);
    assert.equal(prompts.length, scenario === "unavailable" ? 0 : 1);
    assert.equal(contextReads, scenario === "unavailable" ? 1 : scenario === "during verification" ? 2 : 3);
    assert.deepEqual(writes, scenario === "vanished at claim"
      ? [`/api/sessions/${encodeURIComponent(d.sessionId)}/workflow-completion`] : []);
    assert.equal(d.workflows.store.latestRunForBinding(d.bindingId), null);
    assert.equal(d.registry.getQueue(d.sessionId)?.promptedDecision, null, "no consumed generation or direct PR fallback");
  });
}

for (const boundary of ["HTTP claim", "store transaction"] as const) {
  for (const change of ["binding", "version", "trigger mode"] as const) {
    test(`Foreman's plan verdict cannot cross a changed ${change} at the ${boundary}`, async (t) => {
      const replaceOwnership = (d: Dispatched) => {
        const binding = d.workflows.store.getBinding(d.bindingId)!;
        if (change === "binding") {
          d.workflows.archiveBinding(binding.id);
          d.workflows.store.insertBinding({
            ...binding, id: `${binding.id}-replacement`, sessionId: d.sessionId, now: Date.now(),
          });
        } else if (change === "version") {
          const db = openDb();
          const versionId = `v-${d.bindingId}`;
          const revision = boundary === "HTTP claim" ? 2 : 3;
          db.prepare(`INSERT INTO workflow_versions (
            id, workflow_id, version, source_draft_revision, graph_json,
            completion_policy_json, binding_defaults_json, published_at
          ) SELECT ?, workflow_id, ?, ?, graph_json,
            completion_policy_json, binding_defaults_json, published_at
            FROM workflow_versions WHERE id = 'v'`).run(versionId, revision, revision);
          db.prepare("UPDATE workflow_bindings SET workflow_version_id = ? WHERE id = ?")
            .run(versionId, binding.id);
        } else {
          d.workflows.store.updateBinding(binding.id, { triggerMode: "manual" });
        }
      };
      const { d, tick, writes, prompts } = planWrapupFixture(t, `plan-race-${boundary}-${change}`, {
        beforeRequest: (path, d) => {
          if (boundary === "HTTP claim" && path.endsWith("/workflow-completion")) replaceOwnership(d);
        },
      });
      if (boundary === "store transaction") {
        // The manager has selected its binding. Change durable ownership immediately before
        // the transaction starts, proving that a manager-only comparison is insufficient.
        const store = d.workflows.store;
        const claim = store.claimForemanCompletion.bind(store);
        t.mock.method(store, "claimForemanCompletion", (input: Parameters<typeof claim>[0]) => {
          replaceOwnership(d);
          return claim(input);
        });
      }
      assert.equal(await tick(), false, "stale ownership must hold instead of claiming or asking");
      assert.equal(prompts.length, 1, "verification finished before the binding changed");
      assert.deepEqual(writes, [`/api/sessions/${encodeURIComponent(d.sessionId)}/workflow-completion`]);
      const runs = openDb().prepare(`SELECT r.id FROM workflow_runs r
        JOIN workflow_bindings b ON b.id = r.binding_id WHERE b.note_key = ?`).all(d.noteKey);
      assert.equal(runs.length, 0, "neither the old nor the replacement binding received the stale verdict");
      const queue = d.registry.getQueue(d.sessionId)!;
      assert.equal(queue.promptedConsumedGeneration, null);
      assert.equal(queue.promptedDecision, null);
      assert.equal(queue.promptedDirectHandoff, null);
    });
  }
}

const MOCKUP_OBJECTIVE = "Create mockups of alternatives for displaying conversation pills when they wrap.";
const IMPLEMENTATION_OBJECTIVE = "Implement counts on section headings in the conversation Idle rail when its pills wrap.";
const REPLACEMENT_OBJECTIVE = "Implement heading counts only for collapsed sections in the conversation Idle rail.";
const DESIGN_SELECTION = "lets go forward with counts on section headings, that is it, 100%";

const INITIAL_RESTRICTIONS = new Map([
  ["no PR omitted marker", `${DESIGN_SELECTION}. Do not submit this for review or open a PR.`],
  ["embedded no PR", "Implement counts on section headings, but do not open a PR."],
  ["comma-separated no PR", "Implement counts on section headings, no PR"],
  ["do not make a pull request", "Implement counts on section headings. Do not make a pull request."],
  ["no PR yet", "Implement counts on section headings. Do not open a PR yet."],
  ["no PR until approval", "Implement counts on section headings. Do not open a PR until I approve."],
  ["no PR for this task", "Implement counts on section headings. Do not open a PR for this task."],
]);
const INITIAL_SELECTIONS = new Map([
  ...INITIAL_RESTRICTIONS,
  ["preference only", "Counts on section headings is my favorite."],
  ["ambiguous", "Counts, maybe? I am not sure what to do next."],
  ["delegates PR", `${DESIGN_SELECTION}. Don’t open a PR, let the bound Workflow open it.`],
]);
const FOLLOWUP_RESTRICTIONS = new Map([
  ["no PR as steering", "Do not open a PR."],
  ["do not submit a PR", "Do not submit a PR."],
  ["no PR for this change", "Do not open a PR for this change."],
  ["no PR for this work", "Do not open a PR for this work."],
  ["no PR for this implementation", "Do not open a pull request for this implementation."],
  ["no PR for this feature", "Implement the selected design. Do not open a PR for this feature."],
  ["no PR for this feature branch", "Do not open a PR for this feature branch."],
  ["do not submit this as a PR", "Implement the design. Don’t submit this as a PR."],
  ["combined release misses deliverable", "Do not open a PR."],
  ["combined release rewrites unrelated text", "Do not open a PR."],
  ["explicit stop", "Stop here."],
  ["stop working on this", "Stop working on this."],
  ["stop working on this task", "Stop working on this task."],
  ["stop work on this", "Stop work on this."],
  ["stop this task", "Stop this task."],
  ["stop the task", "Stop the task."],
  ["no PR for this", "Do not open a PR for this."],
  ["do not submit for review", "Do not submit this for review."],
  ["do not file a PR", "Do not file a PR."],
  ["no PR without approval", "Do not create a pull request without my approval."],
  ["combined stop and no PR", "Stop here and don't open a PR."],
  ["delegation requires approval", "Do not open a PR until I approve, then let the bound workflow open it."],
  ["full-length contract", "Do not open a PR without my approval."],
  ["model contextual hold", "Keep this local until I review it."],
]);

for (const scenario of [
  ...INITIAL_SELECTIONS.keys(),
  ...FOLLOWUP_RESTRICTIONS.keys(),
  "implementation", "hold survives replacement", "legacy hold survives replacement",
  "release from legacy hold", "release judged unclear", "release invents deliverable",
  "unclear restriction survives replacement", "artifact diff", "stale verdict", "recovery",
]) {
  test(`mockup exploration through the goal model and prompted worker: ${scenario}`, async (t) => {
    const slug = `mockup-transition-${scenario.replaceAll(" ", "-")}`;
    const d = dispatch(slug, { title: MOCKUP_OBJECTIVE, intent: MOCKUP_OBJECTIVE, kind: "bugfix", workflowId: "w" }, false);
    const now = Date.now() - 30_000;
    const transcriptPath = join(home, `${slug}.jsonl`);
    const selection = INITIAL_SELECTIONS.get(scenario) ?? DESIGN_SELECTION;
    const unclearRestriction = scenario === "unclear restriction survives replacement";
    const legacyRelease = scenario === "release from legacy hold";
    const legacyHold = scenario === "legacy hold survives replacement";
    const unclearRelease = scenario === "release judged unclear";
    const releaseInventsDeliverable = scenario === "release invents deliverable";
    const releaseAfterReplacement = scenario === "hold survives replacement" || unclearRelease || releaseInventsDeliverable;
    const replaceWhileHeld = releaseAfterReplacement || unclearRestriction || legacyHold;
    const contextualHold = scenario === "model contextual hold";
    const fullLengthContract = scenario === "full-length contract";
    const releaseWithoutReplacement = legacyRelease || contextualHold;
    const unrelatedRewrite = scenario === "combined release rewrites unrelated text";
    const combinedRelease = scenario === "combined release misses deliverable" || unrelatedRewrite;
    const followupRestriction = FOLLOWUP_RESTRICTIONS.get(scenario)
      ?? (replaceWhileHeld || legacyRelease ? "Do not open a PR." : null);
    let instruction = selection;
    let revision = 2;
    const readGoal = () => d.registry.getGoal(d.sessionId);
    const recordTranscript = (turns: Array<["user" | "assistant", string]>) => {
      writeFileSync(transcriptPath, turns.map(([role, content], index) => JSON.stringify({
        type: role,
        uuid: String(index),
        timestamp: new Date(now + index).toISOString(),
        message: { role, content },
      })).join("\n") + "\n");
    };

    const modelPrompts: string[] = [];
    const verifyPrompts: string[] = [];
    let refiner: ReturnType<typeof startGoalRefiner> | undefined;
    t.after(() => refiner?.());
    t.after(configureClaudeRunnerTransport(() => "sdk", {
      executable: async () => "/fake/bin/claude",
      env: () => ({ PATH: "/usr/bin" }),
      query: async ({ prompt, options }) => {
        assert.ok(typeof prompt === "string");
        assert.deepEqual(options.tools, []);
        let reply: object;
        if (prompt.includes("## The specific unresolved instruction to classify now")) {
          modelPrompts.push(prompt);
          const initial = readGoal()?.promptRevision === 1;
          if (!initial) {
            assert.ok(prompt.includes(instruction));
            assert.ok(prompt.includes("[assistant] The mockups are ready. One option puts counts on section headings."));
          }
          // At the provider seam, replay the installed policy's observed steer response
          // unless the actual goal prompt teaches the new deliverable distinction.
          const teachesTransition = prompt.includes("If exploration was the whole objective");
          const unclear = scenario === "ambiguous" || (unclearRelease && revision === 5)
            || (unclearRestriction && prompt.includes("\nDo not open a PR.\n"));
          const replace = !initial && teachesTransition
            && !unclear && scenario !== "preference only"
            && !(followupRestriction && revision === 3)
            && !(releaseWithoutReplacement && revision === 4)
            && !(releaseAfterReplacement && !releaseInventsDeliverable && revision === 5)
            && !(combinedRelease && !unrelatedRewrite && revision === 4)
            && (scenario !== "recovery" || revision === 3);
          const addsContextualHold = contextualHold && revision === 3;
          const objective = addsContextualHold
            ? `${IMPLEMENTATION_OBJECTIVE}\nAutomatic handoff: operator only`
            : releaseInventsDeliverable && revision === 5
            ? "Replace the Idle rail with a search bar."
            : unrelatedRewrite && revision === 4
            ? `${IMPLEMENTATION_OBJECTIVE} Run focused tests.`
            : replace
            ? (revision >= 4 ? REPLACEMENT_OBJECTIVE : IMPLEMENTATION_OBJECTIVE) + (scenario === "no PR omitted marker"
              ? "\nDo not submit this for review or open a PR."
              : "")
            : readGoal()?.objective ?? MOCKUP_OBJECTIVE;
          reply = {
            relationship: initial ? "initial" : unclear ? "unclear" : replace ? "replace" : "steer",
            objective, goal: objective.split("\n")[0],
            focus: initial ? MOCKUP_OBJECTIVE : instruction,
            reason: "Reconciled against the operator's instruction",
          };
        } else {
          verifyPrompts.push(prompt);
          if (scenario === "stale verdict") {
            refiner?.();
            submitEcho(d.registry, d.noteKey, "Stop here. Do not submit the work.", now + 8, transcriptPath);
          }
          reply = { complete: true, confidence: 1, gaps: [], resolved: [], summary: "The requested counts are implemented and verified." };
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", is_error: false,
              result: JSON.stringify(reply), structured_output: reply };
          },
        };
      },
    }));

    const client = new ForemanClient();
    const writes: string[] = [];
    t.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") writes.push(path);
      request.headers.set("host", "127.0.0.1:7317");
      return d.app.request(request);
    });
    let implemented = false;
    const diffRead = t.mock.method(client, "diff", async () => {
      const path = implemented && scenario !== "artifact diff" ? "src/web/idle-rail.tsx" : "docs/mockups/idle-rail.html";
      return {
        ok: true, error: null, base: "main", baseSha: "base", headSha: "abc",
        repoRoot: "/repo", branch: "feature", filesChanged: 1, insertions: 1, deletions: 0,
        patch: `diff --git a/${path} b/${path}\n+++ b/${path}\n+Section heading count\n`, truncated: false,
      };
    });
    t.mock.method(client, "transcriptSize", async () => 1);
    t.mock.method(client, "standards", async () => ({ docs: [], truncated: false }));
    t.mock.method(client, "instructions", async () => "");
    const cfg = ForemanConfigSchema.parse({
      enabled: true, mode: "live", repoAllowlist: ["/repo"],
      wrapup: "pr", wrapupTriggers: ["prompted"], skipReviewArtifactWrapup: true,
    });
    const tick = async () => {
      const session = d.registry.getSession(d.sessionId)!;
      return processPromptedWrapup(client, cfg, session, [session], d.registry.getQueue(d.sessionId), new Set());
    };
    const runs = () => openDb().prepare("SELECT id FROM workflow_runs WHERE binding_id = ?")
      .all(d.bindingId).map((row) => row.id);
    const waitForRevision = async (revision: number) => {
      const until = Date.now() + 4000;
      while (readGoal()?.resolvedPromptRevision !== revision && Date.now() < until) await delay(10);
      assert.equal(readGoal()?.resolvedPromptRevision, revision, "the real goal refiner settled the revision");
    };

    const offered: ["assistant", string] = ["assistant", "The mockups are ready. One option puts counts on section headings."];
    recordTranscript([["user", MOCKUP_OBJECTIVE], offered]);
    submitEcho(d.registry, d.noteKey, d.echoed, now, transcriptPath);
    workAndPark(d.registry, d.noteKey, now + 1);
    refiner = startGoalRefiner(d.registry);
    await waitForRevision(1);
    assert.equal(await tick(), true);
    assert.equal(d.registry.getQueue(d.sessionId)?.promptedDecision?.outcome, "retired");
    assert.equal(verifyPrompts.length, 0);
    assert.equal(diffRead.mock.callCount(), 0, "artifact-only retirement occurs before evidence collection");
    assert.deepEqual(runs(), []);

    refiner();
    recordTranscript([["user", MOCKUP_OBJECTIVE], offered, ["user", selection], ["assistant", "Counts are implemented in the product."]]);
    implemented = true;
    submitEcho(d.registry, d.noteKey, selection, now + 4, transcriptPath);
    workAndPark(d.registry, d.noteKey, now + 5);
    assert.equal(await tick(), false, "unreconciled instructions cannot consume the new generation");
    refiner = startGoalRefiner(d.registry);
    await waitForRevision(2);
    if (scenario === "recovery") {
      assert.equal(await tick(), true, "simulate the old artifact retirement");
      assert.equal(d.registry.getQueue(d.sessionId)?.promptedDecision?.generation, 2);
      assert.equal(d.registry.getQueue(d.sessionId)?.promptedDecision?.outcome, "retired");
      assert.equal(await tick(), false, "the consumed generation never reopens");
      assert.deepEqual(runs(), []);

      revision = 3;
      instruction = "The requested deliverable is the product implementation of counts on section headings. Verify the existing change and hand it to the bound workflow.";
      recordTranscript([["user", MOCKUP_OBJECTIVE], offered, ["user", selection], ["user", instruction]]);
      submitEcho(d.registry, d.noteKey, instruction, now + 9, transcriptPath);
      workAndPark(d.registry, d.noteKey, now + 10);
      await waitForRevision(3);
    }
    const fullObjective = `${IMPLEMENTATION_OBJECTIVE}\nRequirements: ${"x".repeat(3890)}`;
    if (followupRestriction) {
      assert.equal(resolvedSessionIntent(readGoal())?.objective, IMPLEMENTATION_OBJECTIVE);
      if (fullLengthContract) d.registry.upsertGoal(d.sessionId, { objective: fullObjective });
      revision = 3;
      instruction = followupRestriction;
      recordTranscript([["user", MOCKUP_OBJECTIVE], offered, ["user", selection], ["user", instruction]]);
      submitEcho(d.registry, d.noteKey, instruction, now + 9, transcriptPath);
      workAndPark(d.registry, d.noteKey, now + 10);
      await waitForRevision(3);
    }
    if (legacyHold || legacyRelease) {
      const legacyObjective = `${IMPLEMENTATION_OBJECTIVE}\nDo not open a PR.`;
      d.registry.upsertGoal(d.sessionId, { objective: legacyObjective });
      assert.equal(resolvedSessionIntent(readGoal())?.objective, legacyObjective);
      assert.equal(await tick(), false, "a settled markerless objective must hold before reconciliation");
      assert.equal(verifyPrompts.length, 0);
      assert.deepEqual(runs(), []);
      assert.equal(d.registry.getQueue(d.sessionId)?.promptedConsumedGeneration, 1);
    }
    if (replaceWhileHeld) {
      if (unclearRestriction) {
        assert.equal(readGoal()?.relationship, "unclear");
        assert.equal(resolvedSessionIntent(readGoal()), null);
        assert.equal(await tick(), false);
        assert.equal(verifyPrompts.length, 0);
        assert.equal(d.registry.getQueue(d.sessionId)?.promptedConsumedGeneration, 1);
      }
      if (!legacyHold) assert.ok(readGoal()?.objective?.includes("Automatic handoff: operator only"));
      revision = 4;
      instruction = "Change the implementation to count only collapsed sections.";
      recordTranscript([["user", MOCKUP_OBJECTIVE], offered, ["user", selection], ["user", "Do not open a PR."], ["user", instruction]]);
      submitEcho(d.registry, d.noteKey, instruction, now + 12, transcriptPath);
      workAndPark(d.registry, d.noteKey, now + 13);
      await waitForRevision(4);
    }
    assert.equal(modelPrompts.length, revision + Number(unclearRestriction));
    assert.equal(readGoal()?.openingPrompt, MOCKUP_OBJECTIVE);

    if (scenario === "ambiguous") {
      assert.equal(resolvedSessionIntent(readGoal()), null);
    } else if (scenario === "preference only") {
      assert.equal(resolvedSessionIntent(readGoal())?.objective, MOCKUP_OBJECTIVE);
    } else {
      const authorized = resolvedSessionIntent(readGoal());
      assert.equal(authorized?.episodeKey, `intent:${replaceWhileHeld ? 4 : followupRestriction ? 3 : 2}:${revision}`);
      assert.equal(authorized?.objective.split("\n")[0], replaceWhileHeld ? REPLACEMENT_OBJECTIVE : IMPLEMENTATION_OBJECTIVE);
      const expectsHold = followupRestriction || INITIAL_RESTRICTIONS.has(scenario);
      if (expectsHold && !legacyRelease) {
        assert.ok(authorized?.objective.split("\n").includes("Automatic handoff: operator only"));
      }
      if (fullLengthContract) assert.ok(authorized?.objective.startsWith(fullObjective + "\n"));
    }

    writes.length = 0;
    const claimed = ["implementation", "delegates PR", "recovery"].includes(scenario);
    const retired = scenario === "preference only" || scenario === "artifact diff";
    assert.equal(await tick(), claimed || retired);
    if (claimed || scenario === "stale verdict") {
      assert.equal(verifyPrompts.length, 1);
      assert.ok(verifyPrompts[0]?.includes(IMPLEMENTATION_OBJECTIVE));
      assert.ok(verifyPrompts[0]?.includes("src/web/idle-rail.tsx"));
      assert.ok(verifyPrompts[0]?.includes("focused tests and verification"));
    } else {
      assert.equal(verifyPrompts.length, 0);
      assert.equal(diffRead.mock.callCount(), scenario === "artifact diff" ? 1 : 0);
    }
    const completion = d.registry.getQueue(d.sessionId)?.promptedDecision;
    if (claimed) {
      assert.equal(completion?.outcome, "workflow_claimed");
      assert.equal(completion?.generation, revision);
      assert.equal(await tick(), false, "repeated worker tick cannot verify or claim again");
      assert.equal(verifyPrompts.length, 1);
      const run = d.workflows.store.latestRunForBinding(d.bindingId);
      assert.ok(run);
      assert.deepEqual(runs(), [run.id]);
      const submissions = d.workflows.store.listSubmissions(run.id);
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0]?.triggerSource, "foreman");
      assert.ok(JSON.stringify(submissions[0]?.context).includes(IMPLEMENTATION_OBJECTIVE));
      assert.deepEqual(writes, [`/api/sessions/${encodeURIComponent(d.sessionId)}/workflow-completion`]);
    } else {
      assert.deepEqual(runs(), []);
      if (retired) {
        assert.equal(completion?.outcome, "retired");
        assert.equal(completion?.generation, 2);
      } else {
        assert.equal(completion?.generation, 1, "the new generation was not consumed");
        assert.deepEqual(writes, []);
      }
    }
    if (combinedRelease) {
      const held = resolvedSessionIntent(readGoal());
      revision = 4;
      instruction = "Resume automatic handoff. Change the implementation to count only collapsed sections.";
      submitEcho(d.registry, d.noteKey, instruction, now + 12, transcriptPath);
      workAndPark(d.registry, d.noteKey, now + 13);
      await waitForRevision(4);
      const current = resolvedSessionIntent(readGoal());
      if (unrelatedRewrite) {
        assert.equal(current?.objective.split("\n")[0], `${IMPLEMENTATION_OBJECTIVE} Run focused tests.`);
        assert.ok(current?.objective.split("\n").includes("Automatic handoff: operator only"));
      } else {
        assert.equal(current?.objective, held?.objective);
      }
      assert.equal(await tick(), false);
      assert.equal(verifyPrompts.length, 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(runs(), []);
      assert.equal(d.registry.getQueue(d.sessionId)?.promptedConsumedGeneration, 1);
    }
    if (releaseAfterReplacement || releaseWithoutReplacement) {
      const expectedObjective = releaseWithoutReplacement ? IMPLEMENTATION_OBJECTIVE : REPLACEMENT_OBJECTIVE;
      const deliverableUpdatedAt = readGoal()?.deliverableUpdatedAt;
      assert.ok(deliverableUpdatedAt);
      revision = releaseWithoutReplacement ? 4 : 5;
      instruction = "Resume automatic handoff.";
      submitEcho(d.registry, d.noteKey, instruction, now + 15, transcriptPath);
      workAndPark(d.registry, d.noteKey, now + 16);
      await waitForRevision(revision);
      assert.equal(resolvedSessionIntent(readGoal())?.objective, expectedObjective);
      assert.equal(readGoal()?.text, expectedObjective);
      assert.ok(readGoal()?.handoffReleasedAt);
      assert.equal(getSessionGoal(d.noteKey)?.handoffReleasedAt, readGoal()?.handoffReleasedAt);
      assert.equal(readGoal()?.deliverableUpdatedAt, deliverableUpdatedAt);
      assert.equal(getSessionGoal(d.noteKey)?.deliverableUpdatedAt, deliverableUpdatedAt);
      assert.equal(await tick(), true);
      assert.equal(verifyPrompts.length, 1);
      assert.ok(verifyPrompts[0]?.includes(expectedObjective));
      assert.equal(await tick(), false);
      assert.equal(verifyPrompts.length, 1);
      assert.equal(runs().length, 1);
      assert.equal(d.registry.getQueue(d.sessionId)?.promptedDecision?.generation, revision);
    }
  });
}
