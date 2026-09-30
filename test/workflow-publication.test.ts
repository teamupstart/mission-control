import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorktreeTree } from "../src/server/git/worktree-tree.ts";
import { captureWorkflowPublication } from "../src/server/workflows/publication.ts";
import { captureSubmissionTextArtifacts, WorkflowImageEvidenceError } from "../src/server/workflows/images.ts";
import { workflowHasUnpublishedChanges, workflowPublicationTree } from "../src/shared/workflow-publication.ts";
import { probeMatchesEvidence } from "../src/server/workflows/context.ts";
import { WORKFLOW_TEXT_EVIDENCE_LIMITS, type WorkflowContextSnapshot } from "../src/shared/workflow.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

const home = mkdtempSync(join(tmpdir(), "mission-publication-"));
after(() => rmSync(home, { recursive: true, force: true }));
let serial = 0;
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function repo(): string {
  const root = join(home, String(++serial));
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "source.ts"), "export const answer = 42;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}
const reportPath = "docs/reports/result/report.html";
const html = "<!doctype html><title>Result</title><h1>Result</h1><p>Verified.</p>";
function report(root: string, content = html): void {
  mkdirSync(join(root, "docs/reports/result"), { recursive: true });
  writeFileSync(join(root, reportPath), content);
}
function evidence(capture: Awaited<ReturnType<typeof captureWorkflowPublication>>) {
  return { ...capture, workingTreeDirty: true } as WorkflowContextSnapshot["evidence"];
}

test("retained local report and text evidence do not change required publication", async () => {
  const root = repo();
  report(root, html + '<a href="evidence.csv">Evidence</a>');
  writeFileSync(join(root, "docs/reports/result/evidence.csv"), "check,result\nfocused,passed\n");
  const indexBefore = readFileSync(join(root, ".git/index"));
  const capture = await captureWorkflowPublication(root);
  assert.notEqual(capture.contentTreeOid, capture.publication.treeOid);
  assert.equal(capture.publication.treeOid, git(root, "rev-parse", "HEAD^{tree}"));
  assert.deepEqual(capture.publication.unpublishedPaths, []);
  assert.equal(capture.artifacts.length, 2);
  assert.equal(workflowHasUnpublishedChanges(evidence(capture)), false);
  assert.deepEqual(readFileSync(join(root, ".git/index")), indexBefore);

  const { WorkflowStore } = await import("../src/server/workflows/store.ts");
  const { openDb } = await import("../src/server/db.ts");
  const store = new WorkflowStore(openDb());
  const retained = await captureSubmissionTextArtifacts(store, "publication-retention", Date.now(), capture.artifacts);
  rmSync(join(root, "docs"), { recursive: true });
  assert.deepEqual(new WorkflowStore(openDb()).listSubmissionTextArtifacts("publication-retention"), retained);
  assert.equal(retained.find((item) => item.displayName === reportPath)?.content, html + '<a href="evidence.csv">Evidence</a>');
  assert.equal(workflowPublicationTree({ ...evidence(capture), artifacts: [] }), capture.contentTreeOid,
    "an exemption without retained receipts fails closed");
});

test("tracked edits, deletions, new source, and unrelated HTML remain required", async () => {
  const root = repo();
  report(root);
  writeFileSync(join(root, "new-source.ts"), "export {};\n");
  writeFileSync(join(root, "product.html"), html);
  writeFileSync(join(root, "docs/reports/result/implementation.ts"), "export {};\n");
  rmSync(join(root, "source.ts"));
  const capture = await captureWorkflowPublication(root);
  assert.deepEqual(capture.publication.unpublishedPaths, [
    "docs/reports/result/implementation.ts", "new-source.ts", "product.html", "source.ts",
  ]);
  assert.equal(workflowHasUnpublishedChanges(evidence(capture)), true);
});

test("tracked and staged reports cannot be exempted, including a staged deletion", async () => {
  const root = repo();
  report(root);
  git(root, "add", reportPath);
  const staged = await captureWorkflowPublication(root);
  assert.equal(staged.artifacts.length, 0);
  assert.equal(staged.publication.treeOid, git(root, "write-tree"));
  assert.deepEqual(staged.publication.unpublishedPaths, [reportPath]);
  git(root, "commit", "-qm", "tracked report");
  git(root, "rm", "--cached", reportPath);
  const removedFromIndex = await captureWorkflowPublication(root);
  assert.equal(removedFromIndex.artifacts.length, 0);
  // Capture follows the working tree, where the previously tracked report still exists.
  assert.equal(removedFromIndex.publication.treeOid, git(root, "rev-parse", "HEAD^{tree}"));
  assert.deepEqual(removedFromIndex.publication.unpublishedPaths, []);
  await assert.rejects(captureWorktreeTree(root, { localArtifacts: [{ path: reportPath,
    sha256: createHash("sha256").update(html).digest("hex") }] }), /Tracked artifact must be published/);

  report(root, html + "Updated evidence");
  const modified = await captureWorkflowPublication(root);
  assert.equal(modified.artifacts.length, 0);
  assert.deepEqual(modified.publication.unpublishedPaths, [reportPath]);
  git(root, "add", reportPath);
  assert.equal(modified.publication.treeOid, git(root, "write-tree"));
});

for (const boundary of [
  { name: "file count", reservedBytes: 1, localCount: WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount - 1, localBytes: 256 },
  {
    name: "aggregate UTF-8 bytes",
    reservedBytes: WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact,
    localCount: WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes / WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact - 1,
    localBytes: WORKFLOW_TEXT_EVIDENCE_LIMITS.maxBytesPerArtifact,
  },
]) {
  test(`reserved evidence and local reports accept the ${boundary.name} limit and reject one above it`, async () => {
    const root = realpathSync(repo());
    const padding = boundary.localBytes - Buffer.byteLength(html);
    report(root, html + "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2));
    for (let index = 1; index < boundary.localCount; index++) {
      writeFileSync(join(root, `docs/reports/result/evidence-${index}.txt`), "é".repeat(boundary.localBytes / 2));
    }
    const atLimit = await captureWorkflowPublication(root);
    assert.equal(atLimit.artifacts.length, boundary.localCount);
    const overflowPath = join(root, "docs/reports/result/overflow.txt");
    writeFileSync(overflowPath, "x");
    const aboveLimit = await captureWorkflowPublication(root);
    assert.equal(aboveLimit.artifacts.length, boundary.localCount + 1);

    const { WorkflowStore } = await import("../src/server/workflows/store.ts");
    const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
    const store = new WorkflowStore();
    const id = `publication-retention-${boundary.name}`;
    const reservedContent = "r".repeat(boundary.reservedBytes);
    writeFileSync(join(root, "reserved.txt"), reservedContent);
    store.stageWorkflowEvidence(id, [{
      id: `${id}-reserved`, clientItemId: "reserved", sourceKind: "agent", evidenceKind: "text",
      sourceRoot: root, sourceLocator: "reserved.txt", displayName: "reserved.txt", caption: "Reserved evidence",
      repositoryScope: "repo-01", mimeType: "text/plain", bytes: Buffer.byteLength(reservedContent),
      sha256: createHash("sha256").update(reservedContent).digest("hex"),
    }], 1);
    const binding = store.insertBinding({
      id: `${id}-binding`, workflowVersionId: BUILTIN_WORKFLOWS[0]!.definition.currentVersionId!,
      noteKey: id, sessionId: `${id}-session`, sessionAgent: "codex", sessionName: "retention limits",
      sessionCwd: root, sessionRepoRoot: root, triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5, now: 2,
    });
    const { submission } = store.createInitialSubmission(
      { id: `${id}-run`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: id, now: 3 },
      { id, triggerSource: "manual", triggerKey: id, context: {}, evidence: {}, now: 3 },
    );
    assert.equal(store.listReservedWorkflowEvidence(submission.id).length, 1);
    await assert.rejects(
      captureSubmissionTextArtifacts(store, submission.id, 4, aboveLimit.artifacts),
      (error: unknown) => error instanceof WorkflowImageEvidenceError && error.code === "artifact_aggregate",
    );
    assert.deepEqual(store.listSubmissionTextArtifacts(submission.id), [], "rejection must not retain a partial capture");

    rmSync(overflowPath);
    const retained = await captureSubmissionTextArtifacts(store, submission.id, 5, atLimit.artifacts);
    assert.equal(retained.length, boundary.localCount + 1);
    assert.equal(retained.reduce((sum, item) => sum + item.bytes, 0), boundary.reservedBytes + boundary.localCount * boundary.localBytes);
    assert.deepEqual(retained.map((item) => item.content), [reservedContent, ...atLimit.artifacts.map((item) => item.content)]);
    assert.deepEqual(store.listSubmissionTextArtifacts(submission.id), retained);
  });
}

test("invalid, linked-outside, oversized, and symlinked reports stay required", async () => {
  for (const content of [html + '<script>alert(1)</script>', html + '<a href="../../outside.txt">Outside</a>', html + "x".repeat(65_536)]) {
    const root = repo();
    report(root, content);
    const capture = await captureWorkflowPublication(root);
    assert.equal(capture.artifacts.length, 0);
    assert.deepEqual(capture.publication.unpublishedPaths, [reportPath]);
  }
  const root = repo();
  report(root);
  rmSync(join(root, reportPath));
  symlinkSync(join(root, "source.ts"), join(root, reportPath));
  const capture = await captureWorkflowPublication(root);
  assert.equal(capture.artifacts.length, 0);
  assert.deepEqual(capture.publication.unpublishedPaths, [reportPath]);
});

test("snapshot rejects artifact bytes that changed after validation", async () => {
  const root = repo();
  report(root);
  const sha256 = createHash("sha256").update(html).digest("hex");
  writeFileSync(join(root, reportPath), html + "changed");
  await assert.rejects(captureWorktreeTree(root, { localArtifacts: [{ path: reportPath, sha256 }] }), /changed during capture/);
});

test("report-only edits preserve publication identity but refresh the evidence probe", async () => {
  const root = repo();
  report(root);
  const before = await captureWorkflowPublication(root);
  writeFileSync(join(root, reportPath), html + "new evidence");
  const after = await captureWorkflowPublication(root);
  assert.equal(after.publication.treeOid, before.publication.treeOid);
  assert.notEqual(after.contentTreeOid, before.contentTreeOid);
  const old = { ...evidence(before), headSha: "abcd", diffFingerprint: "same", workingTreeStatus: ["?? docs/"] };
  const probe = { headSha: old.headSha, diffFingerprint: old.diffFingerprint, workingTreeStatus: old.workingTreeStatus,
    contentTreeOid: after.contentTreeOid, publicationVersion: 1 as const };
  assert.equal(probeMatchesEvidence(probe, old), false);
  assert.equal(probeMatchesEvidence({ ...probe, contentTreeOid: before.contentTreeOid }, old), true);
  const legacy = { ...old, publication: undefined };
  assert.equal(probeMatchesEvidence({ ...probe, contentTreeOid: before.contentTreeOid }, legacy), false);
});

test("an extra committed report changes the complete published tree", async () => {
  const root = repo();
  report(root);
  const accepted = await captureWorkflowPublication(root);
  git(root, "add", reportPath);
  git(root, "commit", "-qm", "extra artifact");
  assert.notEqual(git(root, "rev-parse", "HEAD^{tree}"), workflowPublicationTree(evidence(accepted)));
});
