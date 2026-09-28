import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-handoff-retention-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb, getTaskSessionClosure } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { WorktreeManager } = await import("../src/server/worktrees/manager.ts");
const { nativeWorktreeOwnerReferenced } = await import("../src/server/worktrees/owners.ts");
const { buildApp } = await import("../src/server/routes.ts");

test("initial shipping-workflow handoff retains the task worktree and lease, blocking pool reuse", async (t) => {
  const { root, clone } = mkOriginAndClone("mission-handoff-repository-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseSha = gitIn(clone, "rev-parse", "HEAD");
  const db = openDb();
  const worktrees = new WorktreeManager(db, {
    // Prove the lease blocks reuse even when no OS process occupies the checkout.
    occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known", occupants: [] }])),
    ownerReferenced: async (reference) => nativeWorktreeOwnerReferenced(reference, db),
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null }),
  });
  t.after(() => worktrees.stop());
  const acquired = await worktrees.acquire({
    repositoryPath: clone, baseSha, owner: { kind: "task", key: "handoff-task:0" },
  });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const lease = acquired.lease;
  const implementation = join(lease.path, "implementation.txt");
  writeFileSync(implementation, "work awaiting shipping review\n");

  const registry = new Registry();
  const stopped: string[] = [];
  const tasks = new TaskManager(registry, {
    resetWouldDestroyWork: async () => null,
    kill: async (session) => { stopped.push(session.id); return { ok: true }; },
  }, undefined, undefined, undefined, {}, worktrees);
  t.after(async () => {
    tasks.stopMissionSessionClosures();
    await tasks.settleWorktreeReturns();
  });
  registry.applyDiscovery([{
    syntheticId: "handoff-session", agent: "claude", name: "Shipping handoff", nameSource: "process",
    cwd: lease.path, gitBranch: "feature", gitRoot: lease.path, repoRoot: clone,
    agentSessionId: "handoff-session", pid: 123456, tty: "handoff-tty", terminals: [], startedAt: 1,
  }]);
  const task = mkTask({
    id: "handoff-task", status: "running", kind: "ship", sessionId: "handoff-session",
    repoRoot: clone, worktreePath: lease.path, provider: "mission", worktreeLeaseId: lease.leaseId,
    baseSha, workflowId: "shipping-workflow",
  });
  registry.upsertTask(task);
  const objective = "Implement the change, then hand it to the shipping workflow";
  registry.upsertGoal("handoff-session", {
    prompt: objective, text: objective, objective, focus: objective, relationship: "initial",
    rationale: "Initial objective", objectiveVersion: 1, promptRevision: 1,
    resolvedPromptRevision: 1, pendingPrompts: [], source: "heuristic",
  }, 5);
  for (const [event, ts] of [["PreToolUse", 6], ["Stop", 7]] as const) {
    registry.applyHook({
      agent: "claude", event, sessionId: "handoff-session", cwd: lease.path,
      transcriptPath: null, env: {}, toolName: event === "PreToolUse" ? "Edit" : undefined, ts,
    });
  }

  const queues = new QueueManager(registry);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store, {
    queueManager: queues,
    // Keep evidence capture deterministic and spend no model tokens.
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: objective, refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [], priorPersonaFeedback: [],
        session: { agent: "claude", name: "Shipping handoff", cwd: lease.path, branch: "feature" },
        evidence: {
          headSha: baseSha, diffFingerprint: "implementation", diff: "implementation.txt added",
          diffTruncated: false, workingTreeDirty: true, workingTreeStatus: [],
          workingTreeStatusTruncated: false, transcript: [], transcriptAnchor: 1,
          transcriptTruncated: false, standards: [], standardsTruncated: false,
        },
      };
      return {
        raw, context: fallbackWorkflowContext(raw, null),
        boundary: {
          noteKey: binding.noteKey, sessionId: binding.sessionId!, headSha: baseSha,
          transcriptPath: null, transcriptSize: 1, repositoryFingerprint: "handoff-repo",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test"),
  });
  t.after(() => workflows.stop());
  const created = workflows.store.insertWorkflow({
    id: "shipping-workflow", name: "Shipping", normalizedName: "shipping", description: "",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
      ],
      edges: [{ id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
    },
    completionPolicy: { kind: "none" }, resumptionPolicy: "manual", evidenceReadinessPolicy: "off",
    bindingDefaults: { triggerMode: "foreman_complete", deliveryMode: "preview", maxRepairRounds: 2 },
    createdAt: 1, updatedAt: 1,
  });
  assert.equal(created.ok, true);
  assert.equal(workflows.store.publishWorkflow("shipping-workflow", 1, "shipping-version", 2).ok, true);
  const binding = workflows.store.insertBinding({
    id: "shipping-binding", workflowVersionId: "shipping-version", noteKey: "handoff-session",
    sessionId: "handoff-session", sessionAgent: "claude", sessionName: "Shipping handoff",
    sessionCwd: lease.path, sessionRepoRoot: clone, triggerMode: "foreman_complete",
    deliveryMode: "preview", maxRepairRounds: 2, now: 3,
  });
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks, queues, personas, workflows });

  const response = await app.request("/api/sessions/handoff-session/workflow-completion", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({
      completionKind: "prompted", marker: "a".repeat(64), summary: "Implementation is ready for shipping review",
      evidenceFingerprint: "implementation", expectedWorkCycle: { logicalKey: "handoff-session", generation: 1 },
      expectedIntent: { objective, objectiveVersion: 1, promptRevision: 1, episodeKey: "intent:1:1" },
    }),
  });
  const handoff = await response.json() as { claimed: boolean; state: string; runId: string };
  assert.equal(response.status, 200, JSON.stringify(handoff));
  assert.equal(handoff.claimed, true);
  assert.equal(handoff.state, "started");
  assert.equal(workflows.store.getRun(handoff.runId)?.bindingId, binding.id);
  assert.equal(workflows.store.listSubmissions(handoff.runId).length, 1);

  // Drain the same completion cleanup path that would close and return a final task.
  await tasks.sweepMissionSessionClosures();
  await tasks.settleWorktreeReturns();
  const retained = registry.getTask(task.id)!;
  assert.equal(retained.status, "running", "initial handoff is not final completion");
  assert.equal(retained.sessionId, "handoff-session");
  assert.equal(retained.worktreePath, lease.path);
  assert.equal(retained.worktreeLeaseId, lease.leaseId);
  assert.equal(retained.provider, "mission");
  assert.equal(getTaskSessionClosure(task.id), null, "handoff must not schedule session closure");
  assert.deepEqual(stopped, []);
  assert.equal(worktrees.lookupLease({ leaseId: lease.leaseId }).state, "active");
  assert.equal(readFileSync(implementation, "utf8"), "work awaiting shipping review\n");

  const contender = await worktrees.acquire({
    repositoryPath: clone, baseSha, owner: { kind: "task", key: "next-task:0" },
  });
  assert.equal(contender.outcome, "notAcquired", "the held slot must remain unavailable to another task");
  if (contender.outcome === "notAcquired") assert.match(contender.reason, /capacity 1/);
});
