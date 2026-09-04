import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-readiness-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const {
  SubmitWorkflowEvidenceSchema,
  WorkflowEvidenceCoverageClaimsSchema,
  WorkflowEvidenceReadinessResultSchema,
} = await import("../src/shared/protocol.ts");
const {
  WORKFLOW_EVIDENCE_COVERAGE_LIMITS,
  WORKFLOW_EVIDENCE_PROOF_CLASSES,
  evaluateWorkflowEvidenceReadiness,
  workflowEvidenceMissingRoleGaps,
  workflowEvidenceRequiredRoleGroups,
  workflowCommandEvidenceContent,
} = await import("../src/shared/workflow.ts");
const { compactWorkflowContext } = await import("../src/server/workflows/context.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");

const command = {
  kind: "command" as const,
  clientItemId: "focused-command",
  command: "node --test focused.test.ts",
  exitCode: -9,
  output: "ok 1 - focused behavior\n",
  caption: "Focused behavior passed",
  repositoryScope: "repo-01" as const,
};

const focusedClaim = {
  clientCriterionId: "criterion-focused",
  criterion: "The focused behavior remains correct",
  proofClass: "focused_execution" as const,
  repositoryScope: "repo-01" as const,
  links: [{ clientItemId: command.clientItemId, role: "execution" as const }],
};

test("coverage schemas preserve legacy calls and bound criterion mappings", () => {
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({ commandOutputs: [command] }).success, true);
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({ coverage: [focusedClaim] }).success, true);
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({
    commandOutputs: [command],
    coverage: [focusedClaim],
  }).success, true);
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse([
    focusedClaim,
    { ...focusedClaim, criterion: "duplicate id" },
  ]).success, false);
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse([{
    ...focusedClaim,
    criterion: "x".repeat(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes + 1),
  }]).success, false);
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse([{
    ...focusedClaim,
    criterion: "🙂".repeat(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes / 2),
  }]).success, false, "criterion limits count UTF-8 bytes, not JavaScript code units");
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse([{
    ...focusedClaim,
    links: [focusedClaim.links[0], focusedClaim.links[0]],
  }]).success, false);
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse([{
    ...focusedClaim,
    links: Array.from(
      { length: WORKFLOW_EVIDENCE_COVERAGE_LIMITS.linksPerClaim + 1 },
      (_, index) => ({ clientItemId: `item-${index}`, role: "execution" as const }),
    ),
  }]).success, false);
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse([{
    ...focusedClaim,
    links: [{ clientItemId: command.clientItemId, role: "screenshot" }],
  }]).success, false);
  assert.equal(WorkflowEvidenceCoverageClaimsSchema.safeParse(Array.from(
    { length: WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims },
    (_, index) => ({
      ...focusedClaim,
      clientCriterionId: `criterion-${index}`,
      criterion: `${index}:${"x".repeat(3_000)}`,
      links: [],
    }),
  )).success, false, "aggregate coverage JSON must remain bounded");
});

test("the proof matrix and readiness evaluator preserve author authority", () => {
  assert.deepEqual(
    Object.fromEntries(WORKFLOW_EVIDENCE_PROOF_CLASSES.map((proofClass) => [
      proofClass,
      workflowEvidenceRequiredRoleGroups(proofClass),
    ])),
    {
      focused_execution: [["execution"]],
      integration: [["execution"]],
      visual: [["execution"], ["rendered_output"]],
      performance: [["baseline_measurement"], ["result_measurement"]],
      rendered_artifact: [["deliverable", "rendered_output"]],
      state_confirmation: [["state_snapshot"]],
    },
  );
  assert.deepEqual(
    Object.fromEntries(WORKFLOW_EVIDENCE_PROOF_CLASSES.map((proofClass) => [
      proofClass,
      workflowEvidenceMissingRoleGaps(proofClass, []),
    ])),
    {
      focused_execution: ["missing_execution"],
      integration: ["missing_execution"],
      visual: ["missing_execution", "missing_rendered_output"],
      performance: ["missing_baseline_measurement", "missing_result_measurement"],
      rendered_artifact: ["missing_deliverable_or_rendered_output"],
      state_confirmation: ["missing_state_snapshot"],
    },
  );
  const readiness = evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: [{
      id: "canonical-1",
      text: focusedClaim.criterion,
      material: true,
      suggestedProofClass: "visual",
      matchedClientCriterionIds: [focusedClaim.clientCriterionId],
    }],
    coverage: [focusedClaim],
    evidence: [{
      clientItemId: command.clientItemId,
      evidenceId: "artifact-1",
      repositoryScope: "repo-01",
    }],
  });
  assert.equal(readiness.status, "ready");
  assert.deepEqual(readiness.criteria[0]?.gaps, []);
  assert.deepEqual(readiness.criteria[0]?.warnings, ["model_proof_class_disagreement"]);
  assert.equal(
    readiness.criteria[0]?.links.some((link) => link.role === "rendered_output"),
    false,
    "a model suggestion must not force screenshot evidence",
  );
  assert.equal(evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: [],
    coverage: [focusedClaim],
    evidence: [],
    unavailableReason: "provider unavailable",
  }).status, "unavailable");
  assert.equal(evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: [],
    coverage: [focusedClaim],
    evidence: [],
  }).status, "unavailable", "an empty model reconciliation must not read as ready");
  const crossScope = evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: [{
      id: "canonical-all",
      text: focusedClaim.criterion,
      material: true,
      suggestedProofClass: null,
      matchedClientCriterionIds: [focusedClaim.clientCriterionId],
    }],
    coverage: [{ ...focusedClaim, repositoryScope: "all" }],
    evidence: [{
      clientItemId: command.clientItemId,
      evidenceId: "artifact-repo-only",
      repositoryScope: "repo-01",
    }],
  });
  assert.deepEqual(crossScope.gapCodes, ["scope_conflict"]);

  const supportingCriterion = evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: [{
      id: "canonical-supporting",
      text: "Supporting visual context",
      material: false,
      suggestedProofClass: "visual",
      matchedClientCriterionIds: ["criterion-supporting"],
    }],
    coverage: [{
      ...focusedClaim,
      clientCriterionId: "criterion-supporting",
      criterion: "Supporting visual context",
      proofClass: "visual",
    }],
    evidence: [{
      clientItemId: command.clientItemId,
      evidenceId: "artifact-supporting",
      repositoryScope: "repo-01",
    }],
  });
  assert.equal(supportingCriterion.status, "ready");
  assert.deepEqual(
    supportingCriterion.criteria[0]?.gaps,
    [],
    "supporting criteria must not create readiness gaps",
  );
});

test("maximum canonical criterion text remains a valid persisted readiness result", () => {
  const readiness = evaluateWorkflowEvidenceReadiness({
    canonicalCriteria: Array.from(
      { length: WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims },
      (_, index) => ({
        id: `canonical-${index}`,
        text: "x".repeat(WORKFLOW_EVIDENCE_COVERAGE_LIMITS.criterionBytes),
        material: true,
        suggestedProofClass: null,
        matchedClientCriterionIds: [],
      }),
    ),
    coverage: [],
    evidence: [],
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(readiness), "utf8")
      > WORKFLOW_EVIDENCE_COVERAGE_LIMITS.aggregateJsonBytes,
    "the regression fixture must exceed the smaller authoring-packet bound",
  );
  assert.equal(WorkflowEvidenceReadinessResultSchema.safeParse(readiness).success, true);
});

test("compaction exposes bounded metadata and assigns stable daemon criterion ids", async () => {
  const prompts: string[] = [];
  const raw = {
    primaryGoal: { rawPrompt: "Keep focused execution green", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    priorPersonaFeedback: [],
    session: { agent: "codex" as const, name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "diff --git a/src/a.ts b/src/a.ts\n+secret body",
      diffTruncated: false,
      workingTreeDirty: true,
      workingTreeStatus: [" M src/a.ts"],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: null,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
      images: [],
      stagedImageGeneration: 1,
    },
    coverage: [focusedClaim],
    evidenceMetadata: [{
      clientItemId: command.clientItemId,
      kind: "artifact" as const,
      caption: command.caption,
      repositoryScope: command.repositoryScope,
      exitCode: 0,
    }],
  };
  const execute = async (prompt: string) => {
    prompts.push(prompt);
    return {
      kind: "ok" as const,
      value: {
        constraints: [],
        acceptanceCriteria: [focusedClaim.criterion],
        canonicalCriteria: [{
          text: focusedClaim.criterion,
          material: true,
          suggestedProofClass: "focused_execution" as const,
          matchedClientCriterionIds: [focusedClaim.clientCriterionId],
        }],
      },
    };
  };
  const first = await compactWorkflowContext(raw, { execute, runner: "codex", model: "test" });
  const second = await compactWorkflowContext(raw, { execute, runner: "codex", model: "test" });
  assert.equal(first.canonicalCriteria?.[0]?.id, second.canonicalCriteria?.[0]?.id);
  assert.match(prompts[0] ?? "", /focused-command/);
  assert.doesNotMatch(prompts[0] ?? "", /node --test focused\.test\.ts/);
  assert.doesNotMatch(prompts[0] ?? "", /ok 1 - focused behavior/);
});

test("coverage stages idempotently and freezes with the submission", async () => {
  const db = openDb();
  const store = new WorkflowStore(db);
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('readiness-workflow', 'Readiness', 'readiness', '', '{"nodes":[],"edges":[]}',
       '{"kind":"none"}', ?, 1, 'readiness-version', NULL, 1, 1)`,
  ).run(defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('readiness-version', 'readiness-workflow', 1, 1,
       '{"nodes":[{"id":"session","kind":"session","position":{"x":0,"y":0}},{"id":"end","kind":"end","outcome":"Complete","position":{"x":200,"y":0}}],"edges":[]}',
       '{"kind":"none"}', ?, 1)`,
  ).run(defaults);
  const binding = store.insertBinding({
    id: "readiness-binding",
    workflowVersionId: "readiness-version",
    noteKey: "readiness-note",
    sessionId: "readiness-session",
    sessionAgent: "codex",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: 1,
  });
  const inlineContent = workflowCommandEvidenceContent(command);
  const item = {
    id: "staged-command",
    clientItemId: command.clientItemId,
    sourceKind: "command" as const,
    evidenceKind: "text" as const,
    sourceRoot: "/repo",
    sourceLocator: command.command,
    inlineContent,
    commandExitCode: command.exitCode,
    displayName: command.command,
    caption: command.caption,
    repositoryScope: "repo-01" as const,
    mimeType: "text/plain" as const,
    bytes: Buffer.byteLength(inlineContent),
    sha256: (await import("node:crypto")).createHash("sha256").update(inlineContent).digest("hex"),
  };
  const claim = { ...focusedClaim, id: "staged-claim", sourceRoot: "/repo" };
  assert.throws(
    () => store.stageWorkflowEvidence("missing-command-status", [{
      ...item,
      commandExitCode: null,
    }], 2),
  );
  assert.equal(store.stageWorkflowEvidence("readiness-note", [item], 2, null, [claim]).generation, 1);
  assert.equal(store.stageWorkflowEvidence("readiness-note", [item], 3, null, [claim]).generation, 1);
  assert.throws(
    () => store.removeWorkflowEvidence("readiness-note", command.clientItemId, 3),
    /Remove the evidence link/,
  );
  assert.throws(
    () => store.stageWorkflowEvidence("readiness-note", [], 3, null, [{
      ...claim,
      id: "staged-cross-scope-claim",
      clientCriterionId: "criterion-cross-scope",
      repositoryScope: "all",
    }]),
    /outside its repository scope/,
  );
  const created = store.createInitialSubmission(
    { id: "readiness-run", binding, triggerSource: "manual", triggerKey: "manual:one", now: 4 },
    {
      id: "readiness-submission",
      triggerSource: "manual",
      triggerKey: "manual:one",
      context: {},
      evidence: {},
      now: 4,
    },
  );
  assert.deepEqual(store.listSubmissionCoverage(created.submission.id), [focusedClaim]);
  assert.equal(
    (store.listReservedWorkflowEvidence(created.submission.id)[0] as { commandExitCode?: number })
      ?.commandExitCode,
    command.exitCode,
  );
  assert.deepEqual(store.listWorkflowEvidence("readiness-note").coverage, []);
  assert.throws(
    () => store.stageWorkflowEvidence("readiness-note", [], 5, null, [{
      ...claim,
      criterion: "A changed claim cannot rewrite the frozen submission",
    }]),
    /already reserved/,
  );
  store.resetForNoteKey("readiness-note");
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM workflow_submission_evidence_coverage`)
      .get() as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM workflow_evidence_coverage_staging`)
      .get() as { count: number }).count,
    0,
  );
});
