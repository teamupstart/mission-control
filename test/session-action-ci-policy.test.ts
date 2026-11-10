import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderSessionAction } from "../src/server/workflows/feedback.ts";
import { workflowPullRequestCiContract } from "../src/server/workflows/agent-contract.ts";
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

// The policy's text follows Foreman's "Which failures count".
const ALL_CI_POLICY = [
  "## Workflow pull request CI follow-through",
  "Foreman's Keep sessions on track with CI option was selected when this packet was prepared. This policy extends the Pull Request action's stopping point through CI, including when the frozen instruction below says opening the PR is the whole job. Preserve all other task and repository restrictions.",
  "After opening or updating the PR, keep watching its checks. Wait for pending checks and inspect failing check logs. Follow only this action's PR and repository, on the same branch.",
  "Repair actionable CI failures within the authorized scope. Run tests specific to the failure; when they pass, commit and push the repair. Do not rerun the full local test suite before each repair commit.",
  "After every repair push, verify checks for the newly pushed head. Do not rely on an earlier green result. Continue until CI passes or a concrete external blocker prevents authorized progress; distinguish absent or unavailable checks from passing CI and report the blocker rather than retrying indefinitely.",
  "Report the PR, checked head, final CI outcome, and any blocker. Register useful new verification evidence when this workflow supports it, then end the turn so Mission Control can continue the workflow.",
  "This policy does not authorize merge, CI infrastructure changes, bypassing checks, or broader repository scope. Inspector review comments remain with the existing review workflow and Foreman review-comment policy. The workflow still validates published content against its reviewed snapshot.",
].join("\n");

test("All checks keeps the CI policy's text byte for byte", () => {
  assert.equal(workflowPullRequestCiContract(), ALL_CI_POLICY);
  assert.equal(workflowPullRequestCiContract("all"), ALL_CI_POLICY);
  const omitted = renderSessionAction({ ...packet, pullRequestCi: true });
  const all = renderSessionAction({ ...packet, pullRequestCi: true, pullRequestCiStrictness: "all" });
  assert.ok(omitted.ok && all.ok);
  assert.equal(all.payload, omitted.payload);
  assert.ok(all.payload.includes(`\n${ALL_CI_POLICY}\n`));
});

test("Required checks points the CI policy at the checks GitHub marks required", () => {
  const result = renderSessionAction({ ...packet, pullRequestCi: true, pullRequestCiStrictness: "required" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.payload.endsWith(legacyPrompt));
  assert.ok(!result.payload.includes(ALL_CI_POLICY));
  const policy = workflowPullRequestCiContract("required");
  assert.ok(result.payload.includes(`\n${policy}\n`));
  assert.match(policy, /option was selected when this packet was prepared, with Required checks chosen as the failures that count\./);
  assert.ok(policy.includes(
    "After opening or updating the PR, keep watching the checks GitHub marks required (`gh pr checks <url> --required`). "
      + "Wait for pending required checks and inspect failing ones' logs. A failing check that is not required does not block; "
      + "leave it alone unless the task asks. If no check is marked required, follow every check. Follow only this action's PR "
      + "and repository, on the same branch.",
  ));
  assert.match(policy, /^Repair actionable failures of required checks within the authorized scope\./m);
  assert.match(policy, /^After every repair push, verify the required checks for the newly pushed head\./m);
  assert.match(policy, /Continue until the required checks pass or a concrete external blocker/);
  // Everything else is the same policy: scope, focused tests, no merge authority.
  assert.match(policy, /Do not rerun the full local test suite/);
  assert.match(policy, /does not authorize merge/);
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

test("PR policy reaches frozen actions without changing their authored prompt or allowing CI promotion", () => {
  const result = renderSessionAction({ ...packet, pullRequestPolicy: true, pullRequestCi: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.payload.endsWith(legacyPrompt));
  assert.match(result.payload, /get_pull_request_policy immediately before creating each PR/);
  assert.match(result.payload, /alwaysDraftPr is true/);
  assert.match(result.payload, /gh pr create --draft/);
  assert.match(result.payload, /Only the human may promote/);
  assert.match(result.payload, /even to trigger CI or finish this workflow/);
  assert.match(result.payload, /If the policy cannot be read, stop/);
  assert.match(result.payload, /Updating an existing PR preserves its draft or ready status/);
  const ordinary = renderSessionAction(packet);
  assert.equal(ordinary.ok, true);
  if (ordinary.ok) assert.doesNotMatch(ordinary.payload, /Pull request creation policy/);
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
    pullRequestCiStrictness: "required",
    pullRequestPolicy: true,
  });
  assert.equal(result.ok, true, "CI policy must not make existing maximum-size actions undeliverable");
  if (!result.ok) return;
  assert.ok(result.payload.endsWith(promptMarkdown));
  assert.ok(Buffer.byteLength(result.payload) <= WORKFLOW_LIMITS.sessionActionPacketBytes);
});
