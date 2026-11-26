/**
 * The durable proof a completed run needs before its terminal Inspector-only repair can own the
 * author's next idle. `session-action-runtime.test.ts` drives the accepted shape end to end;
 * these are the unproven and unclean shapes the runtime cannot reach on purpose, each of which
 * must fail closed into an ordinary review. The last tests pin the Git facts the claim compares
 * against a real checkout.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedGitRepo } from "./helpers/git-fixture.ts";
import { captureWorktreeTree, LocalArtifactChangedError } from "../src/server/git/worktree-tree.ts";
import { resolveCommitTree } from "../src/server/workflows/commit-id.ts";
import { acceptedInspectorRepair, inspectorRepairTriggerKey } from "../src/server/workflows/inspector-repair-proof.ts";
import type { WorkflowCompletionPolicy, WorkflowInspectorGateState, WorkflowSubmission } from "../src/shared/workflow.ts";

const RUN = "run-1";
const PUBLISHED = "a".repeat(40);
const FIRST = "b".repeat(40);
const SECOND = "c".repeat(40);
const POLICY: WorkflowCompletionPolicy = { kind: "inspector", onFindings: "inspector_only", missingPrAction: "wait" };

function submission(patch: Partial<WorkflowSubmission> & Pick<WorkflowSubmission, "id">): WorkflowSubmission {
  return {
    runId: RUN, round: 1, segment: 0, parentSubmissionId: null, continuationNodeId: null,
    continuationNodeAttemptId: null, mode: "full_workflow", triggerSource: "foreman", triggerKey: `key-${patch.id}`,
    evidenceFingerprint: "fingerprint", context: {}, evidence: {}, prHeadSha: null, status: "completed",
    createdAt: 1, updatedAt: 1, completedAt: 1, ...patch,
  };
}

function repair(id: string, round: number, failedHeadSha: string, newHeadSha: string): WorkflowSubmission {
  return submission({
    id, round, mode: "inspector_only", triggerSource: "manual", triggerKey: inspectorRepairTriggerKey(RUN, newHeadSha),
    prHeadSha: newHeadSha,
    context: { bypassReason: "Published GitHub Inspector-only findings policy", failedHeadSha, newHeadSha,
      priorFindingFingerprints: ["finding"] },
  });
}

function cleanGate(head: string): WorkflowInspectorGateState {
  return {
    prKey: "owner/repo#1", prUrl: "https://github.com/owner/repo/pull/1", targetHeadSha: head,
    failedHeadSha: PUBLISHED, enteredAt: 1, lastObservedAt: 2, observedHeadSha: head, reviewPosture: "live",
    waitReason: null, findingFingerprints: [],
  };
}

const reviewed = submission({ id: "reviewed" });
const published = submission({ id: "published", segment: 1, parentSubmissionId: "reviewed" });

function proof(patch: {
  head?: string;
  gate?: WorkflowInspectorGateState | null;
  policy?: WorkflowCompletionPolicy;
  submissions?: WorkflowSubmission[];
  status?: "completed" | "waiting_for_new_head";
  phase?: string;
  inspectorHeadSha?: string | null;
  publishedSubmissionId?: string;
} = {}) {
  const head = patch.head ?? FIRST;
  return acceptedInspectorRepair({
    run: { id: RUN, status: patch.status ?? "completed", currentPhase: patch.phase ?? "complete",
      inspectorHeadSha: patch.inspectorHeadSha === undefined ? head : patch.inspectorHeadSha },
    gate: patch.gate === undefined ? cleanGate(head) : patch.gate,
    policy: patch.policy ?? POLICY,
    submissions: patch.submissions ?? [reviewed, published, repair("first", 2, PUBLISHED, FIRST)],
    publishedSubmissionId: patch.publishedSubmissionId ?? "published",
  });
}

test("a clean exact-head Inspector-only repair chain is accepted", () => {
  assert.deepEqual(proof(), { published, headSha: FIRST, failedBaseHeadSha: PUBLISHED });
  const chained = proof({ head: SECOND, submissions: [reviewed, published,
    repair("first", 2, PUBLISHED, FIRST), repair("second", 3, FIRST, SECOND)] });
  assert.equal(chained?.headSha, SECOND);
  assert.equal(chained?.failedBaseHeadSha, PUBLISHED, "the first round must still replace the published head");
});

for (const [name, patch] of [
  ["the run is not completed", { status: "waiting_for_new_head" as const }],
  ["the run completed outside the clean gate", { phase: "inspector_review" }],
  ["the run has no Inspector gate", { gate: null }],
  ["the published policy restarts the full workflow", { policy: { ...POLICY, onFindings: "restart_workflow" as const } }],
  ["the completion policy is not Inspector", { policy: { kind: "none" as const } }],
  ["the gate still waits", { gate: { ...cleanGate(FIRST), waitReason: "findings" as const } }],
  ["a finding is outstanding", { gate: { ...cleanGate(FIRST), findingFingerprints: ["finding"] } }],
  ["the reviewed tree changed before repair", { gate: { ...cleanGate(FIRST), reviewedContent: {
    submissionId: "published", headSha: "abc1234", treeOid: "d".repeat(40), publishedTreeOid: "e".repeat(40) } } }],
  ["a recovery grant is unverified", { gate: { ...cleanGate(FIRST), grantObservation: {
    minimumObservedAt: 2, requestedAt: 1 } } }],
  ["Inspector accepted a different head", { gate: { ...cleanGate(SECOND), observedHeadSha: SECOND } }],
  ["Inspector observed a different head", { gate: { ...cleanGate(FIRST), observedHeadSha: SECOND } }],
  ["the run recorded a different head", { inspectorHeadSha: SECOND }],
  ["the run recorded no head", { inspectorHeadSha: null }],
  ["the publication continuation is unknown", { publishedSubmissionId: "missing" }],
  ["the publication handoff is not the latest full review", { publishedSubmissionId: "reviewed" }],
  ["no repair followed the publication", { submissions: [reviewed, published] }],
  ["a full review followed the repair", { submissions: [reviewed, published, repair("first", 2, PUBLISHED, FIRST),
    submission({ id: "restart", round: 3 })] }],
  ["a repair is still open", { submissions: [reviewed, published,
    { ...repair("first", 2, PUBLISHED, FIRST), status: "capturing" as const }] }],
  ["a round skipped the head it replaced", { head: SECOND, submissions: [reviewed, published,
    repair("first", 2, PUBLISHED, FIRST), repair("second", 3, PUBLISHED, SECOND)] }],
  ["a round was not filed for its own head", { submissions: [reviewed, published,
    { ...repair("first", 2, PUBLISHED, FIRST), triggerKey: inspectorRepairTriggerKey("other-run", FIRST) }] }],
  ["a round's context disagrees with its head", { submissions: [reviewed, published,
    { ...repair("first", 2, PUBLISHED, FIRST), prHeadSha: SECOND }] }],
  ["a round's context is unreadable", { submissions: [reviewed, published,
    { ...repair("first", 2, PUBLISHED, FIRST), context: { newHeadSha: FIRST } }] }],
  ["a round repeated the failed head", { head: PUBLISHED, submissions: [reviewed, published,
    repair("first", 2, PUBLISHED, PUBLISHED)] }],
] as const) {
  test(`an Inspector-only repair is unproven when ${name}`, () => {
    assert.equal(proof(patch as Parameters<typeof proof>[0]), null);
  });
}

// ---- the repository facts the claim compares, against real Git ----------------------------------

const home = mkdtempSync(join(tmpdir(), "mission-inspector-repair-"));
after(() => rmSync(home, { recursive: true, force: true }));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

const reportPath = "docs/reports/result/report.html";
const reportBytes = "<!doctype html><title>Result</title><p>Verified.</p>";

function repaired(): { root: string; head: string; artifacts: { path: string; sha256: string }[] } {
  const root = join(home, `repo-${Math.random().toString(16).slice(2)}`);
  seedGitRepo(root, { files: { "card.ts": "export const name = 'Ref';\n" }, message: "published",
    name: "Test", email: "test@example.invalid" });
  writeFileSync(join(root, "card.ts"), "export const name = 'Reference';\n");
  git(root, "commit", "-qam", "Inspector-only repair");
  mkdirSync(join(root, "docs/reports/result"), { recursive: true });
  writeFileSync(join(root, reportPath), reportBytes);
  return {
    root, head: git(root, "rev-parse", "HEAD"),
    artifacts: [{ path: reportPath, sha256: createHash("sha256").update(reportBytes).digest("hex") }],
  };
}

test("a clean checkout of the repaired commit publishes exactly that commit's tree", async () => {
  const { root, head, artifacts } = repaired();
  const current = await captureWorktreeTree(root, { localArtifacts: artifacts });
  assert.equal(current.headOid, head);
  assert.equal(current.publicationTreeOid, await resolveCommitTree(root, head));
  assert.deepEqual(current.unpublishedPaths, []);
});

test("unpublished work beside the repaired commit is visible to the claim", async () => {
  const { root, head, artifacts } = repaired();
  writeFileSync(join(root, "card.ts"), "export const name = 'Reference (edited)';\n");
  writeFileSync(join(root, "notes.md"), "untracked follow-up\n");
  const current = await captureWorktreeTree(root, { localArtifacts: artifacts });
  assert.equal(current.headOid, head);
  assert.notEqual(current.publicationTreeOid, await resolveCommitTree(root, head));
  assert.deepEqual(current.unpublishedPaths.sort(), ["card.ts", "notes.md"]);
});

test("a retained artifact rewritten after review cannot be set aside", async () => {
  const { root, artifacts } = repaired();
  writeFileSync(join(root, reportPath), reportBytes + "<p>Edited.</p>");
  await assert.rejects(captureWorktreeTree(root, { localArtifacts: artifacts }), LocalArtifactChangedError);
});
