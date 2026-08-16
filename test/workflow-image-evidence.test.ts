import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ScoutRepoTask } from "../src/server/scouts/repos.ts";
import type { WorkflowContextSnapshot } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-images-"));
process.env.MISSION_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const {
  SubmitWorkflowSchema,
  SubmitWorkflowEvidenceSchema,
  WorkflowContextSnapshotSchema,
  WorkflowEvidenceImageSchema,
} = await import("../src/shared/protocol.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const {
  captureSubmissionImages,
  captureSubmissionTextArtifacts,
  readSubmissionImageBody,
  reconcileWorkflowEvidenceFiles,
  resolveSubmissionImageInputs,
  stageAgentWorkflowEvidence,
  WorkflowImageEvidenceError,
  workflowEvidenceOrphanCount,
} = await import("../src/server/workflows/images.ts");
const { parsePersonaVerdict } = await import("../src/server/workflows/verdict.ts");

openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const IMAGE_WORKFLOW_VERSION_ID = BUILTIN_WORKFLOWS[0]!.definition.currentVersionId!;
const mutableFs = createRequire(import.meta.url)("node:fs") as {
  openSync: typeof import("node:fs").openSync;
};

async function withParentDirectorySwap<T>(input: {
  targetPath: string;
  parentPath: string;
  outsidePath: string;
  action: () => Promise<T>;
}): Promise<T> {
  const parkedPath = `${input.parentPath}-inside`;
  const originalOpenSync = mutableFs.openSync;
  let swapped = false;
  mutableFs.openSync = ((...args: unknown[]) => {
    if (!swapped && args[0] === input.targetPath) {
      renameSync(input.parentPath, parkedPath);
      symlinkSync(input.outsidePath, input.parentPath);
      swapped = true;
    }
    return Reflect.apply(originalOpenSync, mutableFs, args);
  }) as typeof import("node:fs").openSync;
  syncBuiltinESMExports();
  try {
    return await input.action();
  } finally {
    mutableFs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    if (swapped) {
      unlinkSync(input.parentPath);
      renameSync(parkedPath, input.parentPath);
    }
  }
}

function taskAt(primary: string, extras: string[] = []): ScoutRepoTask {
  return {
    repoRoot: primary,
    worktreePath: primary,
    baseSha: null,
    extraRepos: extras.map((root, position) => ({
      repoRoot: root,
      worktreePath: root,
      baseSha: null,
      position: position + 1,
      branch: null,
      provider: null,
      worktreeLeaseId: null,
      prUrl: null,
      prState: null,
      mergedAt: null,
    })),
  };
}

function context(images: WorkflowContextSnapshot["evidence"]["images"] = []): WorkflowContextSnapshot {
  return {
    primaryGoal: { rawPrompt: "Review the pixels", refined: null, sourceNoteKey: "note" },
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
      transcriptAnchor: null,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
      images,
      stagedImageGeneration: images.length > 0 ? 1 : 0,
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  };
}

test("workflow image contracts default historical context and bind image citations to the current manifest", () => {
  const parsed = WorkflowContextSnapshotSchema.parse(context().evidence.images === undefined
    ? context()
    : {
        ...context(),
        evidence: {
          ...context().evidence,
          images: undefined,
          stagedImageGeneration: undefined,
        },
      });
  assert.deepEqual(parsed.evidence.images, []);
  assert.equal(parsed.evidence.stagedImageGeneration, 0);

  const image = WorkflowEvidenceImageSchema.parse({
    id: "img_123",
    ordinal: 0,
    displayName: "screen.png",
    caption: "The dialog is visible",
    repositoryScope: "repo-01",
    mimeType: "image/png",
    bytes: PNG.byteLength,
    sha256: "a".repeat(64),
    availability: "retained",
    prunedAt: null,
    createdAt: 1,
  });
  assert.equal(WorkflowEvidenceImageSchema.safeParse({
    ...image,
    availability: "pruned",
    prunedAt: null,
  }).success, false);
  const verdict = JSON.stringify({
    verdict: "pass",
    summary: "Seen",
    approvalDetails: {
      reason: "The requested dialog is present",
      evidence: [{ kind: "image", path: image.id, quote: "A dialog is visible" }],
    },
    confidence: 0.9,
  });
  assert.equal(parsePersonaVerdict(verdict, new Set([image.id]))?.verdict, "pass");
  assert.equal(parsePersonaVerdict(verdict, new Set()), null);
  assert.equal(parsePersonaVerdict(verdict.replace('"quote"', '"line":1,"quote"'), new Set([image.id])), null);

  const duplicate = {
    clientItemId: "same",
    uploadId: "upload.png",
    caption: "caption",
    repositoryScope: "repo-01" as const,
    kind: "upload" as const,
  };
  assert.equal(SubmitWorkflowSchema.safeParse({
    requestId: "request",
    evidence: [duplicate, duplicate],
  }).success, false);
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({
    images: [{ ...duplicate, kind: "agent", path: "screen.png" }, { ...duplicate, kind: "agent", path: "other.png" }],
  }).success, false);
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({
    artifacts: [{
      kind: "text",
      clientItemId: "focused-log",
      path: "evidence/focused.tap",
      caption: "Focused TAP output",
      repositoryScope: "repo-01",
    }],
  }).success, true);
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({}).success, false);
  assert.equal(SubmitWorkflowEvidenceSchema.safeParse({
    images: [{ ...duplicate, kind: "agent", path: "screen.png" }],
    artifacts: [{
      kind: "text",
      clientItemId: duplicate.clientItemId,
      path: "evidence/focused.tap",
      caption: "Focused TAP output",
      repositoryScope: "repo-01",
    }],
  }).success, false);
});

test("gitignored UTF-8 logs preserve BOM bytes when digest-bound and submission-frozen", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-workflow-text-repo-")));
  const original = "\uFEFFTAP version 13\nok 13 - focused regression\n";
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "evidence/\n");
    mkdirSync(join(repo, "evidence"));
    const logPath = join(repo, "evidence", "focused.tap");
    writeFileSync(logPath, original);
    writeFileSync(join(repo, "evidence", "invalid.log"), Buffer.from([0xff]));
    writeFileSync(join(repo, "not-ignored.log"), original);
    const store = new WorkflowStore();
    const stageTextPath = (path: string) => stageAgentWorkflowEvidence({
      store,
      noteKey: "text-note",
      task: taskAt(repo),
      fallbackRoot: repo,
      images: [],
      artifacts: [{
        kind: "text",
        clientItemId: `invalid-${path}`,
        path,
        caption: "Focused TAP output",
        repositoryScope: "repo-01",
      }],
      now: 1,
    });
    await assert.rejects(stageTextPath("evidence/invalid.log"), (error: unknown) =>
      error instanceof WorkflowImageEvidenceError && error.code === "artifact_encoding");
    await assert.rejects(stageTextPath("not-ignored.log"), /gitignored/);
    const staged = await stageAgentWorkflowEvidence({
      store,
      noteKey: "text-note",
      task: taskAt(repo),
      fallbackRoot: repo,
      images: [],
      artifacts: [{
        kind: "text",
        clientItemId: "focused-log",
        path: "evidence/focused.tap",
        caption: "Focused TAP output",
        repositoryScope: "repo-01",
      }],
      now: 1,
    });
    assert.deepEqual(staged.images, []);
    assert.equal(staged.artifacts.length, 1);
    assert.equal(staged.artifacts[0]?.bytes, Buffer.byteLength(original));

    const binding = store.insertBinding({
      id: "text-binding",
      workflowVersionId: IMAGE_WORKFLOW_VERSION_ID,
      noteKey: "text-note",
      sessionId: "text-session",
      sessionAgent: "codex",
      sessionName: "text evidence",
      sessionCwd: repo,
      sessionRepoRoot: repo,
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
      now: 2,
    });
    const created = store.createInitialSubmission(
      { id: "text-run", binding, triggerSource: "manual", triggerKey: "text-run", now: 3 },
      {
        id: "text-submission",
        triggerSource: "manual",
        triggerKey: "text-run",
        evidenceGroupKey: "manual:text-note:text-run",
        context: {},
        evidence: {},
        now: 3,
      },
    );
    assert.equal(store.listReservedWorkflowEvidence(created.submission.id)[0]?.evidenceKind, "text");

    writeFileSync(logPath, `${original}not the staged bytes\n`);
    await assert.rejects(
      () => captureSubmissionTextArtifacts(store, created.submission.id, 4),
      (error: unknown) => error instanceof WorkflowImageEvidenceError && error.code === "artifact_changed",
    );
    assert.deepEqual(store.listSubmissionTextArtifacts(created.submission.id), []);

    writeFileSync(logPath, original);
    const captured = await captureSubmissionTextArtifacts(store, created.submission.id, 5);
    assert.equal(captured.length, 1);
    assert.match(captured[0]?.id ?? "", /^txt_[a-f0-9]{32}$/);
    assert.equal(captured[0]?.content, original);
    assert.equal(captured[0]?.sha256, staged.artifacts[0]?.sha256);

    writeFileSync(logPath, "later mutable source\n");
    const replayed = await captureSubmissionTextArtifacts(store, created.submission.id, 6);
    assert.deepEqual(replayed, captured);
    assert.equal(store.listSubmissionTextArtifacts(created.submission.id)[0]?.content, original);

    store.resetForNoteKey("text-note");
    assert.deepEqual(store.listSubmissionTextArtifacts(created.submission.id), []);
    assert.deepEqual(store.listWorkflowEvidence("text-note").artifacts, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parent-directory swaps cannot escape the issued checkout during staging or capture", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-workflow-parent-race-repo-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "mission-workflow-parent-race-outside-")));
  const evidenceDirectory = join(repo, "evidence");
  const targetPath = join(evidenceDirectory, "focused.log");
  const imageTargetPath = join(evidenceDirectory, "screen.png");
  const outsideContent = "outside checkout evidence\n";
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "evidence/\n");
    mkdirSync(evidenceDirectory);
    writeFileSync(targetPath, "inside checkout evidence\n");
    writeFileSync(imageTargetPath, PNG);
    writeFileSync(join(outside, "focused.log"), outsideContent);
    writeFileSync(join(outside, "screen.png"), PNG);
    const store = new WorkflowStore();

    await assert.rejects(
      () => withParentDirectorySwap({
        targetPath,
        parentPath: evidenceDirectory,
        outsidePath: outside,
        action: () => stageAgentWorkflowEvidence({
          store,
          noteKey: "parent-race-stage",
          task: taskAt(repo),
          fallbackRoot: repo,
          images: [],
          artifacts: [{
            kind: "text",
            clientItemId: "parent-race-stage",
            path: "evidence/focused.log",
            caption: "Focused output",
            repositoryScope: "repo-01",
          }],
          now: 1,
        }),
      }),
      WorkflowImageEvidenceError,
    );
    assert.deepEqual(store.listWorkflowEvidence("parent-race-stage").artifacts, []);

    await assert.rejects(
      () => withParentDirectorySwap({
        targetPath: imageTargetPath,
        parentPath: evidenceDirectory,
        outsidePath: outside,
        action: () => stageAgentWorkflowEvidence({
          store,
          noteKey: "parent-race-image-stage",
          task: taskAt(repo),
          fallbackRoot: repo,
          images: [{
            kind: "agent",
            clientItemId: "parent-race-image-stage",
            path: "evidence/screen.png",
            caption: "Focused screenshot",
            repositoryScope: "repo-01",
          }],
          now: 1,
        }),
      }),
      WorkflowImageEvidenceError,
    );
    assert.deepEqual(store.listWorkflowEvidence("parent-race-image-stage").images, []);

    const sha256 = (await import("node:crypto")).createHash("sha256")
      .update(outsideContent)
      .digest("hex");
    store.stageWorkflowEvidence("parent-race-capture", [{
      id: "parent-race-artifact",
      clientItemId: "parent-race-capture",
      sourceKind: "agent",
      evidenceKind: "text",
      sourceRoot: repo,
      sourceLocator: "evidence/focused.log",
      displayName: "focused.log",
      caption: "Focused output",
      repositoryScope: "repo-01",
      mimeType: "text/plain",
      bytes: Buffer.byteLength(outsideContent),
      sha256,
    }], 2);
    const binding = store.insertBinding({
      id: "parent-race-binding",
      workflowVersionId: IMAGE_WORKFLOW_VERSION_ID,
      noteKey: "parent-race-capture",
      sessionId: "parent-race-session",
      sessionAgent: "codex",
      sessionName: "parent race",
      sessionCwd: repo,
      sessionRepoRoot: repo,
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
      now: 3,
    });
    const created = store.createInitialSubmission(
      { id: "parent-race-run", binding, triggerSource: "manual", triggerKey: "parent-race", now: 4 },
      {
        id: "parent-race-submission",
        triggerSource: "manual",
        triggerKey: "parent-race",
        evidenceGroupKey: "manual:parent-race-capture:parent-race",
        context: {},
        evidence: {},
        now: 4,
      },
    );
    await assert.rejects(
      () => withParentDirectorySwap({
        targetPath,
        parentPath: evidenceDirectory,
        outsidePath: outside,
        action: () => captureSubmissionTextArtifacts(store, created.submission.id, 5),
      }),
      WorkflowImageEvidenceError,
    );
    assert.deepEqual(store.listSubmissionTextArtifacts(created.submission.id), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("secure agent staging accepts only contained gitignored raster files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mission-workflow-image-repo-"));
  const outside = join(home, "outside.png");
  const outsideDirectory = join(home, "outside-directory");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "evidence/\n");
    mkdirSync(join(repo, "evidence"));
    writeFileSync(join(repo, "evidence", "screen.png"), PNG);
    writeFileSync(join(repo, "not-ignored.png"), PNG);
    writeFileSync(join(repo, "evidence", "spoof.png"), "not an image");
    writeFileSync(outside, PNG);
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "screen.png"), PNG);
    symlinkSync(outside, join(repo, "evidence", "link.png"));
    symlinkSync(outsideDirectory, join(repo, "linked-evidence"));

    const store = new WorkflowStore();
    const staged = await stageAgentWorkflowEvidence({
      store,
      noteKey: "note-security",
      task: taskAt(repo),
      fallbackRoot: repo,
      images: [{
        kind: "agent",
        clientItemId: "screen",
        path: "evidence/screen.png",
        caption: "The result is visible",
        repositoryScope: "repo-01",
      }],
    });
    assert.equal(staged.generation, 1);
    assert.equal(staged.images[0]?.mimeType, "image/png");

    const refused = async (path: string) => stageAgentWorkflowEvidence({
      store,
      noteKey: "note-security",
      task: taskAt(repo),
      fallbackRoot: repo,
      images: [{
        kind: "agent",
        clientItemId: `bad-${path}`,
        path,
        caption: "bad",
        repositoryScope: "repo-01",
      }],
    });
    await assert.rejects(refused("../outside.png"), WorkflowImageEvidenceError);
    await assert.rejects(refused(join(repo, "evidence", "screen.png")), WorkflowImageEvidenceError);
    await assert.rejects(refused("evidence/link.png"), WorkflowImageEvidenceError);
    await assert.rejects(refused("linked-evidence/screen.png"), WorkflowImageEvidenceError);
    await assert.rejects(refused("evidence"), WorkflowImageEvidenceError);
    await assert.rejects(refused("evidence/missing.png"), WorkflowImageEvidenceError);
    await assert.rejects(refused("evidence/screen.png\u0001"), WorkflowImageEvidenceError);
    await assert.rejects(refused("evidence/spoof.png"), WorkflowImageEvidenceError);
    await assert.rejects(refused("not-ignored.png"), /gitignored/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reservation freezes immutable bytes, supports all-scope fan-out, and prunes through the cleanup ledger", async () => {
  const primary = realpathSync(mkdtempSync(join(tmpdir(), "mission-workflow-image-primary-")));
  const secondary = realpathSync(mkdtempSync(join(tmpdir(), "mission-workflow-image-secondary-")));
  try {
    writeFileSync(join(primary, "screen.png"), PNG);
    writeFileSync(join(primary, "swap.png"), PNG);
    const store = new WorkflowStore();
    const leadBinding = store.insertBinding({
      id: "image-binding-lead",
      workflowVersionId: IMAGE_WORKFLOW_VERSION_ID,
      noteKey: "image-note",
      sessionId: "image-session",
      sessionAgent: "codex",
      sessionName: "images",
      sessionCwd: primary,
      sessionRepoRoot: primary,
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
      now: 1,
    });
    const siblingBinding = store.insertBinding({
      id: "image-binding-sibling",
      workflowVersionId: IMAGE_WORKFLOW_VERSION_ID,
      noteKey: "image-note",
      sessionId: "image-session",
      sessionAgent: "codex",
      sessionName: "images",
      sessionCwd: primary,
      sessionRepoRoot: primary,
      repoRoot: secondary,
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
      now: 1,
    });
    const sha256 = (await import("node:crypto")).createHash("sha256").update(PNG).digest("hex");
    const write = {
      id: "staged-all",
      clientItemId: "screen-all",
      sourceKind: "agent" as const,
      sourceRoot: primary,
      sourceLocator: "screen.png",
      displayName: "screen.png",
      caption: "The same completion result",
      repositoryScope: "all",
      mimeType: "image/png" as const,
      bytes: PNG.byteLength,
      sha256,
    };
    const swapWrite = {
      ...write,
      id: "staged-swap",
      clientItemId: "screen-swap",
      sourceLocator: "swap.png",
      displayName: "swap.png",
      caption: "A source that will change before capture",
    };
    assert.equal(store.stageWorkflowEvidence("image-note", [write, swapWrite], 2).generation, 1);
    assert.equal(
      store.stageWorkflowEvidence("image-note", [write, swapWrite], 3).generation,
      1,
      "idempotent replay",
    );

    const group = "manual:image-note:request";
    const lead = store.createInitialSubmission(
      { id: "image-run-lead", binding: leadBinding, triggerSource: "manual", triggerKey: "image-lead", now: 4 },
      {
        id: "image-submission-lead",
        triggerSource: "manual",
        triggerKey: "image-lead",
        evidenceGroupKey: group,
        context: {},
        evidence: {},
        now: 4,
      },
    );
    const sibling = store.createInitialSubmission(
      { id: "image-run-sibling", binding: siblingBinding, triggerSource: "manual", triggerKey: "image-sibling", now: 4 },
      {
        id: "image-submission-sibling",
        triggerSource: "manual",
        triggerKey: "image-sibling",
        evidenceGroupKey: group,
        context: {},
        evidence: {},
        now: 4,
      },
    );
    assert.equal(store.listReservedWorkflowEvidence(lead.submission.id).length, 2);
    assert.equal(store.listReservedWorkflowEvidence(sibling.submission.id).length, 2);
    assert.deepEqual(store.listWorkflowEvidence("image-note").images, []);
    const secondaryOnly = {
      ...write,
      id: "staged-secondary",
      clientItemId: "screen-secondary",
      sourceRoot: secondary,
      repositoryScope: "repo-02",
    };
    store.stageWorkflowEvidence("image-note", [write, secondaryOnly], 5);
    assert.deepEqual(
      store.listReservedWorkflowEvidence(lead.submission.id).map((item) => item.id),
      ["staged-all", "staged-swap"],
      "a mixed idempotent retry must not return a reserved item to mutable staging",
    );
    assert.deepEqual(
      store.listWorkflowEvidence("image-note").images.map((image) => image.id),
      ["staged-secondary"],
    );
    assert.equal(store.workflowEvidenceGeneration("image-note", primary), 1);
    assert.equal(store.workflowEvidenceGeneration("image-note", secondary), 2);
    store.removeWorkflowEvidence("image-note", secondaryOnly.clientItemId, 6);
    assert.equal(store.workflowEvidenceGeneration("image-note", primary), 1);
    assert.equal(store.workflowEvidenceGeneration("image-note", secondary), 3);

    writeFileSync(join(primary, "swap.png"), Buffer.concat([PNG, Buffer.from([0])]));
    await assert.rejects(
      () => captureSubmissionImages(store, lead.submission.id, 5),
      (error: unknown) => error instanceof WorkflowImageEvidenceError && error.code === "image_changed",
    );
    assert.deepEqual(store.listSubmissionImages(lead.submission.id), []);
    store.setSubmissionState(lead.submission.id, "failed", 5);
    store.setRunState(lead.run.id, "blocked", "image_evidence_capture", { code: "image_changed" }, 5);
    const resumed = store.resumeCapture(
      lead.run.id,
      lead.submission.id,
      ["image_evidence_capture"],
      6,
    );
    assert.equal(resumed?.submission.id, lead.submission.id);
    assert.deepEqual(
      store.listReservedWorkflowEvidence(lead.submission.id).map((item) => item.id),
      ["staged-all", "staged-swap"],
    );
    writeFileSync(join(primary, "swap.png"), PNG);
    const leadImages = await captureSubmissionImages(store, lead.submission.id, 7);
    const siblingImages = await captureSubmissionImages(store, sibling.submission.id, 7);
    assert.equal(leadImages.length, 2);
    assert.equal(siblingImages.length, 2);
    assert.notEqual(leadImages[0]?.id, siblingImages[0]?.id);
    assert.equal(leadImages[0]?.sha256, siblingImages[0]?.sha256);
    rmSync(join(primary, "screen.png"));
    const inputs = resolveSubmissionImageInputs(store, lead.submission.id);
    assert.equal(inputs[0]?.sha256, sha256, "the runner reads the submission-owned copy");
    assert.equal(readSubmissionImageBody(store, lead.run.id, leadImages[0]!.id).data.byteLength, PNG.byteLength);
    assert.throws(
      () => readSubmissionImageBody(store, sibling.run.id, leadImages[0]!.id),
      (error: unknown) => error instanceof WorkflowImageEvidenceError && error.status === 404,
    );
    const audit = store.runExportDetail(lead.run.id);
    assert.deepEqual(audit?.evidenceImages?.[0]?.images.map((image) => image.id), leadImages.map((image) => image.id));
    const auditJson = JSON.stringify(audit?.evidenceImages);
    assert.doesNotMatch(auditJson, /storageRelativePath|sourceLocator|sourceRoot/);
    assert.doesNotMatch(auditJson, new RegExp(PNG.toString("base64")));

    const registry = new Registry();
    registry.applyDiscovery([{
      syntheticId: "image-session",
      agent: "codex",
      name: "images",
      nameSource: "process",
      cwd: primary,
      gitBranch: "feature",
      gitRoot: primary,
      repoRoot: primary,
      pid: 1,
      tty: "ttys-image",
      terminals: [],
      startedAt: 1,
    } as DiscoveredSession]);
    const manager = new WorkflowManager(registry, store);
    assert.equal(manager.supportsImageEvidence(BUILTIN_WORKFLOWS[0]!.definition.id), true);
    assert.equal(manager.supportsImageEvidence("missing-workflow"), false);
    const app = buildApp(
      registry,
      new ReviewManager(registry),
      new TaskManager(registry),
      new QueueManager(registry),
      undefined,
      undefined,
      manager,
    );
    const retainedResponse = await app.request(
      `/api/workflow-runs/${lead.run.id}/images/${leadImages[0]!.id}`,
      { headers: { host: "127.0.0.1:7317" } },
    );
    assert.equal(retainedResponse.status, 200);
    assert.equal(retainedResponse.headers.get("content-type"), "image/png");
    assert.equal(retainedResponse.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await retainedResponse.arrayBuffer()), PNG);
    assert.equal(
      (await app.request(`/api/workflow-runs/${lead.run.id}/images/${leadImages[0]!.id}`, {
        headers: { host: "attacker.example" },
      })).status,
      403,
    );
    const reattached = manager.reattachRetainedEvidence(leadBinding.id, {
      imageId: leadImages[0]!.id,
      clientItemId: "historical-screen",
      caption: "Reuse this exact retained observation",
      repositoryScope: "repo-01",
    }, 7);
    assert.equal(reattached.images[0]?.sourceKind, "retained");
    const unrelatedBinding = store.insertBinding({
      id: "image-binding-unrelated",
      workflowVersionId: IMAGE_WORKFLOW_VERSION_ID,
      noteKey: "another-note",
      sessionId: "image-session",
      sessionAgent: "codex",
      sessionName: "images",
      sessionCwd: primary,
      sessionRepoRoot: primary,
      triggerMode: "manual",
      deliveryMode: "preview",
      maxRepairRounds: 5,
      now: 7,
    });
    assert.throws(
      () => manager.reattachRetainedEvidence(unrelatedBinding.id, {
        imageId: leadImages[0]!.id,
        clientItemId: "stolen-screen",
        caption: "This must not cross conversations",
        repositoryScope: "repo-01",
      }, 7),
      (error: unknown) => error instanceof WorkflowImageEvidenceError && error.code === "image_ownership",
    );

    const captured = WorkflowContextSnapshotSchema.parse(context(leadImages));
    store.updateSubmissionCapture(lead.submission.id, {
      context: workflowJson(captured),
      evidence: workflowJson(captured.evidence),
      fingerprint: "image-fingerprint",
      status: "running",
    }, 6);
    store.setSubmissionState(lead.submission.id, "completed", 7);
    store.setRunState(lead.run.id, "completed", "complete", {}, 7);
    const retention = store.runRetention({
      rawEvidenceBefore: 8,
      completedRunsBefore: 0,
      maxCompletedRuns: 100,
      now: 9,
    });
    assert.deepEqual(retention.compactedRunIds, [lead.run.id]);
    assert.equal(store.listSubmissionImages(lead.submission.id)[0]?.availability, "pruned");
    const pruned = WorkflowContextSnapshotSchema.parse(store.getSubmission(lead.submission.id)?.context);
    assert.equal(pruned.evidence.retention?.state, "pruned");
    assert.equal(pruned.evidence.retention?.state === "pruned" ? pruned.evidence.retention.imageCount : -1, 2);
    assert.equal(store.workflowStatusCounts().pendingEvidenceImageCleanup, 2);
    assert.equal(workflowEvidenceOrphanCount(store), 0, "pending cleanup is tracked, not orphaned");
    const retainedPath = inputs[0]!.path;
    reconcileWorkflowEvidenceFiles(store);
    assert.equal(existsSync(retainedPath), false);
    assert.equal(store.workflowStatusCounts().pendingEvidenceImageCleanup, 0);
    assert.equal(workflowEvidenceOrphanCount(store), 0);
    assert.equal(
      (await app.request(`/api/workflow-runs/${lead.run.id}/images/${leadImages[0]!.id}`, {
        headers: { host: "127.0.0.1:7317" },
      })).status,
      410,
    );
    assert.throws(
      () => readSubmissionImageBody(store, lead.run.id, leadImages[0]!.id),
      (error: unknown) => error instanceof WorkflowImageEvidenceError && error.status === 410,
    );
  } finally {
    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  }
});
