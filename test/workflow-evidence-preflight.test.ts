import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-evidence-preflight-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { fallbackWorkflowContext, compactWorkflowContext } =
  await import("../src/server/workflows/context.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");
const { openDb } = await import("../src/server/db.ts");

const repositoryRoot = process.cwd();
setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [repositoryRoot] });

const passingRunner: LlmRunner = {
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
      verdict: "pass",
      summary: "Ready",
      approvalDetails: { reason: "The requested behavior is present.", evidence: [] },
      confidence: 1,
    });
  },
};

function discovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd: repositoryRoot,
    gitBranch: "feature",
    gitRoot: repositoryRoot,
    repoRoot: repositoryRoot,
    pid: 9000 + id.length,
    tty: `tty-${id}`,
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness(t: TestContext, id: string, beforeReadContext?: () => Promise<void>) {
  const registry = new Registry();
  registry.applyDiscovery([discovered(id)]);
  const store = new WorkflowStore(openDb());
  const personaId = `preflight-persona-${id}`;
  const workflowId = `preflight-workflow-${id}`;
  store.insertPersona({
    id: personaId,
    name: `Preflight ${id}`,
    normalizedName: normalizePersonaName(`Preflight ${id}`),
    description: "",
    guidanceMarkdown: "Review.",
    runner: "claude",
    model: "fake",
    createdAt: 1,
    updatedAt: 1,
  });
  const created = store.insertWorkflow({
    id: workflowId,
    name: `Preflight workflow ${id}`,
    normalizedName: normalizeWorkflowName(`Preflight workflow ${id}`),
    description: "",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "persona", kind: "persona", personaId, position: { x: 200, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "start", source: "session", sourcePort: "submitted", target: "persona", targetPort: "activate" },
        { id: "pass", source: "persona", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "repair", source: "persona", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "auto",
    evidenceReadinessPolicy: "criterion_mapped_v1",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "live", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(created.ok, true);
  const published = store.publishWorkflow(workflowId, 1, `preflight-version-${id}`, 2);
  assert.equal(published.ok, true);
  if (!published.ok) throw new Error("workflow did not publish");
  const injected: string[] = [];
  const manager = new WorkflowManager(registry, store, {
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
    recordInjection: (() => {}) as never,
    readContextRaw: async (_registry, binding) => {
      await beforeReadContext?.();
      const raw = {
        primaryGoal: { rawPrompt: "Render the final workflow state", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: id, cwd: repositoryRoot, branch: "feature" },
        evidence: {
          headSha: "abc",
          diffFingerprint: "diff",
          diff: "patch",
          diffTruncated: false,
          workingTreeDirty: true,
          workingTreeStatus: [" M src/file.ts"],
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
          transcriptSize: 0,
          repositoryFingerprint: "repo",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => compactWorkflowContext(raw, {
      runner: "claude",
      model: "fake",
      execute: async () => ({
        kind: "ok",
        value: {
          constraints: [],
          acceptanceCriteria: ["Rendered workflow state is inspectable"],
          canonicalCriteria: [{
            text: "Rendered workflow state is inspectable",
            material: true,
            suggestedProofClass: "visual",
            matchedClientCriterionIds: (raw.coverage ?? []).map((claim) => claim.clientCriterionId),
          }],
        },
      }),
    }),
    engine: {
      runnerFor: () => passingRunner,
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
    },
  });
  manager.start();
  t.after(() => manager.stop());
  const binding = manager.createBinding({ workflowVersionId: published.version.id, sessionId: id });
  assert.equal(binding.ok, true);
  if (!binding.ok) throw new Error("binding was refused");
  return { registry, store, manager, binding: binding.value, injected };
}

test("automatic readiness sweep does not join a live manual preflight capture", async (t) => {
  let holdCapture = false;
  let liveCaptureCalls = 0;
  let signalCaptureStarted!: () => void;
  const captureStarted = new Promise<void>((resolve) => { signalCaptureStarted = resolve; });
  let releaseCapture!: () => void;
  const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
  const h = await harness(t, "live-evidence-preflight", async () => {
    if (!holdCapture) return;
    liveCaptureCalls += 1;
    signalCaptureStarted();
    await captureReleased;
  });
  const execution = {
    kind: "command" as const,
    clientItemId: "live-browser-run",
    command: "npx playwright test focused.spec.ts",
    exitCode: 0,
    output: "1 passed\n",
    caption: "Focused browser flow passed",
    repositoryScope: "all" as const,
  };
  const claim = {
    clientCriterionId: "live-rendered-state",
    criterion: "Rendered workflow state is inspectable",
    proofClass: "visual" as const,
    repositoryScope: "all" as const,
    links: [{ clientItemId: execution.clientItemId, role: "execution" as const }],
  };
  await h.manager.stageAgentEvidence("live-evidence-preflight", {
    images: [],
    commandOutputs: [execution],
    coverage: [claim],
  });
  const submitted = await h.manager.submit(h.binding.id, { requestId: "live-wait" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  await waitFor(
    () => h.store.getRun(submitted.value.run.id)?.status === "waiting_for_evidence_readiness",
    "run did not wait for evidence readiness",
  );

  const rendered = {
    ...execution,
    clientItemId: "live-rendered-result",
    command: "capture rendered workflow",
    output: "rendered\n",
    caption: "Rendered workflow state",
  };
  await h.manager.stageAgentEvidence("live-evidence-preflight", {
    images: [],
    commandOutputs: [
      { ...execution, clientItemId: "live-repair-execution" },
      rendered,
    ],
    coverage: [{
      ...claim,
      clientCriterionId: "live-rendered-state-repair",
      links: [
        { clientItemId: "live-repair-execution", role: "execution" as const },
        { clientItemId: rendered.clientItemId, role: "rendered_output" as const },
      ],
    }],
  });

  holdCapture = true;
  const retry = h.manager.retryEvidenceReadiness(
    submitted.value.run.id,
    submitted.value.submission.id,
    "live-manual-retry",
  );
  await captureStarted;
  const replay = h.manager.retryEvidenceReadiness(
    submitted.value.run.id,
    submitted.value.submission.id,
    "live-manual-retry",
  );
  const replaySettledWhileCaptureWasLive = await Promise.race([
    replay.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  const sweep = h.manager.sweepResumptions(Date.now() + 60_000);
  const settledWhileCaptureWasLive = await Promise.race([
    sweep.then(() => true),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  releaseCapture();
  const [retried, replayed] = await Promise.all([retry, replay, sweep]);

  assert.equal(
    replaySettledWhileCaptureWasLive,
    true,
    "an idempotent request replay must not join its own live evidence capture",
  );
  assert.equal(
    settledWhileCaptureWasLive,
    true,
    "the sweep must not wait behind an evidence capture that is still live in this process",
  );
  assert.equal(retried.ok, true);
  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.equal(replayed.idempotent, true);
  assert.equal(liveCaptureCalls, 1, "only the first request may enter evidence capture");
});

test("enforced gaps wait, and in-round capture and override replays recover activation", async (t) => {
  const h = await harness(t, "evidence-preflight");
  const execution = {
    kind: "command" as const,
    clientItemId: "browser-run",
    command: "npx playwright test focused.spec.ts",
    exitCode: 0,
    output: "1 passed\n",
    caption: "Focused browser flow passed",
    repositoryScope: "all" as const,
  };
  const claim = {
    clientCriterionId: "rendered-state",
    criterion: "Rendered workflow state is inspectable",
    proofClass: "visual" as const,
    repositoryScope: "all" as const,
    links: [{ clientItemId: execution.clientItemId, role: "execution" as const }],
  };
  await h.manager.stageAgentEvidence("evidence-preflight", {
    images: [],
    commandOutputs: [execution],
    coverage: [claim],
  });
  const submitted = await h.manager.submit(h.binding.id, { requestId: "wait" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
    "run did not wait for evidence readiness",
  );
  assert.equal(h.store.listAttempts(submitted.value.submission.id).length, 0);
  const unchangedRetry = await h.manager.retryEvidenceReadiness(
    runId,
    submitted.value.submission.id,
    "unchanged-retry",
  );
  assert.equal(unchangedRetry.ok, false);
  if (!unchangedRetry.ok) assert.equal(unchangedRetry.reason, "unchanged_evidence");
  assert.equal(h.store.listSubmissions(runId).length, 1);
  assert.deepEqual(h.store.getSubmission(submitted.value.submission.id)?.readiness?.gapCodes, [
    "missing_rendered_output",
  ]);
  const initialEvaluation = h.store.listEvents(runId)
    .find((event) => event.kind === "evidence_readiness_evaluated");
  assert.ok(initialEvaluation, "the activation decision must append its structural evaluation");
  assert.match(JSON.stringify(initialEvaluation.payload), /"status":"gaps"/);
  assert.match(JSON.stringify(initialEvaluation.payload), /"criteriaCount":1/);
  assert.doesNotMatch(
    JSON.stringify(initialEvaluation.payload),
    /Rendered workflow state is inspectable|browser-run|playwright|focused\.spec\.ts/,
    "readiness telemetry must not contain criterion, evidence identity, command or path content",
  );
  await waitFor(
    () => h.store.listDeliveries(runId).some((delivery) => delivery.kind === "evidence_readiness"),
    "readiness delivery was not prepared",
  );
  assert.match(h.store.listDeliveries(runId)[0]?.payload ?? "", /Register and link a gitignored rendered image/);

  const rendered = {
    kind: "command" as const,
    clientItemId: "rendered-result",
    command: "capture rendered workflow",
    exitCode: 0,
    output: "rendered\n",
    caption: "Rendered workflow state",
    repositoryScope: "all" as const,
  };
  await h.manager.stageAgentEvidence("evidence-preflight", {
    images: [],
    commandOutputs: [
      { ...execution, clientItemId: "repair-execution" },
      rendered,
    ],
    coverage: [{
      ...claim,
      clientCriterionId: "rendered-state-repair",
      links: [
        { clientItemId: "repair-execution", role: "execution" as const },
        { clientItemId: rendered.clientItemId, role: "rendered_output" as const },
      ],
    }],
  });
  const captureDriver = h.manager as unknown as {
    captureAndActivate: (...args: unknown[]) => Promise<unknown>;
  };
  const captureAndActivate = captureDriver.captureAndActivate.bind(h.manager);
  let readinessCaptureCalls = 0;
  captureDriver.captureAndActivate = async (...args) => {
    readinessCaptureCalls += 1;
    if (readinessCaptureCalls === 1) {
      throw new Error("simulated interruption after evidence refinement reservation");
    }
    return captureAndActivate(...args);
  };
  await h.manager.sweepResumptions(Date.now() + 60_000);
  const submissions = h.store.listSubmissions(runId);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1]?.round, submissions[0]?.round);
  assert.equal(submissions[1]?.segment, 1);
  assert.equal(submissions[1]?.parentSubmissionId, submissions[0]?.id);
  assert.equal(submissions[1]?.refinementReason, "evidence_preflight");
  assert.equal(h.store.getRun(runId)?.status, "capturing");
  assert.equal(submissions[1]?.status, "capturing");
  assert.equal(h.store.listAttempts(submissions[1]!.id).length, 0);
  await h.manager.sweepResumptions(Date.now() + 120_000);
  assert.equal(readinessCaptureCalls, 2, "the sweep must re-drive interrupted readiness capture");
  assert.equal(h.store.listSubmissions(runId).length, 2, "capture replay must reuse the reserved child");
  await waitFor(() => h.store.getRun(runId)?.status === "completed", "refined run did not activate");

  await h.manager.stageAgentEvidence("evidence-preflight", {
    images: [],
    commandOutputs: [{ ...execution, clientItemId: "override-run" }],
    coverage: [{
      ...claim,
      clientCriterionId: "override-state",
      links: [{ clientItemId: "override-run", role: "execution" }],
    }],
  });
  const second = await h.manager.submit(h.binding.id, { requestId: "override" });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await waitFor(
    () => h.store.getRun(second.value.run.id)?.status === "waiting_for_evidence_readiness",
    "override run did not wait",
  );
  const activateSubmission = h.manager.engine.activateSubmission.bind(h.manager.engine);
  let activationCalls = 0;
  h.manager.engine.activateSubmission = (submissionId) => {
    activationCalls += 1;
    if (activationCalls === 1) throw new Error("simulated interruption after override commit");
    activateSubmission(submissionId);
  };
  assert.throws(() => h.manager.overrideEvidenceReadiness(
    second.value.run.id,
    second.value.submission.id,
    "override-request",
    "The operator accepts the missing rendered output for this run.",
    true,
  ), /simulated interruption after override commit/);
  assert.equal(h.store.getRun(second.value.run.id)?.status, "running");
  assert.equal(h.store.listAttempts(second.value.submission.id).length, 0);

  await h.manager.stop();
  h.manager.start();
  await h.manager.sweepResumptions(Date.now() + 180_000);
  assert.equal(activationCalls, 2, "startup recovery must re-drive interrupted override activation");
  await waitFor(
    () => h.store.getRun(second.value.run.id)?.status === "completed",
    "overridden submission did not activate",
  );
  assert.equal(h.store.getSubmission(second.value.submission.id)?.readiness?.status, "overridden");
  assert.deepEqual(h.store.getSubmission(second.value.submission.id)?.readiness?.gapCodes, [
    "missing_rendered_output",
  ]);
  const replay = h.manager.overrideEvidenceReadiness(
    second.value.run.id,
    second.value.submission.id,
    "override-request",
    "The operator accepts the missing rendered output for this run.",
    true,
  );
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.idempotent, true);
  assert.equal(activationCalls, 2, "a replay after activation progressed must preserve run state");
  assert.equal(h.store.getRun(second.value.run.id)?.status, "completed");
  assert.deepEqual(h.store.listReadinessOverrides(second.value.run.id).map((entry) => ({
    reason: entry.reason,
    acknowledgedRisk: entry.acknowledgedRisk,
  })), [{
    reason: "The operator accepts the missing rendered output for this run.",
    acknowledgedRisk: true,
  }]);
  assert.equal(
    h.store.listEvents(second.value.run.id)
      .filter((event) => event.kind === "evidence_readiness_overridden").length,
    1,
  );

  await h.manager.stageAgentEvidence("evidence-preflight", {
    images: [],
    commandOutputs: [{ ...execution, clientItemId: "second-override-run" }],
    coverage: [{
      ...claim,
      clientCriterionId: "second-override-state",
      links: [{ clientItemId: "second-override-run", role: "execution" }],
    }],
  });
  const third = await h.manager.submit(h.binding.id, { requestId: "second-override" });
  assert.equal(third.ok, true);
  if (!third.ok) return;
  await waitFor(
    () => h.store.getRun(third.value.run.id)?.status === "waiting_for_evidence_readiness",
    "second override run did not wait",
  );
  const scopedOverride = h.manager.overrideEvidenceReadiness(
    third.value.run.id,
    third.value.submission.id,
    "override-request",
    "The operator accepts the missing rendered output for this separate run.",
    true,
  );
  assert.equal(scopedOverride.ok, true, "the same client request id is reusable on another run");
  if (scopedOverride.ok) assert.equal(scopedOverride.idempotent, false);
  assert.equal(activationCalls, 3);
  await waitFor(
    () => h.store.getRun(third.value.run.id)?.status === "completed",
    "second overridden submission did not activate",
  );
});

test("workflow event ids replay exact writes and reject conflicting reuse", () => {
  const store = new WorkflowStore(openDb());
  const first = store.appendEvent("event-run", "readiness", { status: "waiting" }, 1, "event-1");
  const replay = store.appendEvent("event-run", "readiness", { status: "waiting" }, 2, "event-1");
  assert.equal(replay.id, first.id);
  assert.throws(
    () => store.appendEvent("event-run", "readiness", { status: "different" }, 3, "event-1"),
    /replay conflict/,
  );
});
