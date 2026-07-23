import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-context-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  captureStableWorkflowContext,
  compactWorkflowContext,
  fallbackWorkflowContext,
  humanTranscriptDecisions,
  workflowContextFingerprint,
} = await import("../src/server/workflows/context.ts");

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

test("compaction preserves raw intent and visibly degrades on infrastructure failure", async () => {
  const compacted = await compactWorkflowContext(raw, {
    runner: "codex",
    model: "fake",
    execute: async () => ({
      kind: "ok",
      value: {
        rationales: [{ sourceId: "review:r1", rationale: "advisory rewrite" }],
        constraints: ["Keep compatibility"],
        acceptanceCriteria: ["Tests pass"],
      },
    }),
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
