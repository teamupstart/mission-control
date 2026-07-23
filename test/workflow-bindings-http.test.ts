import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { PublishedWorkflowGraph } from "../src/shared/workflow.ts";

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
const { buildApp } = await import("../src/server/routes.ts");

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
    nomistakesGated: false,
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

test("binding routes pin immutable versions, enforce one active owner, and refuse future modes", async () => {
  seedVersion();
  const registry = new Registry();
  registry.applyDiscovery([discovered()]);
  const personas = new PersonaManager(registry);
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
  assert.equal(submitted.status, 200);
  const first = await submitted.json() as { run: { id: string; status: string }; submission: { id: string } };
  assert.equal(first.run.status, "completed");

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

  const detail = await request(app, `/api/workflow-runs/${first.run.id}`, undefined, "GET");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { summary: { workflowVersion: number } }).summary.workflowVersion, 1);

  const archived = await request(app, `/api/workflow-bindings/${binding.id}`, {}, "DELETE");
  assert.equal(archived.status, 200);
  assert.equal((await archived.json() as { state: string }).state, "archived");
  await workflows.stop();
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
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run() {
      return JSON.stringify({
        verdict: "fail",
        summary: "Needs changes",
        requestedChanges: [{ title: "Fix it", rationale: "Not complete", evidence: [] }],
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
