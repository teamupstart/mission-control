import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_EXECUTION_LIMITS,
  PERSONA_FINDING_BASES,
  type WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";
import {
  normalizePersonaVerdict,
  parsePersonaVerdict,
} from "../src/server/workflows/verdict.ts";
import { buildPersonaPrompt } from "../src/server/workflows/prompt.ts";
import { WorkflowRequestedChangeSchema } from "../src/shared/protocol.ts";

test("persisted findings accept every runtime basis and preserve legacy omissions", () => {
  for (const basis of [...PERSONA_FINDING_BASES, undefined]) {
    const change = { basis, title: "Fix behavior", rationale: "The evidence does not prove it",
      evidence: [{ kind: "goal", quote: "Expected behavior" }] };
    const verdict = normalizePersonaVerdict({ verdict: "fail", summary: "Needs repair", requestedChanges: [change], confidence: 1 });
    assert.equal(verdict?.verdict, "fail");
    if (verdict?.verdict === "fail") assert.equal(WorkflowRequestedChangeSchema.parse(verdict.requestedChanges[0]).basis, basis);
  }
});

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

test("Persona Check citations must name a frozen upstream attempt", () => {
  const cited = (path?: string) => JSON.stringify({
    verdict: "pass",
    summary: "The focused Check passed",
    approvalDetails: {
      reason: "The immutable Check output contains the passing result",
      evidence: [{
        kind: "check",
        ...(path === undefined ? {} : { path }),
        quote: "ok 13 - focused regression",
      }],
    },
    confidence: 1,
  });
  const frozenAttempts = new Set(["attempt-check-2"]);

  assert.equal(
    parsePersonaVerdict(cited("attempt-check-2"), new Set(), new Set(), frozenAttempts)?.verdict,
    "pass",
  );
  assert.equal(
    parsePersonaVerdict(cited("fabricated-attempt"), new Set(), new Set(), frozenAttempts),
    null,
  );
  assert.equal(parsePersonaVerdict(cited(), new Set(), new Set(), frozenAttempts), null);
  assert.equal(parsePersonaVerdict(cited("attempt-check-2")), null);
});

test("the evidence-availability contract scopes coverage declarations out of Persona judgment", () => {
  const context: WorkflowContextSnapshot = {
    primaryGoal: { rawPrompt: "Ship the fix", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: ["The fix is proven"],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "abc",
      diffFingerprint: "diff",
      diff: "diff",
      diffTruncated: false,
      workingTreeDirty: false,
      workingTreeStatus: [],
      workingTreeStatusTruncated: false,
      transcript: [],
      transcriptAnchor: null,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  };
  const prompt = buildPersonaPrompt({
    sourcePersonaId: "p1",
    sourceRevision: 1,
    name: "Code Quality",
    description: "",
    guidanceMarkdown: "Review the change.",
    runner: null,
    model: null,
  }, context);
  // The sentence is IN the contract section, not merely somewhere in the prompt: a Persona
  // reads this section to decide what an absence means, and that is where the answer belongs.
  const contract = prompt.slice(
    prompt.indexOf("# Evidence availability contract"),
    prompt.indexOf("# Prior Persona feedback"),
  );
  assert.ok(contract.length > 0);
  assert.match(contract, /Coverage registration belongs to Mission Control/);
  assert.match(contract, /Ready establishes structural completeness, not substantive sufficiency/);
  assert.match(contract, /Legacy attempt has no frozen readiness input/);
  assert.match(contract, /Do not request coverage registration repairs/);
  assert.equal(prompt.includes("proofClass"), false);
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
      workingTreeStatusTruncated: false,
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

test("Persona prompts expose immutable Check outcomes and exact text artifacts as citable evidence", () => {
  const artifactContent = "TAP version 13\nok 13 - focused regression\n";
  const context: WorkflowContextSnapshot = {
    primaryGoal: { rawPrompt: "Verify the implementation", refined: null, sourceNoteKey: "note" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "codex", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha: "head-abc",
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
      artifacts: [{
        id: "txt_focused",
        ordinal: 0,
        displayName: "focused.tap",
        caption: "Focused regression output",
        repositoryScope: "repo-01",
        mimeType: "text/plain",
        bytes: Buffer.byteLength(artifactContent),
        sha256: "a".repeat(64),
        content: artifactContent,
        availability: "retained",
        prunedAt: null,
        createdAt: 1,
      }],
    },
    compaction: { status: "fallback", runner: null, model: null, error: null },
  };
  const checkEvidence = [{
    nodeId: "check-test",
    attemptId: "attempt-check-2",
    attempt: 2,
    slot: "test" as const,
    status: "passed" as const,
    command: ["node", "--test", "test/focused.test.ts"],
    exitCode: 0,
    outputTail: "ok 13 - focused regression\n",
    omittedBytes: 128,
    headSha: "head-abc",
    note: "The test check passed.",
  }];
  const prompt = buildPersonaPrompt({
    sourcePersonaId: "auditor",
    sourceRevision: 1,
    name: "Test Evidence Auditor",
    description: "",
    guidanceMarkdown: "Inspect exact test evidence.",
    runner: null,
    model: null,
  }, context, null, checkEvidence);

  for (const expected of [
    "attempt-check-2",
    '"node",',
    '"--test",',
    '"test/focused.test.ts"',
    '"exitCode": 0',
    '"omittedBytes": 128',
    '"headSha": "head-abc"',
    "ok 13 - focused regression",
    "txt_focused",
    artifactContent,
    '"check"|"image"|"artifact"',
    "For Check evidence, path MUST be the immutable attemptId",
    "Evidence-only logs do not need to be committed.",
    "Pull-request checks, remote CI, and Inspector findings may be later workflow stages",
  ]) {
    assert.match(prompt, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const cited = JSON.stringify({
    verdict: "pass",
    summary: "Focused evidence is present",
    approvalDetails: {
      reason: "The submitted test completed",
      evidence: [{ kind: "artifact", path: "txt_focused", quote: "ok 13" }],
    },
    confidence: 1,
  });
  assert.equal(parsePersonaVerdict(cited, new Set(), new Set(["txt_focused"]))?.verdict, "pass");
  assert.equal(parsePersonaVerdict(cited, new Set(), new Set())?.verdict, undefined);
});
