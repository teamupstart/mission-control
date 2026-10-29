import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookIngest } from "../src/shared/protocol.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import { mkOriginAndClone } from "./helpers/git-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-sdk-hook-isolation-"));
process.env.MISSION_HOME = home;
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { lastAgentBinding, taskWorkEpisodeForTask, openDb } = await import("../src/server/db.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");

const repo = mkOriginAndClone("mission-sdk-hook-repo-");
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo.root, { recursive: true, force: true });
});

const graph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "review", kind: "persona", position: { x: 100, y: 0 }, persona: {
      sourcePersonaId: "review", sourceRevision: 1, name: "Plan validation",
      description: "", guidanceMarkdown: "Validate the plan.", runner: "claude", model: "fake",
    } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: "submit", source: "session", sourcePort: "submitted", target: "review", targetPort: "activate" },
    { id: "pass", source: "review", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "fail", source: "review", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};
const defaults = JSON.stringify({ triggerMode: "foreman_complete", deliveryMode: "preview", maxRepairRounds: 1 });
openDb().prepare(`INSERT INTO workflow_definitions (
  id, name, normalized_name, description, draft_graph_json, completion_policy_json,
  binding_defaults_json, draft_revision, current_version_id, created_at, updated_at
) VALUES ('hook-review', 'Hook review', 'hook review', '', ?, '{"kind":"none"}', ?, 1, 'hook-review-v1', 1, 1)`)
  .run(JSON.stringify({ nodes: [], edges: [] }), defaults);
openDb().prepare(`INSERT INTO workflow_versions (
  id, workflow_id, version, source_draft_revision, graph_json,
  completion_policy_json, binding_defaults_json, published_at
) VALUES ('hook-review-v1', 'hook-review', 1, 1, ?, '{"kind":"none"}', ?, 1)`)
  .run(JSON.stringify(graph), defaults);

function owner(id: string, bound = true) {
  const registry = new Registry();
  registry.registerSdkSession({ id, agent: "claude", name: id, cwd: repo.clone, gitBranch: "main", repoRoot: repo.clone });
  if (bound) registry.applyDriverEvent(id, {
    kind: "bound", agentSessionId: `${id}-native`, transcriptPath: null, modelId: null, pid: null,
  });
  return registry;
}

function hook(sessionId: string | null, env: HookIngest["env"], event = "SessionStart"): HookIngest {
  return { agent: "claude", event, sessionId, transcriptPath: null, cwd: repo.clone, env, source: "startup" };
}

for (const viaPane of [false, true]) {
  test(`auxiliary startup, prompt and stop preserve SDK ownership and validation (${viaPane ? "pane" : "cwd"})`, async (t) => {
    const id = `sdk:hook-${viaPane ? "pane" : "cwd"}`;
    const registry = owner(id);
    registry.applyDiscovery([]);
    const env = viaPane ? { tmuxPane: "%auxiliary" } : {};
    // SDK cards normally have no pane. Include one to exercise pane precedence as well
    // as the unique-cwd fallback when an auxiliary process inherits terminal coordinates.
    if (viaPane) registry.getSession(id)!.terminals.push(mkMuxHandle({ paneId: "%auxiliary" }));
    const tasks = new TaskManager(registry);
    const task = mkTask({ id: `${id}-task`, kind: "plan", title: "Plan publication", status: "running",
      sessionId: id, worktreePath: repo.clone, repoRoot: repo.clone });
    registry.upsertTask(task);
    assert.equal(registry.bindTaskToWorkEpisode(task.id, id), true);
    const dependent = tasks.create({ title: "Implement the plan", intent: "Implement", kind: "ship", agent: "claude",
      repoRoot: repo.clone, backlog: true, dependencies: [{ type: "task", taskId: task.id }, { type: "session", sessionId: id }] });
    registry.upsertGoal(id, { prompt: "Publish the approved plan", text: "Publish the approved plan",
      objective: "Publish the approved plan", focus: "Publish the approved plan", relationship: "initial",
      rationale: "Task intent", objectiveVersion: 1, promptRevision: 1, resolvedPromptRevision: 1,
      pendingPrompts: [], source: "heuristic" });
    let reviews = 0;
    const runner: LlmRunner = {
      id: "claude", label: "Fake reviewer", runInThread: null, structuredOutput: null,
      sandbox: null, price: () => null, litter: null, killLiveRuns() {},
      async run() {
        reviews++;
        return JSON.stringify({ verdict: "pass", summary: "Validated",
          approvalDetails: { reason: "Plan is ready", evidence: [] }, confidence: 1 });
      },
    };
    const workflows = new WorkflowManager(registry, new PersonaManager(registry).store, {
      engine: { runnerFor: () => runner, resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null }, model: { id: "fake", source: "config" },
      }) },
      compactContext: async (raw) => fallbackWorkflowContext(raw, "test"),
    });
    workflows.start();
    t.after(() => workflows.stop());
    const bound = workflows.createBinding({ workflowVersionId: "hook-review-v1", sessionId: id });
    assert.ok(bound.ok, bound.ok ? "" : bound.message);
    const staged = await workflows.stageAgentEvidence(id, { images: [], commandOutputs: [{
      kind: "command", clientItemId: "plan-proof", command: "plan-check", exitCode: 0, output: "plan verified",
      caption: "Approved plan verification", repositoryScope: "repo-01",
    }] });
    registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Planning" });
    registry.applyDriverEvent(id, { kind: "turn_done", usage: null });
    const before = structuredClone(registry.getSession(id)!);
    const episode = registry.workEpisodeForSession(id);
    const taskEpisode = taskWorkEpisodeForTask(task.id);
    const dependentBefore = structuredClone(registry.getTask(dependent.id));
    const persistedIdentity = lastAgentBinding(id);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      registry.applyHook({ ...hook(`${id}-summarizer`, env, event), prompt: "Summarize the completed session" });
      assert.deepEqual(registry.getSession(id), before, `${event} must not alter the SDK card`);
      assert.equal(lastAgentBinding(id), persistedIdentity, `${event} must not persist the auxiliary identity`);
      assert.equal(registry.getTask(task.id)?.status, "running");
      assert.equal(registry.getTask(task.id)?.sessionId, id);
      assert.deepEqual(registry.workEpisodeForSession(id), episode);
      assert.deepEqual(taskWorkEpisodeForTask(task.id), taskEpisode);
      assert.deepEqual(registry.getTask(dependent.id), dependentBefore);
      assert.deepEqual(workflows.store.getBinding(bound.value.id), bound.value);
      assert.deepEqual(workflows.store.listWorkflowEvidence(noteKeyFor(before)), staged);
    }
    const claimed = await workflows.claimCompletion(id, {
      completionKind: "prompted", marker: "a".repeat(64), evidenceFingerprint: "plan-proof",
      summary: "Plan ready for validation", expectedWorkCycle: { logicalKey: before.agentSessionId!, generation: before.workCycle!.generation },
      expectedIntent: { objective: "Publish the approved plan", objectiveVersion: 1, promptRevision: 1, episodeKey: "intent:1:1" },
    });
    assert.ok(claimed.claimed);
    assert.equal(claimed.state, "started");
    assert.equal(workflows.store.getRun(claimed.runId)?.bindingId, bound.value.id);
    assert.equal(workflows.store.getRun(claimed.runId)?.intent?.sourceNoteKey, before.agentSessionId);
    const deadline = Date.now() + 5_000;
    while (workflows.store.getRun(claimed.runId)?.status !== "completed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reviews, 1, "original completion reaches the validation Persona");
    assert.equal(workflows.store.getRun(claimed.runId)?.status, "completed");
    assert.equal(workflows.store.listSubmissionTextArtifacts(claimed.submissionId!).length, 1, "registered evidence reaches validation");
  });
}

test("unbound SDK identity can only be established by its driver", () => {
  const id = "sdk:hook-unbound";
  const registry = owner(id, false);
  const before = structuredClone(registry.getSession(id));
  for (const claimedId of [null, "auxiliary-before-bind"]) {
    registry.applyHook(hook(claimedId, { tmuxPane: "%inherited" }));
    assert.deepEqual(registry.getSession(id), before);
  }
  registry.applyDriverEvent(id, { kind: "bound", agentSessionId: "owned", transcriptPath: null, modelId: null, pid: null });
  assert.equal(registry.getSession(id)?.agentSessionId, "owned");
});

test("SDK hooks require the current native identity, including across an explicit driver clear", () => {
  const id = "sdk:hook-clear";
  const registry = owner(id);
  const env = { tmuxPane: "%clear" };
  registry.getSession(id)!.terminals.push(mkMuxHandle({ paneId: env.tmuxPane }));
  const before = structuredClone(registry.getSession(id));
  for (const claimedId of [null, id, "foreign-clear"]) {
    registry.applyHook({ ...hook(claimedId, env), source: "clear", permissionMode: "plan" });
    assert.deepEqual(registry.getSession(id), before);
  }
  registry.applyHook(hook(`${id}-native`, env, "UserPromptSubmit"));
  assert.equal(registry.getSession(id)?.state, "working", "matching hooks still supply instrumentation");
  assert.equal(registry.getSession(id)?.permissionMode, null, "rejected hooks leave no sticky pane overlay");
  registry.applyDriverEvent(id, { kind: "bound", agentSessionId: "cleared-native", transcriptPath: null,
    modelId: null, pid: null, cleared: true });
  assert.equal(registry.getSession(id)?.agentSessionId, "cleared-native");
  const cleared = structuredClone(registry.getSession(id));
  registry.applyHook(hook(`${id}-native`, env, "Stop"));
  assert.deepEqual(registry.getSession(id), cleared, "late hooks cannot restore the old identity");
  registry.applyHook(hook("cleared-native", env, "Stop"));
  assert.equal(registry.getSession(id)?.state, "idle");
});
