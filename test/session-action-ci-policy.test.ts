import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderSessionAction } from "../src/server/workflows/feedback.ts";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";

const legacyPrompt = "# Pull Request\n\nOpening it is the whole job; this run's final gate reviews it afterwards.\n";
const packet = {
  origin: { kind: "run" as const, workflowName: "Review", workflowVersion: 15, runId: "run-1", repoRoot: "/repo" },
  actionName: "Publish reviewed work",
  promptMarkdown: legacyPrompt,
  skillCommand: "/pull-request",
  workflowEvidence: true,
};

test("CI policy extends a frozen PR stopping instruction without rewriting it", () => {
  const result = renderSessionAction({ ...packet, pullRequestCi: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.payload.startsWith("/pull-request\n"));
  assert.ok(result.payload.endsWith(legacyPrompt));
  assert.ok(result.payload.indexOf("## Workflow pull request CI follow-through") < result.payload.indexOf(legacyPrompt));
  assert.match(result.payload, /extends.*stopping point/);
  assert.match(result.payload, /pending checks/);
  assert.match(result.payload, /same branch/);
  assert.match(result.payload, /tests specific to the failure/);
  assert.match(result.payload, /Do not rerun the full local test suite/);
  assert.match(result.payload, /newly pushed head/);
  assert.match(result.payload, /absent or unavailable/);
  assert.match(result.payload, /concrete external blocker/);
  assert.match(result.payload, /does not authorize merge/);
  assert.match(result.payload, /review comments remain/);
  assert.equal(result.payloadSha256, createHash("sha256").update(result.payload).digest("hex"));
});

test("CI policy is absent when disabled, omitted, or outside a workflow", () => {
  for (const input of [
    packet,
    { ...packet, pullRequestCi: false },
    { ...packet, pullRequestCi: true, origin: { kind: "session" as const, sessionId: "session-1" } },
  ]) {
    const result = renderSessionAction(input);
    assert.equal(result.ok, true);
    if (result.ok) assert.doesNotMatch(result.payload, /Workflow pull request CI follow-through/);
  }
});

test("CI instructions count toward the whole-packet size limit", () => {
  const empty = renderSessionAction({ ...packet, promptMarkdown: "" });
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  const promptMarkdown = "x".repeat(WORKFLOW_LIMITS.sessionActionPacketBytes - Buffer.byteLength(empty.payload));
  assert.equal(renderSessionAction({ ...packet, promptMarkdown }).ok, true);
  const withCi = renderSessionAction({ ...packet, promptMarkdown, pullRequestCi: true });
  assert.equal(withCi.ok, false);
  if (!withCi.ok) assert.ok(withCi.bytes > withCi.limit);
});

test("a maximum authored prompt still fits with authorization and CI instructions", () => {
  const promptMarkdown = "x".repeat(WORKFLOW_LIMITS.sessionActionPromptBytes);
  const result = renderSessionAction({
    ...packet,
    actionName: "界".repeat(WORKFLOW_LIMITS.sessionActionName),
    origin: {
      ...packet.origin,
      workflowName: "界".repeat(WORKFLOW_LIMITS.workflowName),
      repoRoot: `/${"界".repeat(WORKFLOW_LIMITS.checkRepoRoot - 1)}`,
    },
    skillCommand: `/${"s".repeat(WORKFLOW_LIMITS.sessionActionSkillId)}`,
    promptMarkdown,
    pullRequestCi: true,
  });
  assert.equal(result.ok, true, "CI policy must not make existing maximum-size actions undeliverable");
  if (!result.ok) return;
  assert.ok(result.payload.endsWith(promptMarkdown));
  assert.ok(Buffer.byteLength(result.payload) <= WORKFLOW_LIMITS.sessionActionPacketBytes);
});
