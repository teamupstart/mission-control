import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { PublishedWorkflowGraph } from "../src/shared/workflow.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-bindings-http-"));
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
const { NO_MISTAKES_REVIEW_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");

function discovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "session-1",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 1,
    ...over,
  } as DiscoveredSession;
}

function seedVersion(): void {
  const db = openDb();
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "end", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  };
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 7 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'W', 'w', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(JSON.stringify(graph), defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
}

function seedRuntimeVersion(id: string, graph: PublishedWorkflowGraph): void {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`w-${id}`, `W ${id}`, `w-${id}`, defaults, `v-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`v-${id}`, `w-${id}`, JSON.stringify(graph), defaults);
}

function request(app: ReturnType<typeof buildApp>, path: string, body?: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: {
      host: "127.0.0.1:7317",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("a dispatched task arms its selected published workflow at Foreman Complete", async () => {
  const graph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [
      {
        id: "end",
        source: "session",
        sourcePort: "submitted",
        target: "end",
        targetPort: "terminal",
      },
    ],
  };
  seedRuntimeVersion("dispatch-auto", graph);
  setForemanConfig({ enabled: true });
  const registry = new Registry();
  registry.applyDiscovery([
    discovered({
      syntheticId: "session-dispatch-auto",
      tty: "ttys-auto",
      terminals: [mkMuxHandle({ paneId: "%auto" })],
    }),
  ]);
  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "agent-dispatch-auto",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%auto" },
  });
  const workflows = new WorkflowManager(registry, new PersonaManager(registry).store);
  workflows.start();

  assert.equal(workflows.dispatchWorkflowBlock("w-dispatch-auto", "claude"), null);
  registry.upsertTask(mkTask({
    id: "task-dispatch-auto",
    status: "running",
    sessionId: "session-dispatch-auto",
    workflowId: "w-dispatch-auto",
  }));

  const binding = workflows.store.activeBindingForNote("agent-dispatch-auto");
  assert.ok(binding);
  assert.equal(binding.workflowVersionId, "v-dispatch-auto");
  assert.equal(binding.triggerMode, "foreman_complete");
  assert.equal(binding.deliveryMode, "preview");

  seedRuntimeVersion("dispatch-replacement", graph);
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    undefined,
    workflows,
  );
  for (const workflowId of ["w-dispatch-replacement", null]) {
    const changed = await request(
      app,
      "/api/tasks/task-dispatch-auto/update",
      { workflowId },
    );
    assert.equal(changed.status, 409);
    assert.match(
      (await changed.json() as { error: string }).error,
      /cannot change once the task has a session/,
    );
    assert.equal(registry.getTask("task-dispatch-auto")?.workflowId, "w-dispatch-auto");
    assert.equal(
      workflows.store.activeBindingForNote("agent-dispatch-auto")?.workflowVersionId,
      "v-dispatch-auto",
    );
  }

  registry.upsertTask(mkTask({
    id: "task-conflicting-assignment",
    status: "backlog",
    workflowId: "w-dispatch-replacement",
  }));
  const conflictingAssignment = await request(
    app,
    "/api/tasks/task-conflicting-assignment/assign",
    { sessionId: "session-dispatch-auto", overrideDisabled: true },
  );
  assert.equal(conflictingAssignment.status, 409);
  assert.match(
    (await conflictingAssignment.json() as { error: string }).error,
    /different active Workflow binding/,
  );
  assert.equal(registry.getTask("task-conflicting-assignment")?.status, "backlog");
  assert.equal(registry.getTask("task-conflicting-assignment")?.sessionId, null);
  assert.equal(
    workflows.store.activeBindingForNote("agent-dispatch-auto")?.workflowVersionId,
    "v-dispatch-auto",
  );

  assert.equal(workflows.archiveBinding(binding.id).ok, true);
  await workflows.stop();
  setForemanConfig({ enabled: false });
});

test("task creation inherits the dispatch default while explicit None opts out", async () => {
  const graph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [
      {
        id: "end",
        source: "session",
        sourcePort: "submitted",
        target: "end",
        targetPort: "terminal",
      },
    ],
  };
  seedRuntimeVersion("dispatch-default", graph);
  const repo = join(home, "dispatch-default-repo");
  execFileSync("git", ["init", "-q", repo]);
  setForemanConfig({ enabled: false });
  setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: "w-dispatch-default",
  });
  const registry = new Registry();
  const workflows = new WorkflowManager(registry, new PersonaManager(registry).store);
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    undefined,
    workflows,
  );

  const inherited = await request(app, "/api/tasks", {
    repoRoot: repo,
    intent: "Use the default review",
    title: "Inherited Workflow",
    agent: "claude",
    backlog: true,
  });
  assert.equal(inherited.status, 200);
  const inheritedTask = await inherited.json() as {
    id: string;
    status: string;
    workflowId: string | null;
  };
  assert.equal(inheritedTask.status, "backlog");
  assert.equal(inheritedTask.workflowId, "w-dispatch-default");

  const optedOut = await request(app, "/api/tasks", {
    repoRoot: repo,
    intent: "Finish without review",
    title: "No Workflow",
    agent: "claude",
    workflowId: null,
    backlog: true,
  });
  assert.equal(optedOut.status, 200);
  assert.equal((await optedOut.json() as { workflowId: string | null }).workflowId, null);

  const launchBlocked = await request(
    app,
    `/api/tasks/${inheritedTask.id}/dispatch`,
    { overrideDisabled: true },
  );
  assert.equal(launchBlocked.status, 409);
  assert.match(
    (await launchBlocked.json() as { error: string }).error,
    /Turn on Foreman before dispatching/,
  );
  assert.equal(registry.getTask(inheritedTask.id)?.status, "backlog");

  setWorkflowConfig({ liveEnabled: false, repoAllowlist: [], defaultWorkflowId: null });
  setForemanConfig({ enabled: false });
});

test("binding routes pin immutable versions, enforce one active owner, and refuse future modes", async () => {
  seedVersion();
  const registry = new Registry();
  registry.applyDiscovery([discovered()]);
  const personas = new PersonaManager(registry);
  let releaseCompaction!: () => void;
  const compactionBlocked = new Promise<void>((resolve) => {
    releaseCompaction = resolve;
  });
  let markCompactionStarted!: () => void;
  const compactionStarted = new Promise<void>((resolve) => {
    markCompactionStarted = resolve;
  });
  const workflows = new WorkflowManager(registry, personas.store, {
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Review this", refined: "Review", sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "abc",
          diffFingerprint: "diff",
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [" M file.ts"],
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
          repositoryFingerprint: "repository",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => {
      markCompactionStarted();
      await compactionBlocked;
      return fallbackWorkflowContext(raw, "test fallback");
    },
  });
  workflows.start();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    personas,
    workflows,
  );

  const created = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v",
    sessionId: "session-1",
  });
  assert.equal(created.status, 201);
  const binding = await created.json() as {
    id: string;
    workflowVersionId: string;
    noteKey: string;
    maxRepairRounds: number;
  };
  assert.equal(binding.workflowVersionId, "v");
  assert.equal(binding.noteKey, "session-1");
  assert.equal(binding.maxRepairRounds, 7);

  const duplicate = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v",
    sessionId: "session-1",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
  });
  assert.equal(duplicate.status, 409);

  const live = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v",
    sessionId: "session-1",
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 5,
  });
  assert.equal(live.status, 422);

  const listed = await request(app, "/api/workflow-bindings", undefined, "GET");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json() as unknown[]).length, 1);

  const submitted = await request(app, `/api/workflow-bindings/${binding.id}/submit`, {
    requestId: "submit-1",
  });
  assert.equal(submitted.status, 202);
  const first = await submitted.json() as { run: { id: string; status: string }; submission: { id: string } };
  assert.equal(first.run.status, "capturing");
  await compactionStarted;
  assert.equal(workflows.store.getRun(first.run.id)?.status, "capturing");

  const duplicateSubmit = await request(app, `/api/workflow-bindings/${binding.id}/submit`, {
    requestId: "submit-1",
  });
  assert.equal(duplicateSubmit.status, 200);
  const repeated = await duplicateSubmit.json() as {
    run: { id: string };
    submission: { id: string };
    idempotent: boolean;
  };
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.run.id, first.run.id);
  assert.equal(repeated.submission.id, first.submission.id);

  releaseCompaction();
  const completionStarted = Date.now();
  while (workflows.store.getRun(first.run.id)?.status !== "completed") {
    if (Date.now() - completionStarted > 3_000) {
      throw new Error("timed out waiting for accepted workflow submission to complete");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const detail = await request(app, `/api/workflow-runs/${first.run.id}`, undefined, "GET");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { summary: { workflowVersion: number } }).summary.workflowVersion, 1);

  const archived = await request(app, `/api/workflow-bindings/${binding.id}`, {}, "DELETE");
  assert.equal(archived.status, 200);
  assert.equal((await archived.json() as { state: string }).state, "archived");

  const archivedWorkflow = await request(app, "/api/workflows/w", {
    expectedDraftRevision: 1,
  }, "DELETE");
  assert.equal(archivedWorkflow.status, 200);
  const archivedWorkflowBody = await archivedWorkflow.json() as {
    workflow: { draftRevision: number };
  };
  assert.equal(workflows.store.getBinding(binding.id)?.state, "archived");

  const refused = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v",
    sessionId: "session-1",
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "This workflow is archived and must be restored before it can be bound",
    code: "workflow_conflict",
    current: null,
  });

  const restored = await request(app, "/api/workflows/w/unarchive", {
    expectedDraftRevision: archivedWorkflowBody.workflow.draftRevision,
  });
  assert.equal(restored.status, 200);
  const rebound = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v",
    sessionId: "session-1",
  });
  assert.equal(rebound.status, 201);
  await workflows.stop();
});

test("the Ship it review route starts the built-in workflow and never replaces another binding", async () => {
  const graph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [
      { id: "end", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" },
    ],
  };
  seedRuntimeVersion("manual-review-conflict", graph);
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: [], defaultWorkflowId: null });

  const registry = new Registry();
  registry.applyDiscovery([
    discovered({
      syntheticId: "review-session",
      tty: "ttys-review",
      terminals: [mkMuxHandle({ paneId: "%review" })],
    }),
    discovered({
      syntheticId: "conflict-session",
      tty: "ttys-conflict",
      terminals: [mkMuxHandle({ paneId: "%conflict" })],
    }),
  ]);
  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "agent-review",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%review" },
  });
  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "agent-conflict",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%conflict" },
  });
  const personas = new PersonaManager(registry);
  const queues = new QueueManager(registry);
  assert.equal(registry.ensureQueue("review-session", 1), "agent-review");
  const workflows = new WorkflowManager(registry, personas.store, {
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Review this", refined: "Review this", sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "abc",
          diffFingerprint: "diff",
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [" M file.ts"],
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
          repositoryFingerprint: "repository",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test fallback"),
  });
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    queues,
    undefined,
    personas,
    workflows,
  );

  const started = await request(
    app,
    "/api/sessions/review-session/workflow-review",
    { requestId: "ship-review-1" },
  );
  assert.equal(started.status, 200);
  const first = await started.json() as {
    run: { id: string };
    submission: { id: string };
    idempotent: boolean;
  };
  const binding = workflows.store.activeBindingForNote("agent-review");
  assert.ok(binding);
  assert.equal(
    workflows.store.getWorkflowVersionById(binding.workflowVersionId)?.workflowId,
    NO_MISTAKES_REVIEW_WORKFLOW_ID,
  );
  assert.equal(binding.triggerMode, "manual");
  assert.equal(binding.deliveryMode, "preview");
  assert.equal(queues.get("review-session")?.wrapupAnswer, "workflow:no-mistakes-review");

  const repeated = await request(
    app,
    "/api/sessions/review-session/workflow-review",
    { requestId: "ship-review-2" },
  );
  assert.equal(repeated.status, 200);
  const second = await repeated.json() as typeof first;
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.submission.id, first.submission.id);
  assert.equal(second.idempotent, true);

  const conflicting = workflows.createBinding({
    workflowVersionId: "v-manual-review-conflict",
    sessionId: "conflict-session",
  });
  assert.equal(conflicting.ok, true);
  const refused = await request(
    app,
    "/api/sessions/conflict-session/workflow-review",
    { requestId: "ship-review-conflict" },
  );
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /different workflow binding/);
});

test("positive disappearance orphans, compatible reattach is explicit, and conversation changes pause", async () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered({ syntheticId: "session-old", tty: "ttys2" })]);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  workflows.start();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    personas,
    workflows,
  );
  const created = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v",
    sessionId: "session-old",
  });
  assert.equal(created.status, 201);
  const binding = await created.json() as { id: string };

  registry.emit("event", { type: "session_remove", id: "session-old" });
  assert.equal(workflows.store.getBinding(binding.id)?.state, "orphaned");
  assert.equal(workflows.store.getBinding(binding.id)?.sessionId, null);

  registry.applyDiscovery([
    discovered({ syntheticId: "session-old", tty: "ttys2" }),
    discovered({ syntheticId: "session-new", tty: "ttys3" }),
    discovered({ syntheticId: "wrong-checkout", tty: "ttys4", cwd: "/other", gitRoot: "/other", repoRoot: "/other" }),
  ]);
  const incompatible = await request(app, `/api/workflow-bindings/${binding.id}/reattach`, {
    sessionId: "wrong-checkout",
  });
  assert.equal(incompatible.status, 409);

  const reattached = await request(app, `/api/workflow-bindings/${binding.id}/reattach`, {
    sessionId: "session-new",
  });
  assert.equal(reattached.status, 200);
  assert.equal((await reattached.json() as { state: string; sessionId: string }).state, "active");
  assert.equal(workflows.store.getBinding(binding.id)?.sessionId, "session-new");

  const session = registry.getSession("session-new")!;
  registry.emit("event", {
    type: "session_upsert",
    session: { ...session, agentSessionId: "conversation-after-clear" },
  });
  assert.equal(workflows.store.getBinding(binding.id)?.state, "paused");
  await workflows.stop();
});

test("an orphaned binding cannot reattach until its workflow is restored", async () => {
  seedRuntimeVersion("archived-reattach", {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "end", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  });
  const registry = new Registry();
  registry.applyDiscovery([discovered({ syntheticId: "reattach-old", tty: "ttys14" })]);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  workflows.start();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    personas,
    workflows,
  );

  const created = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v-archived-reattach",
    sessionId: "reattach-old",
  });
  assert.equal(created.status, 201);
  const binding = await created.json() as { id: string };
  registry.emit("event", { type: "session_remove", id: "reattach-old" });
  assert.equal(workflows.store.getBinding(binding.id)?.state, "orphaned");

  const archived = await request(app, "/api/workflows/w-archived-reattach", {
    expectedDraftRevision: 1,
  }, "DELETE");
  assert.equal(archived.status, 200);
  const archivedBody = await archived.json() as { workflow: { draftRevision: number } };
  registry.applyDiscovery([discovered({ syntheticId: "reattach-new", tty: "ttys15" })]);

  const refused = await request(app, `/api/workflow-bindings/${binding.id}/reattach`, {
    sessionId: "reattach-new",
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "This workflow is archived and must be restored before it can be reattached",
    code: "workflow_conflict",
    current: null,
  });
  assert.equal(workflows.store.getBinding(binding.id)?.state, "orphaned");
  assert.equal(workflows.store.getBinding(binding.id)?.sessionId, null);

  const restored = await request(app, "/api/workflows/w-archived-reattach/unarchive", {
    expectedDraftRevision: archivedBody.workflow.draftRevision,
  });
  assert.equal(restored.status, 200);
  const reattached = await request(app, `/api/workflow-bindings/${binding.id}/reattach`, {
    sessionId: "reattach-new",
  });
  assert.equal(reattached.status, 200);
  assert.equal((await reattached.json() as { state: string }).state, "active");
  await workflows.stop();
});

test("the first completed discovery orphans bindings whose sessions disappeared during downtime", async () => {
  const registry = new Registry();
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  const binding = workflows.store.insertBinding({
    id: "binding-missing-at-startup",
    workflowVersionId: "v",
    noteKey: "missing-conversation",
    sessionId: "missing-session",
    sessionAgent: "claude",
    sessionName: "gone",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 7,
    now: 1,
  });
  workflows.store.createInitialSubmission(
    { id: "run-missing-at-startup", binding, triggerSource: "manual", triggerKey: "startup:missing", now: 2 },
    {
      id: "submission-missing-at-startup",
      triggerSource: "manual",
      triggerKey: "startup:missing",
      context: {},
      evidence: {},
      now: 2,
    },
  );
  workflows.store.updateSubmissionCapture("submission-missing-at-startup", {
    context: {},
    evidence: {},
    fingerprint: "startup-fingerprint",
    status: "running",
  }, 3);
  workflows.store.setRunState(
    "run-missing-at-startup",
    "running",
    "persona_review",
    null,
    3,
  );
  workflows.start();
  assert.equal(workflows.store.getBinding("binding-missing-at-startup")?.state, "active");
  assert.equal(workflows.store.getRun("run-missing-at-startup")?.status, "running");

  registry.applyDiscovery([]);

  assert.equal(workflows.store.getBinding("binding-missing-at-startup")?.state, "orphaned");
  assert.equal(workflows.store.getBinding("binding-missing-at-startup")?.sessionId, null);
  assert.equal(workflows.store.getRun("run-missing-at-startup")?.status, "blocked");
  await workflows.stop();
});

test("resubmit fingerprints are durable, unchanged confirmation reuses its trigger, and Persona fails cannot use infrastructure retry", async () => {
  const persona = {
    sourcePersonaId: "persona-repair",
    sourceRevision: 1,
    name: "Repair reviewer",
    description: "",
    guidanceMarkdown: "Review the evidence.",
    runner: "claude" as const,
    model: "fake",
  };
  const graph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "persona", kind: "persona", persona, position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
      { id: "p-pass", source: "persona", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "persona", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  seedRuntimeVersion("repair", graph);
  const registry = new Registry();
  registry.applyDiscovery([discovered({ syntheticId: "repair-session", tty: "ttys5" })]);
  const personas = new PersonaManager(registry);
  const fake: LlmRunner = {
    id: "claude",
    label: "fake",
    runInThread: null,
    structuredOutput: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run() {
      return JSON.stringify({
        verdict: "fail",
        summary: "Needs changes",
        requestedChanges: [{
          title: "Fix it",
          rationale: "Not complete",
          evidence: [{ kind: "goal", quote: "Immutable goal" }],
        }],
        confidence: 1,
      });
    },
  };
  const workflows = new WorkflowManager(registry, personas.store, {
    engine: {
      runnerFor: () => fake,
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
      retryBaseMs: 1,
    },
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Immutable goal", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "abc",
          diffFingerprint: "unchanged",
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [" M file.ts"],
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
          repositoryFingerprint: "repository",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test fallback"),
  });
  workflows.start();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    personas,
    workflows,
  );
  const created = await request(app, "/api/workflow-bindings", {
    workflowVersionId: "v-repair",
    sessionId: "repair-session",
  });
  const binding = await created.json() as { id: string };
  const submitted = await request(app, `/api/workflow-bindings/${binding.id}/submit`, {
    requestId: "initial",
  });
  const runId = (await submitted.json() as { run: { id: string } }).run.id;
  const waitFor = async (status: string): Promise<void> => {
    const started = Date.now();
    while (workflows.store.getRun(runId)?.status !== status) {
      if (Date.now() - started > 3_000) throw new Error(`timed out waiting for ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor("waiting_for_session");

  const unchanged = await request(app, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "repair-1",
    resubmitUnchanged: false,
  });
  assert.equal(unchanged.status, 409);
  const refused = workflows.store.submissionByTrigger(`manual:${binding.id}:repair-1`);
  assert.equal(refused?.status, "failed");

  const repeatedRefusal = await request(app, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "repair-1",
    resubmitUnchanged: false,
  });
  assert.equal(repeatedRefusal.status, 409);

  const confirmed = await request(app, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "repair-1",
    resubmitUnchanged: true,
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json() as { submission: { id: string } }).submission.id, refused?.id);
  await waitFor("waiting_for_session");
  assert.equal(workflows.store.getSubmission(refused!.id)?.status, "waiting_for_session");
  assert.equal(workflows.store.listSubmissions(runId).length, 2);
  assert.equal(workflows.store.listAttempts(refused!.id).filter((attempt) => attempt.nodeId === "persona").length, 1);

  const wrongRetry = await request(app, `/api/workflow-runs/${runId}/retry`, {
    requestId: "not-infra",
  });
  assert.equal(wrongRetry.status, 409);
  assert.equal((await wrongRetry.json() as { code: string }).code, "workflow_not_infrastructure_failure");

  const overLimit = await request(app, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "repair-2",
    resubmitUnchanged: true,
  });
  assert.equal(overLimit.status, 409);
  assert.equal((await overLimit.json() as { code: string }).code, "workflow_round_limit");
  await workflows.stop();
});
