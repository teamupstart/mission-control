import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { WorkflowBinding } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-context-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  boundedWorkflowTranscript,
  captureStableWorkflowContext,
  captureBoundaryChanged,
  compactWorkflowContext,
  fallbackWorkflowContext,
  humanTranscriptDecisions,
  probeMatchesEvidence,
  readWorkflowEvidenceProbe,
  readWorkflowContextRaw,
  workflowReviewDecision,
  workflowContextFingerprint,
  WORKFLOW_TRANSCRIPT_LIMITS,
} = await import("../src/server/workflows/context.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");

const raw = {
  primaryGoal: { rawPrompt: "goal", refined: "refined", sourceNoteKey: "n1" },
  humanDecisions: [{
    decision: "decision",
    rationale: "because",
    source: { kind: "review" as const, id: "r1" },
  }],
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
    transcriptAnchor: 12,
    transcriptTruncated: false,
    standards: [{ path: "AGENTS.md", text: "rules", truncated: false, fingerprint: "standards" }],
    standardsTruncated: false,
  },
};

test("workflow context preserves raw goal and excludes every attributed non-human turn", () => {
  const decisions = humanTranscriptDecisions([
    { id: "human", role: "user", text: "Keep the public API stable", tools: [], ts: 1 },
    { id: "foreman", role: "user", text: "automated", tools: [], ts: 2, origin: "foreman" },
    { id: "harness", role: "user", text: "automated", tools: [], ts: 3, origin: "harness" },
    { id: "workflow", role: "user", text: "repair packet", tools: [], ts: 3, origin: "workflow" },
    { id: "answer", role: "assistant", text: "done", tools: [], ts: 4 },
  ]);
  assert.deepEqual(decisions, [{
    decision: "Keep the public API stable",
    rationale: null,
    source: { kind: "transcript", id: "human" },
  }]);

  const context = fallbackWorkflowContext({
    primaryGoal: { rawPrompt: "Ship exactly what I asked for", refined: "Ship it", sourceNoteKey: "n1" },
    humanDecisions: decisions,
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "patch",
      diffTruncated: false,
      workingTreeDirty: true,
      workingTreeStatus: [" M file.ts"],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: 12,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
  }, "provider unavailable");
  assert.equal(context.primaryGoal.rawPrompt, "Ship exactly what I asked for");
  assert.equal(context.compaction.status, "fallback");
  assert.deepEqual(context.constraints, []);
  assert.deepEqual(context.acceptanceCriteria, []);
});

test("transcript evidence retains the observed 5,393-byte TAP turn through test 13", () => {
  const finalLine = "ok 13 - regression finishes here\n";
  const tapPrefix = [
    "TAP version 13",
    ...Array.from({ length: 12 }, (_, index) => `ok ${index + 1} - focused case ${index + 1}`),
  ].join("\n") + "\n";
  const padding = "# captured output "
    + "x".repeat(5_393 - Buffer.byteLength(tapPrefix) - Buffer.byteLength(finalLine) - 19)
    + "\n";
  const tap = `${tapPrefix}${padding}${finalLine}`;
  assert.equal(Buffer.byteLength(tap), 5_393);

  const bounded = boundedWorkflowTranscript([{
    id: "tap-13",
    role: "assistant",
    text: tap,
    tools: [],
    ts: 13,
  }]);

  assert.equal(bounded.truncated, false);
  assert.equal(bounded.omittedHeadBytes, 0);
  assert.equal(bounded.transcript[0]?.content, tap);
  assert.match(bounded.transcript[0]?.content ?? "", /ok 13 - regression finishes here/);
});

test("oversized transcript turns preserve marked heads and tails within aggregate bounds", () => {
  const oversized = `HEAD:${"a".repeat(9_000)}:TAIL`;
  const one = boundedWorkflowTranscript([{
    id: "large",
    role: "assistant",
    text: oversized,
    tools: [],
    ts: 1,
  }]);
  const retained = one.transcript[0]!;
  assert.ok(Buffer.byteLength(retained.content) <= WORKFLOW_TRANSCRIPT_LIMITS.perTurnBytes);
  assert.match(retained.content, /^HEAD:/);
  assert.match(retained.content, /\[transcript turn head retained; \d+ UTF-8 bytes omitted\]/);
  assert.match(retained.content, /\[transcript turn tail retained\]/);
  assert.match(retained.content, /:TAIL$/);
  assert.ok((retained.omittedMiddleBytes ?? 0) > 0);

  const many = boundedWorkflowTranscript(Array.from({ length: 30 }, (_, index) => ({
    id: `turn-${index}`,
    role: "assistant" as const,
    text: `TURN-${String(index).padStart(2, "0")}:${"z".repeat(7_880)}`,
    tools: [],
    ts: index + 1,
  })));
  const contents = many.transcript.map((message) => message.content).join("\n");
  assert.doesNotMatch(contents, /TURN-00:/);
  assert.match(contents, /TURN-29:/);
  assert.ok(many.omittedHeadBytes > 0);
  assert.ok(
    many.transcript.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0)
      <= WORKFLOW_TRANSCRIPT_LIMITS.aggregateBytes,
  );
  assert.ok(JSON.stringify(many.transcript).length <= WORKFLOW_TRANSCRIPT_LIMITS.jsonCharacters);
});

test("transcript omission markers match stored metadata after marker-width changes", () => {
  const bounded = boundedWorkflowTranscript([{
    id: "marker-boundary",
    role: "assistant",
    text: "x".repeat(WORKFLOW_TRANSCRIPT_LIMITS.perTurnBytes + 1),
    tools: [],
    ts: 1,
  }]);
  const retained = bounded.transcript[0]!;
  const marker = /\[transcript turn head retained; (\d+) UTF-8 bytes omitted\]/.exec(retained.content);
  assert.ok(marker);
  assert.equal(Number(marker[1]), retained.omittedMiddleBytes);
  assert.ok(Buffer.byteLength(retained.content) <= WORKFLOW_TRANSCRIPT_LIMITS.perTurnBytes);
});

test("source fingerprints are deterministic and ignore compaction prose", () => {
  const base = fallbackWorkflowContext(raw, "one error");
  const changedCompaction = {
    ...base,
    constraints: ["model prose"],
    compaction: { ...base.compaction, error: "another error" },
  };
  assert.equal(workflowContextFingerprint(base), workflowContextFingerprint(changedCompaction));
  assert.notEqual(
    workflowContextFingerprint(base),
    workflowContextFingerprint({ ...base, primaryGoal: { ...base.primaryGoal, rawPrompt: "new goal" } }),
  );

  const image = {
    id: "img_evidence",
    ordinal: 0,
    displayName: "result.png",
    caption: "The result is visible",
    repositoryScope: "repo-01" as const,
    mimeType: "image/png" as const,
    bytes: 68,
    sha256: "a".repeat(64),
    availability: "retained" as const,
    prunedAt: null,
    createdAt: 1,
  };
  const withImage = {
    ...base,
    evidence: { ...base.evidence, images: [image], stagedImageGeneration: 1 },
  };
  const imageFingerprint = workflowContextFingerprint(withImage);
  assert.equal(imageFingerprint, workflowContextFingerprint({
    ...withImage,
    evidence: {
      ...withImage.evidence,
      transcript: [{ role: "assistant" as const, content: "later transcript growth" }],
    },
  }));
  assert.notEqual(imageFingerprint, workflowContextFingerprint({
    ...withImage,
    evidence: { ...withImage.evidence, images: [{ ...image, sha256: "b".repeat(64) }] },
  }));
  assert.notEqual(imageFingerprint, workflowContextFingerprint({
    ...withImage,
    evidence: { ...withImage.evidence, images: [{ ...image, caption: "A different claim" }] },
  }));
  assert.notEqual(imageFingerprint, workflowContextFingerprint({
    ...withImage,
    evidence: { ...withImage.evidence, images: [] },
  }));
  assert.notEqual(imageFingerprint, workflowContextFingerprint({
    ...withImage,
    evidence: { ...withImage.evidence, stagedImageGeneration: 2 },
  }));

  const matchingProbe = {
    headSha: withImage.evidence.headSha,
    workingTreeStatus: withImage.evidence.workingTreeStatus,
    diffFingerprint: withImage.evidence.diffFingerprint,
    stagedImageGeneration: 1,
  };
  assert.equal(probeMatchesEvidence(matchingProbe, withImage.evidence), true);
  assert.equal(probeMatchesEvidence({ ...matchingProbe, stagedImageGeneration: 2 }, withImage.evidence), false);
});

test("resolved plan decisions preserve the reviewed plan and response", () => {
  const decision = workflowReviewDecision({
    id: "plan-review",
    sessionId: "session",
    kind: "plan",
    title: "Implementation plan",
    body: "1. Keep the stable API\n2. Add recovery coverage",
    status: "approved",
    response: "Proceed without changing the wire format",
    createdAt: 1,
    resolvedAt: 2,
  });
  assert.match(decision.decision, /Keep the stable API/);
  assert.match(decision.decision, /Decision: approved/);
  assert.equal(decision.rationale, "Proceed without changing the wire format");

  const longPlan = workflowReviewDecision({
    id: "long-plan-review",
    sessionId: "session",
    kind: "plan",
    title: "Large implementation plan",
    body: "x".repeat(20_000),
    status: "rejected",
    response: null,
    createdAt: 1,
    resolvedAt: 2,
  });
  assert.match(longPlan.decision, /^Decision: rejected/);
  assert.equal(longPlan.decision.length, 16_000);
});

test("stable capture retries one changed boundary and blocks a second change", async () => {
  let reads = 0;
  const stable = await captureStableWorkflowContext(
    async () => ({ read: ++reads }),
    async (captured) => captured.read === 1,
  );
  assert.deepEqual(stable, { read: 2 });
  assert.equal(reads, 2);

  reads = 0;
  const stale = await captureStableWorkflowContext(
    async () => ({ read: ++reads }),
    async () => true,
  );
  assert.equal(stale, null);
  assert.equal(reads, 2);
});

test("repository capture fails closed and detects worktree evidence changes", async () => {
  const repo = join(home, "evidence-repo");
  mkdirSync(repo);
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "workflow@example.com");
  git("config", "user.name", "Workflow Test");
  writeFileSync(join(repo, "file.txt"), "one\n");
  git("add", "file.txt");
  git("commit", "-m", "initial");

  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "evidence-session",
    agent: "claude",
    name: "evidence",
    nameSource: "process",
    cwd: repo,
    gitBranch: "main",
    gitRoot: repo,
    repoRoot: repo,
    pid: 1,
    tty: "ttys-evidence",
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession]);
  const session = registry.getSession("evidence-session")!;
  const binding = {
    id: "evidence-binding",
    sessionId: session.id,
    noteKey: noteKeyFor(session),
  } as WorkflowBinding;
  const captured = await readWorkflowContextRaw(registry, binding);
  assert.equal(await captureBoundaryChanged(registry, binding, captured.boundary), false);

  writeFileSync(join(repo, "file.txt"), "two\n");

  assert.equal(await captureBoundaryChanged(registry, binding, captured.boundary), true);

  const dirtyCapture = await readWorkflowContextRaw(registry, binding);
  const dirtyProbe = await readWorkflowEvidenceProbe(registry, binding);
  assert.equal(probeMatchesEvidence(dirtyProbe, dirtyCapture.context.evidence), true);

  // Same HEAD, same path, same porcelain status and even the same byte length. Only the file
  // contents move, which is exactly the consecutive-repair shape the old metadata-only probe
  // silently classified as unchanged.
  writeFileSync(join(repo, "file.txt"), "six\n");
  const repairedProbe = await readWorkflowEvidenceProbe(registry, binding);
  assert.deepEqual(repairedProbe.workingTreeStatus, dirtyProbe.workingTreeStatus);
  assert.equal(repairedProbe.headSha, dirtyProbe.headSha);
  assert.notEqual(repairedProbe.diffFingerprint, dirtyProbe.diffFingerprint);
  assert.equal(probeMatchesEvidence(repairedProbe, dirtyCapture.context.evidence), false);

  writeFileSync(join(repo, "file.txt"), "one\n");
  for (let index = 0; index <= 500; index++) {
    writeFileSync(join(repo, `untracked-${String(index).padStart(3, "0")}.txt`), "");
  }
  const capped = await readWorkflowContextRaw(registry, binding);
  assert.equal(capped.raw.evidence.workingTreeStatus.length, 500);
  assert.equal(capped.raw.evidence.workingTreeStatusTruncated, true);
  writeFileSync(join(repo, "z-after-status-cap.txt"), "");
  assert.equal(await captureBoundaryChanged(registry, binding, capped.boundary), true);

  const missing = join(home, "not-a-repository");
  mkdirSync(missing);
  const unavailableRegistry = new Registry();
  unavailableRegistry.applyDiscovery([{
    syntheticId: "unavailable-session",
    agent: "claude",
    name: "unavailable",
    nameSource: "process",
    cwd: missing,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 2,
    tty: "ttys-unavailable",
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession]);
  const unavailableSession = unavailableRegistry.getSession("unavailable-session")!;
  await assert.rejects(
    readWorkflowContextRaw(unavailableRegistry, {
      id: "unavailable-binding",
      sessionId: unavailableSession.id,
      noteKey: noteKeyFor(unavailableSession),
    } as WorkflowBinding),
    /Could not capture repository diff/,
  );
});

test("compaction preserves raw intent and visibly degrades on infrastructure failure", async () => {
  const compacted = await compactWorkflowContext(raw, {
    runner: "codex",
    model: "fake",
    execute: async (prompt) => {
      assert.doesNotMatch(prompt, /rationales/);
      return {
        kind: "ok",
        value: {
          constraints: ["Keep compatibility"],
          acceptanceCriteria: ["Tests pass"],
        },
      };
    },
  });
  assert.equal(compacted.compaction.status, "model");
  assert.equal(compacted.compaction.runner, "codex");
  assert.deepEqual(compacted.constraints, ["Keep compatibility"]);
  assert.deepEqual(compacted.humanDecisions, raw.humanDecisions);

  const fallback = await compactWorkflowContext(raw, {
    runner: "claude",
    model: "fake",
    execute: async () => ({ kind: "failed", reason: "timed out" }),
  });
  assert.equal(fallback.compaction.status, "fallback");
  assert.equal(fallback.compaction.error, "timed out");
  assert.deepEqual(fallback.constraints, []);
  assert.deepEqual(fallback.acceptanceCriteria, []);
  assert.deepEqual(fallback.humanDecisions, raw.humanDecisions);
});
