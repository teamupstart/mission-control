import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";
import type { WorkflowContextSnapshot, WorkflowEvidenceImage } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-carry-forward-"));
process.env.MISSION_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
const {
  captureSubmissionImages,
  captureSubmissionTextArtifacts,
  inheritSubmissionEvidence,
  WorkflowImageEvidenceError,
  WORKFLOW_EVIDENCE_DIR,
} = await import("../src/server/workflows/images.ts");
const { workflowRepositoryFingerprint } = await import("../src/server/workflows/context.ts");
const { evaluateWorkflowEvidenceReadiness } = await import("../src/shared/workflow.ts");
const { buildPersonaPrompt } = await import("../src/server/workflows/prompt.ts");
const { WorkflowContextSnapshotSchema } = await import("../src/shared/protocol.ts");

openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const VERSION_ID = BUILTIN_WORKFLOWS[0]!.definition.currentVersionId!;

function sha(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Every retained body currently on disk, so a second copy of one is countable. */
function retainedBodies(): Array<{ path: string; bytes: number }> {
  const root = join(WORKFLOW_EVIDENCE_DIR, "retained");
  const found: Array<{ path: string; bytes: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push({ path, bytes: statSync(path).size });
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

let ordinal = 0;
function fixture(checkout: string) {
  ordinal += 1;
  const store = new WorkflowStore();
  const noteKey = `carry-note-${ordinal}`;
  const binding = store.insertBinding({
    id: `carry-binding-${ordinal}`,
    workflowVersionId: VERSION_ID,
    noteKey,
    sessionId: `carry-session-${ordinal}`,
    sessionAgent: "codex",
    sessionName: "carry",
    sessionCwd: checkout,
    sessionRepoRoot: checkout,
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  return { store, noteKey, binding, runId: `carry-run-${ordinal}` };
}

function imageWrite(input: {
  id: string;
  clientItemId: string;
  root: string;
  locator: string;
  caption: string;
  bytes: Buffer;
}) {
  return {
    id: input.id,
    clientItemId: input.clientItemId,
    sourceKind: "agent" as const,
    sourceRoot: input.root,
    sourceLocator: input.locator,
    displayName: input.locator,
    caption: input.caption,
    repositoryScope: "all",
    mimeType: "image/png" as const,
    bytes: input.bytes.byteLength,
    sha256: sha(input.bytes),
  };
}

function logWrite(input: {
  id: string;
  clientItemId: string;
  root: string;
  locator: string;
  caption: string;
  body: string;
}) {
  return {
    id: input.id,
    clientItemId: input.clientItemId,
    sourceKind: "agent" as const,
    evidenceKind: "text" as const,
    sourceRoot: input.root,
    sourceLocator: input.locator,
    displayName: input.locator,
    caption: input.caption,
    repositoryScope: "all",
    mimeType: "text/plain" as const,
    bytes: Buffer.byteLength(input.body, "utf8"),
    sha256: sha(Buffer.from(input.body, "utf8")),
  };
}

test("a preflight refinement carries its parent's evidence, including a source the agent has since deleted", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-preflight-")));
  try {
    writeFileSync(join(checkout, "screen.png"), PNG);
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(
      noteKey,
      [imageWrite({
        id: "staged-screen",
        clientItemId: "screen",
        root: checkout,
        locator: "screen.png",
        caption: "The rendered panel the round proved",
        bytes: PNG,
      })],
      2,
      null,
      [{
        id: "staged-claim",
        clientCriterionId: "claim-round-1",
        criterion: "The panel renders",
        proofClass: "visual",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [{ clientItemId: "screen", role: "rendered_output" }],
      }],
    );
    const parent = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "carry-root", now: 3 },
      {
        id: "carry-parent",
        triggerSource: "manual",
        triggerKey: "carry-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    assert.equal((await captureSubmissionImages(store, parent.submission.id, 3)).length, 1);
    store.updateSubmissionCapture(parent.submission.id, {
      context: {},
      evidence: {},
      fingerprint: "parent-identity",
      repositoryFingerprint: "tree-at-round-1",
      status: "running",
    }, 3);
    assert.deepEqual(
      store.listSubmissionCoverage(parent.submission.id).map((claim) => claim.clientCriterionId),
      ["claim-round-1"],
    );

    // The exact loss this phase exists to end: the gitignored capture is gone by the time the
    // mapping repair runs, so nothing that re-reads the source could recover it.
    rmSync(join(checkout, "screen.png"));

    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    store.stageWorkflowEvidence(
      noteKey,
      [],
      5,
      null,
      [{
        id: "staged-claim-repair",
        clientCriterionId: "claim-repair",
        criterion: "The panel renders under its canonical name",
        proofClass: "visual",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [],
      }],
    );
    const reserved = store.reserveEvidenceReadinessRefinement({
      id: "carry-child",
      runId,
      waitingSubmissionId: parent.submission.id,
      triggerKey: "carry-refinement",
      manualRetry: true,
      now: 5,
    });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;

    await captureSubmissionImages(store, reserved.submission.id, 6);
    await captureSubmissionTextArtifacts(store, reserved.submission.id, 6);
    assert.deepEqual(
      store.listSubmissionImages(reserved.submission.id),
      [],
      "a mapping repair stages no new evidence, so on its own it starts with none",
    );

    assert.equal(await inheritSubmissionEvidence(store, reserved.submission, 6), 1);
    const carried = store.listSubmissionImages(reserved.submission.id);
    assert.equal(carried.length, 1);
    assert.equal(carried[0]?.sha256, sha(PNG));
    assert.equal(
      carried[0]?.inheritedFrom?.submissionId,
      parent.submission.id,
      "the carried row names where it came from",
    );
    assert.equal(carried[0]?.inheritedFrom?.round, 1);
    assert.equal(carried[0]?.inheritedFrom?.repositoryFingerprint, "tree-at-round-1");
    assert.deepEqual(
      store.submissionFrozenEvidenceIdentities(reserved.submission.id).map((item) => item.clientItemId),
      ["screen"],
      "the carried item resolves through the reservations the preflight and manifests read",
    );
    assert.deepEqual(
      store.listSubmissionCoverage(reserved.submission.id)
        .map((claim) => claim.clientCriterionId).sort(),
      ["claim-repair", "claim-round-1"],
      "the repair's own claim stands beside the carried one it did not replace",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("registering only the pieces a preflight named accumulates instead of replacing", async () => {
  // The evidence-gathering loop this phase exists to end: an author registers 3 of the 10 the
  // review needs, the preflight names the 7 that are missing, the author registers exactly
  // those 7 - and the submission used to hold 7, because reservation emptied the tray and the
  // first 3 were attached to the previous submission. The preflight then named the first 3 as
  // missing, and the two halves chased each other forever.
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-partial-resubmit-")));
  try {
    const { store, noteKey, binding, runId } = fixture(checkout);
    const stage = (label: string, count: number, at: number) => {
      const writes = [];
      const coverage = [];
      for (let index = 0; index < count; index++) {
        const body = `${label} evidence ${index}\n`;
        writeFileSync(join(checkout, `${label}${index}.log`), body);
        writes.push(logWrite({
          id: `resubmit-${label}${index}`,
          clientItemId: `resubmit-${label}${index}`,
          root: checkout,
          locator: `${label}${index}.log`,
          caption: `${label} evidence ${index}`,
          body,
        }));
        coverage.push({
          id: `resubmit-claim-${label}${index}`,
          clientCriterionId: `criterion-${label}${index}`,
          criterion: `Criterion ${label} ${index}`,
          proofClass: "focused_execution" as const,
          repositoryScope: "all" as const,
          sourceRoot: checkout,
          links: [{ clientItemId: `resubmit-${label}${index}`, role: "execution" as const }],
        });
      }
      store.stageWorkflowEvidence(noteKey, writes, at, null, coverage);
    };

    stage("first", 3, 2);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "resubmit-root", now: 3 },
      { id: "resubmit-1", triggerSource: "manual", triggerKey: "resubmit-root", context: {}, evidence: {}, now: 3 },
    );
    await captureSubmissionTextArtifacts(store, first.submission.id, 3);
    store.updateSubmissionCapture(first.submission.id, {
      context: {}, evidence: {}, fingerprint: "p1", repositoryFingerprint: "tree", status: "running",
    }, 3);
    assert.equal(store.listSubmissionTextArtifacts(first.submission.id).length, 3);

    // The preflight names the gaps and the author registers ONLY those.
    store.setSubmissionState(first.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    stage("second", 4, 5);
    const child = store.reserveEvidenceReadinessRefinement({
      id: "resubmit-2",
      runId,
      waitingSubmissionId: first.submission.id,
      triggerKey: "resubmit-refinement",
      manualRetry: true,
      now: 5,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    await captureSubmissionTextArtifacts(store, child.submission.id, 6);
    await inheritSubmissionEvidence(store, child.submission, 6);

    assert.equal(
      store.listSubmissionTextArtifacts(child.submission.id).length,
      7,
      "the segment holds the first three AND the four just registered, not only the four",
    );
    assert.equal(
      store.listSubmissionCoverage(child.submission.id).length,
      7,
      "and every coverage claim, which is what a preflight gap actually asks for",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a refinement child re-declaring a criterion keeps every link its parent proved for it", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-relink-")));
  try {
    writeFileSync(join(checkout, "panel.png"), Buffer.concat([PNG, Buffer.from("relink", "utf8")]));
    const shot = Buffer.concat([PNG, Buffer.from("relink", "utf8")]);
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(
      noteKey,
      [imageWrite({
        id: "relink-shot",
        clientItemId: "panel",
        root: checkout,
        locator: "panel.png",
        caption: "The panel the parent round proved",
        bytes: shot,
      })],
      2,
      null,
      [{
        id: "relink-claim-parent",
        clientCriterionId: "claim-parent",
        criterion: "The panel renders",
        proofClass: "visual",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [{ clientItemId: "panel", role: "rendered_output" }],
      }],
    );
    const parent = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "relink-root", now: 3 },
      {
        id: "relink-parent",
        triggerSource: "manual",
        triggerKey: "relink-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    await captureSubmissionImages(store, parent.submission.id, 3);
    store.updateSubmissionCapture(parent.submission.id, {
      context: {},
      evidence: {},
      fingerprint: "relink-identity",
      repositoryFingerprint: "tree-at-round-1",
      status: "running",
    }, 3);

    // The repair the preflight actually asks for: the SAME criterion, re-declared under a new
    // claim id, citing the execution the parent's claim was missing.
    writeFileSync(join(checkout, "run.log"), "the focused run that passed\n");
    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    store.stageWorkflowEvidence(
      noteKey,
      [logWrite({
        id: "relink-log",
        clientItemId: "run-log",
        root: checkout,
        locator: "run.log",
        caption: "The focused run behind the panel",
        body: "the focused run that passed\n",
      })],
      5,
      null,
      [{
        id: "relink-claim-child",
        clientCriterionId: "claim-child",
        criterion: "The panel renders",
        proofClass: "visual",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [{ clientItemId: "run-log", role: "execution" }],
      }],
    );
    const child = store.reserveEvidenceReadinessRefinement({
      id: "relink-child",
      runId,
      waitingSubmissionId: parent.submission.id,
      triggerKey: "relink-refinement",
      manualRetry: true,
      now: 5,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    await captureSubmissionImages(store, child.submission.id, 6);
    await captureSubmissionTextArtifacts(store, child.submission.id, 6);
    await inheritSubmissionEvidence(store, child.submission, 6);

    const claims = store.listSubmissionCoverage(child.submission.id);
    assert.deepEqual(
      claims.map((claim) => claim.clientCriterionId).sort(),
      ["claim-child", "claim-parent"],
      "the parent's claim is retained whole beside the child's, not collapsed into it",
    );
    const parentClaim = claims.find((claim) => claim.clientCriterionId === "claim-parent")!;
    const childClaim = claims.find((claim) => claim.clientCriterionId === "claim-child")!;
    assert.equal(
      parentClaim.inheritedFromSubmissionId,
      parent.submission.id,
      "and it says where it came from",
    );
    assert.equal(childClaim.inheritedFromSubmissionId ?? null, null);
    assert.deepEqual(
      parentClaim.links.map((link) => `${link.clientItemId}:${link.role}`),
      ["panel:rendered_output"],
      "each claim keeps its own proof class, scope and link set",
    );
    assert.deepEqual(
      childClaim.links.map((link) => `${link.clientItemId}:${link.role}`),
      ["run-log:execution"],
    );
    assert.equal(
      store.listSubmissionImages(child.submission.id)[0]?.inheritedFrom?.round,
      1,
      "the evidence the carried claim cites came with it",
    );

    // Retaining the ancestry must not read as the author asserting two things at once.
    const readiness = evaluateWorkflowEvidenceReadiness({
      canonicalCriteria: [{
        id: "c1",
        text: "The panel renders",
        material: true,
        suggestedProofClass: null,
      }],
      criterionMappings: [{
        criterionId: "c1",
        matchedClientCriterionIds: ["claim-child", "claim-parent"],
      }],
      coverage: claims,
      evidence: store.submissionFrozenEvidenceIdentities(child.submission.id),
      unavailableReason: null,
      enforceCoverage: true,
    });
    assert.equal(
      readiness.criteria[0]?.matchedClientCriterionId,
      "claim-child",
      "the claim the author declared here answers for the criterion",
    );
    assert.equal(readiness.gapCodes.includes("ambiguous_mapping"), false);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("when the cap binds, a carry gives up old ancestry before the parent's own captures", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-priority-")));
  try {
    const { WORKFLOW_TEXT_EVIDENCE_LIMITS } = await import("../src/shared/workflow.ts");
    const max = WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount;
    const { store, noteKey, binding, runId } = fixture(checkout);
    const stage = (label: string, count: number, at: number) => {
      const writes = [];
      for (let index = 0; index < count; index++) {
        const body = `${label} item ${index}\n`;
        writeFileSync(join(checkout, `${label}-${index}.log`), body);
        writes.push(logWrite({
          id: `${label}-${index}`,
          clientItemId: `${label}-${index}`,
          root: checkout,
          locator: `${label}-${index}.log`,
          caption: `${label} item ${index}`,
          body,
        }));
      }
      store.stageWorkflowEvidence(noteKey, writes, at);
    };

    // Round 1 proves four things, so round 2 can carry them as ancestry.
    stage("ancestry", 4, 2);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "prio-root", now: 3 },
      { id: "prio-first", triggerSource: "manual", triggerKey: "prio-root", context: {}, evidence: {}, now: 3 },
    );
    await captureSubmissionTextArtifacts(store, first.submission.id, 3);
    store.updateSubmissionCapture(first.submission.id, {
      context: {}, evidence: {}, fingerprint: "prio-1", repositoryFingerprint: "tree-1", status: "running",
    }, 3);

    // Round 2 captures four of its own and carries round 1's four: eight, exactly the cap.
    stage("captured", 4, 4);
    const second = store.createRepairSubmission({
      id: "prio-second", runId, round: 2, triggerSource: "manual",
      triggerKey: "prio-repair-1", context: {}, evidence: {}, now: 5,
    });
    await captureSubmissionTextArtifacts(store, second.submission.id, 5);
    await inheritSubmissionEvidence(store, second.submission, 5);
    store.updateSubmissionCapture(second.submission.id, {
      context: {}, evidence: {}, fingerprint: "prio-2", repositoryFingerprint: "tree-2", status: "running",
    }, 5);
    assert.equal(store.listSubmissionTextArtifacts(second.submission.id).length, max);

    // Round 3 stages two of its own, so the carry from round 2 must give up two items.
    stage("latest", 2, 6);
    const third = store.createRepairSubmission({
      id: "prio-third", runId, round: 3, triggerSource: "manual",
      triggerKey: "prio-repair-2", context: {}, evidence: {}, now: 7,
    });
    await captureSubmissionTextArtifacts(store, third.submission.id, 7);
    await inheritSubmissionEvidence(store, third.submission, 7);

    // Provenance follows the ORIGINAL capture in all three fields together. A record naming the
    // hand-off submission beside the origin round would contradict itself.
    for (const carried of store.listSubmissionTextArtifacts(third.submission.id)) {
      if (!carried.inheritedFrom) continue;
      if (carried.displayName.startsWith("ancestry-")) {
        assert.equal(
          carried.inheritedFrom.submissionId,
          first.submission.id,
          "two hops on, a carried item still names the submission that captured it",
        );
      }
    }
    const held = store.listSubmissionTextArtifacts(third.submission.id);
    assert.equal(held.length, max, "the cap still holds");
    const names = held.map((item) => item.displayName);
    for (let index = 0; index < 4; index++) {
      assert.equal(
        names.includes(`captured-${index}.log`),
        true,
        "every item the previous submission captured itself survives the carry",
      );
    }
    assert.equal(
      names.filter((name) => name.startsWith("ancestry-")).length,
      2,
      "and exactly the two oldest ancestry items are what the cap refused",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a parent at the coverage limit meeting a child with claims of its own stays readable", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-claimcap-")));
  try {
    const { WORKFLOW_EVIDENCE_COVERAGE_LIMITS } = await import("../src/shared/workflow.ts");
    const max = WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims;
    const { store, noteKey, binding, runId } = fixture(checkout);
    const claims = [];
    for (let index = 0; index < max; index++) {
      claims.push({
        id: `cap-claim-${index}`,
        clientCriterionId: `cap-criterion-${index}`,
        criterion: `Capped criterion ${index}`,
        proofClass: "focused_execution" as const,
        repositoryScope: "all" as const,
        sourceRoot: checkout,
        links: [],
      });
    }
    store.stageWorkflowEvidence(noteKey, [], 2, null, claims);
    const parent = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "cap-root", now: 3 },
      { id: "cap-parent", triggerSource: "manual", triggerKey: "cap-root", context: {}, evidence: {}, now: 3 },
    );
    store.updateSubmissionCapture(parent.submission.id, {
      context: {}, evidence: {}, fingerprint: "cap-1", repositoryFingerprint: "tree", status: "running",
    }, 3);
    assert.equal(store.listSubmissionCoverage(parent.submission.id).length, max, "the parent is at the cap");

    // The child declares one of its own, so the carry cannot fit every parent claim.
    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    const body = "the repair evidence\n";
    writeFileSync(join(checkout, "cap.log"), body);
    store.stageWorkflowEvidence(noteKey, [logWrite({
      id: "cap-evidence",
      clientItemId: "cap-evidence",
      root: checkout,
      locator: "cap.log",
      caption: "The repair evidence",
      body,
    })], 5, null, [{
      id: "cap-claim-own",
      clientCriterionId: "cap-criterion-own",
      criterion: "A criterion this segment declared itself",
      proofClass: "focused_execution" as const,
      repositoryScope: "all" as const,
      sourceRoot: checkout,
      links: [{ clientItemId: "cap-evidence", role: "execution" as const }],
    }]);
    const child = store.reserveEvidenceReadinessRefinement({
      id: "cap-child",
      runId,
      waitingSubmissionId: parent.submission.id,
      triggerKey: "cap-refinement",
      manualRetry: true,
      now: 5,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    await captureSubmissionTextArtifacts(store, child.submission.id, 6);
    await inheritSubmissionEvidence(store, child.submission, 6);

    // The bound is what a submission can hold, not a preference. Exceeding it would make this
    // read throw rather than return more coverage.
    const held = store.listSubmissionCoverage(child.submission.id);
    assert.equal(held.length, max, "the submission holds exactly what its schema admits");
    assert.equal(
      held.filter((claim) => !claim.inheritedFromSubmissionId).map((claim) => claim.clientCriterionId).length,
      1,
      "the claim this segment declared is kept",
    );
    assert.equal(held.filter((claim) => claim.inheritedFromSubmissionId).length, max - 1);
    // And what did not fit is recorded rather than passed over in silence.
    const truncation = store.listEvents(runId)
      .filter((event) => event.kind === "evidence_carry_truncated");
    assert.equal(truncation.length, 1);
    assert.equal((truncation[0]!.payload as { claims: number }).claims, 1);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("re-registering a criterion under the same id does not spend the carry budget", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-redeclare-")));
  try {
    const shared = 40;
    const { store, noteKey, binding, runId } = fixture(checkout);
    const stageClaims = (
      entries: ReadonlyArray<{ id: string; text: string }>,
      at: number,
    ) => {
      store.stageWorkflowEvidence(noteKey, [], at, null, entries.map((entry) => ({
        id: `redeclare-${entry.id}`,
        clientCriterionId: entry.id,
        criterion: entry.text,
        proofClass: "focused_execution" as const,
        repositoryScope: "all" as const,
        sourceRoot: checkout,
        links: [],
      })));
    };
    // "dup-" sorts ahead of "solo-", so if re-registered ids were charged to the budget they
    // would be charged FIRST and the distinct ancestry behind them would be what got refused.
    const parentClaims = [];
    for (let index = 0; index < shared; index++) {
      parentClaims.push({ id: `dup-${index}`, text: `Shared criterion ${index}` });
    }
    for (let index = 0; index < shared; index++) {
      parentClaims.push({ id: `solo-${index}`, text: `Parent-only criterion ${index}` });
    }
    stageClaims(parentClaims, 2);
    const parent = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "redeclare-root", now: 3 },
      { id: "redeclare-parent", triggerSource: "manual", triggerKey: "redeclare-root", context: {}, evidence: {}, now: 3 },
    );
    store.updateSubmissionCapture(parent.submission.id, {
      context: {}, evidence: {}, fingerprint: "rd-1", repositoryFingerprint: "tree", status: "running",
    }, 3);
    assert.equal(store.listSubmissionCoverage(parent.submission.id).length, shared * 2);

    // The child re-registers every shared id byte-identically, which re-staging returns to the
    // tray so this segment reserves them as its own, plus one genuinely new claim. The new one
    // is what moves the generation; an identical re-registration deliberately does not.
    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    stageClaims([
      ...Array.from({ length: shared }, (_unused, index) => ({
        id: `dup-${index}`,
        text: `Shared criterion ${index}`,
      })),
      { id: "fresh-0", text: "A criterion this segment raised for the first time" },
    ], 5);
    const child = store.reserveEvidenceReadinessRefinement({
      id: "redeclare-child",
      runId,
      waitingSubmissionId: parent.submission.id,
      triggerKey: "redeclare-refinement",
      manualRetry: true,
      now: 5,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    assert.equal(
      store.listSubmissionCoverage(child.submission.id).length,
      shared + 1,
      "the re-registered ids reached this segment alongside its new claim",
    );
    await inheritSubmissionEvidence(store, child.submission, 6);

    const held = store.listSubmissionCoverage(child.submission.id);
    assert.equal(
      held.filter((claim) => claim.clientCriterionId.startsWith("solo-")).length,
      shared,
      "distinct ancestry is not displaced by ids the segment merely re-registered",
    );
    assert.equal(held.length, shared * 2 + 1);
    assert.equal(
      held.find((claim) => claim.clientCriterionId === "dup-0")?.inheritedFromSubmissionId ?? null,
      null,
      "a re-registered id belongs to this segment, not to the carry",
    );
    assert.deepEqual(
      store.listEvents(runId).filter((event) => event.kind === "evidence_carry_truncated"),
      [],
      "nothing was refused, so nothing is reported as refused",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a three-level chain refuses the oldest ancestry, not the parent's own claims", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-chain-")));
  try {
    const { WORKFLOW_EVIDENCE_COVERAGE_LIMITS } = await import("../src/shared/workflow.ts");
    const max = WORKFLOW_EVIDENCE_COVERAGE_LIMITS.maxClaims;
    const ancestry = Math.floor(max * 0.6);
    const declared = max - ancestry;
    const { store, noteKey, binding, runId } = fixture(checkout);
    const stageClaims = (label: string, count: number, at: number) => {
      const claims = [];
      for (let index = 0; index < count; index++) {
        claims.push({
          id: `chain-${label}-${index}`,
          clientCriterionId: `chain-${label}-${index}`,
          criterion: `Chain ${label} criterion ${index}`,
          proofClass: "focused_execution" as const,
          repositoryScope: "all" as const,
          sourceRoot: checkout,
          links: [],
        });
      }
      store.stageWorkflowEvidence(noteKey, [], at, null, claims);
    };

    // Level 1: the grandparent declares the ancestry the chain will eventually have to give up.
    stageClaims("grand", ancestry, 2);
    const grand = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "chain-root", now: 3 },
      { id: "chain-grand", triggerSource: "manual", triggerKey: "chain-root", context: {}, evidence: {}, now: 3 },
    );
    store.updateSubmissionCapture(grand.submission.id, {
      context: {}, evidence: {}, fingerprint: "chain-1", repositoryFingerprint: "tree", status: "running",
    }, 3);

    // Level 2: the parent declares its own AND carries the grandparent's, reaching the cap.
    store.setSubmissionState(grand.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    stageClaims("parent", declared, 5);
    const parent = store.reserveEvidenceReadinessRefinement({
      id: "chain-parent", runId, waitingSubmissionId: grand.submission.id,
      triggerKey: "chain-refine-1", manualRetry: true, now: 5,
    });
    assert.equal(parent.ok, true);
    if (!parent.ok) return;
    await inheritSubmissionEvidence(store, parent.submission, 6);
    store.updateSubmissionCapture(parent.submission.id, {
      context: {}, evidence: {}, fingerprint: "chain-2", repositoryFingerprint: "tree", status: "running",
    }, 6);
    assert.equal(store.listSubmissionCoverage(parent.submission.id).length, max, "the parent is at the cap");

    // Level 3: the child declares a few of its own, so the carry must refuse that many.
    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 7);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 7);
    stageClaims("child", 5, 8);
    const child = store.reserveEvidenceReadinessRefinement({
      id: "chain-child", runId, waitingSubmissionId: parent.submission.id,
      triggerKey: "chain-refine-2", manualRetry: true, now: 8,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    await inheritSubmissionEvidence(store, child.submission, 9);

    const ids = new Set(store.listSubmissionCoverage(child.submission.id)
      .map((claim) => claim.clientCriterionId));
    assert.equal(ids.size, max, "the child holds exactly what its schema admits");
    for (let index = 0; index < declared; index++) {
      assert.equal(
        ids.has(`chain-parent-${index}`),
        true,
        "every claim the immediately preceding submission declared itself survives the carry",
      );
    }
    assert.equal(
      [...ids].filter((id) => id.startsWith("chain-grand-")).length,
      ancestry - 5,
      "and exactly the five oldest ancestry claims are what the cap refused",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a byte-capped carry stops at the first refusal instead of packing smaller ancestry in", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-bytecap-")));
  try {
    const { WORKFLOW_TEXT_EVIDENCE_LIMITS } = await import("../src/shared/workflow.ts");
    const kib = (n: number) => "x".repeat(n * 1024) + "\n";
    const { store, noteKey, binding, runId } = fixture(checkout);
    const stage = (label: string, sizes: readonly number[], at: number) => {
      const writes = sizes.map((size, index) => {
        const body = `${label}${index}` + kib(size);
        writeFileSync(join(checkout, `${label}${index}.log`), body);
        return logWrite({
          id: `bytecap-${label}${index}`,
          clientItemId: `bytecap-${label}${index}`,
          root: checkout,
          locator: `${label}${index}.log`,
          caption: `${label} item ${index}`,
          body,
        });
      });
      store.stageWorkflowEvidence(noteKey, writes, at);
    };

    // Grandparent proves one small thing, so the parent has ancestry to carry.
    stage("small", [5], 2);
    const grand = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "bytecap-root", now: 3 },
      { id: "bytecap-grand", triggerSource: "manual", triggerKey: "bytecap-root", context: {}, evidence: {}, now: 3 },
    );
    await captureSubmissionTextArtifacts(store, grand.submission.id, 3);
    store.updateSubmissionCapture(grand.submission.id, {
      context: {}, evidence: {}, fingerprint: "bc-1", repositoryFingerprint: "tree", status: "running",
    }, 3);

    // The parent captures one LARGE item of its own and carries the small ancestry behind it.
    store.setSubmissionState(grand.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    stage("large", [60], 5);
    const parent = store.reserveEvidenceReadinessRefinement({
      id: "bytecap-parent", runId, waitingSubmissionId: grand.submission.id,
      triggerKey: "bytecap-refine-1", manualRetry: true, now: 5,
    });
    assert.equal(parent.ok, true);
    if (!parent.ok) return;
    await captureSubmissionTextArtifacts(store, parent.submission.id, 6);
    await inheritSubmissionEvidence(store, parent.submission, 6);
    store.updateSubmissionCapture(parent.submission.id, {
      context: {}, evidence: {}, fingerprint: "bc-2", repositoryFingerprint: "tree", status: "running",
    }, 6);
    assert.deepEqual(
      store.listSubmissionTextArtifacts(parent.submission.id).map((item) => item.displayName),
      ["large0.log", "small0.log"],
      "the parent holds its own large capture first, then the small ancestry",
    );

    // The child fills most of the byte budget itself, leaving room for the small ancestry but
    // not the large capture ahead of it. Greedy packing would take the older item and drop the
    // newer one; the rule is that the first refusal ends the carry.
    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 7);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 7);
    stage("own", [60, 60, 60], 8);
    const child = store.reserveEvidenceReadinessRefinement({
      id: "bytecap-child", runId, waitingSubmissionId: parent.submission.id,
      triggerKey: "bytecap-refine-2", manualRetry: true, now: 8,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    await captureSubmissionTextArtifacts(store, child.submission.id, 9);
    const ownBytes = store.listSubmissionTextArtifacts(child.submission.id)
      .reduce((sum, item) => sum + item.bytes, 0);
    const remaining = WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes - ownBytes;
    assert.equal(remaining > 6 * 1024 && remaining < 60 * 1024, true, "the small item fits and the large one does not");
    await inheritSubmissionEvidence(store, child.submission, 9);

    assert.deepEqual(
      store.listSubmissionTextArtifacts(child.submission.id)
        .filter((item) => item.inheritedFrom).map((item) => item.displayName),
      [],
      "the refusal of the parent's own capture ends the carry rather than admitting older ancestry",
    );
    const truncation = store.listEvents(runId)
      .filter((event) => event.kind === "evidence_carry_truncated").at(-1);
    assert.equal((truncation?.payload as { artifacts: number }).artifacts, 2);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("two source records with identical bytes both carry, so neither claim loses its link", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-twins-")));
  try {
    // The exact shape captureSubmissionImages supports and the observed run produced: one
    // screenshot registered twice under two client ids. Both are frozen as distinct records
    // sharing one body, and a claim may cite either one specifically.
    const twin = Buffer.concat([PNG, Buffer.from("twins", "utf8")]);
    writeFileSync(join(checkout, "first.png"), twin);
    writeFileSync(join(checkout, "second.png"), twin);
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(
      noteKey,
      [
        imageWrite({
          id: "twin-a", clientItemId: "shot-a", root: checkout, locator: "first.png",
          caption: "The panel, registered once", bytes: twin,
        }),
        imageWrite({
          id: "twin-b", clientItemId: "shot-b", root: checkout, locator: "second.png",
          caption: "The panel, registered again under another id", bytes: twin,
        }),
      ],
      2,
      null,
      [{
        id: "twin-claim",
        clientCriterionId: "claim-cites-second",
        criterion: "The panel renders",
        proofClass: "visual",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [{ clientItemId: "shot-b", role: "rendered_output" }],
      }],
    );
    const parent = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "twins-root", now: 3 },
      { id: "twins-parent", triggerSource: "manual", triggerKey: "twins-root", context: {}, evidence: {}, now: 3 },
    );
    assert.equal((await captureSubmissionImages(store, parent.submission.id, 3)).length, 2);
    store.updateSubmissionCapture(parent.submission.id, {
      context: {}, evidence: {}, fingerprint: "tw-1", repositoryFingerprint: "tree", status: "running",
    }, 3);

    store.setSubmissionState(parent.submission.id, "waiting_for_evidence_readiness", 4);
    store.setRunState(runId, "waiting_for_evidence_readiness", "evidence_readiness", {}, 4);
    const body = "the repair run\n";
    writeFileSync(join(checkout, "repair.log"), body);
    store.stageWorkflowEvidence(noteKey, [logWrite({
      id: "twin-repair", clientItemId: "repair", root: checkout, locator: "repair.log",
      caption: "The repair", body,
    })], 5);
    const child = store.reserveEvidenceReadinessRefinement({
      id: "twins-child", runId, waitingSubmissionId: parent.submission.id,
      triggerKey: "twins-refinement", manualRetry: true, now: 5,
    });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    await captureSubmissionImages(store, child.submission.id, 6);
    await captureSubmissionTextArtifacts(store, child.submission.id, 6);
    await inheritSubmissionEvidence(store, child.submission, 6);

    assert.deepEqual(
      store.submissionFrozenEvidenceIdentities(child.submission.id)
        .map((item) => item.clientItemId).sort(),
      ["repair", "shot-a", "shot-b"],
      "both identical-byte records carry, so the id the claim cites still resolves",
    );
    const claim = store.listSubmissionCoverage(child.submission.id)
      .find((candidate) => candidate.clientCriterionId === "claim-cites-second");
    assert.deepEqual(
      claim?.links.map((link) => link.clientItemId),
      ["shot-b"],
      "and the parent's claim keeps the link it was frozen with",
    );
    // One digest is still one body: deduplication is about bytes on disk, not rows.
    const paths = new Set(store.submissionImageStorageRecords(child.submission.id)
      .map((record) => record.storageRelativePath));
    assert.equal(paths.size, 1, "the two records share the single retained body");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a parent claim survives a link whose evidence the limit refused", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-partial-")));
  try {
    const { WORKFLOW_TEXT_EVIDENCE_LIMITS } = await import("../src/shared/workflow.ts");
    const max = WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount;
    const { store, noteKey, binding, runId } = fixture(checkout);
    const writes = [];
    for (let index = 0; index < max; index++) {
      const body = `partial round one item ${index}\n`;
      writeFileSync(join(checkout, `p${index}.log`), body);
      writes.push(logWrite({
        id: `partial-${index}`,
        clientItemId: `partial-${index}`,
        root: checkout,
        locator: `p${index}.log`,
        caption: `Partial item ${index}`,
        body,
      }));
    }
    // One claim citing the newest item and the oldest, so the carry can keep only half of it.
    store.stageWorkflowEvidence(noteKey, writes, 2, null, [{
      id: "partial-claim",
      clientCriterionId: "claim-spanning",
      criterion: "The behavior is proven end to end",
      proofClass: "focused_execution",
      repositoryScope: "all",
      sourceRoot: checkout,
      links: [
        { clientItemId: "partial-0", role: "execution" },
        { clientItemId: `partial-${max - 1}`, role: "execution" },
      ],
    }]);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "partial-root", now: 3 },
      {
        id: "partial-first",
        triggerSource: "manual",
        triggerKey: "partial-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    await captureSubmissionTextArtifacts(store, first.submission.id, 3);
    store.updateSubmissionCapture(first.submission.id, {
      context: {},
      evidence: {},
      fingerprint: "partial-identity",
      repositoryFingerprint: "tree-at-round-1",
      status: "running",
    }, 3);

    const body = "partial round two item\n";
    writeFileSync(join(checkout, "p-new.log"), body);
    store.stageWorkflowEvidence(noteKey, [logWrite({
      id: "partial-new",
      clientItemId: "partial-new",
      root: checkout,
      locator: "p-new.log",
      caption: "Round two item",
      body,
    })], 4);
    const second = store.createRepairSubmission({
      id: "partial-second",
      runId,
      round: 2,
      triggerSource: "manual",
      triggerKey: "partial-repair",
      context: {},
      evidence: {},
      now: 5,
    });
    await captureSubmissionTextArtifacts(store, second.submission.id, 5);
    await inheritSubmissionEvidence(store, second.submission, 5);

    const carriedIds = new Set(store.listSubmissionTextArtifacts(second.submission.id)
      .map((item) => item.displayName));
    assert.equal(
      carriedIds.has(`p${max - 1}.log`),
      false,
      "the last of the parent's set is what the cap refused",
    );
    assert.equal(carriedIds.has("p0.log"), true);
    const claim = store.listSubmissionCoverage(second.submission.id)
      .find((candidate) => candidate.clientCriterionId === "claim-spanning");
    assert.notEqual(claim, undefined, "the parent's claim is retained rather than omitted with it");
    assert.deepEqual(
      claim!.links.map((link) => link.clientItemId),
      ["partial-0"],
      "keeping the links whose evidence came, and no link pointing at nothing",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a new repair round retains the parent's claim beside the one the author wrote today", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-round-relink-")));
  try {
    writeFileSync(join(checkout, "old.log"), "round one evidence\n");
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(
      noteKey,
      [logWrite({
        id: "round-old",
        clientItemId: "old-log",
        root: checkout,
        locator: "old.log",
        caption: "Round one evidence",
        body: "round one evidence\n",
      })],
      2,
      null,
      [{
        id: "round-claim-1",
        clientCriterionId: "claim-round-1",
        criterion: "The behavior is proven",
        proofClass: "focused_execution",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [{ clientItemId: "old-log", role: "execution" }],
      }],
    );
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "round-root", now: 3 },
      {
        id: "round-first",
        triggerSource: "manual",
        triggerKey: "round-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    await captureSubmissionTextArtifacts(store, first.submission.id, 3);
    store.updateSubmissionCapture(first.submission.id, {
      context: {},
      evidence: {},
      fingerprint: "round-identity",
      repositoryFingerprint: "tree-at-round-1",
      status: "running",
    }, 3);

    writeFileSync(join(checkout, "new.log"), "round two evidence\n");
    store.stageWorkflowEvidence(
      noteKey,
      [logWrite({
        id: "round-new",
        clientItemId: "new-log",
        root: checkout,
        locator: "new.log",
        caption: "Round two evidence",
        body: "round two evidence\n",
      })],
      4,
      null,
      [{
        id: "round-claim-2",
        clientCriterionId: "claim-round-2",
        criterion: "The behavior is proven",
        proofClass: "focused_execution",
        repositoryScope: "all",
        sourceRoot: checkout,
        links: [{ clientItemId: "new-log", role: "execution" }],
      }],
    );
    const second = store.createRepairSubmission({
      id: "round-second",
      runId,
      round: 2,
      triggerSource: "manual",
      triggerKey: "round-repair",
      context: {},
      evidence: {},
      now: 5,
    });
    await captureSubmissionTextArtifacts(store, second.submission.id, 5);
    await inheritSubmissionEvidence(store, second.submission, 5);

    const claims = store.listSubmissionCoverage(second.submission.id);
    assert.deepEqual(
      claims.map((claim) => claim.clientCriterionId).sort(),
      ["claim-round-1", "claim-round-2"],
    );
    const authored = claims.find((claim) => claim.clientCriterionId === "claim-round-2")!;
    const carriedClaim = claims.find((claim) => claim.clientCriterionId === "claim-round-1")!;
    assert.deepEqual(
      authored.links.map((link) => link.clientItemId),
      ["new-log"],
      "this round's claim cites only what this round chose to cite",
    );
    assert.deepEqual(
      carriedClaim.links.map((link) => link.clientItemId),
      ["old-log"],
      "and the carried claim still cites exactly what the parent froze",
    );
    assert.equal(carriedClaim.inheritedFromSubmissionId, first.submission.id);
    assert.deepEqual(
      store.listSubmissionTextArtifacts(second.submission.id).map((item) => item.displayName).sort(),
      ["new.log", "old.log"],
      "though the older evidence itself is still carried and marked, for the Persona to weigh",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("byte-identical evidence is frozen once and shared, and the shared body outlives its first run", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-dedupe-")));
  try {
    // Bytes unique to this test, so the body count it measures is its own: digest sharing is
    // global by design, and reusing the shared fixture PNG would measure an earlier test.
    const bytes = Buffer.concat([PNG, Buffer.from("dedupe-fixture", "utf8")]);
    writeFileSync(join(checkout, "first.png"), bytes);
    writeFileSync(join(checkout, "second.png"), bytes);
    const { store, noteKey, binding, runId } = fixture(checkout);
    const before = retainedBodies().length;
    store.stageWorkflowEvidence(noteKey, [
      imageWrite({
        id: "dedupe-a",
        clientItemId: "first",
        root: checkout,
        locator: "first.png",
        caption: "One name for these bytes",
        bytes,
      }),
      imageWrite({
        id: "dedupe-b",
        clientItemId: "second",
        root: checkout,
        locator: "second.png",
        caption: "Another name for the same bytes",
        bytes,
      }),
    ], 2);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "dedupe-root", now: 3 },
      {
        id: "dedupe-submission",
        triggerSource: "manual",
        triggerKey: "dedupe-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    const images = await captureSubmissionImages(store, first.submission.id, 3);
    assert.equal(images.length, 2, "both items are frozen as distinct evidence");
    assert.notEqual(images[0]!.id, images[1]!.id);
    assert.equal(
      retainedBodies().length - before,
      1,
      "one digest is one body, however many captions name it",
    );

    // A second run of the same conversation proving the same bytes again writes nothing.
    store.stageWorkflowEvidence(noteKey, [imageWrite({
      id: "dedupe-c",
      clientItemId: "third",
      root: checkout,
      locator: "first.png",
      caption: "A third round proving the same bytes",
      bytes,
    })], 5);
    const second = store.createInitialSubmission(
      {
        id: `${runId}-second`,
        binding,
        intent: FIXTURE_RUN_INTENT,
        triggerSource: "manual",
        triggerKey: "dedupe-second",
        now: 5,
      },
      {
        id: "dedupe-submission-second",
        triggerSource: "manual",
        triggerKey: "dedupe-second",
        context: {},
        evidence: {},
        now: 5,
      },
    );
    const reused = await captureSubmissionImages(store, second.submission.id, 5);
    assert.equal(reused.length, 1);
    assert.equal(
      retainedBodies().length - before,
      1,
      "a later run reuses the frozen body instead of copying it",
    );

    // Deleting the first run must leave the body the second run still reads.
    store.setSubmissionState(first.submission.id, "completed", 6);
    store.setRunState(runId, "completed", "complete", {}, 6);
    store.runRetention({
      rawEvidenceBefore: 0,
      completedRunsBefore: 7,
      maxCompletedRuns: 0,
      now: 8,
    });
    assert.equal(store.getRun(runId), null, "the first run is gone");
    assert.equal(
      store.workflowStatusCounts().pendingEvidenceImageCleanup,
      0,
      "a body another run still reads is never queued for deletion",
    );
    const body = store.submissionImageStorageRecords(second.submission.id)[0]!.storageRelativePath;
    assert.equal(existsSync(join(WORKFLOW_EVIDENCE_DIR, ...body.split("/"))), true);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("re-registering identical bytes attaches them to the next submission, while changed bytes still refuse", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-restage-")));
  try {
    writeFileSync(join(checkout, "shot.png"), PNG);
    const { store, noteKey, binding, runId } = fixture(checkout);
    const write = imageWrite({
      id: "restage-item",
      clientItemId: "shot",
      root: checkout,
      locator: "shot.png",
      caption: "Proof this round and the next",
      bytes: PNG,
    });
    store.stageWorkflowEvidence(noteKey, [write], 2);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "restage-root", now: 3 },
      {
        id: "restage-first",
        triggerSource: "manual",
        triggerKey: "restage-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    assert.equal(store.listReservedWorkflowEvidence(first.submission.id).length, 1);
    assert.deepEqual(
      store.listWorkflowEvidence(noteKey).images,
      [],
      "reservation empties the tray",
    );
    const generation = store.workflowEvidenceGeneration(noteKey, checkout);

    store.stageWorkflowEvidence(noteKey, [write], 4);
    assert.deepEqual(
      store.listWorkflowEvidence(noteKey).images.map((image) => image.clientItemId),
      ["shot"],
      "re-registering identical bytes returns them to the tray",
    );
    assert.equal(
      store.workflowEvidenceGeneration(noteKey, checkout),
      generation,
      "bytes that already existed are not new evidence about the work",
    );
    assert.equal(
      store.listReservedWorkflowEvidence(first.submission.id).length,
      1,
      "and the submission that already reserved them keeps them",
    );

    const next = store.createRepairSubmission({
      id: "restage-second",
      runId,
      round: 2,
      triggerSource: "manual",
      triggerKey: "restage-repair",
      context: {},
      evidence: {},
      now: 5,
    });
    assert.deepEqual(
      store.listReservedWorkflowEvidence(next.submission.id).map((item) => item.clientItemId),
      ["shot"],
      "the next submission reserves them without the author minting a new id",
    );

    // Genuinely different bytes under a reserved id are still refused: that is a claim about
    // this submission's frozen evidence, and it is immutable.
    assert.throws(
      () => store.stageWorkflowEvidence(noteKey, [{ ...write, caption: "A different claim entirely" }], 6),
      /already reserved/,
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a pruned row is not a reference that keeps a body alive", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-refcount-")));
  try {
    const bytes = Buffer.concat([PNG, Buffer.from("refcount", "utf8")]);
    writeFileSync(join(checkout, "ref.png"), bytes);
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(noteKey, [imageWrite({
      id: "ref-a",
      clientItemId: "ref",
      root: checkout,
      locator: "ref.png",
      caption: "The body a later capture may share",
      bytes,
    })], 2);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "ref-root", now: 3 },
      { id: "ref-sub", triggerSource: "manual", triggerKey: "ref-root", context: {}, evidence: {}, now: 3 },
    );
    await captureSubmissionImages(store, first.submission.id, 3);
    const path = store.submissionImageStorageRecords(first.submission.id)[0]!.storageRelativePath;
    assert.equal(store.imageStoragePathIsReferenced(path), true, "a retained row is a reference");

    // Pruning gives the body up. A row that named it no longer keeps it alive, which is what
    // the capture rollback path asks this question to decide.
    const captured = WorkflowContextSnapshotSchema.parse({
      primaryGoal: { rawPrompt: "Prove it", refined: null, sourceNoteKey: "note" },
      humanDecisions: [],
      constraints: [],
      acceptanceCriteria: [],
      priorPersonaFeedback: [],
      session: { agent: "codex", name: "work", cwd: checkout, branch: "feature" },
      evidence: {
        headSha: "abc",
        diffFingerprint: "diff",
        diff: "patch",
        diffTruncated: false,
        workingTreeDirty: false,
        workingTreeStatus: [],
        workingTreeStatusTruncated: false,
        transcript: [],
        transcriptAnchor: 1,
        transcriptTruncated: false,
        standards: [],
        standardsTruncated: false,
        images: store.listSubmissionImages(first.submission.id),
        stagedImageGeneration: 1,
      },
      compaction: { status: "fallback", runner: null, model: null, error: null },
    });
    store.updateSubmissionCapture(first.submission.id, {
      context: workflowJson(captured),
      evidence: workflowJson(captured.evidence),
      fingerprint: "ref-fingerprint",
      status: "running",
    }, 4);
    store.setSubmissionState(first.submission.id, "completed", 5);
    store.setRunState(runId, "completed", "complete", {}, 5);
    store.runRetention({ rawEvidenceBefore: 6, completedRunsBefore: 0, maxCompletedRuns: 100, now: 7 });
    assert.equal(store.listSubmissionImages(first.submission.id)[0]?.availability, "pruned");
    assert.equal(
      store.imageStoragePathIsReferenced(path),
      false,
      "a pruned row names a body already given up, so it cannot strand an orphan",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a half-written carry mark is refused rather than read as fresh evidence", async () => {
  const { parseWorkflowSubmissionImageRow, parseWorkflowSubmissionTextArtifactRow } =
    await import("../src/server/workflows/store.ts");
  const image = {
    id: "img_x", submission_id: "s1", staging_id: "g1", ordinal: 0,
    display_name: "shot.png", caption: "The panel renders", repository_scope: "all",
    mime_type: "image/png", bytes: PNG.byteLength, sha256: sha(PNG),
    storage_relative_path: "retained/s1/img_x.png", availability: "retained", pruned_at: null,
    inherited_from_submission_id: null, origin_round: null,
    origin_repository_fingerprint: null, created_at: 1,
  };
  assert.equal(parseWorkflowSubmissionImageRow(image).origin_round, null, "the ordinary row reads");
  assert.equal(
    parseWorkflowSubmissionImageRow({
      ...image, inherited_from_submission_id: "s0", origin_round: 1,
      origin_repository_fingerprint: null,
    }).origin_round,
    1,
    "a carry with no source fingerprint is legal: a failed capture has none to carry",
  );
  // Each of these would otherwise be read as evidence this submission captured itself, which is
  // the exact misrepresentation the mark exists to prevent.
  assert.throws(
    () => parseWorkflowSubmissionImageRow({ ...image, inherited_from_submission_id: "s0" }),
    /origin submission and its origin round/,
    "an origin submission with no origin round cannot be judged for staleness",
  );
  assert.throws(
    () => parseWorkflowSubmissionImageRow({ ...image, origin_round: 1 }),
    /origin submission and its origin round/,
    "an origin round with no origin submission describes a carry that did not happen",
  );
  assert.throws(
    () => parseWorkflowSubmissionImageRow({ ...image, origin_repository_fingerprint: "tree" }),
    /cannot carry an origin repository fingerprint/,
  );
  assert.throws(
    () => parseWorkflowSubmissionTextArtifactRow({
      id: "txt_x", submission_id: "s1", staging_id: "g1", ordinal: 0,
      display_name: "run.log", caption: "The focused run", repository_scope: "all",
      mime_type: "text/plain", bytes: 4, sha256: sha(Buffer.from("abcd")),
      content: "abcd", availability: "retained", pruned_at: null,
      inherited_from_submission_id: "s0", origin_round: null,
      origin_repository_fingerprint: null, created_at: 1,
    }),
    /origin submission and its origin round/,
    "text artifacts carry the same invariant",
  );
});

test("carried evidence does not defeat the unchanged-evidence refusal", () => {
  const evidenceContext = (images: WorkflowEvidenceImage[]): WorkflowContextSnapshot =>
    WorkflowContextSnapshotSchema.parse({
      primaryGoal: { rawPrompt: "Prove the panel", refined: null, sourceNoteKey: "note" },
      humanDecisions: [],
      constraints: [],
      acceptanceCriteria: [],
      priorPersonaFeedback: [],
      session: { agent: "codex", name: "work", cwd: "/repo", branch: "feature" },
      evidence: {
        headSha: "abc",
        diffFingerprint: "diff",
        diff: "patch",
        diffTruncated: false,
        workingTreeDirty: false,
        workingTreeStatus: [],
        workingTreeStatusTruncated: false,
        transcript: [],
        transcriptAnchor: 1,
        transcriptTruncated: false,
        standards: [],
        standardsTruncated: false,
        images,
        stagedImageGeneration: 4,
      },
      compaction: { status: "fallback", runner: null, model: null, error: null },
    });
  const image = (id: string, sha256: string): WorkflowEvidenceImage => ({
    id,
    ordinal: 0,
    displayName: "shot.png",
    caption: "The panel renders",
    repositoryScope: "all",
    mimeType: "image/png",
    bytes: PNG.byteLength,
    sha256,
    availability: "retained",
    prunedAt: null,
    createdAt: 1,
  });
  const digest = sha(PNG);
  // A carried row is a NEW row with a new id for the same bytes. Reading ids here would make
  // an untouched tree look changed and the refusal would stop firing.
  assert.equal(
    workflowRepositoryFingerprint(evidenceContext([image("img_round_one", digest)])),
    workflowRepositoryFingerprint(evidenceContext([image("img_round_two", digest)])),
  );
  assert.notEqual(
    workflowRepositoryFingerprint(evidenceContext([image("img_round_one", digest)])),
    workflowRepositoryFingerprint(evidenceContext([
      image("img_round_one", digest),
      { ...image("img_new", sha("different bytes")), ordinal: 1 },
    ])),
    "genuinely new evidence still reads as a change",
  );
});

test("the Persona manifest marks carried evidence with the round and tree it was captured against", () => {
  const persona = {
    id: "p",
    name: "Reviewer",
    guidanceMarkdown: "Review.",
    runner: "claude" as const,
    model: "fake",
    description: "",
    version: 1,
  };
  const base = {
    ordinal: 0,
    displayName: "shot.png",
    caption: "The panel renders",
    repositoryScope: "all" as const,
    mimeType: "image/png" as const,
    bytes: PNG.byteLength,
    sha256: sha(PNG),
    availability: "retained" as const,
    prunedAt: null,
    createdAt: 1,
  };
  const context = WorkflowContextSnapshotSchema.parse({
    primaryGoal: { rawPrompt: "Prove the panel", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "codex", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "patch",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: 1,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
      images: [
        { ...base, id: "img_fresh" },
        {
          ...base,
          id: "img_carried",
          ordinal: 1,
          inheritedFrom: {
            submissionId: "sub-round-1",
            round: 1,
            repositoryFingerprint: "tree-at-round-1",
          },
        },
      ],
      stagedImageGeneration: 1,
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  });
  const prompt = buildPersonaPrompt(persona as never, context);
  const manifest = prompt.slice(prompt.indexOf("workflow-image-manifest"));
  assert.match(manifest, /"id": "img_carried"/);
  assert.match(manifest, /"capturedInRound": 1/);
  assert.match(manifest, /"capturedAtRepositoryFingerprint": "tree-at-round-1"/);
  assert.equal(
    (manifest.match(/capturedInRound/g) ?? []).length,
    1,
    "evidence this submission captured itself carries no mark at all",
  );
  assert.match(
    prompt,
    /carried forward rather than re-collected/,
    "and the contract explains what the mark means",
  );
});

test("a later round drops carried evidence whose source now reads differently, and keeps one that is gone", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-stale-")));
  try {
    writeFileSync(join(checkout, "stable.log"), "stable: the run that passed\n");
    writeFileSync(join(checkout, "edited.log"), "edited: the run that passed\n");
    writeFileSync(join(checkout, "removed.log"), "removed: the run that passed\n");
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(noteKey, [
      logWrite({
        id: "stale-stable",
        clientItemId: "stable",
        root: checkout,
        locator: "stable.log",
        caption: "A log that still reads the same",
        body: "stable: the run that passed\n",
      }),
      logWrite({
        id: "stale-edited",
        clientItemId: "edited",
        root: checkout,
        locator: "edited.log",
        caption: "A log whose source has since changed",
        body: "edited: the run that passed\n",
      }),
      logWrite({
        id: "stale-removed",
        clientItemId: "removed",
        root: checkout,
        locator: "removed.log",
        caption: "A gitignored log the agent has since deleted",
        body: "removed: the run that passed\n",
      }),
    ], 2);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "stale-root", now: 3 },
      {
        id: "stale-first",
        triggerSource: "manual",
        triggerKey: "stale-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    assert.equal((await captureSubmissionTextArtifacts(store, first.submission.id, 3)).length, 3);
    store.updateSubmissionCapture(first.submission.id, {
      context: {},
      evidence: {},
      fingerprint: "stale-identity",
      repositoryFingerprint: "tree-at-round-1",
      status: "running",
    }, 3);

    writeFileSync(join(checkout, "edited.log"), "edited: the run that FAILED\n");
    rmSync(join(checkout, "removed.log"));

    const second = store.createRepairSubmission({
      id: "stale-second",
      runId,
      round: 2,
      triggerSource: "manual",
      triggerKey: "stale-repair",
      context: {},
      evidence: {},
      now: 4,
    });
    await captureSubmissionTextArtifacts(store, second.submission.id, 4);
    assert.equal(await inheritSubmissionEvidence(store, second.submission, 4), 2);
    assert.deepEqual(
      store.listSubmissionTextArtifacts(second.submission.id).map((item) => item.displayName).sort(),
      ["removed.log", "stable.log"],
      "a source that reads differently is dropped; one that no longer reads at all is kept",
    );
    for (const carried of store.listSubmissionTextArtifacts(second.submission.id)) {
      assert.equal(carried.inheritedFrom?.round, 1);
      assert.equal(carried.inheritedFrom?.repositoryFingerprint, "tree-at-round-1");
    }
    assert.deepEqual(
      store.listSubmissionTextArtifacts(second.submission.id).map((item) => item.content).sort(),
      ["removed: the run that passed\n", "stable: the run that passed\n"],
      "carried bytes are the original bytes, not a re-read",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a carry never exceeds the aggregate evidence limits it competes for", async () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-budget-")));
  try {
    const { WORKFLOW_TEXT_EVIDENCE_LIMITS } = await import("../src/shared/workflow.ts");
    const max = WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount;
    const { store, noteKey, binding, runId } = fixture(checkout);
    const stage = (round: number, count: number) => {
      const writes = [];
      for (let index = 0; index < count; index++) {
        const body = `round ${round} item ${index}\n`;
        writeFileSync(join(checkout, `r${round}-${index}.log`), body);
        writes.push(logWrite({
          id: `budget-${round}-${index}`,
          clientItemId: `budget-${round}-${index}`,
          root: checkout,
          locator: `r${round}-${index}.log`,
          caption: `Round ${round} item ${index}`,
          body,
        }));
      }
      store.stageWorkflowEvidence(noteKey, writes, 2 + round);
    };
    stage(1, max);
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "budget-root", now: 3 },
      {
        id: "budget-first",
        triggerSource: "manual",
        triggerKey: "budget-root",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    assert.equal((await captureSubmissionTextArtifacts(store, first.submission.id, 3)).length, max);

    stage(2, 2);
    const second = store.createRepairSubmission({
      id: "budget-second",
      runId,
      round: 2,
      triggerSource: "manual",
      triggerKey: "budget-repair",
      context: {},
      evidence: {},
      now: 5,
    });
    await captureSubmissionTextArtifacts(store, second.submission.id, 5);
    await inheritSubmissionEvidence(store, second.submission, 5);
    const held = store.listSubmissionTextArtifacts(second.submission.id);
    assert.equal(held.length, max, "the limit holds whatever the previous round proved");
    assert.deepEqual(
      held.filter((item) => !item.inheritedFrom).map((item) => item.displayName),
      ["r2-0.log", "r2-1.log"],
      "this round's own evidence is never displaced by a carry",
    );
    assert.equal(
      held.filter((item) => item.inheritedFrom).length,
      max - 2,
      "and the carry fills exactly the room that is left",
    );
    // What the cap refused is recorded, so evidence never simply goes quiet.
    const truncation = store.listEvents(runId)
      .filter((event) => event.kind === "evidence_carry_truncated");
    assert.equal(truncation.length, 1);
    assert.deepEqual(
      { ...(truncation[0]!.payload as Record<string, unknown>), submissionId: undefined, sourceSubmissionId: undefined },
      { images: 0, artifacts: 2, claims: 0, submissionId: undefined, sourceSubmissionId: undefined },
      "naming exactly how much of the parent's set the limit refused",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

/*
 * The four below hold the boundary between "the same evidence" and "the same episode".
 *
 * A live session's evidence is stamped with the intent episode that registered it, and that
 * episode advances on every accepted prompt - including the workflow's own repair prompt. The
 * re-staging contract above is only worth anything if it survives that, so each of these passes
 * a real episode key rather than the `null` the older cases default to.
 */

test("identical bytes re-registered in a later episode return to the tray under the new stamp", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-episode-")));
  try {
    writeFileSync(join(checkout, "round.png"), PNG);
    const { store, noteKey, binding, runId } = fixture(checkout);
    const write = imageWrite({
      id: "episode-item",
      clientItemId: "round-proof",
      root: checkout,
      locator: "round.png",
      caption: "Proof this round and the next",
      bytes: PNG,
    });
    store.stageWorkflowEvidence(noteKey, [write], 2, "intent:1:1");
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "episode-root", now: 3 },
      { id: "episode-first", triggerSource: "manual", triggerKey: "episode-root", context: {}, evidence: {}, now: 3 },
    );
    assert.equal(store.listReservedWorkflowEvidence(first.submission.id).length, 1);
    const generation = store.workflowEvidenceGeneration(noteKey, checkout);

    // The repair prompt that opens the next round is itself an accepted prompt, so the episode
    // has moved on by the time the agent presents the same proof again.
    store.stageWorkflowEvidence(noteKey, [write], 4, "intent:1:2");
    const staged = store.listWorkflowEvidence(noteKey).images;
    assert.deepEqual(
      staged.map((image) => image.clientItemId),
      ["round-proof"],
      "a new round does not make unchanged bytes unregisterable",
    );
    assert.equal(
      staged[0]?.episodeKey,
      "intent:1:2",
      "and the stamp moves, so the verifier for THIS episode admits it",
    );
    assert.equal(
      store.workflowEvidenceGeneration(noteKey, checkout),
      generation,
      "re-registering bytes that already exist is still not new evidence about the work",
    );
    assert.equal(
      store.listReservedWorkflowEvidence(first.submission.id).length,
      1,
      "and the submission that already reserved them keeps them",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("an unresolved intent returns evidence to the tray without erasing the stamp it has", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-unresolved-")));
  try {
    writeFileSync(join(checkout, "unresolved.png"), PNG);
    const { store, noteKey, binding, runId } = fixture(checkout);
    const write = imageWrite({
      id: "unresolved-item",
      clientItemId: "unresolved-proof",
      root: checkout,
      locator: "unresolved.png",
      caption: "Captured while the intent still resolved",
      bytes: PNG,
    });
    store.stageWorkflowEvidence(noteKey, [write], 2, "intent:1:1");
    store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "unresolved-root", now: 3 },
      { id: "unresolved-first", triggerSource: "manual", triggerKey: "unresolved-root", context: {}, evidence: {}, now: 3 },
    );

    // A prompt has arrived and the refiner has not reconciled it yet, so the session's intent
    // does not resolve. That is an unknown episode, not the absence of one.
    store.stageWorkflowEvidence(noteKey, [write], 4, null);
    const staged = store.listWorkflowEvidence(noteKey).images;
    assert.deepEqual(staged.map((image) => image.clientItemId), ["unresolved-proof"]);
    assert.equal(
      staged[0]?.episodeKey,
      "intent:1:1",
      "provenance an unknown episode cannot improve on is left alone",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("a coverage claim may link evidence an earlier submission already reserved", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-linkreserved-")));
  try {
    const body = "\u2714 the suite this criterion rests on\n";
    writeFileSync(join(checkout, "suite.log"), body);
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(noteKey, [logWrite({
      id: "link-item",
      clientItemId: "suite-run",
      root: checkout,
      locator: "suite.log",
      caption: "The suite this criterion rests on",
      body,
    })], 2, "intent:1:1");
    const first = store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "link-root", now: 3 },
      { id: "link-first", triggerSource: "manual", triggerKey: "link-root", context: {}, evidence: {}, now: 3 },
    );
    assert.equal(store.listReservedWorkflowEvidence(first.submission.id).length, 1);
    assert.deepEqual(store.listWorkflowEvidence(noteKey).artifacts, [], "reservation empties the tray");

    // The criterion is worth claiming precisely because a previous round proved it. The item is
    // not re-registered here, and it does not need to be.
    store.stageWorkflowEvidence(noteKey, [], 4, "intent:1:2", [{
      id: "link-claim",
      clientCriterionId: "suite-passes",
      criterion: "The suite the change touches passes",
      proofClass: "focused_execution" as const,
      repositoryScope: "all" as const,
      sourceRoot: checkout,
      links: [{ clientItemId: "suite-run", role: "execution" as const }],
    }]);
    const coverage = store.listWorkflowEvidence(noteKey).coverage ?? [];
    assert.deepEqual(
      coverage.map((claim) => claim.clientCriterionId),
      ["suite-passes"],
      "a link resolves against evidence this conversation owns, reserved or not",
    );
    assert.deepEqual(
      coverage[0]?.links,
      [{ clientItemId: "suite-run", role: "execution" }],
      "and the link it was registered with survives intact",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("the store's deliberate refusals carry a code the evidence tool can relay", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-refusalcode-")));
  try {
    writeFileSync(join(checkout, "coded.png"), PNG);
    const { store, noteKey, binding, runId } = fixture(checkout);
    const write = imageWrite({
      id: "coded-item",
      clientItemId: "coded-proof",
      root: checkout,
      locator: "coded.png",
      caption: "The claim this submission froze",
      bytes: PNG,
    });
    store.stageWorkflowEvidence(noteKey, [write], 2, "intent:1:1");
    store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "coded-root", now: 3 },
      { id: "coded-first", triggerSource: "manual", triggerKey: "coded-root", context: {}, evidence: {}, now: 3 },
    );

    // Changed bytes under a reserved id are still refused - that claim is frozen - but the
    // refusal now says which item and why, instead of arriving as an opaque 409.
    assert.throws(
      () => store.stageWorkflowEvidence(
        noteKey,
        [{ ...write, caption: "A different claim entirely" }],
        4,
        "intent:1:2",
      ),
      (error: unknown) => error instanceof WorkflowImageEvidenceError
        && error.code === "evidence_reserved"
        && error.status === 409
        && error.message.includes("coded-proof"),
    );
    assert.throws(
      () => store.stageWorkflowEvidence(noteKey, [], 5, "intent:1:2", [{
        id: "coded-claim",
        clientCriterionId: "never-proved",
        criterion: "A criterion whose proof was never registered",
        proofClass: "focused_execution" as const,
        repositoryScope: "all" as const,
        sourceRoot: checkout,
        links: [{ clientItemId: "no-such-item", role: "execution" as const }],
      }]),
      (error: unknown) => error instanceof WorkflowImageEvidenceError
        && error.code === "coverage_link_unknown"
        && error.message.includes("no-such-item"),
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("evidence retention removed cannot wedge the claims that outlived it", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "mission-carry-danglinglink-")));
  try {
    const body = "the proof a pruned round captured\n";
    writeFileSync(join(checkout, "pruned.log"), body);
    const { store, noteKey, binding, runId } = fixture(checkout);
    store.stageWorkflowEvidence(noteKey, [logWrite({
      id: "dangling-item",
      clientItemId: "pruned-proof",
      root: checkout,
      locator: "pruned.log",
      caption: "The proof a pruned round captured",
      body,
    })], 2, "intent:1:1");
    store.createInitialSubmission(
      { id: runId, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "dangling-root", now: 3 },
      { id: "dangling-first", triggerSource: "manual", triggerKey: "dangling-root", context: {}, evidence: {}, now: 3 },
    );
    store.stageWorkflowEvidence(noteKey, [], 4, "intent:1:2", [{
      id: "dangling-claim",
      clientCriterionId: "pruned-criterion",
      criterion: "A criterion whose proof retention later removed",
      proofClass: "focused_execution" as const,
      repositoryScope: "all" as const,
      sourceRoot: checkout,
      links: [{ clientItemId: "pruned-proof", role: "execution" as const }],
    }]);

    // Retention drops a reserved row once the submission holding it is gone. The claim it was
    // registered against is still staged, so its link now names nothing.
    store.setRunState(runId, "completed", "complete", {}, 5);
    store.runRetention({ rawEvidenceBefore: 6, completedRunsBefore: 6, maxCompletedRuns: 0, now: 7 });
    assert.deepEqual(
      openDb().prepare(
        `SELECT client_item_id FROM workflow_evidence_staging WHERE note_key = ?`,
      ).all(noteKey),
      [],
      "the row the claim links is gone from the table, not merely out of the tray",
    );

    // Unrelated work must not be held hostage to a repair only retention could make.
    writeFileSync(join(checkout, "later.log"), body);
    store.stageWorkflowEvidence(noteKey, [logWrite({
      id: "later-item",
      clientItemId: "later-proof",
      root: checkout,
      locator: "later.log",
      caption: "Evidence captured after the prune",
      body,
    })], 8, "intent:1:3");
    assert.deepEqual(
      store.listWorkflowEvidence(noteKey).artifacts.map((item) => item.clientItemId),
      ["later-proof"],
      "a later registration is not refused on a pruned round's behalf",
    );

    // A claim being registered NOW still has to name evidence that exists.
    assert.throws(
      () => store.stageWorkflowEvidence(noteKey, [], 9, "intent:1:3", [{
        id: "fresh-dangling-claim",
        clientCriterionId: "fresh-criterion",
        criterion: "A criterion registered now against nothing",
        proofClass: "focused_execution" as const,
        repositoryScope: "all" as const,
        sourceRoot: checkout,
        links: [{ clientItemId: "pruned-proof", role: "execution" as const }],
      }]),
      (error: unknown) => error instanceof WorkflowImageEvidenceError
        && error.code === "coverage_link_unknown",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
