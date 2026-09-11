import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import type { WorkflowHumanDecision } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-evidence-preflight-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { LLM_RUNNERS } = await import("../src/server/llm/index.ts");
const { fallbackWorkflowContext, compactWorkflowContext } =
  await import("../src/server/workflows/context.ts");
const { WorkflowContextSnapshotSchema } = await import("../src/shared/protocol.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");
const { openDb } = await import("../src/server/db.ts");
const { EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT } = await import("../src/server/workflows/store.ts");

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

async function harness(
  t: TestContext,
  id: string,
  beforeReadContext?: () => Promise<void>,
  options: {
    humanDecisions?: () => WorkflowHumanDecision[];
    recordCompactionLedger?: boolean;
    compactContext?: typeof compactWorkflowContext;
    reconcileContext?: NonNullable<Parameters<typeof compactWorkflowContext>[1]>["reconcile"];
    /** The Persona verdict this run's single reviewer returns. Defaults to a pass. */
    runner?: LlmRunner;
    evidenceReadinessPolicy?: "off" | "criterion_mapped_v1";
  } = {},
) {
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
    evidenceReadinessPolicy: options.evidenceReadinessPolicy ?? "criterion_mapped_v1",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "live", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(created.ok, true);
  const published = store.publishWorkflow(workflowId, 1, `preflight-version-${id}`, 2);
  assert.equal(published.ok, true);
  if (!published.ok) throw new Error("workflow did not publish");
  const compactionValue = {
    constraints: [],
    acceptanceCriteria: ["Rendered workflow state is inspectable"],
    canonicalCriteria: [{
      text: "Rendered workflow state is inspectable",
      material: true,
      suggestedProofClass: "visual" as const,
    }],
    criterionMappings: [{
      canonicalCriterionOrdinal: 1,
      matchedClientCriterionIds: ["claim-0"],
    }],
  };
  if (options.recordCompactionLedger) {
    const run = LLM_RUNNERS.claude.run;
    LLM_RUNNERS.claude.run = async () => JSON.stringify(compactionValue);
    t.after(() => { LLM_RUNNERS.claude.run = run; });
  }
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
        humanDecisions: options.humanDecisions?.() ?? [],
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
    reconcileContext: options.reconcileContext,
    ...(options.compactContext ? {
      compactContext: options.compactContext,
    } : !options.recordCompactionLedger ? {
      compactContext: async (raw: Parameters<typeof compactWorkflowContext>[0]) =>
        compactWorkflowContext(raw, {
          runner: "claude",
          model: "fake",
          execute: async () => ({ kind: "ok", value: compactionValue }),
          reconcile: async () => ({
            kind: "ok",
            value: { criterionMappings: compactionValue.criterionMappings },
          }),
        }),
    } : {}),
    engine: {
      runnerFor: () => options.runner ?? passingRunner,
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

test("replacement evidence packets reuse stable intent criteria up to the refinement cap", async (t) => {
  const h = await harness(t, "stable-evidence-preflight", undefined, {
    recordCompactionLedger: true,
  });
  const criterion = "Rendered workflow state is inspectable";
  const stageReplacement = async (ordinal: number, ready: boolean) => {
    const executionId = `execution-${ordinal}`;
    const renderedId = `rendered-${ordinal}`;
    await h.manager.stageAgentEvidence("stable-evidence-preflight", {
      images: [],
      commandOutputs: [
        {
          kind: "command",
          clientItemId: executionId,
          command: `verify replacement ${ordinal}`,
          exitCode: 0,
          output: `replacement ${ordinal} passed\n`,
          caption: `Replacement ${ordinal} execution`,
          repositoryScope: "all",
        },
        ...(ready ? [{
          kind: "command" as const,
          clientItemId: renderedId,
          command: `capture replacement ${ordinal}`,
          exitCode: 0,
          output: `replacement ${ordinal} rendered\n`,
          caption: `Replacement ${ordinal} rendered output`,
          repositoryScope: "all" as const,
        }] : []),
      ],
      coverage: [{
        clientCriterionId: `claim-${ordinal}`,
        criterion,
        proofClass: "visual",
        repositoryScope: "all",
        links: [
          { clientItemId: executionId, role: "execution" },
          ...(ready ? [{ clientItemId: renderedId, role: "rendered_output" as const }] : []),
        ],
      }],
    });
  };

  await stageReplacement(0, false);
  const submitted = await h.manager.submit(h.binding.id, { requestId: "stable-root" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
    "initial packet did not wait for missing rendered output",
  );

  // The cap is what bounds this loop now, so the run gets exactly the refinements it is
  // allowed and the last one closes the gap. The refusal past the cap is its own test below.
  let parentId = submitted.value.submission.id;
  for (let ordinal = 1; ordinal <= EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT; ordinal++) {
    const ready = ordinal === EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT;
    await stageReplacement(ordinal, ready);
    const retry = await h.manager.retryEvidenceReadiness(
      runId,
      parentId,
      `stable-refinement-${ordinal}`,
      1_000 + ordinal,
    );
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    parentId = retry.value.submission.id;
    if (!ready) {
      assert.equal(h.store.getRun(runId)?.status, "waiting_for_evidence_readiness");
    }
  }
  await waitFor(() => h.store.getRun(runId)?.status === "completed", "final packet did not activate");

  const submissions = h.store.listSubmissions(runId);
  assert.equal(submissions.length, EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1);
  const contexts = submissions.map((submission) => WorkflowContextSnapshotSchema.parse(submission.context));
  const stableCriteria = contexts.map((context) => context.canonicalCriteria);
  for (const criteria of stableCriteria.slice(1)) assert.deepEqual(criteria, stableCriteria[0]);
  assert.deepEqual(submissions[0]?.readiness?.gapCodes, ["missing_rendered_output"]);
  assert.equal(submissions.at(-1)?.readiness?.status, "ready");
  // Phase 2's cap names the last segment; carry-forward decides what that segment holds.
  const lastClaim = `claim-${EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT}`;
  const finalClaims = h.store.listSubmissionCoverage(submissions.at(-1)!.id);
  assert.deepEqual(
    finalClaims.filter((claim) => !claim.inheritedFromSubmissionId)
      .map((claim) => claim.clientCriterionId),
    [lastClaim],
    "exactly one claim on this segment was declared here",
  );
  assert.deepEqual(
    finalClaims.filter((claim) => claim.inheritedFromSubmissionId)
      .map((claim) => claim.clientCriterionId).sort(),
    Array.from({ length: EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT }, (_unused, index) => `claim-${index}`),
    "and every frozen ancestor claim is retained beside it by id, marked as carried",
  );
  // Retained ancestry is provenance, not a competing assertion: the claim the author declared
  // on this segment is still the one that answers for the criterion.
  assert.deepEqual(contexts.at(-1)?.criterionMappings[0]?.matchedClientCriterionIds.includes(lastClaim), true);
  assert.equal(submissions.at(-1)?.readiness?.criteria[0]?.matchedClientCriterionId, lastClaim);
  assert.equal(
    submissions.at(-1)?.readiness?.gapCodes.includes("ambiguous_mapping"),
    false,
    "retained ancestry never reports as the author asserting two things at once",
  );
  // Evidence accumulates the same way: this author mints a fresh client id every round, so
  // nothing deduplicates and the final segment still holds what earlier ones proved.
  const finalEvidence = h.store.listSubmissionTextArtifacts(submissions.at(-1)!.id);
  assert.deepEqual(
    finalEvidence.filter((item) => !item.inheritedFrom).map((item) => item.caption).sort(),
    [
      `Replacement ${EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT} execution`,
      `Replacement ${EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT} rendered output`,
    ],
  );
  assert.equal(
    finalEvidence.filter((item) => item.inheritedFrom).length,
    finalEvidence.length - 2,
  );
  for (const carried of finalEvidence.filter((item) => item.inheritedFrom)) {
    assert.equal(carried.inheritedFrom?.round, 1, "every segment of this run is round 1");
    assert.equal(typeof carried.inheritedFrom?.repositoryFingerprint, "string");
  }
  const captureEvents = h.store.listEvents(runId)
    .filter((event) => event.kind === "submission_captured");
  assert.equal(captureEvents.length, EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1);
  assert.match(JSON.stringify(captureEvents[0]?.payload), /"criteriaReused":false/);
  for (const event of captureEvents.slice(1)) {
    assert.match(JSON.stringify(event.payload), /"criteriaReused":true/);
    assert.match(
      JSON.stringify(event.payload),
      new RegExp(`"criteriaSourceSubmissionId":"${submissions[0]!.id}"`),
    );
  }
  assert.equal(
    h.store.listLlmCallPage(runId).items
      .filter((call) => call.purpose === "context_compaction").length,
    1,
    "only the source submission may create a context-compaction ledger row",
  );
  assert.equal(
    h.store.listLlmCallPage(runId).items
      .filter((call) => call.purpose === "context_reconciliation").length,
    0,
    "exact matches do not spend a reconciliation call",
  );
});

test("a corrupted submission context cannot restart the run's compaction", async (t) => {
  let compactionCalls = 0;
  const h = await harness(t, "fallback-retry-preflight", undefined, {
    compactContext: async (raw) => {
      compactionCalls += 1;
      return compactWorkflowContext(raw, {
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
            }],
          },
        }),
        reconcile: async () => ({
          kind: "ok",
          value: {
            criterionMappings: [{
              canonicalCriterionOrdinal: 1,
              matchedClientCriterionIds: raw.coverage?.[0]
                ? [raw.coverage[0].clientCriterionId]
                : [],
            }],
          },
        }),
      });
    },
  });
  const stageGap = async (ordinal: number) => {
    const clientItemId = `fallback-execution-${ordinal}`;
    await h.manager.stageAgentEvidence("fallback-retry-preflight", {
      images: [],
      commandOutputs: [{
        kind: "command",
        clientItemId,
        command: "verify fallback retry",
        exitCode: 0,
        output: "fallback retry passed\n",
        caption: "Fallback retry execution",
        repositoryScope: "all",
      }],
      coverage: [{
        clientCriterionId: `fallback-claim-${ordinal}`,
        criterion: "Rendered workflow state is inspectable",
        proofClass: "visual",
        repositoryScope: "all",
        links: [{ clientItemId, role: "execution" }],
      }],
    });
  };

  await stageGap(0);
  const submitted = await h.manager.submit(h.binding.id, { requestId: "fallback-root" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
    "fallback source did not wait for evidence readiness",
  );
  const sourceContext = WorkflowContextSnapshotSchema.parse(submitted.value.submission.context);
  assert.equal(sourceContext.compaction.status, "model");
  assert.equal(compactionCalls, 1);
  const frozen = h.store.getRun(runId)?.criteria ?? null;
  assert.ok(frozen, "the first successful compaction froze the run's criteria");
  assert.equal(frozen.compactedFromSubmissionId, submitted.value.submission.id);
  assert.deepEqual(frozen.acceptanceCriteria, ["Rendered workflow state is inspectable"]);

  // Reuse used to be sourced from the PARENT SUBMISSION's stored context, so anything that
  // damaged that one row - a partial write, a retention sweep, a hand edit like this one -
  // silently bought the run another compaction and another set of criteria. The criteria now
  // belong to the run, and a submission row is a record of what was reviewed rather than the
  // thing later submissions are reviewed by.
  openDb().prepare(
    "UPDATE workflow_submissions SET context_json = ? WHERE id = ?",
  ).run(JSON.stringify({
    ...sourceContext,
    canonicalCriteria: [],
    criterionMappings: [],
    compaction: {
      ...sourceContext.compaction,
      status: "fallback",
      error: "provider unavailable",
    },
  }), submitted.value.submission.id);

  await stageGap(1);
  const reused = await h.manager.retryEvidenceReadiness(
    runId,
    submitted.value.submission.id,
    "fallback-parent-context",
    2,
  );
  assert.equal(reused.ok, true);
  if (!reused.ok) return;
  assert.equal(compactionCalls, 1, "a damaged parent row must not buy a second compaction");
  const reusedContext = WorkflowContextSnapshotSchema.parse(reused.value.submission.context);
  assert.equal(reusedContext.compaction.status, "model");
  assert.equal(reusedContext.compaction.reusedFromSubmissionId, submitted.value.submission.id);
  assert.deepEqual(
    reusedContext.canonicalCriteria?.map((criterion) => criterion.id),
    frozen.canonicalCriteria.map((criterion) => criterion.id),
    "the reusing submission carries the run's frozen criteria verbatim",
  );
  assert.deepEqual(
    h.store.getRun(runId)?.criteria,
    frozen,
    "reuse must not rewrite what it reused",
  );
});

test("a mid-run change to the live decisions never moves the run's frozen criteria", async (t) => {
  let decisions: WorkflowHumanDecision[] = [];
  const h = await harness(t, "intent-change-preflight", undefined, {
    humanDecisions: () => decisions,
    recordCompactionLedger: true,
  });
  const stageGap = async (ordinal: number) => {
    const clientItemId = `intent-execution-${ordinal}`;
    await h.manager.stageAgentEvidence("intent-change-preflight", {
      images: [],
      commandOutputs: [{
        kind: "command",
        clientItemId,
        command: `verify intent ${ordinal}`,
        exitCode: 0,
        output: `intent ${ordinal} passed\n`,
        caption: `Intent ${ordinal} execution`,
        repositoryScope: "all",
      }],
      coverage: [{
        clientCriterionId: `intent-claim-${ordinal}`,
        criterion: "Rendered workflow state is inspectable",
        proofClass: "visual",
        repositoryScope: "all",
        links: [{ clientItemId, role: "execution" }],
      }],
    });
  };
  const compactionCount = (runId: string) => h.store.listLlmCallPage(runId).items
    .filter((call) => call.purpose === "context_compaction").length;
  const reconciliationCount = (runId: string) => h.store.listLlmCallPage(runId).items
    .filter((call) => call.purpose === "context_reconciliation").length;

  await stageGap(0);
  const submitted = await h.manager.submit(h.binding.id, { requestId: "intent-root" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
    "initial intent packet did not wait",
  );
  assert.equal(compactionCount(runId), 1);
  assert.equal(reconciliationCount(runId), 0);

  await stageGap(1);
  const reused = await h.manager.retryEvidenceReadiness(runId, submitted.value.submission.id, "intent-reuse", 2);
  assert.equal(reused.ok, true);
  if (!reused.ok) return;
  assert.equal(compactionCount(runId), 1);
  assert.equal(reconciliationCount(runId), 0);
  const reusedContext = WorkflowContextSnapshotSchema.parse(reused.value.submission.context);
  assert.equal(reusedContext.compaction.reusedFromSubmissionId, submitted.value.submission.id);

  // A mid-run decision is exactly the shape of the failure this run-level freeze exists to
  // remove: on the observed run, seven of eight "human decisions" by round eight were Mission
  // Control's own repair packets, read back through the prompt hook. Whatever writes the live
  // channel now, the run reviews against the ask it froze at creation.
  decisions = [{
    decision: "Also preserve keyboard navigation",
    rationale: "Accessibility is part of the requested outcome",
    source: { kind: "transcript", id: "human-intent-change" },
  }];
  await stageGap(2);
  const changed = await h.manager.retryEvidenceReadiness(runId, reused.value.submission.id, "intent-change", 3);
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.equal(compactionCount(runId), 1, "a later decision must not buy a second compaction");
  assert.equal(reconciliationCount(runId), 0);
  const changedContext = WorkflowContextSnapshotSchema.parse(changed.value.submission.context);
  assert.equal(changedContext.compaction.reusedFromSubmissionId, submitted.value.submission.id);
  assert.deepEqual(
    changedContext.canonicalCriteria,
    reusedContext.canonicalCriteria,
    "the criteria a submission is judged by never move inside a run",
  );

  // The round has now spent its consecutive preflight refinements, so a third one is refused
  // rather than reviewed. That bound is asserted on its own below; what matters here is that
  // the two submissions the round did produce carry one intent identity between them.
  assert.deepEqual(
    new Set(h.store.listSubmissions(runId)
      .map((row) => WorkflowContextSnapshotSchema.parse(row.context).intentFingerprint)),
    new Set([changedContext.intentFingerprint]),
    "every submission of the run carries one intent identity",
  );
});

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

test("the round's third consecutive preflight refinement blocks the run for the operator", async (t) => {
  const h = await harness(t, "capped-evidence-preflight");
  const criterion = "Rendered workflow state is inspectable";
  const stagePacket = async (ordinal: number, ready: boolean) => {
    const executionId = `capped-execution-${ordinal}`;
    const renderedId = `capped-rendered-${ordinal}`;
    await h.manager.stageAgentEvidence("capped-evidence-preflight", {
      images: [],
      commandOutputs: [
        {
          kind: "command",
          clientItemId: executionId,
          command: `verify packet ${ordinal}`,
          exitCode: 0,
          output: `packet ${ordinal} passed\n`,
          caption: `Packet ${ordinal} execution`,
          repositoryScope: "all",
        },
        ...(ready ? [{
          kind: "command" as const,
          clientItemId: renderedId,
          command: `capture packet ${ordinal}`,
          exitCode: 0,
          output: `packet ${ordinal} rendered\n`,
          caption: `Packet ${ordinal} rendered output`,
          repositoryScope: "all" as const,
        }] : []),
      ],
      coverage: [{
        clientCriterionId: `capped-claim-${ordinal}`,
        criterion,
        proofClass: "visual",
        repositoryScope: "all",
        links: [
          { clientItemId: executionId, role: "execution" },
          ...(ready ? [{ clientItemId: renderedId, role: "rendered_output" as const }] : []),
        ],
      }],
    });
  };

  await stagePacket(0, false);
  const submitted = await h.manager.submit(h.binding.id, { requestId: "capped-root" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  await waitFor(
    () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
    "the first gapped packet did not wait for evidence readiness",
  );

  // Refinements one and two are the repair the cap leaves room for, and neither blocks.
  let parentId = submitted.value.submission.id;
  for (let ordinal = 1; ordinal <= EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT; ordinal++) {
    await stagePacket(ordinal, false);
    const retry = await h.manager.retryEvidenceReadiness(runId, parentId, `capped-${ordinal}`, ordinal);
    assert.equal(retry.ok, true, `refinement ${ordinal} was refused`);
    if (!retry.ok) return;
    parentId = retry.value.submission.id;
    await waitFor(
      () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
      `refinement ${ordinal} did not wait for evidence readiness`,
    );
    assert.equal(h.store.getRun(runId)?.currentPhase, "evidence_readiness");
  }
  assert.equal(h.store.listSubmissions(runId).length, EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1);

  await stagePacket(EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1, false);
  const exhausted = await h.manager.retryEvidenceReadiness(
    runId,
    parentId,
    "capped-over-limit",
    EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1,
  );
  assert.equal(exhausted.ok, false);
  if (exhausted.ok) return;
  assert.equal(exhausted.reason, "conflict");
  assert.match(exhausted.message, /continue despite gaps or start a new round/);
  assert.equal(
    h.store.listSubmissions(runId).length,
    EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1,
    "the refused refinement must not create a submission",
  );
  const blocked = h.store.getRun(runId);
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.currentPhase, "preflight_refinement_exhausted");
  const event = h.store.listEvents(runId)
    .find((entry) => entry.kind === "preflight_refinement_exhausted");
  assert.ok(event, "the block must be readable on the run's own timeline");
  assert.deepEqual(event.payload, {
    submissionId: parentId,
    round: 1,
    segment: EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT,
    refinements: EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT,
    limit: EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT,
    manualRetry: true,
  });
  // The automatic sweep is the loop this bound exists to stop: it must not reopen the round.
  await h.manager.sweepResumptions(Date.now() + 60_000);
  assert.equal(h.store.listSubmissions(runId).length, EVIDENCE_PREFLIGHT_REFINEMENT_LIMIT + 1);
  assert.equal(h.store.getRun(runId)?.status, "blocked");

  // The block asks the operator a question, so the answer stays reachable from it.
  const override = h.manager.overrideEvidenceReadiness(
    runId,
    parentId,
    "capped-override",
    "The mapping is right; the preflight and the packet disagree about the proof class.",
    true,
  );
  assert.equal(override.ok, true);
  await waitFor(
    () => h.store.getRun(runId)?.status === "completed",
    "the overridden submission did not activate out of the refinement block",
  );
  assert.equal(h.store.getSubmission(parentId)?.readiness?.status, "overridden");
});

test("a Persona failing a submission the preflight passed records an operator-visible disagreement", async (t) => {
  const failingRunner: LlmRunner = {
    ...passingRunner,
    async run() {
      return JSON.stringify({
        verdict: "fail",
        summary: "No acceptance criterion coverage was declared for this submission",
        requestedChanges: [{ basis: "substantive",
          title: "Declare criterion coverage",
          rationale: "The packet does not link evidence to the acceptance criteria",
          evidence: [{ kind: "goal", quote: "Render the final workflow state" }],
        }],
        confidence: 1,
      });
    },
  };
  const readyPacket = async (h: Awaited<ReturnType<typeof harness>>, id: string) => {
    await h.manager.stageAgentEvidence(id, {
      images: [],
      commandOutputs: [
        {
          kind: "command",
          clientItemId: "disagreement-execution",
          command: "verify disagreement",
          exitCode: 0,
          output: "passed\n",
          caption: "Focused execution passed",
          repositoryScope: "all",
        },
        {
          kind: "command",
          clientItemId: "disagreement-rendered",
          command: "capture disagreement",
          exitCode: 0,
          output: "rendered\n",
          caption: "Rendered state",
          repositoryScope: "all",
        },
      ],
      coverage: [{
        clientCriterionId: "disagreement-claim",
        criterion: "Rendered workflow state is inspectable",
        proofClass: "visual",
        repositoryScope: "all",
        links: [
          { clientItemId: "disagreement-execution", role: "execution" },
          { clientItemId: "disagreement-rendered", role: "rendered_output" },
        ],
      }],
    });
  };

  const enforced = await harness(t, "disagreement-preflight", undefined, { runner: failingRunner });
  await readyPacket(enforced, "disagreement-preflight");
  const submitted = await enforced.manager.submit(enforced.binding.id, { requestId: "disagree" });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const runId = submitted.value.run.id;
  assert.equal(enforced.store.getSubmission(submitted.value.submission.id)?.readiness?.status, "ready");
  await waitFor(
    () => enforced.store.listEvents(runId).some((event) => event.kind === "persona_verdict"),
    "the Persona verdict was never recorded",
  );
  const disagreements = enforced.store.listEvents(runId)
    .filter((event) => event.kind === "readiness_review_disagreement");
  assert.equal(disagreements.length, 1, "a ready-then-failed round must say so exactly once");
  assert.deepEqual(disagreements[0]?.payload, {
    submissionId: submitted.value.submission.id,
    nodeId: "persona",
    persona: "Preflight disagreement-preflight",
    round: 1,
    segment: 0,
    policy: "criterion_mapped_v1",
    evaluatorVersion: "criterion_mapped_v1",
    readiness: "ready",
    summary: "No acceptance criterion coverage was declared for this submission",
  });

  // Advisory readiness gated nothing, but it still ANSWERED `ready` on this submission and a
  // Persona still failed it, which is the same contradiction and just as reachable. The signal
  // fires and its payload names the policy, so a reader can weigh the two differently.
  const advisory = await harness(t, "advisory-preflight", undefined, {
    runner: failingRunner,
    evidenceReadinessPolicy: "off",
  });
  await readyPacket(advisory, "advisory-preflight");
  const advisorySubmitted = await advisory.manager.submit(advisory.binding.id, {
    requestId: "advisory-disagree",
  });
  assert.equal(advisorySubmitted.ok, true);
  if (!advisorySubmitted.ok) return;
  const advisoryRunId = advisorySubmitted.value.run.id;
  assert.equal(
    advisory.store.getSubmission(advisorySubmitted.value.submission.id)?.readiness?.status,
    "ready",
  );
  await waitFor(
    () => advisory.store.listEvents(advisoryRunId).some((event) => event.kind === "persona_verdict"),
    "the advisory Persona verdict was never recorded",
  );
  const advisoryDisagreements = advisory.store.listEvents(advisoryRunId)
    .filter((event) => event.kind === "readiness_review_disagreement");
  assert.equal(advisoryDisagreements.length, 1);
  assert.equal(
    (advisoryDisagreements[0]?.payload as { policy: string }).policy,
    "off",
    "the advisory disagreement records the policy that did not enforce it",
  );
});

async function stageRecoveryProof(h: Awaited<ReturnType<typeof harness>>, id: string, criterion: string): Promise<void> {
  const result = await h.manager.stageAgentEvidence(id, {
    images: [], commandOutputs: [{ kind: "command", clientItemId: "repair-proof", command: "verify workflow behavior", exitCode: 0, output: "ok - focused behavior", caption: "Focused regression proof", repositoryScope: "all" }],
    coverage: [{ clientCriterionId: "repair-claim", criterion, proofClass: "focused_execution", repositoryScope: "all", links: [{ clientItemId: "repair-proof", role: "execution" }] }],
  });
  assert.equal(result.artifacts.length, 1);
}

for (const invalid of ["uncaptured", "malformed", "inspector_only"] as const) {
  test(`evidence recovery refuses ${invalid} parent context without reserving a child`, async (t) => {
    const h = await harness(t, `invalid-recovery-${invalid}`);
    const created = await h.manager.submit(h.binding.id, { requestId: "source" });
    assert.equal(created.ok, true); if (!created.ok) return;
    const { run, submission } = created.value;
    h.store.setRunState(run.id, "blocked", "evidence_reconciliation_error", { submissionId: submission.id, error: "Unavailable context" });
    if (invalid === "inspector_only") {
      openDb().prepare("UPDATE workflow_submissions SET mode = 'inspector_only' WHERE id = ?").run(submission.id);
    } else {
      h.store.updateSubmissionCapture(submission.id, {
        context: invalid === "uncaptured" ? {} : { evidence: "corrupt" },
        evidence: h.store.getSubmission(submission.id)!.evidence,
      });
    }
    const before = h.store.getSubmission(submission.id);
    assert.equal(h.store.reserveEvidenceRecovery({ id: `refused-${invalid}`, runId: run.id,
      parentId: submission.id, requestId: "retry", reason: "mapping", now: Date.now() }), null);
    const response = await h.manager.recoverEvidence(run.id, submission.id, "retry");
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.reason, "conflict");
    assert.equal(h.store.listSubmissions(run.id).length, 1);
    assert.deepEqual(h.store.getSubmission(submission.id), before);
  });
}

test("failed mapping is infrastructure and explicit recovery freezes a same-round child without live recapture", async (t) => {
  let calls = 0; let recovered = false; let captures = 0;
  const h = await harness(t, "mapping-recovery", async () => { captures++; }, {
    compactContext: async (raw) => compactWorkflowContext(raw, {
      deferReconciliation: true, execute: async () => ({ kind: "ok", value: { constraints: [], acceptanceCriteria: ["Rendered workflow state is inspectable"], canonicalCriteria: [{ text: "Rendered workflow state is inspectable", material: true, suggestedProofClass: null }] } }),
    }),
    reconcileContext: async () => {
      calls++;
      return recovered ? { kind: "ok", value: { criterionMappings: [{ canonicalCriterionOrdinal: 1, matchedClientCriterionIds: ["repair-claim"] }] } }
        : { kind: "failed", cause: "transport", reason: "mapping timeout" };
    },
  });
  await stageRecoveryProof(h, "mapping-recovery", "The user can inspect the rendered result");
  const created = await h.manager.submit(h.binding.id, { requestId: "mapping-source" });
  assert.equal(created.ok, true); if (!created.ok) return;
  const { run, submission } = created.value;
  assert.equal(h.store.getRun(run.id)?.currentPhase, "evidence_reconciliation_error");
  assert.equal(calls, 2);
  assert.equal(h.store.listAttempts(submission.id).length, 0);
  assert.equal(h.store.listDeliveries(run.id).length, 0);
  const prior = h.store.getSubmission(submission.id)!;
  const beforeCaptures = captures;
  recovered = true;
  const [retry, replay] = await Promise.all([
    h.manager.recoverEvidence(run.id, submission.id, "mapping-retry"),
    h.manager.recoverEvidence(run.id, submission.id, "mapping-retry"),
  ]);
  assert.equal(retry.ok, true); assert.equal(replay.ok, true); if (!retry.ok || !replay.ok) return;
  assert.equal(retry.value.submission.id, replay.value.submission.id);
  await waitFor(() => h.store.getRun(run.id)?.status === "completed", "recovery failed to finish");
  assert.equal(calls, 3); assert.equal(captures, beforeCaptures);
  const rows = h.store.listSubmissions(run.id);
  assert.deepEqual(rows.map((row) => [row.round, row.segment]), [[1, 0], [1, 1]]);
  assert.deepEqual(h.store.getSubmission(submission.id), prior);
  assert.equal(rows[1]?.readiness?.status, "ready");
  assert.equal(h.store.consecutiveEvidencePreflightRefinements(rows[1]!.id), 0);
  assert.equal(h.store.listSubmissionTextArtifacts(rows[1]!.id).length, 1);
});

for (const scenario of ["registration", "mixed", "parse"] as const) test(`Persona ${scenario} correction has one durable budget and emits no false repair`, async (t) => {
  let calls = 0;
  const h = await harness(t, `contract-${scenario}`, undefined, { runner: { ...passingRunner, async run(prompt) {
    calls++;
    assert.match(prompt, /Daemon structural result/);
    assert.match(prompt, /"status":"ready"/);
    if (scenario === "parse" && calls === 1) return "invalid JSON";
    const changes = [{ basis: "coverage_registration", title: "Declare coverage", rationale: "Missing declaration", evidence: [{ kind: "goal", quote: "Render the final workflow state" }] }];
    if (scenario === "mixed") changes.push({ ...changes[0]!, basis: "substantive", title: "Fix implementation" });
    if (scenario === "registration" && calls === 2) return passingRunner.run(prompt);
    return JSON.stringify({ verdict: "fail", summary: "Repair coverage", requestedChanges: changes, confidence: 1 });
  } } });
  await stageRecoveryProof(h, `contract-${scenario}`, "Rendered workflow state is inspectable");
  const created = await h.manager.submit(h.binding.id, { requestId: "contract-source" });
  assert.equal(created.ok, true); if (!created.ok) return;
  await waitFor(() => ["blocked", "completed"].includes(h.store.getRun(created.value.run.id)?.status ?? ""), "review never settled");
  assert.equal(calls, 2);
  const attempts = h.store.listAttempts(created.value.submission.id).filter((item) => item.persona);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.reviewInput?.status, "ready");
  assert.ok(attempts[0]?.reviewRejections?.length);
  assert.equal(h.store.listReceipts(created.value.submission.id).some((receipt) => receipt.edgeId === "repair"), false);
  assert.equal(h.store.getRun(created.value.run.id)?.status, scenario === "registration" ? "completed" : "blocked");
  assert.equal(h.store.listSubmissions(created.value.run.id).length, 1);
});

test("sequential A and B preflight repairs retain A's winner through real frozen inheritance", async (t) => {
  const h = await harness(t, "sequential-coverage", undefined, { compactContext: async (raw) => compactWorkflowContext(raw, {
    deferReconciliation: true, execute: async () => ({ kind: "ok", value: {
      constraints: [], acceptanceCriteria: ["Verify A", "Verify B"], canonicalCriteria: ["A", "B"].map((id) => ({ text: `Verify ${id}`, material: true, suggestedProofClass: null })),
    } }),
  }) });
  const stage = (rows: Array<{ id: string; criterion: string; ready: boolean }>) => h.manager.stageAgentEvidence("sequential-coverage", {
    images: [], commandOutputs: [{ kind: "command", clientItemId: "proof", command: "test A and B", exitCode: 0, output: "both behaviors passed", caption: "Shared focused execution", repositoryScope: "all" }],
    coverage: rows.map((row) => ({ clientCriterionId: row.id, criterion: `Verify ${row.criterion}`, proofClass: row.ready ? "focused_execution" : "visual", repositoryScope: "all", links: [{ clientItemId: "proof", role: "execution" }] })),
  });
  await stage([{ id: "a0", criterion: "A", ready: false }, { id: "b0", criterion: "B", ready: false }]);
  const source = await h.manager.submit(h.binding.id, { requestId: "sequential-source" });
  assert.equal(source.ok, true); if (!source.ok) return;
  await stage([{ id: "a1", criterion: "A", ready: true }]);
  const a = await h.manager.retryEvidenceReadiness(source.value.run.id, source.value.submission.id, "repair-a");
  assert.equal(a.ok, true); if (!a.ok) return;
  await stage([{ id: "b1", criterion: "B", ready: true }]);
  const b = await h.manager.retryEvidenceReadiness(source.value.run.id, a.value.submission.id, "repair-b");
  assert.equal(b.ok, true); if (!b.ok) return;
  await waitFor(() => h.store.getRun(source.value.run.id)?.status === "completed", "B repair regressed A");
  const current = h.store.getSubmission(b.value.submission.id)!;
  assert.deepEqual(current.readiness?.criteria.map((row) => row.matchedClientCriterionId), ["a1", "b1"]);
  assert.equal(current.readiness?.status, "ready");
  assert.equal(h.store.listSubmissionCoverage(current.id).length, 4);
  const { submissionCoverageSelection } = await import("../src/server/workflows/coverage-selection.ts");
  // Legacy rows have no winner metadata. Replay the immutable declaration provenance.
  for (const row of h.store.listSubmissions(source.value.run.id)) {
    const ctx = WorkflowContextSnapshotSchema.parse(row.context); delete ctx.coverageSelection;
    openDb().prepare("UPDATE workflow_submissions SET context_json = ? WHERE id = ?").run(JSON.stringify(ctx), row.id);
  }
  assert.deepEqual(submissionCoverageSelection(h.store, h.store.getSubmission(current.id)!)?.criteria.map((row) => row.matchedClientCriterionIds), [["a1"], ["b1"]]);
});
