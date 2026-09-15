import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A recurring mission's selected Workflow, from the template through to a started run.
 *
 * `bindDispatchedTaskWorkflow` is the only path from durable task intent to a binding, and
 * it never asks how the task got its `workflowId` - so the scheduler's contribution is the
 * field, and this file proves the field is enough.
 */

const home = mkdtempSync(join(tmpdir(), "mission-schedule-workflow-handoff-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const db = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { promptedCompletionClaim } = await import("../src/server/foreman/workflow-claim.ts");
const { resolvedSessionIntent } = await import("../src/shared/goal.ts");
type CreateScheduleInput = import("../src/server/schedules/manager.ts").CreateScheduleInput;

db.openDb();

const REPO = "/repos/main";
const T0 = Date.parse("2026-07-23T08:00:00Z");
const NINE = Date.parse("2026-07-23T09:00:00Z");
const INTENT = "Read the inbox and file whatever needs filing.";

/** A published workflow with a current immutable version, seeded at the schema. */
function seedWorkflow(id: string, versionId: string): void {
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [
      {
        id: "done",
        source: "session",
        sourcePort: "submitted",
        target: "end",
        targetPort: "terminal",
      },
    ],
  };
  const defaults = JSON.stringify({
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
    maxRepairRounds: 2,
  });
  const d = db.openDb();
  d.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(id, `Review ${id}`, `review ${id}`, JSON.stringify(graph), defaults, versionId);
  d.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(versionId, id, JSON.stringify(graph), defaults);
}

/**
 * A WorkflowManager whose context read is injected.
 *
 * `REPO` is a path, not a checkout: nothing here has a git tree to diff, so the evidence a
 * run would gather is supplied rather than collected. Everything downstream of that - the
 * claim, the run row, the binding it names - is the product's own.
 */
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
        session: { agent: "claude", name: "sweep", cwd: REPO, branch: "feature" },
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

function definition(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    name: "Nightly sweep",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    completionPolicy: "manual",
    template: {
      title: "Sweep the inbox",
      intent: INTENT,
      repoRoot: REPO,
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
      workflowId: null,
    },
    ...over,
  } as CreateScheduleInput;
}

/** Wait for the engine to take a run to a terminal status, off the claim's own turn. */
async function settled(f: Fired, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = f.workflows.store.getRun(runId);
    if (run && run.status !== "capturing" && run.status !== "running") return run.status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never left its in-flight status`);
}

interface Fired {
  registry: InstanceType<typeof Registry>;
  workflows: InstanceType<typeof WorkflowManager>;
  app: ReturnType<typeof buildApp>;
  taskId: string;
  sessionId: string;
  noteKey: string;
}

/**
 * Fire one occurrence and give its task the session a dispatch would, up to the arm.
 *
 * The task/session join is made through `upsertTask` rather than a real dispatch: this file
 * is about what the mission's stored choice reaches, and a launched agent would add a
 * process without adding a claim.
 */
async function fireMission(slug: string, workflowId: string | null): Promise<Fired> {
  for (const existing of store.listSchedules()) store.archiveSchedule(existing.id, T0 - 1);

  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const personas = new PersonaManager(registry);
  const queues = new QueueManager(registry);
  const workflows = mkWorkflows(registry, personas, queues);
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks,
    queues,
    personas,
    workflows,
  });

  const clock = { now: T0 };
  let n = 0;
  const manager = new ScheduleManager({
    tasks,
    now: () => clock.now,
    uuid: () => `${slug}-${++n}`,
    resolveRepoRoot: async (path: string) =>
      path === REPO
        ? { ok: true as const, repoRoot: path }
        : { ok: false as const, error: `not a git repository: ${path}` },
    notifier: { upsert: () => {}, remove: () => {} },
    log: () => {},
  });

  const created = await manager.create(
    definition({ name: slug, template: { ...definition().template, workflowId } }),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("the fixture mission should save");

  clock.now = NINE + 5_000;
  await manager.tick();
  const filed = db.listTasks().filter((t) => t.scheduleId === created.schedule.id);
  assert.equal(filed.length, 1);
  const task = filed[0]!;
  assert.equal(task.workflowId, workflowId, "the template's choice reaches the filed task");

  const sessionId = `sdk:${slug}`;
  const noteKey = `agent:${slug}`;
  registry.registerSdkSession({
    id: sessionId,
    agent: "claude",
    name: slug,
    cwd: REPO,
    gitBranch: "feature",
    gitRoot: REPO,
    repoRoot: REPO,
  });
  registry.bindLaunchedAgentSession(sessionId, "claude", noteKey);
  registry.upsertTask({
    ...registry.getTask(task.id)!,
    status: "running",
    sessionId,
    updatedAt: clock.now,
  });
  workflows.reconcileDispatchedTaskWorkflows();

  return { registry, workflows, app, taskId: task.id, sessionId, noteKey };
}

test("a mission's selected Workflow is armed on the task its run files, on the completion trigger", async () => {
  seedWorkflow("w-armed", "wv-armed");
  const f = await fireMission("armed", "w-armed");

  const binding = f.workflows.store.activeBindingForNote(f.noteKey);
  assert.ok(binding, "the mission's Workflow should be armed on its run's session");
  assert.equal(binding.sessionId, f.sessionId);
  assert.equal(binding.triggerMode, "foreman_complete");
  // The template stores a mutable workflow id; the binding pins the immutable version.
  assert.equal(binding.workflowVersionId, "wv-armed");
  assert.equal(binding.state, "active");
});

test("a mission that selected no Workflow arms nothing at all", async () => {
  const f = await fireMission("no-handoff", null);
  assert.equal(f.workflows.store.activeBindingForNote(f.noteKey), null);
});

test("Foreman's completion of the mission's task starts the Workflow the mission selected", async () => {
  setForemanConfig({ enabled: true, mode: "live", repoAllowlist: [REPO] });
  seedWorkflow("w-executes", "wv-executes");
  const f = await fireMission("executes", "w-executes");

  const binding = f.workflows.store.activeBindingForNote(f.noteKey);
  assert.ok(binding);
  assert.equal(f.workflows.store.activeRunForBinding(binding.id), null);

  // Foreman prerequisites: a queue row, and a resolved objective for the intent guard.
  db.openDb().prepare(
    `INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
     VALUES (?, ?, 'feature', NULL, NULL, NULL, 10)`,
  ).run(f.noteKey, REPO);
  // Prompt revision one: `resolvedSessionIntent` refuses a goal whose resolved revision does
  // not match a captured prompt, so the objective below has to have something to resolve.
  f.registry.captureAcceptedPrompt(f.sessionId, INTENT, f.noteKey, 2);
  f.registry.upsertGoal(f.sessionId, {
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

  // One completed work cycle, so the claim's `expectedWorkCycle` names a generation the
  // session has actually reached. Without it the route refuses as no-longer-current.
  f.registry.applyHook({
    agent: "claude", event: "PreToolUse", sessionId: f.noteKey, cwd: REPO,
    transcriptPath: null, env: {}, toolName: "Edit", ts: 5,
  });
  f.registry.applyHook({
    agent: "claude", event: "Stop", sessionId: f.noteKey, cwd: REPO,
    transcriptPath: null, env: {}, ts: 6,
  });

  const intent = resolvedSessionIntent(f.registry.getGoal(f.sessionId));
  assert.ok(intent, "a claim cannot be built without a resolved intent");
  const response = await f.app.request(
    `/api/sessions/${f.sessionId}/workflow-completion`,
    {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(promptedCompletionClaim({
        noteKey: f.noteKey,
        workCycle: { logicalKey: f.noteKey, generation: 1 },
        intent,
        headSha: "abc",
        transcriptAnchor: 1,
        summary: "The sweep is done.",
      })),
    },
  );
  const claimed = await response.json() as { claimed: boolean; runId: string; state: string };
  assert.equal(response.status, 200, JSON.stringify(claimed));
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.state, "started");

  const run = f.workflows.store.getRun(claimed.runId);
  assert.ok(run);
  assert.equal(run.bindingId, binding.id);
  assert.equal(run.workflowVersionId, "wv-executes");
  const rows = db.openDb().prepare(
    `SELECT id FROM workflow_runs WHERE binding_id = ?`,
  ).all(binding.id) as Array<{ id: string }>;
  assert.deepEqual(rows.map((r) => r.id), [claimed.runId], "exactly one run, and it is that one");

  // Polled: the engine advances the run off the request's own turn.
  assert.equal(await settled(f, claimed.runId), "completed");

  setForemanConfig({ enabled: false });
});
