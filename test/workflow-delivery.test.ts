import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-delivery-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { WorkflowStore } = await import("../src/server/workflows/store.ts");

function seededStore(suffix: string): InstanceType<typeof WorkflowStore> {
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${suffix}`,
    workflowVersionId: `version-${suffix}`,
    noteKey: `note-${suffix}`,
    sessionId: `session-${suffix}`,
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${suffix}`, binding, triggerSource: "manual", triggerKey: `manual:${suffix}`, now: 2 },
    {
      id: `submission-${suffix}`,
      triggerSource: "manual",
      triggerKey: `manual:${suffix}`,
      context: {},
      evidence: {},
      now: 2,
    },
  );
  return store;
}

function prepare(store: InstanceType<typeof WorkflowStore>, suffix: string) {
  return store.prepareDelivery({
    id: `delivery-${suffix}`,
    runId: `run-${suffix}`,
    submissionId: `submission-${suffix}`,
    kind: "persona_feedback",
    sessionId: `session-${suffix}`,
    noteKey: `note-${suffix}`,
    payload: "repair exactly once",
    payloadSha256: "a".repeat(64),
  }).delivery;
}

test("delivery rows are immutable packets claimed prepared to sending exactly once", () => {
  const store = seededStore("claim");
  const delivery = prepare(store, "claim");
  assert.equal(delivery.state, "prepared");
  assert.equal(prepare(store, "claim").id, delivery.id);
  assert.equal(store.claimDeliverySend(delivery.id)?.state, "sending");
  assert.equal(store.claimDeliverySend(delivery.id), null);
  assert.equal(store.setDeliveryState(delivery.id, "delivered", null)?.state, "delivered");
  assert.equal(store.claimDeliverySend(delivery.id, true), null);
});

test("positive refusal is explicitly retryable while uncertain delivery never auto-retries", () => {
  const store = seededStore("states");
  const delivery = prepare(store, "states");
  store.claimDeliverySend(delivery.id);
  store.setDeliveryState(delivery.id, "refused", "pane_blocked");
  assert.equal(store.claimDeliverySend(delivery.id), null);
  assert.equal(store.claimDeliverySend(delivery.id, true)?.state, "sending");
  store.setDeliveryState(delivery.id, "uncertain", "outcome_unknown");
  assert.equal(store.claimDeliverySend(delivery.id, true), null);
});

test("daemon recovery converts sending to uncertain and blocks its run, preserving prepared rows", () => {
  const sendingStore = seededStore("recover");
  const sending = prepare(sendingStore, "recover");
  sendingStore.claimDeliverySend(sending.id);
  const preparedStore = seededStore("prepared");
  const prepared = prepare(preparedStore, "prepared");
  const recovered = sendingStore.recoverSendingDeliveries(10);
  assert.equal(recovered.some((item) => item.id === sending.id), true);
  assert.equal(sendingStore.getDelivery(sending.id)?.state, "uncertain");
  assert.equal(sendingStore.getRun("run-recover")?.currentPhase, "delivery_uncertain");
  assert.equal(preparedStore.getDelivery(prepared.id)?.state, "prepared");
});

test("resolving an uncertain delivery preserves an orphaned run block", () => {
  const store = seededStore("orphaned-resolution");
  const delivery = prepare(store, "orphaned-resolution");
  store.claimDeliverySend(delivery.id);
  store.recoverSendingDeliveries(10);
  store.orphanBinding("binding-orphaned-resolution", "session_disappeared", 11);

  const blocked = store.getRun("run-orphaned-resolution");
  const resolved = store.resolveUncertainDelivery(
    delivery.id,
    "mark_delivered",
    "inspected-after-orphan",
    12,
  );

  assert.equal(resolved?.delivery.state, "delivered");
  assert.equal(resolved?.rearmed, null);
  assert.deepEqual(store.getRun("run-orphaned-resolution"), blocked);
});

test("resolving an old uncertain delivery preserves a reattached run block", () => {
  const store = seededStore("reattached-resolution");
  const delivery = prepare(store, "reattached-resolution");
  store.claimDeliverySend(delivery.id);
  store.recoverSendingDeliveries(10);
  store.reattachBinding("binding-reattached-resolution", {
    noteKey: "note-reattached",
    sessionId: "session-reattached",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
  }, 11);
  store.setRunState("run-reattached-resolution", "waiting_for_session", "reattached_resubmit_required", {
    priorNoteKey: "note-reattached-resolution",
    noteKey: "note-reattached",
  }, 11);

  const blocked = store.getRun("run-reattached-resolution");
  const resolved = store.resolveUncertainDelivery(
    delivery.id,
    "mark_delivered",
    "inspected-after-reattach",
    12,
  );

  assert.equal(resolved?.delivery.state, "delivered");
  assert.equal(resolved?.rearmed, null);
  assert.deepEqual(store.getRun("run-reattached-resolution"), blocked);
});

/**
 * The other half of the re-arm pair, at its narrowest.
 *
 * The two cases above resolve to `rearmed: null` because their bindings are orphaned or
 * reattached, so neither episode may be touched at all. This one has an ACTIVE binding and no
 * queue items, which is the shape `rearmDrainCompletionForDelivery` structurally cannot serve -
 * its `EXISTS (SELECT 1 FROM foreman_queue_items ...)` clause is false - and which therefore
 * re-armed nothing whatsoever before `rearmPromptedCompletionForDelivery` existed.
 *
 * The last assertion is the guard shape, and it is the one worth keeping: an absent queue row
 * means this session has no wrap-up state to restore, and inserting one here would manufacture
 * a Foreman episode for a session Foreman was never watching.
 */
test("an item-less session re-arms through the prompted episode, and never invents a queue", async () => {
  const { getQueueRow, upsertQueue } = await import("../src/server/db.ts");
  const store = seededStore("prompted-rearm");
  const delivery = prepare(store, "prompted-rearm");
  store.claimDeliverySend(delivery.id);
  upsertQueue({
    noteKey: "note-prompted-rearm",
    cwd: "/repo",
    branch: "feature",
    wrapupAskedAt: null,
    wrapupAnswer: null,
    promptedGoal: "Ship the feature",
    updatedAt: 10,
  });

  const confirmed = store.confirmDeliverySend(delivery.id, 1, true, 11);
  assert.equal(confirmed?.rearmed, "prompted");
  assert.equal(getQueueRow("note-prompted-rearm")?.promptedGoal, null);

  const noRow = seededStore("prompted-absent");
  const absent = prepare(noRow, "prompted-absent");
  noRow.claimDeliverySend(absent.id);
  assert.equal(noRow.confirmDeliverySend(absent.id, 1, true, 11)?.rearmed, null);
  assert.equal(getQueueRow("note-prompted-absent"), undefined);
});

test("terminal runs allow acknowledgement-only uncertain delivery resolution", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");

  for (const resolution of ["mark_delivered", "discard_and_new_round"] as const) {
    const suffix = `terminal-${resolution}`;
    const store = seededStore(suffix);
    const delivery = prepare(store, suffix);
    store.claimDeliverySend(delivery.id);
    store.cancelRun(`run-${suffix}`, "operator_cancelled", 10);
    const terminalRun = store.getRun(`run-${suffix}`);
    assert.equal(store.getDelivery(delivery.id)?.state, "uncertain");

    const manager = new WorkflowManager(new Registry(), store);
    const resolved = await manager.resolveDelivery(delivery.id, resolution === "mark_delivered"
      ? {
          requestId: `resolve-${suffix}`,
          resolution,
        }
      : {
          requestId: `resolve-${suffix}`,
          resolution,
          confirmation: "DISCARD AND SEND A NEW REPAIR ROUND",
          expectedSessionId: `session-${suffix}`,
          expectedNoteKey: `note-${suffix}`,
        }, 11);

    assert.equal(resolved.ok, true);
    assert.equal(
      store.getDelivery(delivery.id)?.state,
      resolution === "mark_delivered" ? "delivered" : "cancelled",
    );
    assert.deepEqual(store.getRun(`run-${suffix}`), terminalRun);
    assert.equal(store.listSubmissions(`run-${suffix}`).length, 1);
  }
});

test("copy-mode refusal stays retryable, an ambiguous retry never repeats, and recovery is explicit", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
  const store = seededStore("policy");
  const delivery = prepare(store, "policy");
  store.setDeliveryState(delivery.id, "refused", "ready_for_policy_test", 3);
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "session-policy",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 91,
    tty: "tty-policy",
    terminals: [],
    startedAt: 1,
    agentSessionId: "note-policy",
  } as DiscoveredSession]);
  const attempts: string[] = [];
  const attributed: string[] = [];
  const results = [
    {
      ok: false as const,
      error: "copy mode",
      paneBlocked: true,
      pasted: false,
      submitVerified: false,
    },
    {
      ok: false as const,
      error: "connection lost after paste",
      pasted: true,
      submitVerified: false,
    },
  ];
  const manager = new WorkflowManager(registry, store, {
    inject: (async (
      _session: Session,
      payload: string,
      _deps?: InjectDeps,
      beforeWrite?: PromptWriteGuard,
    ) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      attempts.push(payload);
      return results.shift()!;
    }) as never,
    recordInjection: ((sessionId: string, payload: string, origin: string) => {
      attributed.push(`${sessionId}:${origin}:${payload}`);
    }) as never,
  });

  store.appendEvent(delivery.runId, "delivery_retry_requested", {
    deliveryId: delivery.id,
    requestId: "copy-mode",
  });
  const refused = await manager.retryDelivery(delivery.id, {
    requestId: "copy-mode",
    expectedSessionId: "session-policy",
    expectedNoteKey: "note-policy",
  });
  assert.equal(refused.ok && refused.value.state, "refused");
  assert.equal(store.getDelivery(delivery.id)?.error, "pane_blocked");
  const repeatedRefusal = await manager.retryDelivery(delivery.id, {
    requestId: "copy-mode",
    expectedSessionId: "session-policy",
    expectedNoteKey: "note-policy",
  });
  assert.equal(repeatedRefusal.ok && repeatedRefusal.idempotent, true);
  assert.equal(attempts.length, 1);

  const ambiguous = await manager.retryDelivery(delivery.id, {
    requestId: "ambiguous",
    expectedSessionId: "session-policy",
    expectedNoteKey: "note-policy",
  });
  assert.equal(ambiguous.ok && ambiguous.value.state, "uncertain");
  assert.equal(attempts.length, 2);
  const automaticRetry = await manager.retryDelivery(delivery.id, {
    requestId: "must-not-repeat",
    expectedSessionId: "session-policy",
    expectedNoteKey: "note-policy",
  });
  assert.equal(automaticRetry.ok, false);
  assert.equal(attempts.length, 2, "an uncertain packet must never cross the write boundary again");

  const badDiscard = await manager.resolveDelivery(delivery.id, {
    requestId: "bad-discard",
    resolution: "discard_and_new_round",
    confirmation: "discard",
    expectedSessionId: "session-policy",
    expectedNoteKey: "note-policy",
  });
  assert.equal(badDiscard.ok, false);
  assert.equal(store.getDelivery(delivery.id)?.state, "uncertain");

  const resolved = await manager.resolveDelivery(delivery.id, {
    requestId: "mark-after-inspection",
    resolution: "mark_delivered",
  });
  assert.equal(resolved.ok, true);
  assert.equal(store.getDelivery(delivery.id)?.state, "delivered");
  assert.deepEqual(attributed, ["session-policy:workflow:repair exactly once"]);
  const duplicate = await manager.resolveDelivery(delivery.id, {
    requestId: "mark-after-inspection",
    resolution: "mark_delivered",
  });
  assert.equal(duplicate.ok && duplicate.idempotent, true);
  assert.equal(attributed.length, 1);
  const conflictingReuse = await manager.resolveDelivery(delivery.id, {
    requestId: "mark-after-inspection",
    resolution: "discard_and_new_round",
    confirmation: "DISCARD AND SEND A NEW REPAIR ROUND",
    expectedSessionId: "session-policy",
    expectedNoteKey: "note-policy",
  });
  assert.equal(conflictingReuse.ok, false);
});

test("workflow Live delivery sends an SDK session through its driver", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
  const { runtimePromptInjector } = await import("../src/server/sdk/deliver.ts");
  type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

  const sessionId = "sdk:11111111-1111-4111-8111-111111111111";
  const noteKey = "agent-sdk-workflow";
  const store = seededStore("sdk-driver");
  store.reattachBinding("binding-sdk-driver", {
    noteKey,
    sessionId,
    sessionAgent: "claude",
    sessionName: "embedded review",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
  }, 3);
  const delivery = store.prepareDelivery({
    id: "delivery-sdk-driver",
    runId: "run-sdk-driver",
    submissionId: "submission-sdk-driver",
    kind: "persona_feedback",
    sessionId,
    noteKey,
    payload: "apply the requested review changes",
    payloadSha256: "b".repeat(64),
  }).delivery;
  store.setDeliveryState(delivery.id, "refused", "ready_for_sdk_retry", 4);

  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const registry = new Registry();
  registry.registerSdkSession({
    id: sessionId,
    agent: "claude",
    name: "embedded review",
    cwd: "/repo",
    gitRoot: "/repo",
    repoRoot: "/repo",
  });
  registry.applyDriverEvent(sessionId, {
    kind: "bound",
    agentSessionId: noteKey,
    transcriptPath: null,
    modelId: null,
    pid: null,
  });

  const sent: { id: string; text: string }[] = [];
  const supervisor = {
    async send(id: string, turn: { text: string }) {
      sent.push({ id, text: turn.text });
      return "started" as const;
    },
  } as unknown as SdkSupervisor;
  const attributed: string[] = [];
  const manager = new WorkflowManager(registry, store, {
    inject: runtimePromptInjector(supervisor),
    recordInjection: ((id: string, payload: string, origin: string) => {
      attributed.push(`${id}:${origin}:${payload}`);
    }) as never,
  });

  const result = await manager.retryDelivery(delivery.id, {
    requestId: "send-sdk-feedback",
    expectedSessionId: sessionId,
    expectedNoteKey: noteKey,
  }, 5);

  assert.equal(result.ok && result.value.state, "delivered");
  assert.deepEqual(sent, [{ id: sessionId, text: "apply the requested review changes" }]);
  assert.deepEqual(attributed, [
    `${sessionId}:workflow:apply the requested review changes`,
  ]);
});

test("Live sends one exact packet, attributes it once, and re-arms only the drain guard", async () => {
  const { openDb } = await import("../src/server/db.ts");
  const { Registry } = await import("../src/server/registry.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
  const { setWorkflowConfig } = await import("../src/server/workflows/config.ts");
  const db = openDb();
  const snapshot = {
    sourcePersonaId: "live-persona",
    sourceRevision: 1,
    name: "Live reviewer",
    description: "",
    guidanceMarkdown: "Review.",
    runner: "claude" as const,
    model: "fake",
  };
  const graph = {
    nodes: [
      { id: "live-session", kind: "session", position: { x: 0, y: 0 } },
      { id: "live-persona", kind: "persona", persona: snapshot, position: { x: 100, y: 0 } },
    ],
    edges: [
      { id: "activate", source: "live-session", sourcePort: "submitted", target: "live-persona", targetPort: "activate" },
      { id: "repair", source: "live-persona", sourcePort: "fail", target: "live-session", targetPort: "return_for_changes" },
    ],
  };
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "live", maxRepairRounds: 2 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('live-workflow', 'Live review', 'live review', '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, 'live-version', NULL, 1, 1)`,
  ).run(defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('live-version', 'live-workflow', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES ('live-session', '/repo', 'feature', 5, 'workflow:old', NULL, 5)`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
       send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
       proposed_payload, recovered_at, revision, created_at, updated_at, sent_at, completed_at
     ) VALUES (
       'live-item', 'live-session', 0, 'work', 'verified', 1, 'base', 1, '[]',
       1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2
     )`,
  ).run();
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "live-session",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 88,
    tty: "tty-live",
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession]);
  const queues = new QueueManager(registry);
  const injected: string[] = [];
  const attributed: string[] = [];
  const fakeRunner: LlmRunner = {
    id: "claude",
    label: "fake",
    runInThread: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run() {
      return JSON.stringify({
        verdict: "fail",
        summary: "One issue",
        requestedChanges: [{
          title: "Fix it",
          rationale: "The evidence requires it.",
          evidence: [{ kind: "diff", quote: "bad line" }],
        }],
        confidence: 1,
      });
    },
  };
  const manager = new WorkflowManager(registry, new WorkflowStore(), {
    queueManager: queues,
    inject: (async (
      _session: Session,
      payload: string,
      _deps?: InjectDeps,
      beforeWrite?: PromptWriteGuard,
    ) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    }) as never,
    recordInjection: ((sessionId: string, payload: string, origin: string) => {
      attributed.push(`${sessionId}:${origin}:${payload}`);
    }) as never,
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Original live goal", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "head",
          diffFingerprint: "diff",
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [],
          workingTreeStatusTruncated: false,
          transcript: [],
          transcriptAnchor: null,
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
          headSha: "head",
          transcriptPath: null,
          transcriptSize: 0,
          repositoryFingerprint: "repo",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test"),
    engine: {
      runnerFor: () => fakeRunner,
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
    },
  });
  const binding = manager.createBinding({
    workflowVersionId: "live-version",
    sessionId: "live-session",
    triggerMode: "manual",
    deliveryMode: "live",
    maxRepairRounds: 2,
  });
  assert.equal(binding.ok, true);
  manager.start();
  const submitted = await manager.submit(
    binding.ok ? binding.value.id : "",
    { requestId: "live-submit" },
  );
  assert.equal(submitted.ok, true);
  const runId = submitted.ok ? submitted.value.run.id : "";
  const started = Date.now();
  while (manager.store.listDeliveries(runId)[0]?.state !== "delivered") {
    if (Date.now() - started > 3_000) throw new Error("timed out waiting for Live delivery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const delivery = manager.store.listDeliveries(runId)[0]!;
  assert.deepEqual(injected, [delivery.payload]);
  assert.equal(attributed.length, 1);
  assert.match(attributed[0]!, /^live-session:workflow:/);
  const queue = queues.getByKey("live-session")!;
  assert.equal(queue.wrapupAskedAt, null);
  assert.equal(queue.wrapupAnswer, null);
  assert.equal(queue.items[0]?.state, "verified");
  await manager.stop();
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: ["/repo"] });
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(manager.store.getDelivery(delivery.id)?.state, "delivered");
  assert.equal(injected.length, 1);
  const second = await manager.resubmit(runId, {
    requestId: "live-consent-removed",
    resubmitUnchanged: true,
  });
  assert.equal(second.ok, true);
  const refusedStarted = Date.now();
  while (manager.store.listDeliveries(runId)[1]?.state !== "refused") {
    if (Date.now() - refusedStarted > 3_000) throw new Error("timed out waiting for refused delivery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const refused = manager.store.listDeliveries(runId)[1]!;
  assert.equal(refused.state, "refused");
  assert.equal(refused.error, "live_not_authorized");
  assert.equal(manager.store.getBinding(binding.ok ? binding.value.id : "")?.deliveryMode, "live");
  assert.equal(injected.length, 1, "consent removal must block before a second terminal write");
  await manager.stop();
});

test("archiving cancels retryable packets and makes an in-flight send uncertain", () => {
  const store = seededStore("archive");
  const sending = prepare(store, "archive");
  const refused = store.prepareDelivery({
    id: "delivery-archive-refused",
    runId: "run-archive",
    submissionId: "submission-archive",
    kind: "persona_feedback",
    sessionId: "session-archive",
    noteKey: "note-archive",
    payload: "second repair",
    payloadSha256: "b".repeat(64),
  }).delivery;
  store.claimDeliverySend(sending.id);
  store.setDeliveryState(refused.id, "refused", "pane_blocked");

  const archived = store.archiveBindingAndCancel("binding-archive", 20);

  assert.equal(archived?.cancelledRunId, "run-archive");
  assert.equal(store.getDelivery(sending.id)?.state, "uncertain");
  assert.equal(store.getDelivery(sending.id)?.error, "binding_archived_during_send");
  assert.equal(store.getDelivery(refused.id)?.state, "cancelled");
  assert.equal(store.getRun("run-archive")?.status, "cancelled");
  assert.equal(
    store.listEvents("run-archive").some((event) =>
      event.kind === "delivery_uncertain"
      && (event.payload as { deliveryId?: string }).deliveryId === sending.id),
    true,
  );
});
