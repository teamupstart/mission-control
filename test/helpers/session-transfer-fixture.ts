import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { Registry } from "../../src/server/registry.ts";
import { ReviewManager } from "../../src/server/reviews.ts";
import { TaskManager } from "./task-manager-fixture.ts";
import { WorkflowManager, type WorkflowManagerOptions } from "../../src/server/workflows/manager.ts";
import { WorkflowStore } from "../../src/server/workflows/store.ts";
import { SessionTransferCoordinator } from "../../src/server/session-transfers/coordinator.ts";
import { claimResumeLease, resumeLeaseStatus } from "../../src/server/terminal/resume-lease.ts";
import { prepareTerminalResume } from "../../src/server/harness/resume.ts";
import type { PreparedResume } from "../../src/server/harness/resume.ts";
import { openDb } from "../../src/server/db.ts";
import { upsertSdkSession, setSdkSessionStatus } from "../../src/server/sdk/store.ts";
import type { SdkSupervisor } from "../../src/server/sdk/supervisor.ts";
import type { HandoffDeps } from "../../src/server/sdk/handoff.ts";
import type { DiscoveredSession } from "../../src/server/discovery/correlate.ts";
import { mkTask, mkMuxHandle } from "./session-fixture.ts";
import { FIXTURE_RUN_INTENT } from "./workflow-run-intent.ts";

export function transferFixture(t: TestContext, options: { task?: boolean; workflows?: number; workflowOptions?: WorkflowManagerOptions;
  processSnapshot?: typeof import("../../src/server/discovery/processes.ts").listProcessesSnapshot } = {}) {
  const suffix = randomUUID();
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const reviews = new ReviewManager(registry);
  const store = new WorkflowStore();
  let injections = 0;
  const workflows = new WorkflowManager(registry, store, { inject: async () => { injections++; return { ok: true, pasted: true, submitVerified: true }; }, ...options.workflowOptions });
  const sourceId = `sdk:${suffix}`;
  const nativeId = `native-${suffix}`;
  const cwd = `/fixture/${suffix}`;
  registry.registerSdkSession({ id: sourceId, agent: "claude", name: "Continue work", cwd });
  registry.applyDriverEvent(sourceId, { kind: "bound", agentSessionId: nativeId, transcriptPath: null, modelId: null, pid: null });
  const task = options.task === false ? null : mkTask({ id: `task-${suffix}`, sessionId: sourceId,
    status: "running", worktreePath: cwd, dispatchedAt: 10 });
  if (task) { registry.upsertTask(task); registry.bindTaskToWorkEpisode(task.id, sourceId); }
  upsertSdkSession({ id: sourceId, agent: "claude", agentSessionId: nativeId, cwd, taskId: task?.id ?? null,
    model: null, effort: null, permissionMode: null, status: "running", turnInProgress: false });
  const source = registry.getSession(sourceId)!;
  const db = openDb();
  const bindings: string[] = [];
  for (let index = 0; index < (options.workflows ?? 0); index++) {
    const id = `${suffix}-${index}`;
    const graph = JSON.stringify({ nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ], edges: [] });
    const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3 });
    db.prepare(`INSERT INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json,
      completion_policy_json, binding_defaults_json, draft_revision, current_version_id, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, '{"kind":"none"}', ?, 2, ?, 1, 1)`)
      .run(`w-${id}`, `Workflow ${id}`, `workflow ${id}`, graph, defaults, `new-${id}`);
    for (const [prefix, version] of [["old", 1], ["new", 2]] as const) {
      db.prepare(`INSERT INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json,
        completion_policy_json, binding_defaults_json, published_at) VALUES (?, ?, ?, ?, ?, '{"kind":"none"}', ?, 1)`)
        .run(`${prefix}-${id}`, `w-${id}`, version, version, graph, defaults);
    }
    const binding = store.insertBinding({ id: `binding-${id}`, workflowVersionId: `old-${id}`, noteKey: nativeId,
      sessionId: sourceId, sessionAgent: "claude", sessionName: source.name,
      sessionCwd: index === 0 ? cwd : `${cwd}/secondary-${index}`, sessionRepoRoot: index === 0 ? null : `/second-${index}`,
      repoRoot: index === 0 ? "" : `/second-${index}`, triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3, now: 1 });
    bindings.push(binding.id);
    store.createInitialSubmission({ id: `run-${id}`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: `trigger-${id}`, now: 2 },
      { id: `submission-${id}`, triggerSource: "manual", triggerKey: `trigger-${id}`, context: { immutable: "context" }, evidence: { immutable: "evidence" }, now: 2 });
    store.setSubmissionState(`submission-${id}`, "completed", 3);
    store.setRunState(`run-${id}`, "blocked", "delivery_refused", null, 3);
  }
  workflows.start();
  let prepared: PreparedResume | null = null;
  const processes = async () => {
    const owner = prepared ? resumeLeaseStatus(prepared.lease).owner : null;
    const common = { tty: "fixture", startRaw: "fixture", command: "fixture", agent: null, agentNative: false };
    return owner ? [{ ...common, pid: owner.pid, ppid: 1, startMs: owner.startMs },
      { ...common, pid: 100001, ppid: owner.pid, startMs: 100 }] : [];
  };
  const transfers = new SessionTransferCoordinator(registry, { workflows, reviews,
    settleTask: (id) => tasks.settleAfterFailedHandoff(id), taskBlocked: (id) => tasks.taskCleanupIsReserved(id),
    processes, processSnapshot: options.processSnapshot });
  transfers.start();
  t.after(async () => { await transfers.stop(); await workflows.stop(); });
  let live = true;
  let launches = 0;
  let stops = 0;
  const claiming = new Set<string>();
  const supervisor = {
    handleFor: () => live ? { recoveryProcessId: process.pid } : null,
    beginHandoff: () => { if (claiming.size) return false; claiming.add(sourceId); return true; },
    endHandoff: () => claiming.clear(),
    stop: async () => { stops++; live = false; setSdkSessionStatus(sourceId, "exited"); registry.applyDriverEvent(sourceId, { kind: "exited", reason: "stopped", resumable: true }); },
  } as unknown as SdkSupervisor;
  const candidate: DiscoveredSession = { syntheticId: `proc:${suffix}`, agent: "claude", name: "terminal", nameSource: "tmux",
    cwd, gitBranch: source.gitBranch, gitRoot: null, repoRoot: source.repoRoot, pid: 100_001, tty: `tty-${suffix}`,
    terminals: [mkMuxHandle({ session: `resource-${suffix}`, paneId: `%${suffix}` })], startedAt: 100, agentSessionId: nativeId, transcriptPath: null };
  const deps: HandoffDeps = {
    transfers,
    prepare: async () => {
      prepared = await prepareTerminalResume(source, { managed: true, requiredTools: [], extraDirs: [] });
      return prepared;
    },
    spawn: async ({ prepared }) => { launches++; prepared.beginLaunch(); return { homeName: "continued", homeBackend: "tmux", terminalResourceId: `multiplexer:tmux:resource-${suffix}` }; },
    waitForSessionAtCwd: async () => null,
    settleTask: (id) => tasks.settleAfterFailedHandoff(id),
  };
  return { registry, tasks, reviews, workflows, store, transfers, source, task, candidate, deps, supervisor, bindings,
    processes, prepared: () => { assert.ok(prepared); return prepared; }, counts: () => ({ launches, stops, injections }),
    setLive: (value: boolean) => { live = value; },
    discover: (patch: Partial<DiscoveredSession> = {}) => {
      if (prepared && !resumeLeaseStatus(prepared.lease).owner) claimResumeLease(prepared.lease, 200001, 50);
      registry.applyDiscovery([{ ...candidate, ...patch }]); return registry.getSession(patch.syntheticId ?? candidate.syntheticId)!; } };
}
