import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_EXECUTION_LIMITS,
  type WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";
import {
  normalizePersonaVerdict,
  parsePersonaVerdict,
} from "../src/server/workflows/verdict.ts";
import { buildPersonaPrompt } from "../src/server/workflows/prompt.ts";

test("Persona verdicts discriminate pass and fail and clamp bounded model values", () => {
  const pass = parsePersonaVerdict(JSON.stringify({
    verdict: "pass",
    summary: "approved",
    approvalDetails: { reason: "meets intent", evidence: [] },
    confidence: 0.9,
  }));
  assert.equal(pass?.verdict, "pass");

  const fail = normalizePersonaVerdict({
    verdict: "fail",
    summary: "x".repeat(WORKFLOW_EXECUTION_LIMITS.verdictSummary + 50),
    requestedChanges: Array.from(
      { length: WORKFLOW_EXECUTION_LIMITS.verdictChanges + 5 },
      (_, index) => ({
        title: `change ${index}`,
        rationale: "needed",
        evidence: [{ kind: "goal", quote: "required behavior" }],
        line: -10,
      }),
    ),
    confidence: 4,
  });
  assert.equal(fail?.verdict, "fail");
  assert.equal(fail?.confidence, 1);
  assert.equal(
    fail?.verdict === "fail" ? fail.requestedChanges.length : 0,
    WORKFLOW_EXECUTION_LIMITS.verdictChanges,
  );
  assert.equal(fail?.summary.length, WORKFLOW_EXECUTION_LIMITS.verdictSummary);
  assert.equal(fail?.verdict === "fail" ? fail.requestedChanges[0]?.line : null, 1);
  assert.equal(normalizePersonaVerdict({
    verdict: "fail",
    summary: "unsupported",
    requestedChanges: [{ title: "change", rationale: "needed", evidence: [] }],
    confidence: 1,
  }), null);
});

test("malformed model output is an infrastructure parse failure, never a fail verdict", () => {
  assert.equal(parsePersonaVerdict("not json"), null);
  assert.equal(parsePersonaVerdict(JSON.stringify({ verdict: "fail", summary: "missing changes" })), null);
  assert.equal(parsePersonaVerdict(JSON.stringify({
    verdict: "pass",
    summary: "missing approval details",
    confidence: 1,
  })), null);
  assert.equal(parsePersonaVerdict(JSON.stringify({
    verdict: "fail",
    summary: "too large",
    requestedChanges: Array.from({ length: 20 }, (_, index) => ({
      title: `change ${index}`,
      rationale: "x".repeat(4_000),
      evidence: [{ kind: "goal", quote: "required behavior" }],
    })),
    confidence: 1,
  })), null);
});

test("Persona prompts put immutable human intent before exact Persona Markdown and fence evidence", () => {
  const context: WorkflowContextSnapshot = {
    primaryGoal: { rawPrompt: "RAW HUMAN GOAL", refined: "refined", sourceNoteKey: "note" },
    humanDecisions: [{
      decision: "HUMAN DECISION",
      rationale: "HUMAN RATIONALE",
      source: { kind: "review", id: "r1" },
    }],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "UNTRUSTED DIFF",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      transcript: [],
      transcriptAnchor: null,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  };
  const guidance = "EXACT PERSONA MARKDOWN\n\nDo not normalize me.";
  const prompt = buildPersonaPrompt({
    sourcePersonaId: "p1",
    sourceRevision: 1,
    name: "Security",
    description: "",
    guidanceMarkdown: guidance,
    runner: null,
    model: null,
  }, context);
  assert.ok(prompt.indexOf("RAW HUMAN GOAL") < prompt.indexOf(guidance));
  assert.ok(prompt.indexOf("HUMAN DECISION") < prompt.indexOf(guidance));
  assert.match(prompt, /workflow-diff-untrusted/);
  assert.match(prompt, /untrusted evidence/i);

  const largePrompt = buildPersonaPrompt({
    sourcePersonaId: "p1",
    sourceRevision: 1,
    name: "Security",
    description: "",
    guidanceMarkdown: guidance,
    runner: null,
    model: null,
  }, {
    ...context,
    evidence: { ...context.evidence, diff: "x".repeat(500_000), diffTruncated: true },
  });
  assert.match(largePrompt, /\[section truncated\]/);
  assert.ok(largePrompt.indexOf("# Required output") > largePrompt.indexOf("workflow-diff-untrusted"));
  assert.match(largePrompt, /Reply with ONLY one JSON object/);
});
