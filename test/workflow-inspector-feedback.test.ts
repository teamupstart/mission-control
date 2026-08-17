import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInspectorFeedback } from "../src/server/workflows/feedback.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// What is at stake: a repair delivery is an immutable instruction packet. Ordering,
// deduplication, fallback text, and hashing must not depend on a later ledger read.
function finding(
  fingerprint: string,
  severity: InspectorComment["severity"],
  over: Partial<InspectorComment> = {},
): InspectorComment {
  return {
    id: fingerprint,
    prKey: "owner/repo#12",
    fingerprint,
    path: "src/file.ts",
    line: 10,
    title: `${severity} title`,
    body: `${severity} detail`,
    severity,
    round: 3,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function render(
  findings: InspectorComment[],
  policy: "restart_workflow" | "inspector_only" = "restart_workflow",
  workflowEvidence = true,
) {
  return renderInspectorFeedback({
    workflowName: "Release review",
    workflowVersion: 4,
    runId: "run-1",
    submissionRound: 2,
    originalGoal: "Ship the safe change",
    prUrl: "https://github.com/owner/repo/pull/12",
    targetHeadSha: "a".repeat(40),
    inspectorRound: 3,
    reviewPosture: "live",
    policy,
    findings,
    workflowEvidence,
  });
}

test("Inspector feedback is severity ordered, fingerprint deduplicated, and stable", () => {
  const rows = [
    finding("minor", "minor"),
    finding("blocker", "blocker", { path: "z.ts" }),
    finding("major", "major"),
    finding("nit", "nit"),
    finding("major", "major", { title: "duplicate wording must not win" }),
  ];
  const first = render(rows);
  const second = render([...rows].reverse());
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payload, second.payload);
  assert.equal(first.failedPersonaCount, 4);
  assert.ok(first.payload.indexOf("BLOCKER") < first.payload.indexOf("MAJOR"));
  assert.ok(first.payload.indexOf("MAJOR") < first.payload.indexOf("MINOR"));
  assert.ok(first.payload.indexOf("MINOR") < first.payload.indexOf("NIT"));
  assert.equal(first.payload.match(/Fingerprint: major/g)?.length, 1);
  assert.match(first.payload, /Original user goal:\nShip the safe change/);
  assert.match(first.payload, /Pinned head: a{40}/);
  assert.match(first.payload, /already authorized you to commit the scoped work/);
  assert.match(first.payload, /already authorized `submit_workflow_evidence`/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
});

test("scrubbed detail and legacy fallback are frozen with published policy wording", () => {
  const packet = render([
    finding("scrubbed", "major", { body: "Token: [REDACTED]\u0007" }),
    finding("legacy", "minor", { body: null, path: null, line: null }),
  ], "inspector_only");
  assert.match(packet.payload, /Token: \[REDACTED\]/);
  assert.doesNotMatch(packet.payload, /\u0007/);
  assert.match(packet.payload, /Legacy finding detail is unavailable/);
  assert.match(packet.payload, /permits bypassing Personas only for this GitHub Inspector repair/);
  assert.match(packet.payload, /commit and push a new head/);
});

test("field and packet caps retain a deterministic hash and truncation notice", () => {
  const huge = "ø".repeat(200_000);
  const first = render([finding("huge", "blocker", { title: huge, body: huge })]);
  const second = render([finding("huge", "blocker", { title: huge, body: huge })]);
  assert.equal(first.truncated, true);
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payload, second.payload);
  assert.match(first.payload, /Workflow repair packet truncated deterministically/);
  assert.match(first.payload, /do not ask the human to resubmit the workflow/);
  assert.ok(Buffer.byteLength(first.payload, "utf8") <= 64 * 1024);
});

test("Inspector feedback omits evidence-tool authority when the pinned graph has no Persona", () => {
  const packet = render([finding("major", "major")], "restart_workflow", false);
  assert.doesNotMatch(packet.payload, /submit_workflow_evidence/);
  assert.match(packet.payload, /do not ask the human to resubmit the workflow/);
});
