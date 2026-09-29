import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorktreeTree } from "../src/server/git/worktree-tree.ts";
import { captureWorkflowPublication } from "../src/server/workflows/publication.ts";
import { captureSubmissionTextArtifacts } from "../src/server/workflows/images.ts";
import { workflowHasUnpublishedChanges, workflowPublicationTree } from "../src/shared/workflow-publication.ts";
import { probeMatchesEvidence } from "../src/server/workflows/context.ts";
import type { WorkflowContextSnapshot } from "../src/shared/workflow.ts";

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
  assert.equal((await captureWorkflowPublication(root)).artifacts.length, 0);
  git(root, "commit", "-qm", "tracked report");
  git(root, "rm", "--cached", reportPath);
  assert.equal((await captureWorkflowPublication(root)).artifacts.length, 0);
  await assert.rejects(captureWorktreeTree(root, { localArtifacts: [{ path: reportPath,
    sha256: createHash("sha256").update(html).digest("hex") }] }), /Tracked artifact must be published/);
});

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
  assert.equal((await captureWorkflowPublication(root)).artifacts.length, 0);
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
